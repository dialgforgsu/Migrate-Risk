# Will It Lock?

A static, browser-only tool that tells you **exactly what a DDL migration will do to your live table** — lock type, reads/writes blocked, table rewrite, estimated duration, and a safer alternative — before you run it in production.

No backend. No AI guessing. Every verdict comes from an auditable rules knowledge base grounded in official documentation.

---

## What it does

You pick an engine, version, operation, table size, and write throughput. The tool returns:

| Output | Example |
|---|---|
| **Severity** | 🔴 Danger |
| **Lock type** | `ACCESS EXCLUSIVE` |
| **Blocks reads?** | Yes |
| **Blocks writes?** | Yes |
| **Table rewrite?** | Yes (~7 min at 250k rows/sec) |
| **Safer alternative** | Step-by-step online migration path |
| **Source citations** | Links to official docs for every verdict |

It also includes:

- **Version lock matrix** — a side-by-side comparison of how lock behaviour differs across engine versions (e.g. PG ≤10 vs PG 11+ for `ADD COLUMN DEFAULT`, MySQL 5.7 vs 8.0 INSTANT DDL)
- **Real-world scenarios** — contextual examples with actual timing math, shown inline when you select a relevant operation
- **Migration advisor chat** — action buttons (Why does it lock? / How to do it safely? / What can go wrong?) that generate answers grounded in the matched rule

---

## Supported engines and versions

| Engine | Versions | Notes |
|---|---|---|
| **PostgreSQL** | 9.6 – 16 | Version-specific rules for PG 10/11 inflection points |
| **MySQL** | 5.7, 8.0, 8.1+ | Version-specific rules for INSTANT DDL (8.0.12+) |
| **SQL Server** | 2016 – 2022 | Edition-aware: Standard vs Enterprise (ONLINE=ON) |

---

## Supported operations

11 DDL operations are covered across all three engines:

| Operation | Key |
|---|---|
| Add nullable column | `add_column_nullable` |
| Add column with constant DEFAULT | `add_column_constant_default` |
| Add column with volatile DEFAULT (`now()`, `random()`) | `add_column_volatile_default` |
| Add NOT NULL column | `add_column_not_null` |
| Add NOT NULL constraint to existing column | `add_not_null_constraint` |
| Create index | `create_index` |
| Create index (CONCURRENTLY / ONLINE) | `create_index_concurrent` |
| Alter column type | `alter_column_type` |
| Add foreign key | `add_foreign_key` |
| Drop column | `drop_column` |
| Rename column | `rename_column` |

The rules engine contains **42 rules** covering version- and edition-specific behaviour within these operations.

---

## How to use it

### Online

Open the deployed site — no install required.

### Locally

The page fetches `rules.json` and two ES modules over HTTP, so it must be served (not opened from disk):

```bash
# Python (built-in)
python -m http.server 8080

# Node.js
npx serve .

# VS Code
# Install "Live Server" extension → right-click index.html → Open with Live Server
```

Then open `http://localhost:8080`.

### In your own code

The rules engine is a pure ES module with zero dependencies:

```js
import { resolveVerdict } from './src/engine/lookup.js';
import rules from './src/engine/rules.json' assert { type: 'json' };

const result = resolveVerdict(
  {
    engine: 'postgres',
    version: '13',
    operation: 'create_index',
    context: {
      tableSizeRows: 50_000_000,
      writesPerSec: 2000,
    },
  },
  rules.rules
);

console.log(result.severity);       // 'danger'
console.log(result.lockType);       // 'SHARE'
console.log(result.blocksWrites);   // true
console.log(result.estDurationLabel); // '~1 min'
```

---

## Examples

### PostgreSQL — the PG 11 constant-default inflection point

```sql
-- PostgreSQL 13 — SAFE (instant, no table rewrite)
ALTER TABLE users ADD COLUMN is_verified BOOLEAN DEFAULT false;

-- PostgreSQL 10 — DANGER (full table rewrite under ACCESS EXCLUSIVE)
-- 50M rows at 250k rows/sec ≈ 3 min of total unavailability
ALTER TABLE users ADD COLUMN is_verified BOOLEAN DEFAULT false;
```

