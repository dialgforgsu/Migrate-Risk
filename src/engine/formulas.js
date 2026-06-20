/**
 * formulas.js — pure duration math for the lock-verdict engine.
 *
 * ZERO React/DOM dependencies. Importable anywhere (browser, Node, tests).
 *
 * These are deliberately ROUGH, order-of-magnitude estimates. Always
 * benchmark on a staging replica before production. The per-second
 * throughput constants are exposed below so they're trivial to tune.
 */

// --- Tunable assumptions (rows processed per second) -----------------
export const REWRITE_ROWS_PER_SEC = 250_000; // full table rewrite
export const INDEX_ROWS_PER_SEC = 500_000;   // index build scan

/**
 * Human-readable duration label, rounded aggressively.
 *   < 1s   → "instant"
 *   < 60s  → "~Ns"
 *   < 60m  → "~N min"
 *   else   → "~N hr"
 *
 * @param {number|null} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  if (seconds == null || !isFinite(seconds) || seconds < 1) return 'instant';
  if (seconds < 60) return `~${Math.round(seconds)}s`;
  if (seconds < 3600) return `~${Math.round(seconds / 60)} min`;
  return `~${Math.round(seconds / 3600)} hr`;
}

/**
 * Estimate duration for a given model + context.
 * Keyed on the rule's `estDurationModel`.
 *
 * @param {"instant"|"rewrite"|"index_build"|string} model
 * @param {{ tableSizeRows?: number }} [context]
 * @returns {{ seconds: number|null, label: string }}
 */
export function estimateDuration(model, context = {}) {
  const rows = Number(context.tableSizeRows) || 0;

  switch (model) {
    case 'instant':
      return { seconds: null, label: 'instant' };

    case 'rewrite': {
      const seconds = rows / REWRITE_ROWS_PER_SEC;
      return { seconds, label: formatDuration(seconds) };
    }

    case 'index_build': {
      const seconds = rows / INDEX_ROWS_PER_SEC;
      return { seconds, label: formatDuration(seconds) };
    }

    default:
      // Unknown model — don't pretend to know a duration.
      return { seconds: null, label: 'unknown' };
  }
}
