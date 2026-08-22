'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createProject } = require('./harness');

function geminiPayload(text) {
  return JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] });
}

function setupProject() {
  const sheet = {
    name: 'Sheet1',
    values: [
      ['Name', 'Total'],
      ['', ''],
      ['Alice', '100'],
      ['Bob', '200'],
    ],
  };
  return createProject({
    CONFIG: {
      FOLDER_IDS: ['folderA'], FOLDER_LABELS: ['Test Folder'], FILES_PER_PAGE: 10,
      FOLDER_CACHE_TTL_SECONDS: 300, FOLDER_SCAN_DEPTH: 1, GEMINI_MAX_ROWS: 500,
    },
    DriveApp: { folderA: { name: 'Test Folder', files: [{ id: 'file1', name: 'Test Sheet' }], folders: {} } },
    SpreadsheetApp: { file1: { sheets: [sheet] } },
    initialProperties: { ADMIN_IDS: '111' },
  });
}

function lastCallBody(urlFetch) {
  return urlFetch.calls[urlFetch.calls.length - 1].body;
}

function keyboardLabels(body) {
  const rows = (body.reply_markup && body.reply_markup.keyboard) || [];
  return rows.flat().map((b) => b.text);
}

function keyboardOptions(state) {
  return state.currentOptions || [];
}

test('Gemini Analysis button appears on the tab-list screen, before Fav Doc', () => {
  const { context } = setupProject();
  const chatId = '111';
  context.setState(chatId, {
    step: 'sheet_list', folderIndex: 0, folderId: 'folderA', folderName: 'Test Folder',
    fileId: 'file1', fileName: 'Test Sheet',
  });
  context.renderSheetList(chatId, context.getState(chatId), null);

  const options = keyboardOptions(context.getState(chatId));
  const values = options.map((o) => o.value);
  const geminiIdx = values.indexOf('gemini');
  const favIdx = values.indexOf('favdoc');

  assert.ok(geminiIdx >= 0, 'Gemini Analysis button should be present');
  assert.ok(favIdx >= 0, 'Fav Doc button should be present');
  assert.ok(geminiIdx < favIdx, 'Gemini Analysis must come before Fav Doc');
});

test('full flow: pick sheet -> Column -> pick column -> prompt -> Gemini result sent as plain text', () => {
  const { context, urlFetch } = setupProject();
  const chatId = '111';
  context.setState(chatId, {
    step: 'sheet_list', folderIndex: 0, folderId: 'folderA', folderName: 'Test Folder',
    fileId: 'file1', fileName: 'Test Sheet',
  });

  context.handleGeminiStart(chatId);
  assert.equal(context.getState(chatId).step, 'gemini_pick_sheet');

  context.handleGeminiSheetSelect(chatId, 0);
  assert.equal(context.getState(chatId).geminiSheetName, 'Sheet1');
  assert.equal(context.getState(chatId).step, 'gemini_pick_type');

  context.handleGeminiTypeSelect(chatId, 'column');
  assert.equal(context.getState(chatId).step, 'gemini_pick_column');
  let labels = keyboardOptions(context.getState(chatId)).map((o) => o.label);
  assert.ok(labels.includes('Name') && labels.includes('Total'));

  context.handleGeminiColumnSelect(chatId, 1); // "Total"
  assert.equal(context.getState(chatId).geminiColLabel, 'Total');
  assert.equal(context.getState(chatId).step, 'gemini_wait_prompt');

  // Mock the Gemini HTTP call once the prompt is submitted.
  urlFetch.fetch = (url, options) => {
    urlFetch.calls.push({ url, options, body: JSON.parse(options.payload) });
    return { getResponseCode: () => 200, getContentText: () => geminiPayload('Total looks fine.') };
  };

  context.handleGeminiPromptInput(chatId, context.getState(chatId), 'Sanity check the totals');

  const resultCall = urlFetch.calls.find((c) => c.body && c.body.text === 'Total looks fine.');
  assert.ok(resultCall, 'the Gemini result should have been sent back to the chat');
  assert.equal(resultCall.body.parse_mode, undefined, 'model output must be sent WITHOUT parse_mode (never trusted as HTML)');

  // Flow should land back on the sheet menu for the analyzed tab, with gemini-* scratch state cleared.
  const finalState = context.getState(chatId);
  assert.equal(finalState.step, 'sheet_menu');
  assert.equal(finalState.sheetName, 'Sheet1');
  assert.equal(finalState.geminiSheetName, undefined);
  assert.equal(finalState.geminiColIndex, undefined);
});

