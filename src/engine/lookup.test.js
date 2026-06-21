/**
 * lookup.test.js — unit tests for the lock-verdict engine.
 * Run with:  npm test   (uses Node's built-in test runner, zero deps)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { resolveVerdict, parseVersion } from './lookup.js';
import { estimateDuration, formatDuration } from './formulas.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rules = JSON.parse(readFileSync(join(__dirname, 'rules.json'), 'utf8'));

// Silence expected collision warnings unless a test opts in.
const quiet = { onCollision: () => {} };

const ctx = (over = {}) => ({ tableSizeRows: 50_000_000, writesPerSec: 2000, edition: null, onlineFlag: null, ...over });

test('Postgres 16 + add_column_constant_default → safe, no rewrite (v11plus rule)', () => {
  const v = resolveVerdict({ engine: 'postgres', version: '16', operation: 'add_column_constant_default', context: ctx() }, rules, quiet);
  assert.equal(v.matchedRuleId, 'pg_add_col_const_v11plus');
  assert.equal(v.severity, 'safe');
  assert.equal(v.lockType, 'ACCESS EXCLUSIVE (brief)');
  assert.equal(v.rewritesTable, false);
  assert.equal(v.estDurationSeconds, null);
  assert.equal(v.estDurationLabel, 'instant');
});

test('Postgres 10 + add_column_constant_default → danger, rewrites (pre11 rule)', () => {
  const v = resolveVerdict({ engine: 'postgres', version: '10', operation: 'add_column_constant_default', context: ctx() }, rules, quiet);
  assert.equal(v.matchedRuleId, 'pg_add_col_const_pre11');
  assert.equal(v.severity, 'danger');
  assert.equal(v.rewritesTable, true);
  assert.equal(v.lockType, 'ACCESS EXCLUSIVE');
  assert.ok(v.safeAlternative, 'should offer a safe alternative');
});

test('Postgres 16 + add_column_volatile_default → danger, rewrites', () => {
  const v = resolveVerdict({ engine: 'postgres', version: '16', operation: 'add_column_volatile_default', context: ctx() }, rules, quiet);
  assert.equal(v.matchedRuleId, 'pg_add_col_volatile');
  assert.equal(v.severity, 'danger');
  assert.equal(v.rewritesTable, true);
});

test('MySQL 8 + add_column_nullable → safe, instant', () => {
  const v = resolveVerdict({ engine: 'mysql', version: '8.0', operation: 'add_column_nullable', context: ctx() }, rules, quiet);
  assert.equal(v.matchedRuleId, 'mysql_add_col_instant_v8');
  assert.equal(v.severity, 'safe');
  assert.equal(v.estDurationLabel, 'instant');
  assert.equal(v.estDurationSeconds, null);
});

test('SQL Server 2019 + create_index + enterprise → caution (ONLINE rule wins)', () => {
  const v = resolveVerdict({ engine: 'sqlserver', version: '2019', operation: 'create_index', context: ctx({ edition: 'enterprise' }) }, rules, quiet);
  assert.equal(v.matchedRuleId, 'mssql_create_index_online_ent');
  assert.equal(v.severity, 'caution');
  assert.equal(v.blocksWrites, false);
});

test('SQL Server 2019 + create_index + standard → caution (offline NC build: S lock, reads+writes continue)', () => {
  const v = resolveVerdict({ engine: 'sqlserver', version: '2019', operation: 'create_index', context: ctx({ edition: 'standard' }) }, rules, quiet);
  assert.equal(v.matchedRuleId, 'mssql_create_index_offline');
  assert.equal(v.severity, 'caution');
  assert.equal(v.blocksWrites, false);
  assert.equal(v.blocksReads, false);
  assert.equal(v.lockType, 'S (shared)');
});

test('SQL Server 2019 + create_index + edition null → caution (falls through to offline)', () => {
  const v = resolveVerdict({ engine: 'sqlserver', version: '2019', operation: 'create_index', context: ctx({ edition: null }) }, rules, quiet);
  assert.equal(v.matchedRuleId, 'mssql_create_index_offline');
  assert.equal(v.severity, 'caution');
});

test('Unknown operation → caution fallback, no crash', () => {
  const v = resolveVerdict({ engine: 'postgres', version: '16', operation: 'reticulate_splines', context: ctx() }, rules, quiet);
  assert.equal(v.matchedRuleId, null);
  assert.equal(v.severity, 'caution');
  assert.match(v.explanation, /verify manually/i);
});

test('Unknown engine → caution fallback, no crash', () => {
  const v = resolveVerdict({ engine: 'oracle', version: '19', operation: 'create_index', context: ctx() }, rules, quiet);
  assert.equal(v.severity, 'caution');
  assert.equal(v.matchedRuleId, null);
});

test('Duration: rewrite on 50M rows at 250k/s → 200s → "~3 min"', () => {
  const v = resolveVerdict({ engine: 'postgres', version: '16', operation: 'add_column_volatile_default', context: ctx({ tableSizeRows: 50_000_000 }) }, rules, quiet);
  assert.equal(v.estDurationSeconds, 200);
  assert.equal(v.estDurationLabel, '~3 min');
});

// --- direct unit coverage of the pure helpers ------------------------

test('parseVersion handles "8.0" → 8, "2019" → 2019, "16" → 16, empty → NaN', () => {
  assert.equal(parseVersion('8.0'), 8);
  assert.equal(parseVersion('2019'), 2019);
  assert.equal(parseVersion('16'), 16);
  assert.ok(Number.isNaN(parseVersion('')));
  assert.ok(Number.isNaN(parseVersion(null)));
});

test('formatDuration bucket boundaries', () => {
  assert.equal(formatDuration(0.4), 'instant');
  assert.equal(formatDuration(30), '~30s');
  assert.equal(formatDuration(200), '~3 min');
  assert.equal(formatDuration(7200), '~2 hr');
  assert.equal(formatDuration(null), 'instant');
});

test('estimateDuration: index_build on 50M rows at 500k/s → 100s → "~2 min"', () => {
  const r = estimateDuration('index_build', { tableSizeRows: 50_000_000 });
  assert.equal(r.seconds, 100);
  assert.equal(r.label, '~2 min');
});

// --- expanded batch: drop_column / add_foreign_key / add_not_null_constraint
//     / rename_column / alter_column_type across all three engines ----

test('drop_column: Postgres → caution, metadata (no rewrite, instant)', () => {
  const v = resolveVerdict({ engine: 'postgres', version: '16', operation: 'drop_column', context: ctx() }, rules, quiet);
  assert.equal(v.matchedRuleId, 'pg_drop_column');
  assert.equal(v.severity, 'caution');
  assert.equal(v.rewritesTable, false);
  assert.equal(v.estDurationLabel, 'instant');
});

test('drop_column: MySQL → caution, online INPLACE rebuild', () => {
  const v = resolveVerdict({ engine: 'mysql', version: '8.0', operation: 'drop_column', context: ctx() }, rules, quiet);
  assert.equal(v.matchedRuleId, 'mysql_drop_column');
  assert.equal(v.severity, 'caution');
  assert.equal(v.rewritesTable, true);
  assert.equal(v.blocksWrites, false);
});

test('drop_column: SQL Server → caution, metadata (no rewrite, instant)', () => {
  const v = resolveVerdict({ engine: 'sqlserver', version: '2019', operation: 'drop_column', context: ctx() }, rules, quiet);
  assert.equal(v.matchedRuleId, 'mssql_drop_column');
  assert.equal(v.severity, 'caution');
  assert.equal(v.rewritesTable, false);
  assert.equal(v.estDurationLabel, 'instant');
});

test('add_foreign_key: Postgres → danger, blocks writes not reads, NOT VALID alternative', () => {
  const v = resolveVerdict({ engine: 'postgres', version: '16', operation: 'add_foreign_key', context: ctx() }, rules, quiet);
  assert.equal(v.severity, 'danger');
  assert.equal(v.blocksWrites, true);
  assert.equal(v.blocksReads, false);
  assert.match(v.safeAlternative.title, /NOT VALID/i);
});

test('add_foreign_key: MySQL → danger, COPY rebuild (foreign_key_checks default)', () => {
  const v = resolveVerdict({ engine: 'mysql', version: '8.0', operation: 'add_foreign_key', context: ctx() }, rules, quiet);
  assert.equal(v.matchedRuleId, 'mysql_add_fk');
  assert.equal(v.severity, 'danger');
  assert.equal(v.rewritesTable, true);
});

test('add_foreign_key: SQL Server → danger, blocks reads and writes', () => {
  const v = resolveVerdict({ engine: 'sqlserver', version: '2019', operation: 'add_foreign_key', context: ctx() }, rules, quiet);
  assert.equal(v.matchedRuleId, 'mssql_add_fk');
  assert.equal(v.severity, 'danger');
  assert.equal(v.blocksReads, true);
  assert.match(v.safeAlternative.steps.join(' '), /NOCHECK/i);
});

test('add_not_null_constraint: Postgres → danger, full scan under ACCESS EXCLUSIVE', () => {
  const v = resolveVerdict({ engine: 'postgres', version: '16', operation: 'add_not_null_constraint', context: ctx() }, rules, quiet);
  assert.equal(v.matchedRuleId, 'pg_add_not_null');
  assert.equal(v.severity, 'danger');
  assert.equal(v.blocksReads, true);
  assert.equal(v.lockType, 'ACCESS EXCLUSIVE');
});

test('add_not_null_constraint: MySQL → caution, online INPLACE', () => {
  const v = resolveVerdict({ engine: 'mysql', version: '8.0', operation: 'add_not_null_constraint', context: ctx() }, rules, quiet);
  assert.equal(v.matchedRuleId, 'mysql_add_not_null');
  assert.equal(v.severity, 'caution');
  assert.equal(v.blocksWrites, false);
});

test('add_not_null_constraint: SQL Server → danger, Sch-M scan', () => {
  const v = resolveVerdict({ engine: 'sqlserver', version: '2019', operation: 'add_not_null_constraint', context: ctx() }, rules, quiet);
  assert.equal(v.matchedRuleId, 'mssql_add_not_null');
  assert.equal(v.severity, 'danger');
});

test('rename_column: Postgres → safe, instant metadata', () => {
  const v = resolveVerdict({ engine: 'postgres', version: '16', operation: 'rename_column', context: ctx() }, rules, quiet);
  assert.equal(v.matchedRuleId, 'pg_rename_column');
  assert.equal(v.severity, 'safe');
  assert.equal(v.estDurationLabel, 'instant');
});

test('rename_column: MySQL 8 → safe (metadata-only RENAME COLUMN)', () => {
  const v = resolveVerdict({ engine: 'mysql', version: '8.0', operation: 'rename_column', context: ctx() }, rules, quiet);
  assert.equal(v.matchedRuleId, 'mysql_rename_column_v8');
  assert.equal(v.severity, 'safe');
});

test('rename_column: MySQL 5.7 → caution (CHANGE COLUMN, pure rename is online INPLACE)', () => {
  const v = resolveVerdict({ engine: 'mysql', version: '5.7', operation: 'rename_column', context: ctx() }, rules, quiet);
  assert.equal(v.matchedRuleId, 'mysql_rename_column_pre8');
  assert.equal(v.severity, 'caution');
  assert.equal(v.rewritesTable, false);
  assert.equal(v.blocksWrites, false);
});

test('rename_column: SQL Server → caution (sp_rename breaks dependencies)', () => {
  const v = resolveVerdict({ engine: 'sqlserver', version: '2019', operation: 'rename_column', context: ctx() }, rules, quiet);
  assert.equal(v.matchedRuleId, 'mssql_rename_column');
  assert.equal(v.severity, 'caution');
  assert.equal(v.estDurationLabel, 'instant');
});

test('alter_column_type: Postgres → danger, rewrites table', () => {
  const v = resolveVerdict({ engine: 'postgres', version: '16', operation: 'alter_column_type', context: ctx() }, rules, quiet);
  assert.equal(v.matchedRuleId, 'pg_alter_column_type');
  assert.equal(v.severity, 'danger');
  assert.equal(v.rewritesTable, true);
});

test('alter_column_type: SQL Server → danger, rewrites table', () => {
  const v = resolveVerdict({ engine: 'sqlserver', version: '2019', operation: 'alter_column_type', context: ctx() }, rules, quiet);
  assert.equal(v.matchedRuleId, 'mssql_alter_column_type');
  assert.equal(v.severity, 'danger');
  assert.equal(v.rewritesTable, true);
});

test('alter_column_type: MySQL still resolves (regression on existing rule)', () => {
  const v = resolveVerdict({ engine: 'mysql', version: '8.0', operation: 'alter_column_type', context: ctx() }, rules, quiet);
  assert.equal(v.matchedRuleId, 'mysql_modify_column');
  assert.equal(v.severity, 'danger');
});

// --- final batch: add_column_not_null + create_index_concurrent ------

test('add_column_not_null: Postgres 16 → safe, metadata (constant default)', () => {
  const v = resolveVerdict({ engine: 'postgres', version: '16', operation: 'add_column_not_null', context: ctx() }, rules, quiet);
  assert.equal(v.matchedRuleId, 'pg_add_col_not_null_v11plus');
  assert.equal(v.severity, 'safe');
  assert.equal(v.estDurationLabel, 'instant');
});

test('add_column_not_null: Postgres 10 → danger, rewrites', () => {
  const v = resolveVerdict({ engine: 'postgres', version: '10', operation: 'add_column_not_null', context: ctx() }, rules, quiet);
  assert.equal(v.matchedRuleId, 'pg_add_col_not_null_pre11');
  assert.equal(v.severity, 'danger');
  assert.equal(v.rewritesTable, true);
});

test('add_column_not_null: MySQL 8 → safe, INSTANT', () => {
  const v = resolveVerdict({ engine: 'mysql', version: '8.0', operation: 'add_column_not_null', context: ctx() }, rules, quiet);
  assert.equal(v.matchedRuleId, 'mysql_add_col_not_null_v8');
  assert.equal(v.severity, 'safe');
});

test('add_column_not_null: MySQL 5.7 → caution, INPLACE rebuild', () => {
  const v = resolveVerdict({ engine: 'mysql', version: '5.7', operation: 'add_column_not_null', context: ctx() }, rules, quiet);
  assert.equal(v.matchedRuleId, 'mysql_add_col_not_null_pre8');
  assert.equal(v.severity, 'caution');
  assert.equal(v.rewritesTable, true);
});

test('add_column_not_null: SQL Server enterprise → safe (online metadata add)', () => {
  const v = resolveVerdict({ engine: 'sqlserver', version: '2019', operation: 'add_column_not_null', context: ctx({ edition: 'enterprise' }) }, rules, quiet);
  assert.equal(v.matchedRuleId, 'mssql_add_col_not_null_online_ent');
  assert.equal(v.severity, 'safe');
  assert.equal(v.blocksWrites, false);
});

test('add_column_not_null: SQL Server standard → danger (size-of-data update)', () => {
  const v = resolveVerdict({ engine: 'sqlserver', version: '2019', operation: 'add_column_not_null', context: ctx({ edition: 'standard' }) }, rules, quiet);
  assert.equal(v.matchedRuleId, 'mssql_add_col_not_null');
  assert.equal(v.severity, 'danger');
  assert.equal(v.rewritesTable, true);
});

test('add_column_not_null: SQL Server edition null → danger (falls through)', () => {
  const v = resolveVerdict({ engine: 'sqlserver', version: '2019', operation: 'add_column_not_null', context: ctx({ edition: null }) }, rules, quiet);
  assert.equal(v.matchedRuleId, 'mssql_add_col_not_null');
  assert.equal(v.severity, 'danger');
});

test('create_index_concurrent: Postgres → safe, no read/write block', () => {
  const v = resolveVerdict({ engine: 'postgres', version: '16', operation: 'create_index_concurrent', context: ctx() }, rules, quiet);
  assert.equal(v.matchedRuleId, 'pg_create_index_concurrent');
  assert.equal(v.severity, 'safe');
  assert.equal(v.blocksReads, false);
  assert.equal(v.blocksWrites, false);
});

test('create_index_concurrent: MySQL → safe, online INPLACE', () => {
  const v = resolveVerdict({ engine: 'mysql', version: '8.0', operation: 'create_index_concurrent', context: ctx() }, rules, quiet);
  assert.equal(v.matchedRuleId, 'mysql_create_index_concurrent');
  assert.equal(v.severity, 'safe');
});

test('create_index_concurrent: SQL Server enterprise → caution (ONLINE=ON)', () => {
  const v = resolveVerdict({ engine: 'sqlserver', version: '2019', operation: 'create_index_concurrent', context: ctx({ edition: 'enterprise' }) }, rules, quiet);
  assert.equal(v.matchedRuleId, 'mssql_create_index_concurrent_ent');
  assert.equal(v.severity, 'caution');
});

test('create_index_concurrent: SQL Server standard → caution (ONLINE unavailable; offline NC build allows reads+writes)', () => {
  const v = resolveVerdict({ engine: 'sqlserver', version: '2019', operation: 'create_index_concurrent', context: ctx({ edition: 'standard' }) }, rules, quiet);
  assert.equal(v.matchedRuleId, 'mssql_create_index_concurrent_offline');
  assert.equal(v.severity, 'caution');
  assert.equal(v.blocksWrites, false);
});

// --- new rules: add_column_nullable / add_column_constant_default /
//     add_column_volatile_default / create_index (mysql) ------------------

test('add_column_nullable: Postgres → safe, instant catalog change', () => {
  const v = resolveVerdict({ engine: 'postgres', version: '16', operation: 'add_column_nullable', context: ctx() }, rules, quiet);
  assert.equal(v.matchedRuleId, 'pg_add_col_nullable');
  assert.equal(v.severity, 'safe');
  assert.equal(v.rewritesTable, false);
  assert.equal(v.estDurationLabel, 'instant');
});

test('add_column_nullable: MySQL 5.7 → caution, INPLACE rebuild (no block)', () => {
  const v = resolveVerdict({ engine: 'mysql', version: '5.7', operation: 'add_column_nullable', context: ctx() }, rules, quiet);
  assert.equal(v.matchedRuleId, 'mysql_add_col_nullable_pre8');
  assert.equal(v.severity, 'caution');
  assert.equal(v.rewritesTable, true);
  assert.equal(v.blocksWrites, false);
});

test('create_index: MySQL → safe, already runs INPLACE LOCK=NONE', () => {
  const v = resolveVerdict({ engine: 'mysql', version: '8.0', operation: 'create_index', context: ctx() }, rules, quiet);
  assert.equal(v.matchedRuleId, 'mysql_create_index');
  assert.equal(v.severity, 'safe');
  assert.equal(v.blocksReads, false);
  assert.equal(v.blocksWrites, false);
});

test('add_column_constant_default: MySQL 8 → safe, INSTANT', () => {
  const v = resolveVerdict({ engine: 'mysql', version: '8.0', operation: 'add_column_constant_default', context: ctx() }, rules, quiet);
  assert.equal(v.matchedRuleId, 'mysql_add_col_const_default_v8');
  assert.equal(v.severity, 'safe');
  assert.equal(v.estDurationLabel, 'instant');
});

test('add_column_constant_default: MySQL 5.7 → caution, INPLACE rebuild', () => {
  const v = resolveVerdict({ engine: 'mysql', version: '5.7', operation: 'add_column_constant_default', context: ctx() }, rules, quiet);
  assert.equal(v.matchedRuleId, 'mysql_add_col_const_default_pre8');
  assert.equal(v.severity, 'caution');
  assert.equal(v.rewritesTable, true);
});

test('add_column_volatile_default: MySQL → caution, INPLACE (no row-value write, unlike Postgres)', () => {
  const v = resolveVerdict({ engine: 'mysql', version: '8.0', operation: 'add_column_volatile_default', context: ctx() }, rules, quiet);
  assert.equal(v.matchedRuleId, 'mysql_add_col_volatile_default');
  assert.equal(v.severity, 'caution');
  assert.equal(v.blocksWrites, false);
  assert.equal(v.rewritesTable, true);
});

test('add_column_constant_default: SQL Server → safe, metadata-only (existing rows get NULL)', () => {
  const v = resolveVerdict({ engine: 'sqlserver', version: '2019', operation: 'add_column_constant_default', context: ctx() }, rules, quiet);
  assert.equal(v.matchedRuleId, 'mssql_add_col_const_default');
  assert.equal(v.severity, 'safe');
  assert.equal(v.rewritesTable, false);
  assert.equal(v.estDurationLabel, 'instant');
});

test('add_column_volatile_default: SQL Server → safe, metadata-only (existing rows get NULL)', () => {
  const v = resolveVerdict({ engine: 'sqlserver', version: '2019', operation: 'add_column_volatile_default', context: ctx() }, rules, quiet);
  assert.equal(v.matchedRuleId, 'mssql_add_col_volatile_default');
  assert.equal(v.severity, 'safe');
  assert.equal(v.rewritesTable, false);
});

test('no accidental rule collisions across the whole knowledge base', () => {
  // Resolve every engine/version/operation the UI can produce; fail if any
  // real lookup triggers the collision warning (two equally-specific rules).
  const engines = { postgres: ['16', '10', '9.6'], mysql: ['8.0', '5.7'], sqlserver: ['2019'] };
  const ops = ['add_column_constant_default', 'add_column_volatile_default', 'add_column_nullable', 'add_column_not_null', 'create_index', 'create_index_concurrent', 'drop_column', 'add_foreign_key', 'add_not_null_constraint', 'rename_column', 'alter_column_type'];
  const editions = [null, 'standard', 'enterprise'];
  const collisions = [];
  for (const [eng, versions] of Object.entries(engines)) {
    for (const ver of versions) {
      for (const op of ops) {
        for (const ed of editions) {
          resolveVerdict({ engine: eng, version: ver, operation: op, context: ctx({ edition: ed }) }, rules,
            { onCollision: (msg, ids) => collisions.push(`${eng} ${ver} ${op} ed=${ed}: ${ids.join(',')}`) });
        }
      }
    }
  }
  assert.deepEqual(collisions, [], 'unexpected rule collisions:\n' + collisions.join('\n'));
});

test('collision hook fires when two equally-specific rules match', () => {
  // Two generic (unbounded, no-edition) rules for the same engine/operation.
  const colliding = {
    rules: [
      { id: 'dup_a', engine: 'postgres', operation: 'drop_column', verdict: { severity: 'caution', lockType: 'x', blocksReads: false, blocksWrites: false, rewritesTable: false, estDurationModel: 'instant' } },
      { id: 'dup_b', engine: 'postgres', operation: 'drop_column', verdict: { severity: 'danger', lockType: 'y', blocksReads: true, blocksWrites: true, rewritesTable: false, estDurationModel: 'instant' } },
    ],
  };
  let captured = null;
  const v = resolveVerdict(
    { engine: 'postgres', version: '16', operation: 'drop_column', context: ctx() },
    colliding,
    { onCollision: (msg, ids) => { captured = ids; } },
  );
  assert.deepEqual(captured, ['dup_a', 'dup_b']);
  assert.equal(v.matchedRuleId, 'dup_b'); // later-defined wins
});
