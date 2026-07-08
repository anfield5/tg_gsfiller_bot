/**
 * SheetActions.js
 */

/**
 * Находит самое последнее заполненное значение в заданной колонке (1-based).
 * Игнорирует строку заголовков (строка 1).
 * @param {string} fileId
 * @param {string} sheetName
 * @param {number} colIndex 1-based index
 * @returns {{status: string, value: string|null}} статус 'empty_sheet', 'no_values' или 'found'
 */
function actionGetLastValueInColumn(fileId, sheetName, colIndex) {
  try {
    const sheet = _getSheet(fileId, sheetName);
    const lastRow = sheet.getLastRow();
    
    // Если в таблице только строка заголовков или вообще пусто
    if (lastRow < 2) {
      return { status: 'empty_sheet', value: null };
    }
    
    // Получаем все значения столбца начиная со 2-й строки
    const range = sheet.getRange(2, colIndex, lastRow - 1, 1);
    const values = range.getValues(); // Двумерный массив [[val1], [val2], ...]
    
    // Ищем снизу вверх первое непустое значение
    for (let i = values.length - 1; i >= 0; i--) {
      const val = String(values[i][0]).trim();
      if (val !== '') {
        return { status: 'found', value: val };
      }
    }
    
    return { status: 'no_values', value: null };
  } catch (e) {
    console.error('actionGetLastValueInColumn failed: ' + e);
    return { status: 'no_values', value: null };
  }
}

// --- Все остальные функции из старого SheetActions.js остаются без изменений ---
function actionListSpreadsheets(folderId, forceRefresh) {
  try { return listSpreadsheetsInFolder(folderId, forceRefresh); } catch (e) {
    console.error('actionListSpreadsheets failed: ' + e);
    throw new Error('Could not read that folder. It may have been moved or deleted.');
  }
}
function actionGetFolderName(folderId) {
  try { return getFolderInfo(folderId).name; } catch (e) {
    console.error('actionGetFolderName failed: ' + e);
    throw new Error('Could not read folder name.');
  }
}
function actionListSheets(fileId) {
  try { return listSheetsInFile(fileId); } catch (e) {
    console.error('actionListSheets failed: ' + e);
    throw new Error('Could not open that spreadsheet.');
  }
}
function actionGetHeaders(fileId, sheetName) {
  try {
    const headers = getHeaderRow(fileId, sheetName);
    if (headers.length === 0) throw new Error('This sheet has no header row (row 1 is empty).');
    return headers;
  } catch (e) {
    console.error('actionGetHeaders failed: ' + e);
    throw new Error('Could not read column headers: ' + e.message);
  }
}
function actionAddRow(fileId, sheetName, formData, headers) {
  try {
    const values = headers.map((h) => (formData[h] !== undefined ? formData[h] : ''));
    appendRowToSheet(fileId, sheetName, values);
  } catch (e) {
    console.error('actionAddRow failed: ' + e);
    throw new Error('Failed to save the row. Please try again.');
  }
}
function actionGetLastRows(fileId, sheetName, n) {
  try { return getLastRows(fileId, sheetName, n); } catch (e) {
    console.error('actionGetLastRows failed: ' + e);
    throw new Error('Could not read rows from this sheet.');
  }
}
function actionGetRowValues(fileId, sheetName, rowIndex) {
  try { return getRowValues(fileId, sheetName, rowIndex); } catch (e) {
    console.error('actionGetRowValues failed: ' + e);
    throw new Error('Could not read that row.');
  }
}
function actionUpdateCell(fileId, sheetName, rowIndex, colIndex, value) {
  try { updateCell(fileId, sheetName, rowIndex, colIndex, value); } catch (e) {
    console.error('actionUpdateCell failed: ' + e);
    throw new Error('Failed to save the change. Please try again.');
  }
}
function actionGetSheetGid(fileId, sheetName) {
  try { return getSheetGid(fileId, sheetName); } catch (e) {
    console.error('actionGetSheetGid failed: ' + e);
    throw new Error('Could not resolve sheet tab.');
  }
}
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
  const range = 'A' + startRow + ':' + endColLetter + endRow;
  return 'https://docs.google.com/spreadsheets/d/' + fileId + '/edit#gid=' + gid + '&range=' + range;
}
function formatPreview(value, maxLen) {
  const s = value === null || value === undefined ? '' : String(value);
  if (s.length === 0) return '(empty)';
  if (s.length <= maxLen) return s;
  return s.substring(0, maxLen - 1) + '…';
}

/**
 * Formats the last 5 rows and first 4 columns into a clean text preview for Telegram,
 * and appends a direct link to this specific Google Sheets range.
 */
function actionBuildPreviewText(fileId, sheetName) {
  try {
    const maxRows = 5;
    const maxCols = 4;
    
    const headers = actionGetHeaders(fileId, sheetName).slice(0, maxCols);
    const rows = actionGetLastRows(fileId, sheetName, maxRows);

    if (rows.length === 0) {
      return "📊 <b>Sheet:</b> " + sheetName + "\n\n" + "⚠️ <i>This sheet is empty (no data found outside headers).</i>";
    }

    let text = "📊 <b>Recent " + rows.length + " rows in " + sheetName + " (First " + maxCols + " columns):</b>\n\n";

    // Build rows preview (newest first)
    rows.forEach((row) => {
      text += "🔹 <b>Row #" + row.rowIndex + "</b>\n";
      headers.forEach((h, colIdx) => {
        let val = row.values[colIdx] !== undefined ? String(row.values[colIdx]).trim() : "";
        
        // Truncate value to 20 characters if it's too long
        if (val.length > 20) {
          val = val.substring(0, 17) + "...";
        }
        
        if (val.length > 0) {
          text += "• <i>" + h + ":</i> " + val + "\n";
        }
      });
      text += "\n";
    });

    // Generate direct link to the exact range of these rows
    try {
      const gid = actionGetSheetGid(fileId, sheetName);
      const minRow = Math.min(...rows.map(r => r.rowIndex));
      const maxRow = Math.max(...rows.map(r => r.rowIndex));
      
      // Reusing your native URL builder from Navigation.js structure
      const rangeLink = buildSheetRangeUrl(fileId, gid, minRow, maxRow, maxCols);
      text += "🔗 <a href=\"" + rangeLink + "\">Open this range in Google Sheets</a>";
    } catch (urlError) {
      console.error("Failed to build range URL for preview: " + urlError);
      // Fallback to basic file link if range builder fails
      text += "🔗 <a href=\"https://docs.google.com/spreadsheets/d/" + fileId + "/edit#gid=0\">Open Spreadsheet</a>";
    }

    return text;
  } catch (e) {
    console.error("actionBuildPreviewText failed: " + e);
    return "❌ <i>Failed to generate data preview for this sheet.</i>";
  }
}