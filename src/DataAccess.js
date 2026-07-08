/**
 * DataAccess.js
 * Manages direct interaction with Google Drive and Sheets API.
 */

function getFolderInfo(folderId) {
  const folder = DriveApp.getFolderById(folderId);
  return { id: folderId, name: folder.getName() };
}

/**
 * Fast deep scan using native DriveApp memory filtering.
 * Completely bypasses Drive API v3 "Invalid Value" issues.
 */
function listSpreadsheetsInFolder(folderId, forceRefresh) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'folderFiles:' + folderId;

  if (!forceRefresh) {
    const cached = cache.get(cacheKey);
    if (cached) return JSON.parse(cached);
  }

  const files = [];

  try {
    // 1. Map all subfolders in memory to know the target tree
    const allowedFolderIds = {};
    allowedFolderIds[folderId] = true;
    
    const rootFolder = DriveApp.getFolderById(folderId);
    const subFolderIterator = rootFolder.getFolders();
    while (subFolderIterator.hasNext()) {
      const subFolder = subFolderIterator.next();
      allowedFolderIds[subFolder.getId()] = true;
    }

    // 2. Fetch all spreadsheets accessible to the script via safe, native query
    const query = "mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false";
    const fileIterator = DriveApp.searchFiles(query);
    
    while (fileIterator.hasNext()) {
      const f = fileIterator.next();
      const parents = f.getParents();
      
      // 3. Filter files that live inside our folder structure
      if (parents.hasNext()) {
        const parentId = parents.next().getId();
        if (allowedFolderIds[parentId]) {
          files.push({ id: f.getId(), name: f.getName() });
        }
      }
    }
  } catch (e) {
    console.error('Native memory deep scan failed: ' + e);
  }

  // Sort files alphabetically
  files.sort((a, b) => a.name.localeCompare(b.name));

  try {
    cache.put(cacheKey, JSON.stringify(files), CONFIG.FOLDER_CACHE_TTL_SECONDS || 300);
  } catch (e) {
    console.error('Cache allocation error: ' + e);
  }

  return files;
}

function clearFolderCache(folderId) {
  CacheService.getScriptCache().remove('folderFiles:' + folderId);
}

function listSheetsInFile(fileId) {
  const ss = SpreadsheetApp.openById(fileId);
  return ss.getSheets().filter((s) => !s.isSheetHidden()).map((s) => s.getName());
}

function getSheetGid(fileId, sheetName) {
  return _getSheet(fileId, sheetName).getSheetId();
}

function getHeaderRow(fileId, sheetName) {
  const sheet = _getSheet(fileId, sheetName);
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) return [];
  const values = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
  return values.map((v) => String(v).trim()).filter(v => v.length > 0);
}

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

function getLastRows(fileId, sheetName, n) {
  const sheet = _getSheet(fileId, sheetName);
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol === 0) return [];

  const startRow = Math.max(2, lastRow - n + 1);
  const numRows = lastRow - startRow + 1;
  const displayValues = sheet.getRange(startRow, 1, numRows, lastCol).getDisplayValues();

  const rows = displayValues.map((rowValues, i) => {
    const sanitizedValues = rowValues.map(v => {
      let str = String(v);
      if (str.includes('GMT') || str.includes('00:00:00')) {
        try {
          const d = new Date(str);
          if (!isNaN(d.getTime())) {
            return Utilities.formatDate(d, Session.getScriptTimeZone(), "dd.MM.yyyy");
          }
        } catch(e){}
      }
      return str;
    });

    return {
      rowIndex: startRow + i,
      values: sanitizedValues,
    };
  });
  
  rows.reverse();
  return rows;
}

function getRowValues(fileId, sheetName, rowIndex) {
  const sheet = _getSheet(fileId, sheetName);
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) return [];
  const displayValues = sheet.getRange(rowIndex, 1, 1, lastCol).getDisplayValues()[0];
  return displayValues.map(v => {
    let str = String(v);
    if (str.includes('GMT')) {
      try {
        const d = new Date(str);
        if (!isNaN(d.getTime())) return Utilities.formatDate(d, Session.getScriptTimeZone(), "dd.MM.yyyy");
      } catch(e){}
    }
    return str;
  });
}

/**
 * Updates a specific cell value in the target sheet.
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

function _getSheet(fileId, sheetName) {
  const ss = SpreadsheetApp.openById(fileId);
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('Sheet "' + sheetName + '" not found.');
  return sheet;
}