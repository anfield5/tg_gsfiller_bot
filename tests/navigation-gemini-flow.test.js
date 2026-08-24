'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createProject } = require('./harness');

function geminiPayload(text) {
  return JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] });
}

// Raw ListModels-shaped entries for the models used across these tests —
// handleGeminiStart now always fetches+picks a model before anything else,
// so every test needs the ListModels endpoint mocked, not just generateContent.
function rawTextModel(name, displayName) {
  return { name: 'models/' + name, displayName, description: 'cost-efficient', supportedGenerationMethods: ['generateContent'] };
}
function rawAudioModel(name, displayName) {
  return { name: 'models/' + name, displayName, description: 'text to speech', supportedGenerationMethods: ['generateContent'] };
}

/**
 * Routes the mock UrlFetchApp by URL: GET .../models?... (ListModels) gets
 * `models`, POST .../generateContent gets `generateReply` (as a Gemini
 * text-response payload). Call this before context.handleGeminiStart(...)
 * in any test that needs to get past the model picker.
 */
// Some payloads (sendAudio/sendPhoto's multipart-style { chat_id, audio: blob })
// are plain objects, not JSON strings — only try to parse string payloads,
// same as the real Telegram/Gemini calls this app makes.
function parseBody(options) {
  if (!options || typeof options.payload !== 'string') return null;
  try { return JSON.parse(options.payload); } catch (e) { return null; }
}

function mockGeminiApi(urlFetch, { models, generateReply }) {
  urlFetch.fetch = (url, options) => {
    urlFetch.calls.push({ url, options, body: parseBody(options) });
    if (/\/models\?/.test(url)) {
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ models }) };
    }
    return { getResponseCode: () => 200, getContentText: () => geminiPayload(generateReply || 'ok') };
  };
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

function startAtSheetList(context, chatId) {
  context.setState(chatId, {
    step: 'sheet_list', folderIndex: 0, folderId: 'folderA', folderName: 'Test Folder',
    fileId: 'file1', fileName: 'Test Sheet',
  });
}

function keyboardOptions(state) {
  return state.currentOptions || [];
}

/** Runs handleGeminiStart + picks model index 0, landing on 'gemini_pick_sheet'. */
function pickFirstModel(context, chatId) {
  context.handleGeminiStart(chatId);
  assert.equal(context.getState(chatId).step, 'gemini_pick_model');
  context.handleGeminiModelSelect(chatId, 0);
}

test('Gemini Analysis button appears on the tab-list screen, before Fav Doc', () => {
  const { context } = setupProject();
  const chatId = '111';
  startAtSheetList(context, chatId);
  context.renderSheetList(chatId, context.getState(chatId), null);

  const options = keyboardOptions(context.getState(chatId));
  const values = options.map((o) => o.value);
  const geminiIdx = values.indexOf('gemini');
  const favIdx = values.indexOf('favdoc');

  assert.ok(geminiIdx >= 0, 'Gemini Analysis button should be present');
  assert.ok(favIdx >= 0, 'Fav Doc button should be present');
  assert.ok(geminiIdx < favIdx, 'Gemini Analysis must come before Fav Doc');
});

test('model picker: groups models by category, lets you pick one, and carries the choice forward', () => {
  const { context, urlFetch } = setupProject();
  const chatId = '111';
  startAtSheetList(context, chatId);
  mockGeminiApi(urlFetch, {
    models: [rawTextModel('gemini-3.6-flash', 'Gemini 3.6 Flash'), rawTextModel('gemini-2.5-pro', 'Gemini 2.5 Pro')],
  });

  context.handleGeminiStart(chatId);
  const state = context.getState(chatId);
  assert.equal(state.step, 'gemini_pick_model');
  assert.equal(state.geminiModelChoices.length, 2);

  context.handleGeminiModelSelect(chatId, 0);
  const afterState = context.getState(chatId);
  assert.equal(afterState.geminiModel, state.geminiModelChoices[0].name);
  assert.equal(afterState.geminiModality, 'text');
  assert.equal(afterState.geminiModelChoices, undefined, 'the choice list is discarded once a model is picked');
  assert.equal(afterState.step, 'gemini_pick_sheet');
});

