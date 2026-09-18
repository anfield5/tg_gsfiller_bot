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
