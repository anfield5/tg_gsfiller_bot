'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createProject } = require('./harness');

// ---------------------------------------------------------------------------
// A1 range parsing (DataAccess.js: _parseA1Range_ / _columnLetterToNumber_)
// ---------------------------------------------------------------------------

test('_parseA1Range_ parses a standard range', () => {
  const { context } = createProject({ files: ['DataAccess.js'] });
  assert.deepEqual(context._parseA1Range_('A2:C10'), { row: 2, col: 1, numRows: 9, numCols: 3 });
});

test('_parseA1Range_ handles a single cell (no colon)', () => {
  const { context } = createProject({ files: ['DataAccess.js'] });
  assert.deepEqual(context._parseA1Range_('B5'), { row: 5, col: 2, numRows: 1, numCols: 1 });
});

test('_parseA1Range_ normalises reversed corners (e.g. C10:A2) into a positive range', () => {
  const { context } = createProject({ files: ['DataAccess.js'] });
  assert.deepEqual(context._parseA1Range_('C10:A2'), { row: 2, col: 1, numRows: 9, numCols: 3 });
});

test('_parseA1Range_ handles multi-letter columns', () => {
  const { context } = createProject({ files: ['DataAccess.js'] });
  assert.deepEqual(context._parseA1Range_('AA1:AB2'), { row: 1, col: 27, numRows: 2, numCols: 2 });
});

test('_parseA1Range_ is case-insensitive and trims whitespace', () => {
  const { context } = createProject({ files: ['DataAccess.js'] });
  assert.deepEqual(context._parseA1Range_('  a2:c10  '), { row: 2, col: 1, numRows: 9, numCols: 3 });
});

test('_parseA1Range_ returns null for garbage input', () => {
  const { context } = createProject({ files: ['DataAccess.js'] });
  assert.equal(context._parseA1Range_('not a range'), null);
  assert.equal(context._parseA1Range_(''), null);
  assert.equal(context._parseA1Range_('A2:C10:E5'), null);
});

// ---------------------------------------------------------------------------
// getColumnValues / getRangeValues (DataAccess.js)
// ---------------------------------------------------------------------------

function sheetWithColumn(numDataRows) {
  const values = [['Header']];
  for (let i = 1; i <= numDataRows; i++) values.push(['row' + i]);
  return { name: 'Sheet1', values };
}

test('getColumnValues skips the header row and returns the rest', () => {
  const { context } = createProject({
    files: ['DataAccess.js'],
    SpreadsheetApp: { file1: { sheets: [sheetWithColumn(3)] } },
  });
  const result = context.getColumnValues('file1', 'Sheet1', 1, 500);
  assert.deepEqual(result.values, ['row1', 'row2', 'row3']);
  assert.equal(result.truncated, false);
});

test('getColumnValues truncates at maxRows and reports it', () => {
  const { context } = createProject({
    files: ['DataAccess.js'],
    SpreadsheetApp: { file1: { sheets: [sheetWithColumn(10)] } },
  });
  const result = context.getColumnValues('file1', 'Sheet1', 1, 4);
  assert.deepEqual(result.values, ['row1', 'row2', 'row3', 'row4']);
  assert.equal(result.truncated, true);
});

test('getColumnValues on a header-only sheet returns an empty, non-truncated result', () => {
  const { context } = createProject({
    files: ['DataAccess.js'],
    SpreadsheetApp: { file1: { sheets: [sheetWithColumn(0)] } },
  });
  const result = context.getColumnValues('file1', 'Sheet1', 1, 500);
  assert.deepEqual(result.values, []);
  assert.equal(result.truncated, false);
});

test('getRangeValues reads the requested rectangle', () => {
  const sheet = {
    name: 'Sheet1',
    values: [
      ['H1', 'H2', 'H3'],
      ['a1', 'b1', 'c1'],
      ['a2', 'b2', 'c2'],
      ['a3', 'b3', 'c3'],
    ],
  };
  const { context } = createProject({
    files: ['DataAccess.js'],
    SpreadsheetApp: { file1: { sheets: [sheet] } },
  });
  const result = context.getRangeValues('file1', 'Sheet1', 'A2:B3', 500);
  assert.deepEqual(result.values, [['a1', 'b1'], ['a2', 'b2']]);
  assert.equal(result.truncated, false);
});

test('getRangeValues clamps a range that overruns the sheet, without erroring', () => {
  const sheet = { name: 'Sheet1', values: [['H1', 'H2'], ['a1', 'b1']] };
  const { context } = createProject({
    files: ['DataAccess.js'],
    SpreadsheetApp: { file1: { sheets: [sheet] } },
  });
  const result = context.getRangeValues('file1', 'Sheet1', 'A1:Z100', 500);
  assert.deepEqual(result.values, [['H1', 'H2'], ['a1', 'b1']]);
});

test('getRangeValues throws a clear error for an unparseable range', () => {
  const sheet = { name: 'Sheet1', values: [['H1']] };
  const { context } = createProject({
    files: ['DataAccess.js'],
    SpreadsheetApp: { file1: { sheets: [sheet] } },
  });
  assert.throws(() => context.getRangeValues('file1', 'Sheet1', 'not a range', 500), /A2:C10/);
});

// ---------------------------------------------------------------------------
// callGemini_ (GeminiApi.js)
// ---------------------------------------------------------------------------

