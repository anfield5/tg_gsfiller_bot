/**
 * GeminiActions.js
 * Builds the data dump + prompt for each Gemini Analysis selection type
 * (row / column / range) and calls GeminiApi.js. Never touches
 * DriveApp/SpreadsheetApp directly — goes through DataAccess.js only,
 * same layering rule as SheetActions.js.
 *
 * Prompt-building is shared (_buildRowPrompt_ / _buildColumnPrompt_ /
 * _buildRangePrompt_) so the same data dump can be sent to any modality:
 * actionAnalyze* asks Gemini to write text, actionNarrate* asks it to
 * speak the answer (audio), actionIllustrate* asks it to draw the answer
 * (image — not reachable yet, no free image model exists; see
 * GeminiApi.js DEFAULT_FREE_MODELS_ comment).
 */

/** Builds the prompt for analyzing a single row. */
function _buildRowPrompt_(fileId, sheetName, rowIndex, userPrompt) {
  const values  = getRowValues(fileId, sheetName, rowIndex);
  let headers = [];
  try { headers = actionGetHeaders(fileId, sheetName); } catch (e) { /* labels are best-effort */ }

  const lines = values.map((v, i) => (headers[i] || 'Column ' + (i + 1)) + ': ' + v);
  const dataBlock = 'Row ' + rowIndex + ' from sheet "' + sheetName + '":\n' + lines.join('\n');
  return _buildAnalysisPrompt_(dataBlock, userPrompt, false);
}

/** Builds the prompt for analyzing a whole column (capped at CONFIG.GEMINI_MAX_ROWS rows). */
function _buildColumnPrompt_(fileId, sheetName, colIndex, columnLabel, userPrompt) {
  const maxRows = (CONFIG && CONFIG.GEMINI_MAX_ROWS) || 500;
  const result  = getColumnValues(fileId, sheetName, colIndex, maxRows);

  const dataBlock = 'Column "' + columnLabel + '" from sheet "' + sheetName + '" (' +
    result.values.length + ' rows):\n' + result.values.join('\n');
  return _buildAnalysisPrompt_(dataBlock, userPrompt, result.truncated);
}

/** Builds the prompt for analyzing an arbitrary A1 range (capped at CONFIG.GEMINI_MAX_ROWS rows). */
function _buildRangePrompt_(fileId, sheetName, a1Range, userPrompt) {
  const maxRows = (CONFIG && CONFIG.GEMINI_MAX_ROWS) || 500;
  const result  = getRangeValues(fileId, sheetName, a1Range, maxRows);

  const dataBlock = 'Range ' + a1Range + ' from sheet "' + sheetName + '" (' +
    result.values.length + ' rows):\n' +
    result.values.map(row => row.join('\t')).join('\n');
  return _buildAnalysisPrompt_(dataBlock, userPrompt, result.truncated);
}

// ---------------------------------------------------------------------------
// Text analysis (default) — returns a string, sent as a plain-text message.
// ---------------------------------------------------------------------------

function actionAnalyzeRow(fileId, sheetName, rowIndex, userPrompt, model) {
  return callGemini_(_buildRowPrompt_(fileId, sheetName, rowIndex, userPrompt), model);
}

function actionAnalyzeColumn(fileId, sheetName, colIndex, columnLabel, userPrompt, model) {
  return callGemini_(_buildColumnPrompt_(fileId, sheetName, colIndex, columnLabel, userPrompt), model);
}

function actionAnalyzeRange(fileId, sheetName, a1Range, userPrompt, model) {
  return callGemini_(_buildRangePrompt_(fileId, sheetName, a1Range, userPrompt), model);
}

// ---------------------------------------------------------------------------
// Audio narration — returns a WAV Blob, sent via sendAudio. Only usable
// with TTS-capable models (currently gemini-2.5-flash-preview-tts).
// ---------------------------------------------------------------------------

function actionNarrateRow(fileId, sheetName, rowIndex, userPrompt, model) {
  return callGeminiAudio_(_buildRowPrompt_(fileId, sheetName, rowIndex, userPrompt), model);
}

function actionNarrateColumn(fileId, sheetName, colIndex, columnLabel, userPrompt, model) {
  return callGeminiAudio_(_buildColumnPrompt_(fileId, sheetName, colIndex, columnLabel, userPrompt), model);
}

function actionNarrateRange(fileId, sheetName, a1Range, userPrompt, model) {
  return callGeminiAudio_(_buildRangePrompt_(fileId, sheetName, a1Range, userPrompt), model);
}

// ---------------------------------------------------------------------------
// Image illustration — returns {blob, caption}, sent via sendPhoto. Not
// reachable from the model picker yet (see GeminiApi.js), implemented so
// wiring in a model later is a one-line allowlist change.
// ---------------------------------------------------------------------------

function actionIllustrateRow(fileId, sheetName, rowIndex, userPrompt, model) {
  return callGeminiImage_(_buildRowPrompt_(fileId, sheetName, rowIndex, userPrompt), model);
}

function actionIllustrateColumn(fileId, sheetName, colIndex, columnLabel, userPrompt, model) {
  return callGeminiImage_(_buildColumnPrompt_(fileId, sheetName, colIndex, columnLabel, userPrompt), model);
}

function actionIllustrateRange(fileId, sheetName, a1Range, userPrompt, model) {
  return callGeminiImage_(_buildRangePrompt_(fileId, sheetName, a1Range, userPrompt), model);
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
