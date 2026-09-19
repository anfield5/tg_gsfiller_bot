'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createProject } = require('./harness');

function setup(initialProperties) {
  return createProject({
    CONFIG: { FOLDER_IDS: [], FOLDER_LABELS: [], FILES_PER_PAGE: 10, FOLDER_CACHE_TTL_SECONDS: 300, FOLDER_SCAN_DEPTH: 1 },
    initialProperties: initialProperties || { ADMIN_IDS: '111' },
  });
}

function message(chatId, text) {
  return { chat: { id: chatId }, text };
}

function lastCallText(urlFetch) {
  return urlFetch.calls[urlFetch.calls.length - 1].body.text;
}

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

test('handleMessage denies chats not listed in ADMIN_IDS', () => {
  const { context, urlFetch } = setup({ ADMIN_IDS: '111' });
  context.handleMessage(message('999', '/start'));
  assert.match(lastCallText(urlFetch), /Access denied/);
});

test('handleMessage allows any chat id present in the comma-separated ADMIN_IDS list', () => {
  const { context, urlFetch } = setup({ ADMIN_IDS: '111, 222 ,333' });
  context.handleMessage(message('222', '/start'));
  assert.doesNotMatch(lastCallText(urlFetch), /Access denied/);
});

// ---------------------------------------------------------------------------
// Global commands
// ---------------------------------------------------------------------------

test('/start clears state and shows the main menu', () => {
  const { context, urlFetch } = setup();
  context.setState('111', { step: 'add_filling', currentFieldIndex: 3 });
  context.handleMessage(message('111', '/start'));
  assert.equal(context.getState('111').step, 'main_menu');
  assert.match(lastCallText(urlFetch), /No folders configured|Choose a folder/);
});

test('/cancel clears state and returns to the main menu', () => {
  const { context, urlFetch } = setup();
  context.setState('111', { step: 'gemini_wait_prompt' });
  context.handleMessage(message('111', '/cancel'));
  assert.equal(context.getState('111').step, 'main_menu');
  assert.match(lastCallText(urlFetch), /Choose a folder|No folders configured/);
});

test('/version replies with BOT_VERSION and does not touch conversation state', () => {
  const { context, urlFetch } = setup();
  context.setState('111', { step: 'add_filling', currentFieldIndex: 2, formData: { A: 'x' } });
  context.handleMessage(message('111', '/version'));

  const { body } = urlFetch.calls[urlFetch.calls.length - 1];
  assert.match(body.text, /Bot version:.*\d+\.\d+\.\d+/);
  assert.equal(body.parse_mode, 'HTML', '/version reply is a normal sendMessage, HTML-escaped like everything else');

  // Unlike /start and /cancel, /version is a pure info command — the flow
  // the user was in the middle of must still be there afterwards.
  const state = context.getState('111');
  assert.equal(state.step, 'add_filling');
  assert.equal(state.currentFieldIndex, 2);
});

test('/version is not swallowed by the free-text field-input handler while mid-flow', () => {
  // Global commands are checked before any step-specific text branch in
  // handleMessage, so typing /version while filling a row must still be
  // treated as the command, not saved as the field's value.
  const { context, urlFetch } = setup();
  context.setState('111', { step: 'add_filling', headers: ['A', 'B'], currentFieldIndex: 0, formData: {} });
  context.handleMessage(message('111', '/version'));

  const { body } = urlFetch.calls[urlFetch.calls.length - 1];
  assert.match(body.text, /Bot version/);
  assert.deepEqual(context.getState('111').formData, {}, '/version text must not have been stored as field A\'s value');
});

// ---------------------------------------------------------------------------
// /help
// ---------------------------------------------------------------------------

test('/help lists every command with a description and an example invocation', () => {
  const { context, urlFetch } = setup();
  context.handleMessage(message('111', '/help'));

  const text = lastCallText(urlFetch);
  ['/start', '/cancel', '/version', '/log', '/help'].forEach((cmd) => {
    assert.match(text, new RegExp(cmd.replace('/', '\\/')), cmd + ' must be listed in /help');
  });
  // At least one concrete example invocation, e.g. `/log 20`, must be present
  // — a bare command list without usage examples doesn't satisfy "example
  // invocation" for a command that takes an argument.
  assert.match(text, /<code>\/log 20<\/code>/);
});