**Why it changed in PG 11:** PostgreSQL 11 stores constant defaults in `pg_attrdef` (the catalog) rather than writing them to every physical row. The `ALTER TABLE` still takes an `ACCESS EXCLUSIVE` lock, but it completes in milliseconds regardless of table size.

**Safe path on PG ≤10:**
```sql
-- Step 1: add the column with no default (instant)
ALTER TABLE users ADD COLUMN is_verified BOOLEAN;

-- Step 2: backfill in batches (no lock, no downtime)
UPDATE users SET is_verified = false WHERE id BETWEEN 1 AND 100000;
-- ... repeat in batches of 10k–100k rows

-- Step 3: set the default for new rows (instant catalog change)
ALTER TABLE users ALTER COLUMN is_verified SET DEFAULT false;
```

---

### PostgreSQL — CREATE INDEX vs CREATE INDEX CONCURRENTLY

```sql
-- DANGER: full ACCESS EXCLUSIVE for the entire build
-- 500M-row orders table at 500k rows/sec ≈ 16 min of total unavailability
CREATE INDEX idx_orders_customer ON orders(customer_id);

-- SAFE: two scans, only blocks DDL — reads and writes continue
-- Takes ~2× longer (two passes) but zero write downtime
CREATE INDEX CONCURRENTLY idx_orders_customer ON orders(customer_id);
```

**Caveats with CONCURRENTLY:** Cannot run inside a transaction block. If the build fails mid-way, it leaves an INVALID index — drop it and retry.

---

### MySQL — INSTANT DDL in 8.0

```sql
-- MySQL 8.0 — SAFE (ALGORITHM=INSTANT, metadata-only)
ALTER TABLE events ADD COLUMN processed_at DATETIME DEFAULT NULL;

-- MySQL 5.7 — CAUTION (INPLACE rebuild, reads continue but writes queue at swap)
-- 100M rows at 250k rows/sec ≈ 7 min
ALTER TABLE events ADD COLUMN processed_at DATETIME DEFAULT NULL;
```

MySQL 8.0.12 introduced `ALGORITHM=INSTANT` for most `ADD COLUMN` operations with constant defaults. The same SQL statement has completely different behaviour across versions.

---

### MySQL — online index creation (already the default)

```sql
-- MySQL 5.6+ — SAFE by default (INPLACE LOCK=NONE)
-- 500M rows at 500k rows/sec ≈ 16 min, reads and writes fully unblocked
CREATE INDEX idx_orders_status ON orders(status);

-- Explicit syntax (same result):
ALTER TABLE orders ADD INDEX idx_orders_status (status)
  ALGORITHM=INPLACE, LOCK=NONE;
```

Unlike PostgreSQL, MySQL's `CREATE INDEX` is already online by default. There is no separate `CONCURRENTLY` keyword.

---

### SQL Server — the Standard vs Enterprise trap

```sql
-- SQL Server Enterprise — SAFE (ONLINE=ON, reads+writes continue)
CREATE INDEX idx_orders_customer
  ON orders(customer_id)
  WITH (ONLINE = ON);

-- SQL Server Standard — DANGER (Sch-M lock, blocks reads AND writes)
-- ONLINE=ON is Enterprise-only; this falls back to a blocking full build
CREATE INDEX idx_orders_customer
  ON orders(customer_id);
```

This is the most common SQL Server incident pattern: a DBA adds `WITH (ONLINE = ON)` locally (on Enterprise dev), the same script runs on a Standard production instance, silently ignores the option, and takes a full Schema Modification lock.

---

### PostgreSQL — safe foreign key migration

```sql
-- DANGER: holds SHARE ROW EXCLUSIVE on both tables for the full validation scan
ALTER TABLE orders ADD CONSTRAINT fk_orders_customer
  FOREIGN KEY (customer_id) REFERENCES customers(id);

-- SAFE: instant + background validation
-- Step 1: instant, only enforces on new/updated rows
ALTER TABLE orders ADD CONSTRAINT fk_orders_customer
  FOREIGN KEY (customer_id) REFERENCES customers(id)
  NOT VALID;

-- Step 2: background validation (SHARE UPDATE EXCLUSIVE — no DML block)
ALTER TABLE orders VALIDATE CONSTRAINT fk_orders_customer;
```

