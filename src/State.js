/**
 * State.js
 * Per-user conversation state backed by PropertiesService (Script Properties).
 *
 * Key scheme:
 *   state:{chatId}          → JSON conversation state object
 *   lastpath:{chatId}       → JSON last opened folder/file/sheet path
 *   favdocs:{chatId}        → JSON array of favorite document descriptors (max 3)
 *   favsheets:{chatId}:{fileId} → JSON array of favorite sheet names (max 3)
 */

const STATE_PREFIX      = 'state:';
const LAST_PATH_PREFIX  = 'lastpath:';
const FAV_DOCS_PREFIX   = 'favdocs:';
const FAV_SHEETS_PREFIX = 'favsheets:';

const MAX_FAV_DOCS   = 3;
const MAX_FAV_SHEETS = 3;

// ---------------------------------------------------------------------------
// Conversation state
// ---------------------------------------------------------------------------

/**
 * Returns the persisted state for a chat, or a default main-menu state.
 * @param {string} chatId
 * @returns {Object}
 */
function getState(chatId) {
  const raw = PropertiesService.getScriptProperties().getProperty(STATE_PREFIX + chatId);
  if (!raw) return { step: 'main_menu' };
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error('Failed to parse state for chat ' + chatId + ': ' + e);
    return { step: 'main_menu' };
  }
}

/**
 * Persists conversation state, stripping ephemeral list caches that would
 * overflow the 9 KB PropertiesService per-property limit.
 * @param {string} chatId
 * @param {Object} state
 */
function setState(chatId, state) {
  // Strip non-persistent, re-loadable list caches before saving.
  delete state.fileList;
  delete state.sheetList;
  delete state.rowList;   // can hold up to 1000 rows — never persist this

  PropertiesService.getScriptProperties().setProperty(
    STATE_PREFIX + chatId,
    JSON.stringify(state)
  );
}

/** Clears the conversation state for a chat. */
function clearState(chatId) {
  PropertiesService.getScriptProperties().deleteProperty(STATE_PREFIX + chatId);
}

// ---------------------------------------------------------------------------
// Last-path shortcut
// ---------------------------------------------------------------------------

/**
 * Saves the last fully-opened path so /start can offer a "Continue" button.
 * @param {string} chatId
 * @param {{ folderIndex, folderId, folderName, fileId, fileName, sheetName, label }} path
 */
function setLastPath(chatId, path) {
  PropertiesService.getScriptProperties().setProperty(
    LAST_PATH_PREFIX + chatId,
    JSON.stringify(path)
  );
}

/**
 * Returns the last-opened path, or null.
 * @param {string} chatId
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

// ---------------------------------------------------------------------------
// Favorite documents  (max MAX_FAV_DOCS per user)
// Each entry: { fileId, fileName, folderId, folderIndex, folderName }
// ---------------------------------------------------------------------------

/**
 * @param {string} chatId
 * @returns {Array<Object>}
 */
function getFavDocs(chatId) {
  const raw = PropertiesService.getScriptProperties().getProperty(FAV_DOCS_PREFIX + chatId);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (e) { return []; }
}

/**
 * Adds a document to favorites if not already present and the list is not full.
 * Returns true if the list was modified.
 * @param {string} chatId
 * @param {{ fileId, fileName, folderId, folderIndex, folderName }} doc
 * @returns {boolean}
 */
function addFavDoc(chatId, doc) {
  const docs = getFavDocs(chatId);
  if (docs.some(d => d.fileId === doc.fileId)) return false; // already present
  if (docs.length >= MAX_FAV_DOCS) return false;             // list full
  docs.push(doc);
  PropertiesService.getScriptProperties().setProperty(FAV_DOCS_PREFIX + chatId, JSON.stringify(docs));
  return true;
}

/**
 * Removes a document from favorites by fileId.
 * Returns true if the list was modified.
 * @param {string} chatId
 * @param {string} fileId
 * @returns {boolean}
 */
function removeFavDoc(chatId, fileId) {
  const docs = getFavDocs(chatId);
  const next = docs.filter(d => d.fileId !== fileId);
  if (next.length === docs.length) return false;
  PropertiesService.getScriptProperties().setProperty(FAV_DOCS_PREFIX + chatId, JSON.stringify(next));
  return true;
}

/**
 * Returns true if the document is in the user's favorites.
 * @param {string} chatId
 * @param {string} fileId
 * @returns {boolean}
 */
function isFavDoc(chatId, fileId) {
  return getFavDocs(chatId).some(d => d.fileId === fileId);
}

// ---------------------------------------------------------------------------
// Favorite sheets  (max MAX_FAV_SHEETS per user, per document)
// Stored as an array of sheet name strings.
// ---------------------------------------------------------------------------

/**
 * @param {string} chatId
 * @param {string} fileId
 * @returns {string[]}
 */
function getFavSheets(chatId, fileId) {
  const key = FAV_SHEETS_PREFIX + chatId + ':' + fileId;
  const raw = PropertiesService.getScriptProperties().getProperty(key);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (e) { return []; }
}

/**
 * Adds a sheet name to favorites for a given document.
 * Returns true if the list was modified.
 * @param {string} chatId
 * @param {string} fileId
 * @param {string} sheetName
 * @returns {boolean}
 */
function addFavSheet(chatId, fileId, sheetName) {
  const sheets = getFavSheets(chatId, fileId);
  if (sheets.includes(sheetName)) return false;
  if (sheets.length >= MAX_FAV_SHEETS) return false;
  sheets.push(sheetName);
  const key = FAV_SHEETS_PREFIX + chatId + ':' + fileId;
  PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(sheets));
  return true;
}

/**
 * Removes a sheet name from favorites.
 * Returns true if the list was modified.
 * @param {string} chatId
 * @param {string} fileId
 * @param {string} sheetName
 * @returns {boolean}
 */
function removeFavSheet(chatId, fileId, sheetName) {
  const sheets = getFavSheets(chatId, fileId);
  const next = sheets.filter(s => s !== sheetName);
  if (next.length === sheets.length) return false;
  const key = FAV_SHEETS_PREFIX + chatId + ':' + fileId;
  PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(next));
  return true;
}

/**
 * Returns true if the sheet is favorited for this document.
 * @param {string} chatId
 * @param {string} fileId
 * @param {string} sheetName
 * @returns {boolean}
 */
function isFavSheet(chatId, fileId, sheetName) {
  return getFavSheets(chatId, fileId).includes(sheetName);
}
