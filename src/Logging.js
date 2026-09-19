/**
 * Logging.js
 * Persistent, script-wide ring buffer of recent log lines, backed by
 * CacheService — Apps Script's own Executions transcript has no API to
 * read itself back at runtime, so this is what powers the /log command
 * (Code.js): every line any part of the bot logs (timing diagnostics from
 * Timing.js, caught errors, Telegram/Gemini failures, …) also lands here,
 * so it can be read straight from Telegram without opening the editor.
 *
 * Best-effort by design: a CacheService read-modify-write here is not
 * atomic across two truly concurrent executions, so under a genuine race a
 * line could occasionally be lost. That's an acceptable trade-off for a
 * diagnostics feature — losing an occasional log line is harmless, unlike
 * the per-chat conversation state in State.js, which does need the
 * dedicated lock added in v1.7.2.
 */

const LOG_CACHE_KEY_       = 'app_log_v1';
const LOG_MAX_ENTRIES_     = 200;   // ring buffer capacity, kept above the /log max (100) so a burst of logging doesn't push older lines out before they can be read
const LOG_TTL_SECONDS_     = 21600; // 6h — the CacheService max; recent-only by design, not a permanent audit log
const LOG_ENTRY_MAX_CHARS_ = 300;   // truncate any single message so one huge error body can't blow the cache value size or flood /log's output

const LOG_COMMAND_DEFAULT_ = 10;
const LOG_COMMAND_MAX_     = 100;

/**
 * Logs an info-level line: still goes to console.log (unchanged behavior —
 * visible in the Executions transcript exactly as before), and also into
 * the persistent ring buffer /log reads from.
 * @param {string} message
 */
function log_(message) {
  console.log(message);
  _appendLogEntry_(String(message));
}

/**
 * Logs an error-level line: console.error AND Logger.log (Logger.log is
 * what reliably surfaces in the Apps Script editor's "Execution log" popup
 * when manually running a function — see Code.js history — worth keeping
 * for error-level lines specifically), plus the persistent ring buffer.
 * @param {string} message
 */
function logError_(message) {
  console.error(message);
  try { Logger.log(message); } catch (e) { /* Logger unavailable in some contexts — never fatal */ }
  _appendLogEntry_('ERROR: ' + String(message));
}

function _appendLogEntry_(message) {
  try {
    const truncated = message.length > LOG_ENTRY_MAX_CHARS_
      ? message.slice(0, LOG_ENTRY_MAX_CHARS_) + '…'
      : message;

    const cache = CacheService.getScriptCache();
    const raw   = cache.get(LOG_CACHE_KEY_);
    let entries = [];
    if (raw) {
      try { entries = JSON.parse(raw); } catch (e) { entries = []; }
    }

    entries.push(_logTimestampPrefix_() + truncated);
    if (entries.length > LOG_MAX_ENTRIES_) entries = entries.slice(entries.length - LOG_MAX_ENTRIES_);

    cache.put(LOG_CACHE_KEY_, JSON.stringify(entries), LOG_TTL_SECONDS_);
  } catch (e) {
    // Logging must never be the reason a real request fails.
  }
}

function _logTimestampPrefix_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'HH:mm:ss') + ' ';
}

/**
 * Returns the last `n` stored log entries, oldest-first (reads top-to-
 * bottom the same way the Executions transcript does).
 * @param {number} n
 * @returns {string[]}
 */
function getRecentLogEntries_(n) {
  try {
    const raw = CacheService.getScriptCache().get(LOG_CACHE_KEY_);
    if (!raw) return [];
    const entries = JSON.parse(raw);
    return entries.slice(Math.max(0, entries.length - n));
  } catch (e) {
    return [];
  }
}

/** Clears the log ring buffer. Not wired to a command — handy from the Apps Script editor's Run button. */
function clearLogEntries_() {
  try { CacheService.getScriptCache().remove(LOG_CACHE_KEY_); } catch (e) { /* ignore */ }
}

/**
 * Handles the /log[ N] command (Code.js): replies with the last N entries
 * from the ring buffer above. N defaults to LOG_COMMAND_DEFAULT_ (10) when
 * omitted or unparseable, and is clamped to [1, LOG_COMMAND_MAX_] (100).
 * Sent as PLAIN text (sendLongPlainMessage, auto-chunked, no parse_mode) —
 * log lines can contain '<', '>', '&' from error messages or raw JSON and
 * must never be interpreted as Telegram HTML.
 *
 * @param {string} chatId
 * @param {string} argText  raw text after "/log", e.g. "" or " 50"
 */
function handleLogCommand_(chatId, argText) {
  const trimmed = (argText || '').trim();
  const parsed  = trimmed ? parseInt(trimmed, 10) : LOG_COMMAND_DEFAULT_;
  const n = (isNaN(parsed) || parsed < 1) ? LOG_COMMAND_DEFAULT_ : Math.min(parsed, LOG_COMMAND_MAX_);

  const entries = getRecentLogEntries_(n);
  if (!entries.length) {
    sendPlainMessage(chatId, 'No log entries yet.');
    return;
  }

  sendLongPlainMessage(
    chatId,
    'Last ' + entries.length + ' log ' + (entries.length === 1 ? 'entry' : 'entries') + ':\n\n' + entries.join('\n')
  );
}
