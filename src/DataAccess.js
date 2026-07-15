/**
 * DataAccess.js
 * The ONLY file that calls DriveApp / SpreadsheetApp directly.
 * All other modules must go through the functions defined here.
 *
 * Caching strategy (CacheService, script-scoped):
 *   folderFiles:{folderId}          → JSON array of {id, name}   TTL: FOLDER_CACHE_TTL_SECONDS
 *   folderName:{folderId}           → folder display name         TTL: 600 s
 *   sheetList:{fileId}              → JSON array of sheet names   TTL: 120 s
 *   headers:{fileId}:{sheetName}    → JSON array of header labels TTL: 120 s
 */

// ---------------------------------------------------------------------------
// Folder helpers
// ---------------------------------------------------------------------------

/**
 * Returns folder {id, name}. Name is cached for 10 minutes.
 * @param {string} folderId
 * @returns {{ id: string, name: string }}
 */
function getFolderInfo(folderId) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'folderName:' + folderId;
  const cached = cache.get(cacheKey);
  if (cached) return { id: folderId, name: cached };

  const name = DriveApp.getFolderById(folderId).getName();
  try { cache.put(cacheKey, name, 600); } catch (e) { /* ignore */ }
  return { id: folderId, name: name };
}

/**
 * Lists all Google Sheets files inside a folder (root + one level of
 * subfolders). Uses folder.getFilesByType() — much faster than a global
 * DriveApp.searchFiles() scan because it only iterates files in the target
 * tree, not every spreadsheet accessible to the account.
 *
 * Results are cached for FOLDER_CACHE_TTL_SECONDS seconds.
 *
 * @param {string}  folderId
 * @param {boolean} forceRefresh  skip cache when true
 * @returns {Array<{id: string, name: string}>} sorted alphabetically
 */
function listSpreadsheetsInFolder(folderId, forceRefresh) {
  const cache    = CacheService.getScriptCache();
  const cacheKey = 'folderFiles:' + folderId;

  if (!forceRefresh) {
    const cached = cache.get(cacheKey);
    if (cached) return JSON.parse(cached);
  }

  const files = [];

  try {
    const rootFolder = DriveApp.getFolderById(folderId);

    // Collect from root folder directly
    _collectSheets_(rootFolder, files);

    // Collect from immediate subfolders (one level deep, same as original)
    const subIter = rootFolder.getFolders();
    while (subIter.hasNext()) {
      _collectSheets_(subIter.next(), files);
    }
  } catch (e) {
    console.error('listSpreadsheetsInFolder failed: ' + e);
  }

  files.sort((a, b) => a.name.localeCompare(b.name));

  try {
    cache.put(cacheKey, JSON.stringify(files), CONFIG.FOLDER_CACHE_TTL_SECONDS || 300);
  } catch (e) {
    console.error('Cache write error (folderFiles): ' + e);
  }

  return files;
}

/**
 * Iterates a Drive folder and pushes all Google Sheets entries into `out`.
 * @param {GoogleAppsScript.Drive.Folder} folder
 * @param {Array}                          out
 */
function _collectSheets_(folder, out) {
  const iter = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
  while (iter.hasNext()) {
    const f = iter.next();
    if (!f.isTrashed()) out.push({ id: f.getId(), name: f.getName() });
  }
}

/** Invalidates the cached file list for a folder. */
function clearFolderCache(folderId) {
  CacheService.getScriptCache().remove('folderFiles:' + folderId);
}

// ---------------------------------------------------------------------------
// Sheet helpers
// ---------------------------------------------------------------------------

/**
 * Returns visible sheet names for a spreadsheet. Result is cached for 2 min.
 * @param {string} fileId
 * @returns {string[]}
 */
function listSheetsInFile(fileId) {
  const cache    = CacheService.getScriptCache();
  const cacheKey = 'sheetList:' + fileId;
  const cached   = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const names = SpreadsheetApp.openById(fileId)
    .getSheets()
    .filter(s => !s.isSheetHidden())
    .map(s => s.getName());

  try { cache.put(cacheKey, JSON.stringify(names), 120); } catch (e) { /* ignore */ }
  return names;
}