test('/help does not touch conversation state (pure read-only diagnostic, like /version and /log)', () => {
  const { context, urlFetch } = setup();
  context.setState('111', { step: 'add_filling', currentFieldIndex: 2, formData: { A: 'x' } });
  context.handleMessage(message('111', '/help'));

  assert.match(lastCallText(urlFetch), /Available commands/);
  const state = context.getState('111');
  assert.equal(state.step, 'add_filling');
  assert.equal(state.currentFieldIndex, 2);
});

test('/help bypasses the lock check but does not clear a genuine in-flight lock', () => {
  const { context, cache, urlFetch } = setup();
  context.tryAcquireChatLock_('111', '⭐ TNNS_STATS');
  context.handleMessage(message('111', '/help'));

  assert.doesNotMatch(lastCallText(urlFetch), /still in progress/, '/help must answer even while another update is locked');
  assert.equal(cache.get('inflight:111'), '⭐ TNNS_STATS', 'the original lock must survive — /help never touches it');
});

test('/help is not swallowed by the free-text field-input handler while mid-flow', () => {
  const { context, urlFetch } = setup();
  context.setState('111', { step: 'add_filling', headers: ['A', 'B'], currentFieldIndex: 0, formData: {} });
  context.handleMessage(message('111', '/help'));

  assert.match(lastCallText(urlFetch), /Available commands/);
  assert.deepEqual(context.getState('111').formData, {}, '/help text must not have been stored as field A\'s value');
});

// ---------------------------------------------------------------------------
// /log — wiring through handleMessage (parsing/clamping itself is covered
// directly against handleLogCommand_ in logging.test.js; these tests only
// need to prove handleMessage recognises the command and, like /version,
// treats it as a bypass-the-lock, don't-touch-state diagnostic).
// ---------------------------------------------------------------------------

test('/log with no argument replies with the default last-10 entries', () => {
  const { context, urlFetch } = setup();
  for (let i = 0; i < 15; i++) context.log_('line' + i);
  context.handleMessage(message('111', '/log'));
  assert.match(lastCallText(urlFetch), /^Last 10 log entries:/);
});

test('/log N replies with the last N entries', () => {
  const { context, urlFetch } = setup();
  for (let i = 0; i < 15; i++) context.log_('line' + i);
  context.handleMessage(message('111', '/log 5'));
  assert.match(lastCallText(urlFetch), /^Last 5 log entries:/);
});

test('/log does not touch conversation state (pure read-only diagnostic, like /version)', () => {
  const { context, urlFetch } = setup();
  context.setState('111', { step: 'add_filling', currentFieldIndex: 2, formData: { A: 'x' } });
  context.handleMessage(message('111', '/log'));

  assert.match(lastCallText(urlFetch), /log entr/);
  const state = context.getState('111');
  assert.equal(state.step, 'add_filling');
  assert.equal(state.currentFieldIndex, 2);
});

test('/log bypasses the lock check but does not clear a genuine in-flight lock', () => {
  const { context, cache, urlFetch } = setup();
  context.tryAcquireChatLock_('111', '⭐ TNNS_STATS');
  context.handleMessage(message('111', '/log'));

  assert.doesNotMatch(lastCallText(urlFetch), /still in progress/, '/log must answer even while another update is locked');
  assert.equal(cache.get('inflight:111'), '⭐ TNNS_STATS', 'the original lock must survive — /log never touches it');
});

test('/log is not swallowed by the free-text field-input handler while mid-flow', () => {
  const { context, urlFetch } = setup();
  context.setState('111', { step: 'add_filling', headers: ['A', 'B'], currentFieldIndex: 0, formData: {} });
  context.handleMessage(message('111', '/log'));

  assert.match(lastCallText(urlFetch), /log entr/);
  assert.deepEqual(context.getState('111').formData, {}, '/log text must not have been stored as field A\'s value');
});

