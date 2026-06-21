/**
 * lookup.js — pure lock-verdict resolver.
 *
 * resolveVerdict(input, rules) takes (engine, version, operation, context)
 * plus the rules knowledge base, and returns a fully-resolved verdict.
 *
 * ZERO React/DOM dependencies. No I/O. Deterministic. Importable anywhere.
 * The caller supplies `rules` (parsed rules.json) so this stays pure and
 * trivially testable.
 */

import { estimateDuration } from './formulas.js';

/**
 * Parse a major version to a number for comparison.
 * "8.0" → 8, "2019" → 2019, "16" → 16, "11" → 11.
 * Returns NaN when no version is given (NaN fails every bound check,
 * so version-bounded rules simply won't match).
 */
export function parseVersion(version) {
  if (version == null || version === '') return NaN;
  return Math.floor(parseFloat(String(version)));
}

function hasVersionBound(rule) {
  return rule.versionMin != null || rule.versionMax != null;
}

function versionMatches(rule, versionNum) {
  const minOk = rule.versionMin == null || versionNum >= rule.versionMin;
  const maxOk = rule.versionMax == null || versionNum <= rule.versionMax;
  return minOk && maxOk;
}

function editionMatches(rule, edition) {
  // Rules without editionRequired always match on edition.
  if (rule.editionRequired == null) return true;
  return edition === rule.editionRequired;
}

/**
 * Specificity score — higher wins.
 *   +2 if the rule is edition-specific (and matched)
 *   +1 if the rule is version-bounded
 * So: edition-specific > version-bounded > generic.
 */
function specificity(rule) {
  return (rule.editionRequired != null ? 2 : 0) + (hasVersionBound(rule) ? 1 : 0);
}

function fallbackVerdict() {
  return {
    severity: 'caution',
    lockType: 'unknown',
    blocksReads: false,
    blocksWrites: false,
    rewritesTable: false,
    estDurationSeconds: null,
    estDurationLabel: 'unknown',
    explanation: 'No specific rule for this operation/version yet — verify manually.',
    safeAlternative: null,
    caveats: ['This engine/version/operation combination is not yet in the rules knowledge base.'],
    citations: [],
    matchedRuleId: null,
  };
}

/**
 * Resolve a verdict for a migration operation.
 *
 * @param {{
 *   engine: string,
 *   version: string|number,
 *   operation: string,
 *   context?: { tableSizeRows?: number, writesPerSec?: number, edition?: string|null, onlineFlag?: boolean|null }
 * }} input
 * @param {{ rules: Array }|Array} rules - parsed rules.json (object with .rules, or a bare array)
 * @param {{ onCollision?: (msg: string, ids: string[]) => void }} [opts]
 * @returns {object} fully-resolved verdict (see fallbackVerdict for shape)
 */
export function resolveVerdict(input, rules, opts = {}) {
  const { engine, version, operation, context = {} } = input || {};
  const ruleArray = Array.isArray(rules) ? rules : (rules && rules.rules) || [];
  const versionNum = parseVersion(version);
  const onCollision =
    opts.onCollision ||
    ((msg, ids) => console.warn(`[resolveVerdict] ${msg} (rules: ${ids.join(', ')})`));

  // 1. engine + operation, 2. version bounds, 3. edition — carry original index.
  const matches = ruleArray
    .map((rule, idx) => ({ rule, idx }))
    .filter(
      ({ rule }) =>
        rule.engine === engine &&
        rule.operation === operation &&
        versionMatches(rule, versionNum) &&
        editionMatches(rule, context.edition),
    );

  if (matches.length === 0) return fallbackVerdict();

  // 4. Specificity ranking. Highest score wins; ties → later-defined wins + warn.
  const maxScore = Math.max(...matches.map(({ rule }) => specificity(rule)));
  const top = matches.filter(({ rule }) => specificity(rule) === maxScore);

  if (top.length > 1) {
    onCollision(
      `Rule collision for ${engine}/${operation} v${version} edition=${context.edition ?? 'null'} — using last defined`,
      top.map(({ rule }) => rule.id),
    );
  }

  const winner = top.reduce((a, b) => (b.idx > a.idx ? b : a)).rule;

  // 5. Fill in duration from the model + context.
  const v = winner.verdict;
  const { seconds, label } = estimateDuration(v.estDurationModel, context);

  return {
    severity: v.severity,
    lockType: v.lockType,
    blocksReads: v.blocksReads,
    blocksWrites: v.blocksWrites,
    rewritesTable: v.rewritesTable,
    estDurationSeconds: seconds,
    estDurationLabel: label,
    explanation: v.explanation,
    safeAlternative: v.safeAlternative ?? null,
    caveats: v.caveats ?? [],
    citations: v.citations ?? [],
    matchedRuleId: winner.id,
  };
}
