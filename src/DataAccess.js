/**
 * DataAccess.js
 * The ONLY file allowed to call DriveApp / SpreadsheetApp directly.
 * Every other module must go through these functions. This keeps the rest
 * of the codebase testable and makes it easy to swap in per-user OAuth /
 * multi-tenant access later without touching navigation or state logic.
 */

/**
 * @param {string} folderId
 * @returns {{id:string, name:string}}
 */
function getFolderInfo(folderId) {
  const folder = DriveApp.getFolderById(folderId);
  return { id: folderId, name: folder.getName() };
}

/**
 * Recursively finds every Google Sheet in the given folder AND all of its
 * nested subfolders (any depth). Files found inside subfolders get their
 * subfolder path prefixed to the name (e.g. "Reports / 2026 / Budget") so
 * the origin is still clear once flattened into one list.
 *
 * Results are cached (CacheService) for CONFIG.FOLDER_CACHE_TTL_SECONDS,
 * since walking every subfolder on every visit is by far the slowest step
 * in the bot. Pass forceRefresh=true to bypass the cache (used by the
 * "🔄 Refresh" button).
 *
 * @param {string} folderId
 * @param {boolean} [forceRefresh]
 * @returns {Array<{id:string, name:string}>}
 */
function listSpreadsheetsInFolder(folderId, forceRefresh) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'folderFiles:' + folderId;

  if (!forceRefresh) {
    const cached = cache.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }
  }

  const files = [];
  _collectSpreadsheetsRecursive_(DriveApp.getFolderById(folderId), '', files);
  // Stable alphabetical order so pagination/indices don't shuffle between calls.
  files.sort((a, b) => a.name.localeCompare(b.name));

  try {
    cache.put(cacheKey, JSON.stringify(files), CONFIG.FOLDER_CACHE_TTL_SECONDS);
  } catch (e) {
    // Cache entry too large (CacheService caps out around 100KB) — not fatal,
    // just means this particular folder won't benefit from caching.
    console.error('Could not cache folder listing for ' + folderId + ': ' + e);
  }

  return files;
}

/**
 * Clears the cached file listing for a folder, forcing the next
 * listSpreadsheetsInFolder call to re-scan Drive.
 * @param {string} folderId
 */
function clearFolderCache(folderId) {
  CacheService.getScriptCache().remove('folderFiles:' + folderId);
}

/**
 * @private
 * @param {GoogleAppsScript.Drive.Folder} folder
 * @param {string} pathPrefix
 * @param {Array<{id:string, name:string}>} files accumulator, mutated in place
 */
function _collectSpreadsheetsRecursive_(folder, pathPrefix, files) {
  const fileIt = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
  while (fileIt.hasNext()) {
    const f = fileIt.next();
    const label = pathPrefix ? pathPrefix + ' / ' + f.getName() : f.getName();
    files.push({ id: f.getId(), name: label });
  }

  const folderIt = folder.getFolders();
  while (folderIt.hasNext()) {
    const sub = folderIt.next();
    const subPrefix = pathPrefix ? pathPrefix + ' / ' + sub.getName() : sub.getName();
    _collectSpreadsheetsRecursive_(sub, subPrefix, files);
  }
}

/**
 * @param {string} fileId
 * @returns {Array<string>} sheet (tab) names
 */
function listSheetsInFile(fileId) {
  const ss = SpreadsheetApp.openById(fileId);
  return ss
    .getSheets()
    .filter((s) => !s.isSheetHidden())
    .map((s) => s.getName());
}

/**
 * Returns the sheet's internal gid — used to build a link that opens
 * Google Sheets directly on this tab (and optionally a specific range).
 * @param {string} fileId
 * @param {string} sheetName
 * @returns {number}
 */
function getSheetGid(fileId, sheetName) {
  return _getSheet(fileId, sheetName).getSheetId();
}

/**
 * @param {string} fileId
 * @param {string} sheetName
 * @returns {Array<string>} header row values (row 1)
 */
function getHeaderRow(fileId, sheetName) {
  const sheet = _getSheet(fileId, sheetName);
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) return [];
  const values = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  return values.map((v) => String(v));
}

/**
 * @param {string} fileId
 * @param {string} sheetName
 * @param {Array} values ordered to match header columns
 */
function appendRowToSheet(fileId, sheetName, values) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sheet = _getSheet(fileId, sheetName);
    sheet.appendRow(values);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Returns the last N non-empty rows (excluding the header row), most recent first.
 * @param {string} fileId
 * @param {string} sheetName
 * @param {number} n
 * @returns {Array<{rowIndex:number, values:Array}>}
 */
function getLastRows(fileId, sheetName, n) {
  const sheet = _getSheet(fileId, sheetName);
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol === 0) return [];

  const startRow = Math.max(2, lastRow - n + 1);
  const numRows = lastRow - startRow + 1;
  const values = sheet.getRange(startRow, 1, numRows, lastCol).getValues();

  const rows = values.map((rowValues, i) => ({
    rowIndex: startRow + i,
    values: rowValues,
  }));
  rows.reverse();
  return rows;
}

/**
 * @param {string} fileId
 * @param {string} sheetName
 * @param {number} rowIndex 1-based sheet row
 * @returns {Array}
 */
function getRowValues(fileId, sheetName, rowIndex) {
  const sheet = _getSheet(fileId, sheetName);
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) return [];
  return sheet.getRange(rowIndex, 1, 1, lastCol).getValues()[0];
}

/**
 * @param {string} fileId
 * @param {string} sheetName
 * @param {number} rowIndex 1-based
 * @param {number} colIndex 1-based
 * @param {*} value
 */
function updateCell(fileId, sheetName, rowIndex, colIndex, value) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sheet = _getSheet(fileId, sheetName);
    sheet.getRange(rowIndex, colIndex).setValue(value);
  } finally {
    lock.releaseLock();
  }
}

/**
 * @private
 */
function _getSheet(fileId, sheetName) {
  const ss = SpreadsheetApp.openById(fileId);
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    throw new Error('Sheet "' + sheetName + '" not found in file ' + fileId);
  }
  return sheet;
}
