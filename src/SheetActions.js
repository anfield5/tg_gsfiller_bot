/**
 * SheetActions.js
 * Business-logic layer for reading/writing sheet data.
 * Calls DataAccess.js only — never DriveApp/SpreadsheetApp directly.
 * Wraps every call in try/catch and turns failures into user-facing messages.
 */

/**
 * @param {string} folderId
 * @param {boolean} [forceRefresh]
 * @returns {Array<{id:string, name:string}>}
 */
function actionListSpreadsheets(folderId, forceRefresh) {
  try {
    return listSpreadsheetsInFolder(folderId, forceRefresh);
  } catch (e) {
    console.error('actionListSpreadsheets failed: ' + e);
    throw new Error('Could not read that folder. It may have been moved or deleted.');
  }
}

/**
 * Fetches the real Drive folder name — used as a fallback when
 * CONFIG.FOLDER_LABELS doesn't have an explicit label for this folder.
 * @param {string} folderId
 * @returns {string}
 */
function actionGetFolderName(folderId) {
  try {
    return getFolderInfo(folderId).name;
  } catch (e) {
    console.error('actionGetFolderName failed: ' + e);
    throw new Error('Could not read folder name.');
  }
}

/**
 * @param {string} fileId
 * @returns {Array<string>}
 */
function actionListSheets(fileId) {
  try {
    return listSheetsInFile(fileId);
  } catch (e) {
    console.error('actionListSheets failed: ' + e);
    throw new Error('Could not open that spreadsheet.');
  }
}

/**
 * @param {string} fileId
 * @param {string} sheetName
 * @returns {Array<string>}
 */
function actionGetHeaders(fileId, sheetName) {
  try {
    const headers = getHeaderRow(fileId, sheetName);
    if (headers.length === 0) {
      throw new Error('This sheet has no header row (row 1 is empty).');
    }
    return headers;
  } catch (e) {
    console.error('actionGetHeaders failed: ' + e);
    throw new Error('Could not read column headers: ' + e.message);
  }
}

/**
 * @param {string} fileId
 * @param {string} sheetName
 * @param {Object} formData map of headerName -> value
 * @param {Array<string>} headers ordered column headers
 */
function actionAddRow(fileId, sheetName, formData, headers) {
  try {
    const values = headers.map((h) => (formData[h] !== undefined ? formData[h] : ''));
    appendRowToSheet(fileId, sheetName, values);
  } catch (e) {
    console.error('actionAddRow failed: ' + e);
    throw new Error('Failed to save the row. Please try again.');
  }
}

/**
 * @param {string} fileId
 * @param {string} sheetName
 * @param {number} n
 * @returns {Array<{rowIndex:number, values:Array}>}
 */
function actionGetLastRows(fileId, sheetName, n) {
  try {
    return getLastRows(fileId, sheetName, n);
  } catch (e) {
    console.error('actionGetLastRows failed: ' + e);
    throw new Error('Could not read rows from this sheet.');
  }
}

/**
 * @param {string} fileId
 * @param {string} sheetName
 * @param {number} rowIndex
 * @returns {Array}
 */
function actionGetRowValues(fileId, sheetName, rowIndex) {
  try {
    return getRowValues(fileId, sheetName, rowIndex);
  } catch (e) {
    console.error('actionGetRowValues failed: ' + e);
    throw new Error('Could not read that row.');
  }
}

/**
 * @param {string} fileId
 * @param {string} sheetName
 * @param {number} rowIndex
 * @param {number} colIndex
 * @param {string} value
 */
function actionUpdateCell(fileId, sheetName, rowIndex, colIndex, value) {
  try {
    updateCell(fileId, sheetName, rowIndex, colIndex, value);
  } catch (e) {
    console.error('actionUpdateCell failed: ' + e);
    throw new Error('Failed to save the change. Please try again.');
  }
}

/**
 * @param {string} fileId
 * @param {string} sheetName
 * @returns {number}
 */
function actionGetSheetGid(fileId, sheetName) {
  try {
    return getSheetGid(fileId, sheetName);
  } catch (e) {
    console.error('actionGetSheetGid failed: ' + e);
    throw new Error('Could not resolve sheet tab.');
  }
}

/**
 * Converts a 1-based column number to its spreadsheet letter (1 -> "A",
 * 27 -> "AA", etc).
 * @param {number} n
 * @returns {string}
 */
function columnNumberToLetter(n) {
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/**
 * Builds a Google Sheets URL that opens directly on the given tab with a
 * specific cell range pre-selected/highlighted.
 * @param {string} fileId
 * @param {number} gid
 * @param {number} startRow 1-based
 * @param {number} endRow 1-based
 * @param {number} numCols how many columns starting from A (e.g. 3 -> A:C)
 * @returns {string}
 */
function buildSheetRangeUrl(fileId, gid, startRow, endRow, numCols) {
  const endColLetter = columnNumberToLetter(numCols);
  const range = 'A' + startRow + ':' + endColLetter + endRow;
  return (
    'https://docs.google.com/spreadsheets/d/' + fileId + '/edit#gid=' + gid + '&range=' + range
  );
}

/**
 * Truncates a value for use in a button label / preview line.
 * @param {*} value
 * @param {number} maxLen
 * @returns {string}
 */
function formatPreview(value, maxLen) {
  const s = value === null || value === undefined ? '' : String(value);
  if (s.length === 0) return '(empty)';
  if (s.length <= maxLen) return s;
  return s.substring(0, maxLen - 1) + '…';
}
