/**
 * TelegramApi.js
 * Thin wrappers around the Telegram Bot HTTP API.
 */

function _apiUrl_(method) {
  return 'https://api.telegram.org/bot' + getBotToken_() + '/' + method;
}

function _callTelegram_(method, payload) {
  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };
  const response = UrlFetchApp.fetch(_apiUrl_(method), options);
  const code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    console.error(
      'Telegram API error [' + method + ']: ' + code + ' ' + response.getContentText()
    );
  }
  return response;
}

/**
 * Sends a plain content message. Does NOT touch whatever reply keyboard is
 * currently showing — Telegram leaves an existing reply keyboard in place
 * until a later message explicitly replaces or removes it. Used for
 * displaying data (row values, previews, confirmations).
 * @param {number|string} chatId
 * @param {string} text
 */
function sendMessage(chatId, text) {
  return _callTelegram_('sendMessage', {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML',
  });
}

/**
 * Sends a message and (re)pins a persistent reply keyboard to the chat.
 * Tapping one of these buttons sends its label back to the bot as a normal
 * text message — there is no callback_query involved, unlike an inline
 * keyboard. Used for every selection screen (folders, files, sheets, rows,
 * fields, actions).
 * @param {number|string} chatId
 * @param {string} text
 * @param {Array<Array<string>>} keyboardRows rows of button labels
 */
function sendMessageWithKeyboard(chatId, text, keyboardRows) {
  return _callTelegram_('sendMessage', {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML',
    reply_markup: {
      keyboard: keyboardRows.map((row) => row.map((label) => ({ text: label }))),
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  });
}

/**
 * Sends a message and removes the reply keyboard. Used right before a
 * free-text prompt (e.g. "enter a value for..."), so leftover buttons from
 * the previous screen can't be mistaken for a typed answer.
 * @param {number|string} chatId
 * @param {string} text
 */
function sendMessageNoKeyboard(chatId, text) {
  return _callTelegram_('sendMessage', {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML',
    reply_markup: { remove_keyboard: true },
  });
}

/**
 * Registers the web app URL as the bot's webhook.
 * Run this once manually from the Apps Script editor after deploying,
 * e.g. from the console: setWebhook('https://script.google.com/macros/s/.../exec')
 * @param {string} webAppUrl the /exec URL of your deployed web app
 */
function setWebhook(webAppUrl) {
  const result = _callTelegram_('setWebhook', { url: webAppUrl });
  console.log(result.getContentText());
  return result.getContentText();
}

/**
 * Removes the webhook (useful if you ever want to stop the bot temporarily).
 */
function deleteWebhook() {
  const result = _callTelegram_('deleteWebhook', {});
  console.log(result.getContentText());
  return result.getContentText();
}

/**
 * Convenience check — prints current webhook info to the execution log.
 */
function getWebhookInfo() {
  const result = _callTelegram_('getWebhookInfo', {});
  console.log(result.getContentText());
  return result.getContentText();
}
