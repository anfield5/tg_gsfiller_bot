'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createProject } = require('./harness');

function setup() {
  return createProject({ files: ['Icons.js', 'TelegramApi.js'] });
}

function lastCall(urlFetch) {
  return urlFetch.calls[urlFetch.calls.length - 1];
}

// ---------------------------------------------------------------------------
// Message senders — payload shape
// ---------------------------------------------------------------------------

test('sendMessage sends HTML-mode text with no keyboard change', () => {
  const { context, urlFetch } = setup();
  context.sendMessage('111', 'hello <b>world</b>');
  const { url, body } = lastCall(urlFetch);
  assert.match(url, /\/sendMessage$/);
  assert.deepEqual(body, { chat_id: '111', text: 'hello <b>world</b>', parse_mode: 'HTML' });
});

test('sendMessageWithKeyboard builds a reply keyboard from a 2D label array', () => {
  const { context, urlFetch } = setup();
  context.sendMessageWithKeyboard('111', 'pick one', [['A', 'B'], ['C']]);
  const { body } = lastCall(urlFetch);
  assert.equal(body.parse_mode, 'HTML');
  assert.deepEqual(body.reply_markup.keyboard, [[{ text: 'A' }, { text: 'B' }], [{ text: 'C' }]]);
  assert.equal(body.reply_markup.resize_keyboard, true);
  assert.equal(body.reply_markup.one_time_keyboard, false);
});

test('sendMessageNoKeyboard removes the reply keyboard', () => {
  const { context, urlFetch } = setup();
  context.sendMessageNoKeyboard('111', 'typing time');
  const { body } = lastCall(urlFetch);
  assert.deepEqual(body.reply_markup, { remove_keyboard: true });
});

test('sendPlainMessage omits parse_mode entirely (untrusted/model-generated text)', () => {
  const { context, urlFetch } = setup();
  context.sendPlainMessage('111', '<not-really-html> & raw text');
  const { body } = lastCall(urlFetch);
  assert.equal(body.text, '<not-really-html> & raw text');
  assert.equal('parse_mode' in body, false);
  assert.equal('reply_markup' in body, false);
});

// ---------------------------------------------------------------------------
// sendLongPlainMessage — chunking logic
// ---------------------------------------------------------------------------

test('sendLongPlainMessage sends short text as a single message', () => {
  const { context, urlFetch } = setup();
  context.sendLongPlainMessage('111', 'just one short line');
  assert.equal(urlFetch.calls.length, 1);
  assert.equal(lastCall(urlFetch).body.text, 'just one short line');
});

test('sendLongPlainMessage splits on line breaks once a chunk would exceed the limit', () => {
  const { context, urlFetch } = setup();
  const lineA = 'A'.repeat(30);
  const lineB = 'B'.repeat(30);
  context.sendLongPlainMessage('111', lineA + '\n' + lineB, 40);

  const texts = urlFetch.calls.map((c) => c.body.text);
  assert.equal(texts.length, 2, 'each line exceeds the combined-but-not-individual limit, so they split into separate messages');
  assert.equal(texts[0], lineA);
  assert.equal(texts[1], lineB);
});

test('sendLongPlainMessage keeps lines together under the limit instead of splitting eagerly', () => {
  const { context, urlFetch } = setup();
  context.sendLongPlainMessage('111', 'short one\nshort two', 100);
  assert.equal(urlFetch.calls.length, 1);
  assert.equal(lastCall(urlFetch).body.text, 'short one\nshort two');
});

test('sendLongPlainMessage hard-splits a single line longer than the limit on its own', () => {
  const { context, urlFetch } = setup();
  const longLine = 'x'.repeat(95);
  context.sendLongPlainMessage('111', longLine, 40);

  const texts = urlFetch.calls.map((c) => c.body.text);
  texts.forEach((t) => assert.ok(t.length <= 40, 'no chunk should exceed the configured limit'));
  assert.equal(texts.join(''), longLine, 'concatenating all chunks must reproduce the original text exactly');
});

// ---------------------------------------------------------------------------
// Webhook management
// ---------------------------------------------------------------------------

test('setWebhook registers the URL with no secret_token by default', () => {
  const { context, urlFetch } = setup();
  context.setWebhook('https://relay.example.workers.dev');
  const { url, body } = lastCall(urlFetch);
  assert.match(url, /\/setWebhook$/);
  assert.deepEqual(body, { url: 'https://relay.example.workers.dev' });
});

test('setWebhook includes secret_token when provided (matches cloudflare-relay ENABLE_SECRET_CHECK)', () => {
  const { context, urlFetch } = setup();
  context.setWebhook('https://relay.example.workers.dev', 'super-secret');
  const { body } = lastCall(urlFetch);
  assert.deepEqual(body, { url: 'https://relay.example.workers.dev', secret_token: 'super-secret' });
});

test('deleteWebhook and getWebhookInfo call the matching Telegram methods', () => {
  const { context, urlFetch } = setup();
  context.deleteWebhook();
  assert.match(lastCall(urlFetch).url, /\/deleteWebhook$/);

  context.getWebhookInfo();
  assert.match(lastCall(urlFetch).url, /\/getWebhookInfo$/);
});

// ---------------------------------------------------------------------------
// _callTelegram_ — never throws on a failed send
// ---------------------------------------------------------------------------

test('_callTelegram_ does not throw on a non-2xx Telegram response (a single failed send must not crash the webhook)', () => {
  const { context, urlFetch } = setup();
  context.UrlFetchApp = {
    fetch(url, options) {
      urlFetch.calls.push({ url, options, body: JSON.parse(options.payload) });
      return { getResponseCode: () => 503, getContentText: () => 'Service Unavailable' };
    },
  };

  assert.doesNotThrow(() => context.sendMessage('111', 'hi'));
  const response = context.sendMessage('111', 'hi again');
  assert.equal(response.getResponseCode(), 503);
});