test('model picker Refresh button clears the cache and re-fetches', () => {
  const { context, urlFetch } = setupProject();
  const chatId = '111';
  startAtSheetList(context, chatId);
  mockGeminiApi(urlFetch, { models: [rawTextModel('gemini-3.6-flash', 'Gemini 3.6 Flash')] });

  context.handleGeminiStart(chatId);
  const listCallsBefore = urlFetch.calls.filter((c) => /\/models\?/.test(c.url)).length;
  context.handleGeminiModelRefresh(chatId);
  const listCallsAfter = urlFetch.calls.filter((c) => /\/models\?/.test(c.url)).length;

  assert.equal(listCallsBefore, 1);
  assert.equal(listCallsAfter, 2, 'Refresh must bypass the cache and hit ListModels again');
  assert.equal(context.getState(chatId).step, 'gemini_pick_model');
});

test('model picker warns when a model was recently overloaded (503) but still lets it be picked', () => {
  const { context, urlFetch } = setupProject();
  const chatId = '111';
  startAtSheetList(context, chatId);
  context._markGeminiModelOverloaded_('gemini-3.6-flash');
  mockGeminiApi(urlFetch, { models: [rawTextModel('gemini-3.6-flash', 'Gemini 3.6 Flash')] });

  context.handleGeminiStart(chatId);
  const options = keyboardOptions(context.getState(chatId));
  const modelOption = options.find((o) => o.value === 'gemini_model:0');
  assert.match(modelOption.label, /busy/);

  // Still selectable despite the warning.
  context.handleGeminiModelSelect(chatId, 0);
  assert.equal(context.getState(chatId).geminiModel, 'gemini-3.6-flash');
});

test('model picker surfaces a friendly error and falls back to the tab list if ListModels fails', () => {
  const { context, urlFetch } = setupProject();
  const chatId = '111';
  startAtSheetList(context, chatId);
  urlFetch.fetch = (url, options) => {
    urlFetch.calls.push({ url, options, body: parseBody(options) });
    return { getResponseCode: () => 500, getContentText: () => 'boom' };
  };

  context.handleGeminiStart(chatId);
  const warningCall = [...urlFetch.calls].reverse().find((c) => c.body && /Failed to fetch Gemini model list/.test(c.body.text || ''));
  assert.ok(warningCall, 'a warning about the failed model fetch should have been sent');
});

test('full flow: pick model -> pick sheet -> Column -> pick column -> prompt -> Gemini result sent as plain text', () => {
  const { context, urlFetch } = setupProject();
  const chatId = '111';
  startAtSheetList(context, chatId);
  mockGeminiApi(urlFetch, {
    models: [rawTextModel('gemini-3.6-flash', 'Gemini 3.6 Flash')],
    generateReply: 'Total looks fine.',
  });

  pickFirstModel(context, chatId);
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
  assert.equal(finalState.geminiModel, undefined);
});

test('Row type: rejects row 1 (header) and a non-numeric row, accepts a valid row', () => {
  const { context, urlFetch } = setupProject();
  const chatId = '111';
  startAtSheetList(context, chatId);
  mockGeminiApi(urlFetch, { models: [rawTextModel('gemini-3.6-flash', 'Gemini 3.6 Flash')], generateReply: 'Row analyzed.' });

  pickFirstModel(context, chatId);
  context.handleGeminiSheetSelect(chatId, 0);
  context.handleGeminiTypeSelect(chatId, 'row');
  assert.equal(context.getState(chatId).step, 'gemini_wait_row');

  context.handleGeminiRowInput(chatId, context.getState(chatId), 'abc');
  assert.equal(context.getState(chatId).step, 'gemini_wait_row', 'non-numeric input must not advance the flow');

  context.handleGeminiRowInput(chatId, context.getState(chatId), '1');
  assert.equal(context.getState(chatId).step, 'gemini_wait_row', 'row 1 (header) must be rejected');

  context.handleGeminiRowInput(chatId, context.getState(chatId), '3');
  assert.equal(context.getState(chatId).step, 'gemini_wait_prompt');

  context.handleGeminiPromptInput(chatId, context.getState(chatId), 'Describe this row');
  // Several Telegram/Gemini calls happen here in order (the ListModels call
  // from pickFirstModel, the "Analyzing..." status message, the Gemini
  // generateContent request itself, then the final result message) — so
  // pick the generateContent request specifically rather than assuming
  // it's at a fixed index.
  const geminiCall = urlFetch.calls.find((c) => c.body && c.body.contents);
  const sentPrompt = geminiCall.body.contents[0].parts[0].text;
  assert.match(sentPrompt, /Name: Alice/);
});

