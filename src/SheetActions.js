/**
 * SheetActions.js
 * Advanced spreadsheet manipulation handling formulas and merged headers.
 */

/**
 * Checks whether a target cell evaluates data using a formula.
 */
function isCellFormula(fileId, sheetName, row, col) {
  try {
    const sheet = _getSheet(fileId, sheetName);
    const range = sheet.getRange(row, col);
    const formula = range.getFormula();
    return !!(formula && formula.toString().trim().startsWith('='));
  } catch (e) {
    console.error('isCellFormula engine lookup failed: ' + e);
    return false;
  }
}

/**
 * Robust header parser that respects multi-row or merged header layouts.
 * Maps exact columns 1-to-1 to prevent shifted fields.
 */
function actionGetHeaders(fileId, sheetName) {
  try {
    const sheet = _getSheet(fileId, sheetName);
    const maxCols = sheet.getLastColumn();
    if (maxCols === 0) return [];

    // Reading rows 1 and 2 to look for nested headers
    const range = sheet.getRange(1, 1, 2, maxCols);
    const values = range.getValues();
    const mergedRanges = sheet.getRange(1, 1, 2, maxCols).getMergedRanges();

    const headers = [];

    for (let col = 1; col <= maxCols; col++) {
      let topHeader = String(values[0][col - 1]).trim();
      let bottomHeader = String(values[1][col - 1]).trim();

      // Resolve text if the column falls inside an actively merged range
      mergedRanges.forEach((mr) => {
        if (mr.getRow() <= 2 && col >= mr.getColumn() && col <= mr.getLastColumn()) {
          const displayCell = mr.getCell(1, 1);
          if (mr.getRow() === 1 && mr.getLastRow() === 1) {
            topHeader = String(displayCell.getValue()).trim();
          }
        }
      });

      // Construct a clean singular label for the column
      let finalLabel = "";
      if (topHeader && bottomHeader && topHeader !== bottomHeader) {
        finalLabel = topHeader + " (" + bottomHeader + ")";
      } else {
        finalLabel = topHeader || bottomHeader || ("Column " + col);
      }

      headers.push(finalLabel);
    }

    return headers;
  } catch (e) {
    console.error('actionGetHeaders failed: ' + e);
    throw new Error('Could not read column headers cleanly: ' + e.message);
  }
}

/**
 * Saves a new row data, explicitly replicating formulas and cell merges from the row above.
 */
function actionAddRow(fileId, sheetName, formData, headers) {
  try {
    const sheet = _getSheet(fileId, sheetName);
    const templateRow = sheet.getLastRow();
    const targetRow = templateRow + 1;

    // 1. Insert data array mapping literal values
    const dataValues = headers.map((h) => {
      const val = formData[h];
      return (val === '🧬 (Calculated Formula)' || val === undefined) ? '' : val;
    });
    
    sheet.appendRow(dataValues);

    // 2. Scan template row for formulas and replicate them matching autofill mechanics
    for (let col = 1; col <= headers.length; col++) {
      if (isCellFormula(fileId, sheetName, templateRow, col)) {
        const sourceRange = sheet.getRange(templateRow, col);
        const targetRange = sheet.getRange(targetRow, col);
        sourceRange.copyTo(targetRange, SpreadsheetApp.CopyPasteType.PASTE_FORMULA, false);
      }
    }

    // 3. Mirror merged cells (like МІСЦЕ ГРИ columns D & E) from the template row
    const templateRange = sheet.getRange(templateRow, 1, 1, headers.length);
    const mergedRanges = templateRange.getMergedRanges();

    mergedRanges.forEach((mergedRange) => {
      const firstCol = mergedRange.getColumn();
      const lastCol = mergedRange.getLastColumn();
      const numCols = lastCol - firstCol + 1;

      // If there's a horizontal merge in the template row, mirror it to the target row
      if (numCols > 1) {
        const targetMergeRange = sheet.getRange(targetRow, firstCol, 1, numCols);
        targetMergeRange.merge();
      }
    });

  } catch (e) {
    console.error('actionAddRow failed: ' + e);
    throw new Error('Failed to save row dynamically: ' + e.message);
  }
}

function actionGetLastValueInColumn(fileId, sheetName, colIndex) {
  try {
    const sheet = _getSheet(fileId, sheetName);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { status: 'empty_sheet', value: null };
    const range = sheet.getRange(2, colIndex, lastRow - 1, 1);
    const values = range.getValues(); 
    for (let i = values.length - 1; i >= 0; i--) {
      const val = String(values[i][0]).trim();
      if (val !== '') return { status: 'found', value: val };
    }
    return { status: 'no_values', value: null };
  } catch (e) { return { status: 'no_values', value: null }; }
}

function actionListSpreadsheets(folderId, forceRefresh) { return listSpreadsheetsInFolder(folderId, forceRefresh); }
function actionGetFolderName(folderId) { return getFolderInfo(folderId).name; }
function actionListSheets(fileId) { return listSheetsInFile(fileId); }
function actionGetLastRows(fileId, sheetName, n) { return getLastRows(fileId, sheetName, n); }
function actionGetRowValues(fileId, sheetName, rowIndex) { return getRowValues(fileId, sheetName, rowIndex); }
function actionUpdateCell(fileId, sheetName, rowIndex, colIndex, value) { updateCell(fileId, sheetName, rowIndex, colIndex, value); }
function actionGetSheetGid(fileId, sheetName) { return getSheetGid(fileId, sheetName); }

function columnNumberToLetter(n) {
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function buildSheetRangeUrl(fileId, gid, startRow, endRow, numCols) {
  const endColLetter = columnNumberToLetter(numCols);
  return 'https://docs.google.com/spreadsheets/d/' + fileId + '/edit#gid=' + gid + '&range=A' + startRow + ':' + endColLetter + endRow;
}

function formatPreview(value, maxLen) {
  const s = value === null || value === undefined ? '' : String(value);
  if (s.length === 0) return '(empty)';
  if (s.length <= maxLen) return s;
  return s.substring(0, maxLen - 1) + '…';
}

function actionBuildPreviewText(fileId, sheetName) {
  try {
    const maxRows = 5; const maxCols = 4;
    const headers = actionGetHeaders(fileId, sheetName).slice(0, maxCols);
    const rows = actionGetLastRows(fileId, sheetName, maxRows);
    if (rows.length === 0) return "📊 <b>Sheet:</b> " + sheetName + "\n\n⚠️ <i>Empty.</i>";
    let text = "📊 <b>Recent " + rows.length + " rows in " + sheetName + ":</b>\n\n";
    rows.forEach((row) => {
      text += "🔹 <b>Row #" + row.rowIndex + "</b>\n";
      headers.forEach((h, colIdx) => {
        let val = row.values[colIdx] !== undefined ? String(row.values[colIdx]).trim() : "";
        if (val.length > 20) val = val.substring(0, 17) + "...";
        if (val.length > 0) text += "• <i>" + h + ":</i> " + val + "\n";
      });
      text += "\n";
    });
    const gid = actionGetSheetGid(fileId, sheetName);
    const minRow = Math.min(...rows.map(r => r.rowIndex));
    const maxRow = Math.max(...rows.map(r => r.rowIndex));
    text += "🔗 <a href=\"" + buildSheetRangeUrl(fileId, gid, minRow, maxRow, maxCols) + "\">Open Range</a>";
    return text;
  } catch (e) { return "❌ <i>Failed preview.</i>"; }
}