/**
 * SheetActions.js
 * Business-logic layer for spreadsheet operations.
 * Calls DataAccess.js exclusively — never touches DriveApp/SpreadsheetApp directly.
 */

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

/**
 * Parses column headers from however many rows are frozen at the top of the
 * sheet (Sheet.getFrozenRows()) — not a fixed guess — so a single-row header
 * and a multi-row header both resolve correctly without misreading a data
 * row as part of the header. A sheet with no frozen rows still needs *some*
 * header, so that case falls back to row 1 alone. Merged cells in row 1 are
 * resolved so that every column they span maps to one consistent label.
 *
 * Label rules (per column, across all frozen rows top to bottom):
 *   - Merged row-1 cell: use its text for all columns it spans
 *   - Blank rows are dropped; an exact repeat keeps only its first occurrence
 *   - One distinct value left: use it
 *   - 2+ distinct values left: "First (Second, Third, ...)"
 *   - Nothing left (every frozen row blank for this column): "Column N"
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
    // We need direct Sheet access here for the frozen-row + merge read.
    // _getSheet_ is a DataAccess private but accessible within the same GAS project.
    const sheet   = _getSheet_(fileId, sheetName);
    const maxCols = sheet.getLastColumn();
    if (maxCols === 0) return [];

    const frozenRows   = Math.max(1, sheet.getFrozenRows());
    const range        = sheet.getRange(1, 1, frozenRows, maxCols);
    const values       = range.getValues();
    const mergedRanges = range.getMergedRanges();

    const headers = [];

    for (let col = 1; col <= maxCols; col++) {
      const rowTexts = [];

      for (let row = 1; row <= frozenRows; row++) {
        let text = String(values[row - 1][col - 1]).trim();

        // A row-1 merge spanning columns anchors every column it covers to
        // the same text. Merges below row 1 aren't resolved — same scope
        // this had before, just no longer tied to a hardcoded 2-row read.
        if (row === 1) {
          mergedRanges.forEach(mr => {
            if (mr.getRow() <= 1 && col >= mr.getColumn() && col <= mr.getLastColumn()) {
              text = String(mr.getCell(1, 1).getValue()).trim();
            }
          });
        }

        rowTexts.push(text);
      }

      headers.push(_combineHeaderRowTexts_(rowTexts, col));
    }

    try { cache.put(cacheKey, JSON.stringify(headers), 120); } catch (e) { /* ignore */ }
    return headers;
  } catch (e) {
    logError_('actionGetHeaders failed: ' + e);
    throw new Error('Could not read column headers: ' + e.message);
  }
}

/**
 * Combines one column's text across every frozen header row into a single
 * label — see actionGetHeaders' label rules above. A direct generalization
 * of the old hardcoded "Top (Bottom)" 2-row rule to however many rows are
 * actually frozen.
 * @param {string[]} rowTexts  trimmed cell text, one per frozen row, top to bottom
 * @param {number}   col       1-based column number, for the "Column N" fallback
 * @returns {string}
 */