// ---------------------------------------------------------------------------
// Per-chat processing lock
//
// Simulates the race two overlapping updates for the same chat would cause
// (a slow request plus a Telegram retry, or a user double-tapping before
// the keyboard visibly updates) by manually pre-acquiring the lock the way
// a still-running handleMessage() call would have, then sending a second
// update for the same chat on top of it.
// ---------------------------------------------------------------------------

test('a second update for the same chat is rejected with "<label> is still in progress" while the first is locked', () => {
  const { context, cache, urlFetch } = setup();
  context.setState('111', { step: 'main_menu', currentOptions: [{ label: '⭐ TNNS_STATS', value: 'openfavdoc:0' }] });
  context.tryAcquireChatLock_('111', '⬅️ Back'); // simulates an in-flight "Back" still being processed

  context.handleMessage(message('111', '⭐ TNNS_STATS'));

  const { body } = urlFetch.calls[urlFetch.calls.length - 1];
  assert.match(body.text, /⬅️ Back.*still in progress/);
  // The second button press must not have been dispatched at all — state
  // (and specifically currentOptions, the exact thing that mismatches when
  // two updates race) must be untouched.
  assert.deepEqual(context.getState('111').currentOptions, [{ label: '⭐ TNNS_STATS', value: 'openfavdoc:0' }]);
});

test('the lock is released once handleMessage finishes, so the next update processes normally', () => {
  const { context, cache } = setup();
  context.setState('111', { step: 'main_menu', currentOptions: [] });
  context.handleMessage(message('111', 'anything'));
  assert.equal(cache.get('inflight:111'), null, 'lock must not outlive a completed handleMessage call');
});

test('the lock is released even when something inside handleMessage throws unexpectedly', () => {
  const { context, cache } = setup();
  const realGetState = context.getState;
  context.getState = () => { throw new Error('boom'); };
  try {
    assert.throws(() => context.handleMessage(message('111', 'anything')), /boom/);
    assert.equal(cache.get('inflight:111'), null, 'the finally block must release the lock even when the try body throws');
  } finally {
    context.getState = realGetState;
  }
});

test('/start bypasses and clears an existing lock (the explicit escape hatch always works)', () => {
  const { context, cache, urlFetch } = setup();
  context.tryAcquireChatLock_('111', '⭐ TNNS_STATS');
  context.handleMessage(message('111', '/start'));

  assert.equal(context.getState('111').step, 'main_menu');
  assert.doesNotMatch(lastCallText(urlFetch), /still in progress/);
  assert.equal(cache.get('inflight:111'), null, '/start must clear any stuck lock, not just skip it');
});

test('/cancel bypasses and clears an existing lock the same way /start does', () => {
  const { context, cache, urlFetch } = setup();
  context.tryAcquireChatLock_('111', '⭐ TNNS_STATS');
  context.handleMessage(message('111', '/cancel'));

  assert.equal(context.getState('111').step, 'main_menu');
  assert.doesNotMatch(lastCallText(urlFetch), /still in progress/);
  assert.equal(cache.get('inflight:111'), null);
});

test('/version bypasses the lock check but does not clear a genuine in-flight lock', () => {
  const { context, cache, urlFetch } = setup();
  context.tryAcquireChatLock_('111', '⭐ TNNS_STATS');
  context.handleMessage(message('111', '/version'));

  assert.match(lastCallText(urlFetch), /Bot version/, '/version must answer even while another update is locked');
  assert.equal(cache.get('inflight:111'), '⭐ TNNS_STATS', 'the original lock must survive — /version never touches it');
});

test('the lock is per-chat: a locked chat does not block a different chat', () => {
  const { context, urlFetch } = setup({ ADMIN_IDS: '111,222' });
  context.tryAcquireChatLock_('111', '⭐ TNNS_STATS');
  context.setState('222', { step: 'main_menu', currentOptions: [] });

  context.handleMessage(message('222', 'anything'));

  const { body } = urlFetch.calls[urlFetch.calls.length - 1];
  assert.doesNotMatch(body.text, /still in progress/);
});
