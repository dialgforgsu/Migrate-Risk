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

test('Postgres 16 + add_column_constant_default → safe, metadata-only (v11plus rule)', () => {
  const v = resolveVerdict({ engine: 'postgres', version: '16', operation: 'add_column_constant_default', context: ctx() }, rules, quiet);
  assert.equal(v.matchedRuleId, 'pg_add_col_const_v11plus');
  assert.equal(v.severity, 'safe');
  assert.equal(v.lockType, 'metadata-only');
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

test('SQL Server 2019 + create_index + standard → danger (offline; edition rule excluded)', () => {
  const v = resolveVerdict({ engine: 'sqlserver', version: '2019', operation: 'create_index', context: ctx({ edition: 'standard' }) }, rules, quiet);
  assert.equal(v.matchedRuleId, 'mssql_create_index_offline');
  assert.equal(v.severity, 'danger');
  assert.equal(v.blocksWrites, true);
  assert.equal(v.blocksReads, true);
});

test('SQL Server 2019 + create_index + edition null → danger (falls through to offline)', () => {
  const v = resolveVerdict({ engine: 'sqlserver', version: '2019', operation: 'create_index', context: ctx({ edition: null }) }, rules, quiet);
  assert.equal(v.matchedRuleId, 'mssql_create_index_offline');
  assert.equal(v.severity, 'danger');
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