test('Range type: an unparseable range surfaces an error and still returns to the sheet menu', () => {
  const { context, urlFetch } = setupProject();
  const chatId = '111';
  startAtSheetList(context, chatId);
  mockGeminiApi(urlFetch, { models: [rawTextModel('gemini-3.6-flash', 'Gemini 3.6 Flash')] });

  pickFirstModel(context, chatId);
  context.handleGeminiSheetSelect(chatId, 0);
  context.handleGeminiTypeSelect(chatId, 'range');
  context.handleGeminiRangeInput(chatId, context.getState(chatId), 'not-a-range');
  assert.equal(context.getState(chatId).step, 'gemini_wait_prompt');

  context.handleGeminiPromptInput(chatId, context.getState(chatId), 'Analyze this');

  const warningCall = [...urlFetch.calls].reverse().find((c) => c.body && /Could not understand range/.test(c.body.text || ''));
  assert.ok(warningCall, 'an error message about the bad range should have been sent');
  assert.equal(context.getState(chatId).step, 'sheet_menu', 'flow should still land back on the sheet menu after an error');
});

test('audio modality: narration result is sent via sendAudio instead of a text message', () => {
  const { context, urlFetch } = setupProject();
  const chatId = '111';
  startAtSheetList(context, chatId);
  mockGeminiApi(urlFetch, { models: [rawAudioModel('gemini-2.5-flash-preview-tts', 'Gemini 2.5 Flash Preview TTS')] });

  pickFirstModel(context, chatId);
  assert.equal(context.getState(chatId).geminiModality, 'audio');

  context.handleGeminiSheetSelect(chatId, 0);
  context.handleGeminiTypeSelect(chatId, 'row');
  context.handleGeminiRowInput(chatId, context.getState(chatId), '3');

  // From here on, the generateContent mock must return audio inline data,
  // not a text payload — override just that branch.
  const pcmBase64 = Buffer.from([1, 2, 3, 4]).toString('base64');
  urlFetch.fetch = (url, options) => {
    urlFetch.calls.push({ url, options, body: parseBody(options) });
    if (/sendAudio/.test(url)) return { getResponseCode: () => 200, getContentText: () => '{}' };
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcmBase64 } }] } }],
      }),
    };
  };

  context.handleGeminiPromptInput(chatId, context.getState(chatId), 'Narrate this row');

  const audioCall = urlFetch.calls.find((c) => /sendAudio/.test(c.url));
  assert.ok(audioCall, 'narration result should have been sent via sendAudio, not sendMessage');
  assert.equal(context.getState(chatId).step, 'sheet_menu');
});

test('Cancel at the model-picker step returns to the tab list without ever reaching the sheet picker', () => {
  const { context, urlFetch } = setupProject();
  const chatId = '111';
  startAtSheetList(context, chatId);
  mockGeminiApi(urlFetch, { models: [rawTextModel('gemini-3.6-flash', 'Gemini 3.6 Flash')] });

  context.handleGeminiStart(chatId);
  assert.equal(context.getState(chatId).step, 'gemini_pick_model');
  context.handleGeminiCancel(chatId);

  const tabsCall = [...urlFetch.calls].reverse().find((c) => c.body && /^Tabs in/.test(c.body.text || ''));
  assert.ok(tabsCall, 'cancelling should redisplay the tab list, not the sheet menu');
  assert.equal(context.getState(chatId).geminiModelChoices, undefined, 'gemini scratch state must be cleared on cancel');
});

test('Cancel at the sheet-picker step (after picking a model) returns to the tab list, not the sheet menu', () => {
  const { context, urlFetch } = setupProject();
  const chatId = '111';
  startAtSheetList(context, chatId);
  mockGeminiApi(urlFetch, { models: [rawTextModel('gemini-3.6-flash', 'Gemini 3.6 Flash')] });

  pickFirstModel(context, chatId);
  assert.equal(context.getState(chatId).step, 'gemini_pick_sheet');
  context.handleGeminiCancel(chatId);

  // Button-driven screens in this app don't rigorously track state.step —
  // only free-text steps rely on it — so assert on what was actually shown.
  const tabsCall = [...urlFetch.calls].reverse().find((c) => c.body && /^Tabs in/.test(c.body.text || ''));
  assert.ok(tabsCall, 'cancelling should redisplay the tab list, not the sheet menu');
  const options = context.getState(chatId).currentOptions || [];
  assert.ok(options.some((o) => o.value === 'gemini'), 'the tab list (with its Gemini Analysis button) should be showing again');
  assert.equal(context.getState(chatId).geminiSheetName, undefined, 'gemini scratch state must be cleared on cancel');
  assert.equal(context.getState(chatId).geminiModel, undefined, 'the picked model must be cleared on cancel too');
});