function geminiResponsePayload(text, finishReason) {
  return {
    candidates: [{
      finishReason: finishReason || 'STOP',
      content: { parts: [{ text: text }] },
    }],
  };
}

test('callGemini_ sends the model + prompt and returns the response text', () => {
  const { context, urlFetch } = createProject({
    files: ['GeminiApi.js'],
    CONFIG: { GEMINI_MODEL: 'gemini-2.5-flash' },
  });
  urlFetch.fetch = (url, options) => {
    urlFetch.calls.push({ url, options });
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify(geminiResponsePayload('Hello from Gemini')) };
  };

  const result = context.callGemini_('Say hello');
  assert.equal(result, 'Hello from Gemini');
  assert.match(urlFetch.calls[0].url, /gemini-2\.5-flash/);
  assert.match(urlFetch.calls[0].url, /key=TEST_GEMINI_KEY/);
  const body = JSON.parse(urlFetch.calls[0].options.payload);
  assert.equal(body.contents[0].parts[0].text, 'Say hello');
});

test('callGemini_ throws on a non-2xx HTTP response', () => {
  const { context, urlFetch } = createProject({ files: ['GeminiApi.js'] });
  urlFetch.fetch = () => ({ getResponseCode: () => 429, getContentText: () => '{"error":"rate limited"}' });
  assert.throws(() => context.callGemini_('x'), /HTTP 429/);
});

test('callGemini_ throws a specific error when the response is safety-blocked', () => {
  const { context, urlFetch } = createProject({ files: ['GeminiApi.js'] });
  urlFetch.fetch = () => ({
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({ candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] }),
  });
  assert.throws(() => context.callGemini_('x'), /SAFETY/);
});

test('callGemini_ throws when there are no candidates at all', () => {
  const { context, urlFetch } = createProject({ files: ['GeminiApi.js'] });
  urlFetch.fetch = () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({}) });
  assert.throws(() => context.callGemini_('x'), /empty response/);
});

// ---------------------------------------------------------------------------
// GeminiActions.js — data dump + prompt assembly
// ---------------------------------------------------------------------------

function mockGeminiReply(urlFetch, text) {
  urlFetch.fetch = (url, options) => {
    urlFetch.calls.push({ url, options });
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify(geminiResponsePayload(text)) };
  };
}

test('actionAnalyzeRow labels values with headers and includes the user instructions', () => {
  // actionGetHeaders() reads rows 1-2 as a (possibly 2-row) header — see the
  // note in tests/navigation-prev-field.test.js — hence the blank row 2.
  const sheet = { name: 'Sheet1', values: [['Name', 'Total'], ['', ''], ['Alice', '100']] };
  const { context, urlFetch } = createProject({
    files: ['DataAccess.js', 'SheetActions.js', 'GeminiApi.js', 'GeminiActions.js'],
    SpreadsheetApp: { file1: { sheets: [sheet] } },
  });
  mockGeminiReply(urlFetch, 'Analysis result');

  const result = context.actionAnalyzeRow('file1', 'Sheet1', 3, 'Summarise this row');
  assert.equal(result, 'Analysis result');

  const sentPrompt = JSON.parse(urlFetch.calls[0].options.payload).contents[0].parts[0].text;
  assert.match(sentPrompt, /Summarise this row/);
  assert.match(sentPrompt, /Name: Alice/);
  assert.match(sentPrompt, /Total: 100/);
});

test('actionAnalyzeColumn includes the truncation note when data was capped', () => {
  const values = [['Header']];
  for (let i = 1; i <= 10; i++) values.push(['v' + i]);
  const sheet = { name: 'Sheet1', values };
  const { context, urlFetch } = createProject({
    files: ['DataAccess.js', 'SheetActions.js', 'GeminiApi.js', 'GeminiActions.js'],
    CONFIG: { GEMINI_MAX_ROWS: 3 },
    SpreadsheetApp: { file1: { sheets: [sheet] } },
  });
  mockGeminiReply(urlFetch, 'ok');

  context.actionAnalyzeColumn('file1', 'Sheet1', 1, 'Header', 'Count them');
  const sentPrompt = JSON.parse(urlFetch.calls[0].options.payload).contents[0].parts[0].text;
  assert.match(sentPrompt, /truncated/);
  assert.match(sentPrompt, /v1[\s\S]*v2[\s\S]*v3/);
  assert.doesNotMatch(sentPrompt, /v4/);
});

test('actionAnalyzeRange sends the requested rectangle as tab-separated rows', () => {
  const sheet = {
    name: 'Sheet1',
    values: [['H1', 'H2'], ['a1', 'b1'], ['a2', 'b2']],
  };
  const { context, urlFetch } = createProject({
    files: ['DataAccess.js', 'SheetActions.js', 'GeminiApi.js', 'GeminiActions.js'],
    SpreadsheetApp: { file1: { sheets: [sheet] } },
  });
  mockGeminiReply(urlFetch, 'ok');

  context.actionAnalyzeRange('file1', 'Sheet1', 'A1:B3', 'Compare the columns');
  const sentPrompt = JSON.parse(urlFetch.calls[0].options.payload).contents[0].parts[0].text;
  assert.match(sentPrompt, /Compare the columns/);
  assert.match(sentPrompt, /a1\tb1/);
  assert.match(sentPrompt, /a2\tb2/);
});