test('Row type: rejects row 1 (header) and a non-numeric row, accepts a valid row', () => {
  const { context, urlFetch } = setupProject();
  const chatId = '111';
  context.setState(chatId, {
    step: 'sheet_list', folderIndex: 0, folderId: 'folderA', folderName: 'Test Folder',
    fileId: 'file1', fileName: 'Test Sheet',
  });
  context.handleGeminiStart(chatId);
  context.handleGeminiSheetSelect(chatId, 0);
  context.handleGeminiTypeSelect(chatId, 'row');
  assert.equal(context.getState(chatId).step, 'gemini_wait_row');

  context.handleGeminiRowInput(chatId, context.getState(chatId), 'abc');
  assert.equal(context.getState(chatId).step, 'gemini_wait_row', 'non-numeric input must not advance the flow');

  context.handleGeminiRowInput(chatId, context.getState(chatId), '1');
  assert.equal(context.getState(chatId).step, 'gemini_wait_row', 'row 1 (header) must be rejected');

  urlFetch.fetch = (url, options) => {
    urlFetch.calls.push({ url, options, body: JSON.parse(options.payload) });
    return { getResponseCode: () => 200, getContentText: () => geminiPayload('Row analyzed.') };
  };

  context.handleGeminiRowInput(chatId, context.getState(chatId), '3');
  assert.equal(context.getState(chatId).step, 'gemini_wait_prompt');

  context.handleGeminiPromptInput(chatId, context.getState(chatId), 'Describe this row');
  // Three Telegram calls happen here in order: the "Analyzing..." status
  // message, the Gemini API request itself (recognisable by .body.contents),
  // then the final result message — so pick the Gemini request specifically
  // rather than assuming it's the last call.
  const geminiCall = urlFetch.calls.find((c) => c.body && c.body.contents);
  const sentPrompt = geminiCall.body.contents[0].parts[0].text;
  assert.match(sentPrompt, /Name: Alice/);
});

test('Range type: an unparseable range surfaces an error and still returns to the sheet menu', () => {
  const { context, urlFetch } = setupProject();
  const chatId = '111';
  context.setState(chatId, {
    step: 'sheet_list', folderIndex: 0, folderId: 'folderA', folderName: 'Test Folder',
    fileId: 'file1', fileName: 'Test Sheet',
  });
  context.handleGeminiStart(chatId);
  context.handleGeminiSheetSelect(chatId, 0);
  context.handleGeminiTypeSelect(chatId, 'range');
  context.handleGeminiRangeInput(chatId, context.getState(chatId), 'not-a-range');
  assert.equal(context.getState(chatId).step, 'gemini_wait_prompt');

  context.handleGeminiPromptInput(chatId, context.getState(chatId), 'Analyze this');

  const warningCall = [...urlFetch.calls].reverse().find((c) => c.body && /Could not understand range/.test(c.body.text || ''));
  assert.ok(warningCall, 'an error message about the bad range should have been sent');
  assert.equal(context.getState(chatId).step, 'sheet_menu', 'flow should still land back on the sheet menu after an error');
});

test('Cancel at the sheet-picker step returns to the tab list, not the sheet menu', () => {
  const { context, urlFetch } = setupProject();
  const chatId = '111';
  context.setState(chatId, {
    step: 'sheet_list', folderIndex: 0, folderId: 'folderA', folderName: 'Test Folder',
    fileId: 'file1', fileName: 'Test Sheet',
  });
  context.handleGeminiStart(chatId);
  context.handleGeminiCancel(chatId);

  // The tab-list screen re-renders (button-driven screens in this app don't
  // rigorously track state.step — only free-text steps rely on it — so we
  // assert on what was actually shown instead of the step value).
  const tabsCall = [...urlFetch.calls].reverse().find((c) => c.body && /^Tabs in/.test(c.body.text || ''));
  assert.ok(tabsCall, 'cancelling should redisplay the tab list, not the sheet menu');
  const options = context.getState(chatId).currentOptions || [];
  assert.ok(options.some((o) => o.value === 'gemini'), 'the tab list (with its Gemini Analysis button) should be showing again');
  assert.equal(context.getState(chatId).geminiSheetName, undefined, 'gemini scratch state must be cleared on cancel');
});
