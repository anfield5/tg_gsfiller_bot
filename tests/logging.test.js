'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createProject } = require('./harness');

/**
 * Logging.js is the persistent CacheService-backed ring buffer that powers
 * /log (Code.js) — Apps Script's own Executions transcript has no read-back
 * API, so this is the only way the bot can report its own recent log lines
 * over Telegram. log_/logError_ are also the routing point every other
 * src/*.js file was switched to this release, so these tests cover the
 * buffer mechanics directly rather than through some other file's call site.
 */
function setup() {
  return createProject({ files: ['Logging.js'] });
}

test('log_ writes to console.log and stores the line in the ring buffer', () => {
  const { context } = setup();
  const logs = [];
  context.console = { log: (m) => logs.push(m), error: () => {} };

  context.log_('hello world');

  assert.deepEqual(logs, ['hello world']);
  const entries = context.getRecentLogEntries_(10);
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^\d{2}:\d{2}:\d{2} hello world$/);
});

test('logError_ writes to console.error, Logger.log, and prefixes the buffered line with ERROR:', () => {
  const { context } = setup();
  const errors = [];
  let loggerCalls = [];
  context.console = { log: () => {}, error: (m) => errors.push(m) };
  context.Logger = { log: (m) => loggerCalls.push(m) };

  context.logError_('something broke');

  assert.deepEqual(errors, ['something broke']);
  assert.deepEqual(loggerCalls, ['something broke']);
  const entries = context.getRecentLogEntries_(10);
  assert.match(entries[0], /ERROR: something broke$/);
});

test('logError_ never throws even if Logger.log itself throws', () => {
  const { context } = setup();
  context.console = { log: () => {}, error: () => {} };
  context.Logger = { log: () => { throw new Error('Logger unavailable'); } };

  assert.doesNotThrow(() => context.logError_('still gets buffered'));
  assert.match(context.getRecentLogEntries_(10)[0], /ERROR: still gets buffered$/);
});

test('getRecentLogEntries_ returns entries oldest-first, limited to the requested count', () => {
  const { context } = setup();
  context.console = { log: () => {}, error: () => {} };
  ['first', 'second', 'third'].forEach((m) => context.log_(m));

  const last2 = context.getRecentLogEntries_(2);
  assert.equal(last2.length, 2);
  assert.match(last2[0], /second$/);
  assert.match(last2[1], /third$/);
});

test('getRecentLogEntries_ returns [] when nothing has been logged yet', () => {
  const { context } = setup();
  assert.deepEqual(context.getRecentLogEntries_(10), []);
});

test('the ring buffer is capped at LOG_MAX_ENTRIES_ (200), dropping the oldest lines first', () => {
  const { context } = setup();
  context.console = { log: () => {}, error: () => {} };
  for (let i = 0; i < 205; i++) context.log_('entry-' + i);

  const all = context.getRecentLogEntries_(1000); // ask for more than the cap
  assert.equal(all.length, 200, 'buffer must not grow past its 200-entry capacity');
  assert.match(all[0], /entry-5$/, 'the 5 oldest entries (0-4) should have been evicted');
  assert.match(all[all.length - 1], /entry-204$/);
});

test('a single log line longer than LOG_ENTRY_MAX_CHARS_ (300) is truncated with an ellipsis', () => {
  const { context } = setup();
  context.console = { log: () => {}, error: () => {} };
  context.log_('x'.repeat(500));

  const entry = context.getRecentLogEntries_(1)[0];
  // Strip the "HH:mm:ss " timestamp prefix before measuring the payload.
  const payload = entry.replace(/^\d{2}:\d{2}:\d{2} /, '');
  assert.equal(payload.length, 301, '300 chars + the appended ellipsis character');
  assert.ok(payload.endsWith('…'));
});

test('clearLogEntries_ empties the buffer', () => {
  const { context } = setup();
  context.console = { log: () => {}, error: () => {} };
  context.log_('one');
  assert.equal(context.getRecentLogEntries_(10).length, 1);

  context.clearLogEntries_();
  assert.deepEqual(context.getRecentLogEntries_(10), []);
});

