/**
 * SheetActions.js
 * Business-logic layer for spreadsheet operations.
 * Calls DataAccess.js exclusively — never touches DriveApp/SpreadsheetApp directly.
 */

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

/**
 * Parses column headers from rows 1 and 2, resolving merged cells so that
 * every column maps to exactly one label (prevents off-by-one field shifts).
 *
 * Label rules:
 *   - Merged top-row cell: use its text for all columns it spans
 *   - Two distinct non-empty rows: "TopHeader (BottomHeader)"
 *   - Only one row has a value: use that value
 *   - Neither row has a value: "Column N"
 *
 * @param {string} fileId
 * @param {string} sheetName
 * @returns {string[]}
 */
function actionGetHeaders(fileId, sheetName) {
  // Use cache key consistent with the rest of the caching strategy.
  const cache    = CacheService.getScriptCache();
  const cacheKey = 'headers:' + fileId + ':' + sheetName;
  const cached   = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  try {
    // We need direct Sheet access here for the 2-row + merge read.
    // _getSheet_ is a DataAccess private but accessible within the same GAS project.
    const sheet   = _getSheet_(fileId, sheetName);
    const maxCols = sheet.getLastColumn();
    if (maxCols === 0) return [];

    const range        = sheet.getRange(1, 1, 2, maxCols);
    const values       = range.getValues();
    const mergedRanges = range.getMergedRanges();

    const headers = [];

    for (let col = 1; col <= maxCols; col++) {
      let top    = String(values[0][col - 1]).trim();
      let bottom = String(values[1][col - 1]).trim();

      // If this column falls inside a row-1 merge, use the anchor cell's text.
      mergedRanges.forEach(mr => {
        if (mr.getRow() <= 1 &&
            col >= mr.getColumn() && col <= mr.getLastColumn()) {
          top = String(mr.getCell(1, 1).getValue()).trim();
        }
      });

      let label;
      if (top && bottom && top !== bottom) {
        label = top + ' (' + bottom + ')';
      } else {
        label = top || bottom || ('Column ' + col);
      }
      headers.push(label);
    }

    try { cache.put(cacheKey, JSON.stringify(headers), 120); } catch (e) { /* ignore */ }
    return headers;
  } catch (e) {
    console.error('actionGetHeaders failed: ' + e);
    throw new Error('Could not read column headers: ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// Row writes
// ---------------------------------------------------------------------------

/**
 * Appends a new row, then:
 *   1. Replicates formulas from the previous row (auto-fill style).
 *   2. Replicates horizontal cell merges from the previous row.
 *
 * Cells whose formData value is the formula-placeholder sentinel are left
 * empty so the formula copy step can fill them in.
 *
 * @param {string} fileId
 * @param {string} sheetName
 * @param {Object} formData   { [headerLabel]: value }
 * @param {string[]} headers  ordered header labels
 */
function actionAddRow(fileId, sheetName, formData, headers) {
  try {
    // --- 1. Build the data array and append ---
    const FORMULA_PLACEHOLDER = '🧬 (Calculated Formula)';
    const dataValues = headers.map(h => {
      const val = formData[h];
      return (val === FORMULA_PLACEHOLDER || val === undefined) ? '' : val;
    });

    appendRowToSheet(fileId, sheetName, dataValues);

    // After appendRow the new row is always sheet.getLastRow().
    // We need to know the template row (the row just before the new one).
    const sheet       = _getSheet_(fileId, sheetName);
    const targetRow   = sheet.getLastRow();
    const templateRow = targetRow - 1;
    if (templateRow < 2) return; // nothing to replicate from (row 1 is headers)

    // --- 2. Copy formulas from the template row ---
    for (let col = 1; col <= headers.length; col++) {
      if (isCellFormula(fileId, sheetName, templateRow, col)) {
        copyFormulaDown(fileId, sheetName, templateRow, targetRow, col);
      }
    }

    // --- 3. Mirror horizontal merges from the template row ---
    const merges = getRowMergedRanges(fileId, sheetName, templateRow, headers.length);
    merges.forEach(m => {
      const numCols = m.lastCol - m.firstCol + 1;
      if (numCols > 1) {
        mergeRowRange(fileId, sheetName, targetRow, m.firstCol, numCols);
      }
    });
  } catch (e) {
    console.error('actionAddRow failed: ' + e);
    throw new Error('Failed to save row: ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// Thin delegation wrappers (kept so Navigation/Code never bypass DataAccess)
// ---------------------------------------------------------------------------

function actionListSpreadsheets(folderId, forceRefresh) { return listSpreadsheetsInFolder(folderId, forceRefresh); }
function actionGetFolderName(folderId)                  { return getFolderInfo(folderId).name; }
function actionListSheets(fileId)                       { return listSheetsInFile(fileId); }
function actionGetLastRows(fileId, sheetName, n)        { return getLastRows(fileId, sheetName, n); }
function actionGetRowValues(fileId, sheetName, rowIndex){ return getRowValues(fileId, sheetName, rowIndex); }
function actionUpdateCell(fileId, sheetName, rowIndex, colIndex, value) {
  updateCell(fileId, sheetName, rowIndex, colIndex, value);
}
function actionGetSheetGid(fileId, sheetName) { return getSheetGid(fileId, sheetName); }

// ---------------------------------------------------------------------------
// UI / formatting helpers
// ---------------------------------------------------------------------------

/**
 * Builds a short HTML preview of the last few rows for the Preview action.
 * @param {string} fileId
 * @param {string} sheetName
 * @returns {string} HTML-formatted Telegram message
 */
function actionBuildPreviewText(fileId, sheetName) {
  try {
    const MAX_ROWS = 5;
    const MAX_COLS = 4;
    const headers = actionGetHeaders(fileId, sheetName).slice(0, MAX_COLS);
    const rows    = actionGetLastRows(fileId, sheetName, MAX_ROWS);

    if (rows.length === 0) {
      return '📊 <b>Sheet:</b> ' + sheetName + '\n\n⚠️ <i>No data rows found.</i>';
    }

    let text = '📊 <b>Last ' + rows.length + ' rows — ' + sheetName + ':</b>\n\n';
    rows.forEach(row => {
      text += '🔹 <b>Row #' + row.rowIndex + '</b>\n';
      headers.forEach((h, colIdx) => {
        let val = (row.values[colIdx] !== undefined) ? String(row.values[colIdx]).trim() : '';
        if (val.length > 20) val = val.substring(0, 17) + '…';
        if (val.length > 0) text += '• <i>' + h + ':</i> ' + val + '\n';
      });
      text += '\n';
    });

    const gid    = actionGetSheetGid(fileId, sheetName);
    const minRow = Math.min.apply(null, rows.map(r => r.rowIndex));
    const maxRow = Math.max.apply(null, rows.map(r => r.rowIndex));
    text += '🔗 <a href="' + buildSheetRangeUrl(fileId, gid, minRow, maxRow, MAX_COLS) + '">Open in Google Sheets</a>';
    return text;
  } catch (e) {
    return '❌ <i>Preview failed: ' + e.message + '</i>';
  }
}

// ---------------------------------------------------------------------------
// URL / string utilities
// ---------------------------------------------------------------------------

/**
 * Converts a 1-based column number to a spreadsheet column letter (A, B, … Z, AA …).
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
 * Builds a Google Sheets URL that opens directly to a row range.
 * @param {string} fileId
 * @param {number} gid
 * @param {number} startRow
 * @param {number} endRow
 * @param {number} numCols
 * @returns {string}
 */
function buildSheetRangeUrl(fileId, gid, startRow, endRow, numCols) {
  const endCol = columnNumberToLetter(numCols);
  return 'https://docs.google.com/spreadsheets/d/' + fileId +
         '/edit#gid=' + gid + '&range=A' + startRow + ':' + endCol + endRow;
}

/**
 * Truncates a value for display, appending "…" if it exceeds maxLen.
 * Returns "(empty)" for null/undefined/empty strings.
 * @param {*}      value
 * @param {number} maxLen
 * @returns {string}
 */
function formatPreview(value, maxLen) {
  const s = (value === null || value === undefined) ? '' : String(value);
  if (s.length === 0) return '(empty)';
  if (s.length <= maxLen) return s;
  return s.substring(0, maxLen - 1) + '…';
}