/** Clears the cached sheet list for a spreadsheet. */
function clearSheetListCache(fileId) {
  CacheService.getScriptCache().remove('sheetList:' + fileId);
}

/**
 * Returns the numeric GID of a sheet tab (used to build direct links).
 * @param {string} fileId
 * @param {string} sheetName
 * @returns {number}
 */
function getSheetGid(fileId, sheetName) {
  return _getSheet_(fileId, sheetName).getSheetId();
}

/**
 * Returns the header labels for a sheet. Cached for 2 minutes.
 * Only row 1 is read here — multi-row / merged header parsing lives in
 * SheetActions.actionGetHeaders() which calls this for raw values.
 *
 * @param {string} fileId
 * @param {string} sheetName
 * @returns {string[]} trimmed, non-empty values from row 1
 */
function getHeaderRow(fileId, sheetName) {
  const sheet   = _getSheet_(fileId, sheetName);
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) return [];
  const values = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
  return values.map(v => String(v).trim()).filter(v => v.length > 0);
}

// ---------------------------------------------------------------------------
// Row read helpers
// ---------------------------------------------------------------------------

/**
 * Returns the last `n` data rows (skipping row 1 which is headers),
 * sorted newest-first. Date values are normalised to dd.MM.yyyy.
 *
 * @param {string} fileId
 * @param {string} sheetName
 * @param {number} n
 * @returns {Array<{rowIndex: number, values: string[]}>}
 */
function getLastRows(fileId, sheetName, n) {
  const sheet   = _getSheet_(fileId, sheetName);
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol === 0) return [];

  const startRow    = Math.max(2, lastRow - n + 1);
  const numRows     = lastRow - startRow + 1;
  const displayVals = sheet.getRange(startRow, 1, numRows, lastCol).getDisplayValues();

  const rows = displayVals.map((rowValues, i) => ({
    rowIndex: startRow + i,
    values:   rowValues.map(_normaliseDateString_),
  }));

  rows.reverse();
  return rows;
}

/**
 * Returns the display values of a single row.
 * @param {string} fileId
 * @param {string} sheetName
 * @param {number} rowIndex  1-based
 * @returns {string[]}
 */
function getRowValues(fileId, sheetName, rowIndex) {
  const sheet   = _getSheet_(fileId, sheetName);
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) return [];
  return sheet.getRange(rowIndex, 1, 1, lastCol)
    .getDisplayValues()[0]
    .map(_normaliseDateString_);
}

// ---------------------------------------------------------------------------
// Row write helpers
// ---------------------------------------------------------------------------

/**
 * Appends a new row. Acquires a script-level lock to prevent races.
 * Values are sanitised to prevent formula injection.
 *
 * @param {string}   fileId
 * @param {string}   sheetName
 * @param {string[]} values
 */
function appendRowToSheet(fileId, sheetName, values) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    _getSheet_(fileId, sheetName).appendRow(values.map(_sanitiseCellValue_));
  } finally {
    lock.releaseLock();
  }
}

/**
 * Updates a single cell. Acquires a script-level lock to prevent races.
 * Value is sanitised to prevent formula injection.
 *
 * @param {string} fileId
 * @param {string} sheetName
 * @param {number} rowIndex  1-based
 * @param {number} colIndex  1-based
 * @param {string} value
 */
function updateCell(fileId, sheetName, rowIndex, colIndex, value) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    _getSheet_(fileId, sheetName).getRange(rowIndex, colIndex).setValue(_sanitiseCellValue_(value));
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Merge / formula inspection (exposed so Navigation never calls _getSheet_)
// ---------------------------------------------------------------------------

/**
 * Returns true if the cell at (rowIndex, colIndex) contains a formula.
 * @param {string} fileId
 * @param {string} sheetName
 * @param {number} rowIndex
 * @param {number} colIndex
 * @returns {boolean}
 */
function isCellFormula(fileId, sheetName, rowIndex, colIndex) {
  try {
    const formula = _getSheet_(fileId, sheetName).getRange(rowIndex, colIndex).getFormula();
    return !!(formula && formula.toString().trim().startsWith('='));
  } catch (e) {
    console.error('isCellFormula failed: ' + e);
    return false;
  }
}