function _combineHeaderRowTexts_(rowTexts, col) {
  const distinct = [];
  rowTexts.forEach(text => {
    if (text && distinct.indexOf(text) === -1) distinct.push(text);
  });

  if (distinct.length === 0) return 'Column ' + col;
  if (distinct.length === 1) return distinct[0];
  return distinct[0] + ' (' + distinct.slice(1).join(', ') + ')';
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
    const placeholder = formulaPlaceholderText_();
    const dataValues = headers.map(h => {
      const val = formData[h];
      return (val === placeholder || val === undefined) ? '' : val;
    });

    appendRowToSheet(fileId, sheetName, dataValues);

    // After appendRow the new row is always sheet.getLastRow().
    // We need to know the template row (the row just before the new one).
    const sheet       = _getSheet_(fileId, sheetName);
    const targetRow   = sheet.getLastRow();
    const templateRow = targetRow - 1;
    if (templateRow < 2) return; // nothing to replicate from (row 1 is headers)

    // --- 2. Copy formulas from the template row ---
    // One batched read for the whole row instead of one isCellFormula()
    // Sheets API call per column — meaningful for wide sheets, since this
    // used to be N calls just to find out WHICH columns need copying.
    const formulaFlags = getRowFormulaFlags(fileId, sheetName, templateRow, headers.length);
    formulaFlags.forEach((hasFormula, i) => {
      if (hasFormula) copyFormulaDown(fileId, sheetName, templateRow, targetRow, i + 1);
    });

    // --- 3. Mirror horizontal merges from the template row ---
    const merges = getRowMergedRanges(fileId, sheetName, templateRow, headers.length);
    merges.forEach(m => {
      const numCols = m.lastCol - m.firstCol + 1;
      if (numCols > 1) {
        mergeRowRange(fileId, sheetName, targetRow, m.firstCol, numCols);
      }
    });
  } catch (e) {
    logError_('actionAddRow failed: ' + e);
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

/**
 * Looks at the last `lookbackRows` values of a single column and returns
 * the `topN` most frequently occurring non-empty ones, most common first.
 * Used by the add-row flow's "Recent TOP3 values" button — a quick,
 * copy-pasteable suggestion list for fields that tend to repeat a small
 * set of values (statuses, categories, names, etc.).
 *
 * @param {string} fileId
 * @param {string} sheetName
 * @param {number} colIndex      1-based
 * @param {number} [lookbackRows] how many recent rows to sample (default 10)
 * @param {number} [topN]         how many values to return (default 3)
 * @returns {string[]}
 */
function actionTopFrequentColumnValues(fileId, sheetName, colIndex, lookbackRows, topN) {
  const values = getLastColumnValues(fileId, sheetName, colIndex, lookbackRows || 10);
  return _topFrequentValues_(values, topN || 3);
}

/**
 * Ranks values by occurrence count, most frequent first. Ties keep
 * first-seen order (Array.prototype.sort is stable in the V8 runtime both
 * Apps Script and Node use). Empty/whitespace-only values are ignored —
 * they're not a useful "suggestion".
 *
 * @param {Array<*>} values
 * @param {number} topN
 * @returns {string[]}
 */
function _topFrequentValues_(values, topN) {
  const counts = {};
  const order  = []; // first-seen order, used for stable tie-breaking

  values.forEach(function (v) {
    const key = String(v === null || v === undefined ? '' : v).trim();
    if (!key) return;
    if (!(key in counts)) {
      counts[key] = 0;
      order.push(key);
    }
    counts[key]++;
  });

  return order
    .sort(function (a, b) { return counts[b] - counts[a]; })
    .slice(0, topN);
}
function actionUpdateCell(fileId, sheetName, rowIndex, colIndex, value) {
  updateCell(fileId, sheetName, rowIndex, colIndex, value);
}
function actionGetSheetGid(fileId, sheetName) { return getSheetGid(fileId, sheetName); }

// ---------------------------------------------------------------------------
// UI / formatting helpers
// ---------------------------------------------------------------------------

/**
 * Builds a short HTML preview of the last few rows for the Preview action.
 * All dynamic content is escaped — sheetName and cell values come straight
 * from user data and are sent with parse_mode: 'HTML'.
 * @param {string} fileId
 * @param {string} sheetName
 * @returns {string} HTML-formatted Telegram message
 */
function actionBuildPreviewText(fileId, sheetName) {
  const icons = getIcons_();
  try {
    const MAX_ROWS = 5;
    const MAX_COLS = 4;
    const headers = actionGetHeaders(fileId, sheetName).slice(0, MAX_COLS);
    const rows    = actionGetLastRows(fileId, sheetName, MAX_ROWS);

    if (rows.length === 0) {
      return icons.CHART + ' <b>Sheet:</b> ' + escapeHtml_(sheetName) +
             '\n\n' + icons.WARNING + ' <i>No data rows found.</i>';
    }

    let text = icons.CHART + ' <b>Last ' + rows.length + ' rows — ' + escapeHtml_(sheetName) + ':</b>\n\n';
    rows.forEach(row => {
      text += icons.BULLET + ' <b>Row #' + row.rowIndex + '</b>\n';
      headers.forEach((h, colIdx) => {
        let val = (row.values[colIdx] !== undefined) ? String(row.values[colIdx]).trim() : '';
        if (val.length > 20) val = val.substring(0, 17) + '…';
        if (val.length > 0) text += '• <i>' + escapeHtml_(h) + ':</i> ' + escapeHtml_(val) + '\n';
      });
      text += '\n';
    });

    const gid    = actionGetSheetGid(fileId, sheetName);
    const minRow = Math.min.apply(null, rows.map(r => r.rowIndex));
    const maxRow = Math.max.apply(null, rows.map(r => r.rowIndex));
    text += icons.LINK + ' <a href="' + buildSheetRangeUrl(fileId, gid, minRow, maxRow, MAX_COLS) + '">Open in Google Sheets</a>';
    return text;
  } catch (e) {
    return icons.CANCEL + ' <i>Preview failed: ' + escapeHtml_(e.message) + '</i>';
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