---

### PostgreSQL — adding NOT NULL safely

```sql
-- DANGER: full table scan under ACCESS EXCLUSIVE
-- 100M rows ≈ 7 min of unavailability
ALTER TABLE users ALTER COLUMN email SET NOT NULL;

-- SAFE: three-step approach using a CHECK constraint
-- Step 1: instant, no scan, only enforces on future writes
ALTER TABLE users
  ADD CONSTRAINT users_email_not_null
  CHECK (email IS NOT NULL) NOT VALID;

-- Step 2: background validation (SHARE UPDATE EXCLUSIVE, no DML block)
ALTER TABLE users VALIDATE CONSTRAINT users_email_not_null;

-- Step 3: instant — PG recognises the existing validated constraint
ALTER TABLE users ALTER COLUMN email SET NOT NULL;
```

---

## What it doesn't do

### Out of scope (by design)

- **No DDL parsing** — you select the operation from a dropdown; the tool does not parse raw SQL strings. There is no "paste your migration" mode.
- **No migration diffing** — it evaluates one DDL operation at a time, not a sequence of operations or a full migration file.
- **No locking simulation** — verdicts are based on documented engine behaviour, not a live database connection or query plan.
- **No AI generation** — the chat panel generates its explanations entirely from the matched rule data. There are no LLM API calls.

### Engines not covered

| Engine | Status |
|---|---|
| Oracle Database | Not covered |
| MariaDB | Not covered (diverges from MySQL in online DDL behaviour) |
| SQLite | Not covered (no concurrent access model) |
| CockroachDB / TiDB / Aurora | Not covered (distributed behaviour differs significantly) |
| Redshift / BigQuery / Snowflake | Not covered (cloud warehouse DDL is a different model) |

### Operations not yet covered

The following DDL types return a generic "verify manually" caution and are not in the rules knowledge base:

- `TRUNCATE TABLE`
- `DROP TABLE` / `DROP INDEX`
- `CREATE TABLE` / `CREATE TABLE AS SELECT`
- `ADD UNIQUE CONSTRAINT`
- `ADD CHECK CONSTRAINT`
- `PARTITION` operations
- `VACUUM` / `ANALYZE` / `REINDEX`
- Stored procedure / function DDL

### Limitations of the duration estimates

Duration estimates (e.g. "~7 min") are **order-of-magnitude only**, computed as:

```
rewrite:     table_rows ÷ 250,000 rows/sec
index_build: table_rows ÷ 500,000 rows/sec
```

Actual duration depends on:
- I/O throughput and IOPS (SSD vs HDD, RAID, cloud tier)
- Row width (wide rows are slower than narrow rows)
- Write amplification during a concurrent rebuild
- Buffer cache hit rate
- Autovacuum activity / bloat
- Network latency (for replication lag)

**Always benchmark on a staging replica before running on production.** The estimates are useful for order-of-magnitude planning (instant vs seconds vs minutes vs hours), not for SLA commitments.

---

## Architecture

```
index.html          — single-file React app (Babel standalone, no build step)
src/
  engine/
    rules.json      — 42 versioned lock-verdict rules (the source of truth)
    lookup.js       — pure ES module: resolveVerdict(input, rules) → verdict
    formulas.js     — pure ES module: duration math (rewrite / index_build models)
    lookup.test.js  — 67 Node.js built-in test runner tests
```

The rules engine is **zero-dependency** and runs identically in the browser, Node.js, Deno, and any ES module environment. The UI is the only thing that requires a browser.

### Running the tests

```bash
npm test
# or
node --test src/engine/lookup.test.js
```

---

## Contributing

The most valuable contributions are **new rules** and **corrections to existing ones**. Every rule must:

1. Be grounded in official documentation (link in `citations`)
2. Cover a specific `engine` + `operation` combination
3. Be version- or edition-bounded when behaviour differs across versions
4. Pass the existing test suite (`npm test`)

See `src/engine/rules.json` for the rule schema and `src/engine/lookup.test.js` for test examples.

---

## License

MIT