/**
 * Returns true when the cell is part of a horizontal merge where the
 * top-left anchor is to the LEFT of this column — i.e. this cell is a
 * trailing "shadow" of a merge and should be skipped during row rendering.
 *
 * @param {string} fileId
 * @param {string} sheetName
 * @param {number} rowIndex
 * @param {number} colIndex
 * @returns {boolean}
 */
function isCellTrailingMerge(fileId, sheetName, rowIndex, colIndex) {
  try {
    const cell = _getSheet_(fileId, sheetName).getRange(rowIndex, colIndex);
    if (!cell.isPartOfMerge()) return false;
    const topLeft = cell.getMergedRanges()[0].getCell(1, 1);
    return topLeft.getColumn() < colIndex;
  } catch (e) {
    console.error('isCellTrailingMerge failed: ' + e);
    return false;
  }
}

/**
 * Returns the merged ranges inside a single-row range, as an array of
 * { firstCol, lastCol } objects. Used by actionAddRow to replicate merges.
 *
 * @param {string} fileId
 * @param {string} sheetName
 * @param {number} rowIndex
 * @param {number} numCols
 * @returns {Array<{firstCol: number, lastCol: number}>}
 */
function getRowMergedRanges(fileId, sheetName, rowIndex, numCols) {
  try {
    const sheet  = _getSheet_(fileId, sheetName);
    const ranges = sheet.getRange(rowIndex, 1, 1, numCols).getMergedRanges();
    return ranges.map(mr => ({ firstCol: mr.getColumn(), lastCol: mr.getLastColumn() }));
  } catch (e) {
    return [];
  }
}

/**
 * Copies the formula from (srcRow, colIndex) to (dstRow, colIndex).
 * Used by actionAddRow to replicate auto-fill formulas.
 *
 * @param {string} fileId
 * @param {string} sheetName
 * @param {number} srcRow
 * @param {number} dstRow
 * @param {number} colIndex
 */
function copyFormulaDown(fileId, sheetName, srcRow, dstRow, colIndex) {
  const sheet = _getSheet_(fileId, sheetName);
  sheet.getRange(srcRow, colIndex).copyTo(
    sheet.getRange(dstRow, colIndex),
    SpreadsheetApp.CopyPasteType.PASTE_FORMULA,
    false
  );
}

/**
 * Merges a horizontal cell range in a given row.
 * @param {string} fileId
 * @param {string} sheetName
 * @param {number} rowIndex
 * @param {number} firstCol
 * @param {number} numCols
 */
function mergeRowRange(fileId, sheetName, rowIndex, firstCol, numCols) {
  _getSheet_(fileId, sheetName).getRange(rowIndex, firstCol, 1, numCols).merge();
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Opens and returns a sheet, or throws if it doesn't exist.
 * Note: this function is PRIVATE — prefix "_" signals internal use only.
 * External modules must use the public functions above.
 *
 * @param {string} fileId
 * @param {string} sheetName
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 */
function _getSheet_(fileId, sheetName) {
  const ss    = SpreadsheetApp.openById(fileId);
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('Sheet "' + sheetName + '" not found.');
  return sheet;
}

/**
 * Normalises date strings returned by getDisplayValues():
 * converts "Thu Jan 01 2026 00:00:00 GMT+0200" → "01.01.2026".
 * Passes through any string that doesn't look like a Date toString().
 * @param {string} v
 * @returns {string}
 */
function _normaliseDateString_(v) {
  const s = String(v);
  if (s.includes('GMT') || s.includes('00:00:00')) {
    try {
      const d = new Date(s);
      if (!isNaN(d.getTime())) {
        return Utilities.formatDate(d, Session.getScriptTimeZone(), 'dd.MM.yyyy');
      }
    } catch (e) { /* fall through */ }
  }
  return s;
}

/**
 * Prevents formula injection by prefixing values that start with a formula
 * trigger character (=, +, -, @) with a leading apostrophe, which Google
 * Sheets treats as a text-literal prefix.
 * @param {string} value
 * @returns {string}
 */
function _sanitiseCellValue_(value) {
  if (typeof value !== 'string') return value;
  if (/^[=+\-@]/.test(value)) return "'" + value;
  return value;
}
