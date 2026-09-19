'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createProject } = require('./harness');

/**
 * _timed_ (Timing.js) is the always-on instrumentation wrapped around the
 * calls that actually cause the occasional 10-40+ second replies (DriveApp,
 * SpreadsheetApp.openById, LockService.waitLock, Telegram/Gemini
 * UrlFetchApp) — see its file header. Tests inject a fake Date.now() (two
 * values: the "start" and "end" timestamps _timed_ reads) rather than
 * actually sleeping, so elapsed time is deterministic and tests stay fast.
 */
function setupWithFakeClock(times) {
  const { context } = createProject({ files: ['Logging.js', 'Timing.js'] });
  const logs = [];
  context.console = { log: (msg) => logs.push(msg), error: () => {} };
  let i = 0;
  // Only stub the static Date.now() that _timed_ actually calls — replacing
  // the whole `Date` binding with a plain object would break `new Date()`
  // (not constructible), which log_()'s ring buffer (Logging.js) uses for
  // its timestamp prefix.
  context.Date.now = () => times[i++];
  return { context, logs };
}

test('_timed_ returns the wrapped function\'s return value unchanged', () => {
  const { context } = setupWithFakeClock([1000, 1050]);
  const obj = { a: 1 };
  assert.equal(context._timed_('noop', () => obj), obj);
});

test('_timed_ logs "[timing] <label>: <ms>ms" once elapsed time is >= the threshold', () => {
  const { context, logs } = setupWithFakeClock([1000, 1300]); // 300ms elapsed
  const result = context._timed_('SpreadsheetApp.openById:file1', () => 42);
  assert.equal(result, 42);
  assert.deepEqual(logs, ['[timing] SpreadsheetApp.openById:file1: 300ms']);
});

test('_timed_ stays silent for calls under the threshold (cache hits, in-memory work)', () => {
  const { context, logs } = setupWithFakeClock([1000, 1050]); // 50ms elapsed
  context._timed_('fast-op', () => 'x');
  assert.deepEqual(logs, []);
});

test('_timed_ logs right at the threshold boundary (>=, not >)', () => {
  const { context, logs } = setupWithFakeClock([1000, 1200]); // exactly 200ms
  context._timed_('boundary-op', () => null);
  assert.deepEqual(logs, ['[timing] boundary-op: 200ms']);
});

test('_timed_ still logs elapsed time and rethrows when the wrapped function throws', () => {
  const { context, logs } = setupWithFakeClock([1000, 1500]); // 500ms elapsed
  assert.throws(
    () => context._timed_('Gemini:gemini-3.6-flash', () => { throw new Error('boom'); }),
    /boom/
  );
  // A call that failed slowly is exactly the case worth seeing — timing
  // must be logged even though the call never returned normally.
  assert.deepEqual(logs, ['[timing] Gemini:gemini-3.6-flash: 500ms']);
});
