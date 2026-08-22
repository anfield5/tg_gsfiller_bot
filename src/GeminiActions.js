/**
 * GeminiActions.js
 * Builds the data dump + prompt for each Gemini Analysis selection type
 * (row / column / range) and calls GeminiApi.js. Never touches
 * DriveApp/SpreadsheetApp directly — goes through DataAccess.js only,
 * same layering rule as SheetActions.js.
 */

/**
 * Analyzes a single row: fetches its values (labelled with headers where
 * available) and asks Gemini to follow the user's instructions.
 *
 * @param {string} fileId
 * @param {string} sheetName
 * @param {number} rowIndex
 * @param {string} userPrompt
 * @returns {string} Gemini's response text
 */
function actionAnalyzeRow(fileId, sheetName, rowIndex, userPrompt) {
  const values  = getRowValues(fileId, sheetName, rowIndex);
  let headers = [];
  try { headers = actionGetHeaders(fileId, sheetName); } catch (e) { /* labels are best-effort */ }

  const lines = values.map((v, i) => (headers[i] || 'Column ' + (i + 1)) + ': ' + v);
  const dataBlock = 'Row ' + rowIndex + ' from sheet "' + sheetName + '":\n' + lines.join('\n');

  return callGemini_(_buildAnalysisPrompt_(dataBlock, userPrompt, false));
}

/**
 * Analyzes a whole column (capped at CONFIG.GEMINI_MAX_ROWS rows).
 *
 * @param {string} fileId
 * @param {string} sheetName
 * @param {number} colIndex
 * @param {string} columnLabel  header text, for context in the prompt
 * @param {string} userPrompt
 * @returns {string}
 */
function actionAnalyzeColumn(fileId, sheetName, colIndex, columnLabel, userPrompt) {
  const maxRows = (CONFIG && CONFIG.GEMINI_MAX_ROWS) || 500;
  const result  = getColumnValues(fileId, sheetName, colIndex, maxRows);

  const dataBlock = 'Column "' + columnLabel + '" from sheet "' + sheetName + '" (' +
    result.values.length + ' rows):\n' + result.values.join('\n');

  return callGemini_(_buildAnalysisPrompt_(dataBlock, userPrompt, result.truncated));
}

/**
 * Analyzes an arbitrary A1 range (capped at CONFIG.GEMINI_MAX_ROWS rows).
 *
 * @param {string} fileId
 * @param {string} sheetName
 * @param {string} a1Range
 * @param {string} userPrompt
 * @returns {string}
 */
function actionAnalyzeRange(fileId, sheetName, a1Range, userPrompt) {
  const maxRows = (CONFIG && CONFIG.GEMINI_MAX_ROWS) || 500;
  const result  = getRangeValues(fileId, sheetName, a1Range, maxRows);

  const dataBlock = 'Range ' + a1Range + ' from sheet "' + sheetName + '" (' +
    result.values.length + ' rows):\n' +
    result.values.map(row => row.join('\t')).join('\n');

  return callGemini_(_buildAnalysisPrompt_(dataBlock, userPrompt, result.truncated));
}

/**
 * Wraps the raw data dump and the user's free-text instructions into a
 * single prompt. Any filtering the user wants ("only rows where Status is
 * Done", etc.) is just part of their instructions — Gemini applies it
 * itself rather than the bot pre-filtering rows.
 *
 * @param {string} dataBlock
 * @param {string} userPrompt
 * @param {boolean} truncated
 * @returns {string}
 */
function _buildAnalysisPrompt_(dataBlock, userPrompt, truncated) {
  const truncationNote = truncated
    ? '\n\n(Note: the data below was truncated to fit a safe request size — treat it as a partial sample, not the complete dataset.)'
    : '';
  return 'You are analyzing data exported from a Google Sheet. ' +
    'Follow the instructions exactly; if the instructions ask you to only ' +
    'consider a subset of rows (a filter, a condition, etc.), apply that ' +
    'yourself based on the data shown.\n\n' +
    'Instructions: ' + userPrompt + '\n\n' +
    'Data:\n' + dataBlock + truncationNote;
}
