/**
 * State.js
 * Per-user conversation state, backed by PropertiesService (Script Properties).
 * Key: "state:<chatId>"  Value: JSON string
 */

const STATE_PREFIX = 'state:';
const LAST_PATH_PREFIX = 'lastpath:';

/**
 * @param {number|string} chatId
 * @returns {Object} state object, defaults to { step: 'main_menu' }
 */
function getState(chatId) {
  const raw = PropertiesService.getScriptProperties().getProperty(STATE_PREFIX + chatId);
  if (!raw) {
    return { step: 'main_menu' };
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error('Failed to parse state for chat ' + chatId + ': ' + e);
    return { step: 'main_menu' };
  }
}

/**
 * @param {number|string} chatId
 * @param {Object} state
 */
function setState(chatId, state) {
  // Защита от переполнения 9KB лимита PropertiesService:
  // Никогда не храним кэшируемые списки файлов/листов в долгосрочном стейте.
  if (state.fileList) delete state.fileList;
  if (state.sheetList) delete state.sheetList;
  
  PropertiesService.getScriptProperties().setProperty(
    STATE_PREFIX + chatId,
    JSON.stringify(state)
  );
}

/**
 * @param {number|string} chatId
 */
function clearState(chatId) {
  PropertiesService.getScriptProperties().deleteProperty(STATE_PREFIX + chatId);
}

/**
 * Remembers the last fully-opened path (folder/file/sheet) so /start can
 * offer a "Continue: <path>" shortcut button.
 * @param {number|string} chatId
 * @param {Object} path { folderIndex, folderId, folderName, fileId, fileName, sheetName, label }
 */
function setLastPath(chatId, path) {
  PropertiesService.getScriptProperties().setProperty(
    LAST_PATH_PREFIX + chatId,
    JSON.stringify(path)
  );
}

/**
 * @param {number|string} chatId
 * @returns {Object|null}
 */
function getLastPath(chatId) {
  const raw = PropertiesService.getScriptProperties().getProperty(LAST_PATH_PREFIX + chatId);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}