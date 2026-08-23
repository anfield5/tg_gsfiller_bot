/**
 * Config.js
 * Static configuration for the bot.
 * DO NOT hardcode secrets here — the bot token and Gemini key live in
 * Script Properties.
 */

const FOLDER_IDS = [
  '1jq1qXuTiMNyPms_njlklJcMkHSi2r7HU',
  '1NUlubKxTRE2Ul8AzF_6Eyosb_Ph-aUov',
  '1wP-tbBtjrKqpI_xd1zgh1sc0Kv_BDdkc',
];

const FOLDER_LABELS = [];

const CONFIG = {
  FOLDER_IDS:               FOLDER_IDS,
  FOLDER_LABELS:            FOLDER_LABELS,
  FILES_PER_PAGE:           10,
  EDIT_ROWS_LIMIT:          10,
  MAX_TEXT_PREVIEW_LEN:     24,
  FOLDER_CACHE_TTL_SECONDS: 300,
  FOLDER_SCAN_DEPTH: 1,
  GEMINI_MODEL: 'gemini-2.5-flash',
  GEMINI_MAX_ROWS: 500,
};

function getBotToken_() {
  const token = PropertiesService.getScriptProperties().getProperty('BOT_TOKEN');
  if (!token) {
    throw new Error(
      'BOT_TOKEN is not set. ' +
      'Run PropertiesService.getScriptProperties().setProperty("BOT_TOKEN", "<token>") ' +
      'from the Apps Script editor.'
    );
  }
  return token;
}

function getGeminiApiKey_() {
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY is not set in Script Properties.');
  return key;
}
