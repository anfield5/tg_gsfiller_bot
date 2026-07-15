/**
 * TelegramApi.js
 * Thin wrappers around the Telegram Bot HTTP API.
 * All outbound calls go through _callTelegram_ so error handling is centralised.
 */

function _apiUrl_(method) {
  return 'https://api.telegram.org/bot' + getBotToken_() + '/' + method;
}

/**
 * Makes a POST request to the Telegram Bot API.
 * Logs non-2xx responses but does not throw, so a single failed send does
 * not crash an entire webhook execution.
 *
 * @param {string} method   Telegram API method name
 * @param {Object} payload  Request body (will be JSON-serialised)
 * @returns {GoogleAppsScript.URL_Fetch.HTTPResponse}
 */
function _callTelegram_(method, payload) {
  const options = {
    method:            'post',
    contentType:       'application/json',
    payload:           JSON.stringify(payload),
    muteHttpExceptions: true,
  };
  const response = UrlFetchApp.fetch(_apiUrl_(method), options);
  const code     = response.getResponseCode();
  if (code < 200 || code >= 300) {
    console.error('Telegram API error [' + method + ']: ' + code + ' ' + response.getContentText());
  }
  return response;
}

// ---------------------------------------------------------------------------
// Message senders
// ---------------------------------------------------------------------------

/**
 * Sends a plain HTML message WITHOUT changing the reply keyboard.
 * Telegram leaves whatever keyboard is currently displayed in place.
 * Use for data displays (previews, row contents, confirmations).
 *
 * @param {string|number} chatId
 * @param {string}        text    HTML-formatted content
 */
function sendMessage(chatId, text) {
  return _callTelegram_('sendMessage', {
    chat_id:    chatId,
    text:       text,
    parse_mode: 'HTML',
  });
}

/**
 * Sends a message and (re)attaches a persistent reply keyboard.
 * Tapping a button sends its label as a plain text message — no callback_query.
 * Used for every selection screen.
 *
 * @param {string|number}   chatId
 * @param {string}          text
 * @param {string[][]}      keyboardRows  2D array of button label strings
 */
function sendMessageWithKeyboard(chatId, text, keyboardRows) {
  return _callTelegram_('sendMessage', {
    chat_id:    chatId,
    text:       text,
    parse_mode: 'HTML',
    reply_markup: {
      keyboard:          keyboardRows.map(row => row.map(label => ({ text: label }))),
      resize_keyboard:   true,
      one_time_keyboard: false,
    },
  });
}

/**
 * Sends a message and removes the reply keyboard.
 * Used just before a free-text input prompt so leftover buttons from the
 * previous screen are not mistaken for typed input.
 *
 * @param {string|number} chatId
 * @param {string}        text
 */
function sendMessageNoKeyboard(chatId, text) {
  return _callTelegram_('sendMessage', {
    chat_id:    chatId,
    text:       text,
    parse_mode: 'HTML',
    reply_markup: { remove_keyboard: true },
  });
}

// ---------------------------------------------------------------------------
// Webhook management (run once from the Apps Script editor, not at runtime)
// ---------------------------------------------------------------------------

/**
 * Registers the web-app URL as the bot's webhook.
 * Call once after deploying: setWebhook('https://…workers.dev')
 * (point to the Cloudflare relay, not directly to the /exec URL).
 *
 * @param {string} webAppUrl  The relay or /exec URL to receive updates
 */
function setWebhook(webAppUrl) {
  const result = _callTelegram_('setWebhook', { url: webAppUrl });
  console.log(result.getContentText());
  return result.getContentText();
}

/** Removes the currently registered webhook. */
function deleteWebhook() {
  const result = _callTelegram_('deleteWebhook', {});
  console.log(result.getContentText());
  return result.getContentText();
}

/** Prints current webhook info to the Apps Script execution log. */
function getWebhookInfo() {
  const result = _callTelegram_('getWebhookInfo', {});
  console.log(result.getContentText());
  return result.getContentText();
}
