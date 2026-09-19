/**
 * Timing.js
 * Lightweight, always-on instrumentation for the handful of calls that
 * actually cause the occasional 10-40+ second replies users see: DriveApp,
 * SpreadsheetApp (via DataAccess.js's _getSheet_), LockService, and
 * outbound HTTP to Telegram/Gemini. Every wrapped call logs its own
 * duration via console.log, so a slow request is diagnosable straight from
 * the Apps Script Executions log (Execution transcript / Cloud Logging) —
 * no need to reproduce it live or guess which layer was slow.
 *
 * Deliberately NOT gated behind a debug flag — this project's own history
 * (see README/commit log around the folder-name debug output) is that
 * always-on, low-noise diagnostics are worth the tiny log volume: the whole
 * point is that it's already there the next time something is slow,
 * instead of needing a redeploy to add instrumentation after the fact.
 *
 * Logs via log_() (Logging.js), not a bare console.log — that's what makes
 * every [timing] line also readable from Telegram via /log, not just from
 * the Apps Script Executions transcript.
 */

// Calls faster than this are noise (cache hits, in-memory work) — only log
// the ones that could plausibly explain "why did this take so long".
const TIMING_LOG_THRESHOLD_MS_ = 200;

/**
 * Runs `fn`, logs how long it took under `label` if it was slow enough to
 * matter, and returns fn's result — or rethrows its error, but only AFTER
 * logging the elapsed time, since a call that failed slowly is exactly the
 * case worth seeing.
 *
 * @param {string} label   short, greppable identifier, e.g. "SpreadsheetApp.openById:<fileId>"
 * @param {Function} fn    zero-arg function to time
 * @returns {*}
 */
function _timed_(label, fn) {
  const start = Date.now();
  try {
    return fn();
  } finally {
    const ms = Date.now() - start;
    if (ms >= TIMING_LOG_THRESHOLD_MS_) log_('[timing] ' + label + ': ' + ms + 'ms');
  }
}