test('logging never throws even if CacheService is broken (a diagnostics failure must not break the request)', () => {
  const { context } = setup();
  context.console = { log: () => {}, error: () => {} };
  context.CacheService = {
    getScriptCache() {
      return {
        get() { throw new Error('cache down'); },
        put() { throw new Error('cache down'); },
        remove() { throw new Error('cache down'); },
      };
    },
  };

  assert.doesNotThrow(() => context.log_('should not throw'));
  assert.doesNotThrow(() => context.getRecentLogEntries_(10));
  assert.doesNotThrow(() => context.clearLogEntries_());
});

// ---------------------------------------------------------------------------
// handleLogCommand_ — argument parsing/clamping (the /log[ N] command body)
// ---------------------------------------------------------------------------

function setupWithTelegram() {
  const { context, urlFetch } = createProject({ files: ['Logging.js', 'Timing.js', 'Icons.js', 'TelegramApi.js'] });
  context.console = { log: () => {}, error: () => {} };
  return { context, urlFetch };
}

function lastMessageText(urlFetch) {
  return urlFetch.calls[urlFetch.calls.length - 1].body.text;
}

test('handleLogCommand_ with no argument defaults to the last 10 entries', () => {
  const { context, urlFetch } = setupWithTelegram();
  for (let i = 0; i < 15; i++) context.log_('line' + i);

  context.handleLogCommand_('111', '');

  const text = lastMessageText(urlFetch);
  assert.match(text, /^Last 10 log entries:/);
  assert.doesNotMatch(text, /line4\b/, 'line4 is the 11th-oldest of 15 and should have been dropped by the 10-entry default');
  assert.match(text, /line14$/);
});

test('handleLogCommand_ "50" returns the last 50 entries', () => {
  const { context, urlFetch } = setupWithTelegram();
  for (let i = 0; i < 60; i++) context.log_('line' + i);

  context.handleLogCommand_('111', ' 50');

  assert.match(lastMessageText(urlFetch), /^Last 50 log entries:/);
});

test('handleLogCommand_ clamps anything above 100 down to the max of 100', () => {
  const { context, urlFetch } = setupWithTelegram();
  for (let i = 0; i < 150; i++) context.log_('line' + i);

  context.handleLogCommand_('111', '500');

  assert.match(lastMessageText(urlFetch), /^Last 100 log entries:/);
});

test('handleLogCommand_ falls back to the default (10) on non-numeric input instead of erroring', () => {
  const { context, urlFetch } = setupWithTelegram();
  for (let i = 0; i < 15; i++) context.log_('line' + i);

  assert.doesNotThrow(() => context.handleLogCommand_('111', 'abc'));
  assert.match(lastMessageText(urlFetch), /^Last 10 log entries:/);
});

test('handleLogCommand_ falls back to the default on 0 or negative input', () => {
  const { context, urlFetch } = setupWithTelegram();
  for (let i = 0; i < 15; i++) context.log_('line' + i);

  context.handleLogCommand_('111', '0');
  assert.match(lastMessageText(urlFetch), /^Last 10 log entries:/);

  context.handleLogCommand_('111', '-5');
  assert.match(lastMessageText(urlFetch), /^Last 10 log entries:/);
});

test('handleLogCommand_ reports "No log entries yet." (singular-safe, no crash) when the buffer is empty', () => {
  const { context, urlFetch } = setupWithTelegram();
  context.handleLogCommand_('111', '');
  assert.equal(lastMessageText(urlFetch), 'No log entries yet.');
});

test('handleLogCommand_ uses singular "entry" wording for exactly 1 result', () => {
  const { context, urlFetch } = setupWithTelegram();
  context.log_('only one');
  context.handleLogCommand_('111', '1');
  assert.match(lastMessageText(urlFetch), /^Last 1 log entry:/);
});

test('handleLogCommand_ sends plain text, not HTML — log lines can contain raw < > & from error bodies', () => {
  const { context, urlFetch } = setupWithTelegram();
  context.log_('<script>&amp;</script>');
  context.handleLogCommand_('111', '');

  const { body } = urlFetch.calls[urlFetch.calls.length - 1];
  assert.match(body.text, /<script>&amp;<\/script>/, 'content must be sent raw, unescaped');
  assert.equal(body.parse_mode, undefined, 'must not set parse_mode:HTML, or Telegram would choke on the raw tags above');
});
