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
  // No `candidates` key at all is a distinct failure from "candidate present
  // but its parts were empty" (see the next test) — GeminiApi.js reports
  // them with different messages, so pin each to its own wording.
  assert.throws(() => context.callGemini_('x'), /no candidates/);
});

test('callGemini_ throws "empty response" when a candidate is present but has no text', () => {
  const { context, urlFetch } = createProject({ files: ['GeminiApi.js'] });
  urlFetch.fetch = () => ({
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [] } }] }),
  });
  assert.throws(() => context.callGemini_('x'), /empty response/);
});

test('callGemini_ marks the model overloaded on a 503, so isGeminiModelOverloaded_ picks it up', () => {
  const { context, urlFetch } = createProject({ files: ['GeminiApi.js'] });
  urlFetch.fetch = () => ({ getResponseCode: () => 503, getContentText: () => '{"error":{"message":"high demand"}}' });

  assert.equal(context.isGeminiModelOverloaded_('gemini-3.6-flash'), false);
  assert.throws(() => context.callGemini_('x', 'gemini-3.6-flash'), /HTTP 503/);
  assert.equal(context.isGeminiModelOverloaded_('gemini-3.6-flash'), true);
  // A different model must not be affected.
  assert.equal(context.isGeminiModelOverloaded_('gemini-2.5-pro'), false);
});

test('callGemini_ does NOT mark the model overloaded on a non-503 error', () => {
  const { context, urlFetch } = createProject({ files: ['GeminiApi.js'] });
  urlFetch.fetch = () => ({ getResponseCode: () => 429, getContentText: () => '{"error":{"message":"rate limited"}}' });
  assert.throws(() => context.callGemini_('x', 'gemini-3.6-flash'), /HTTP 429/);
  assert.equal(context.isGeminiModelOverloaded_('gemini-3.6-flash'), false);
});

// ---------------------------------------------------------------------------
// _findGeminiAllowEntry_ / _geminiPrefixMatches_ (GeminiApi.js) — the
// free-tier allowlist gate. Regression coverage for the false-positive bug
// caught live on 2026-08-24 (naive prefix matching let "gemini-2.5-pro"
// match the unrelated sibling "gemini-2.5-pro-preview-tts").
// ---------------------------------------------------------------------------

test('_findGeminiAllowEntry_ accepts exact ids and genuine version/date/Gemma-size suffixes', () => {
  const { context } = createProject({ files: ['GeminiApi.js'] });
  const free = context._getDefaultFreeModels_();
  const accept = [
    'gemini-2.5-pro',
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash-lite-preview-09-2025',
    'gemini-3.5-flash-lite',
    'gemini-3.7-flash',
    'gemini-2.5-flash-preview-tts',
    'gemma-3-27b-it',
  ];
  accept.forEach((id) => {
    assert.ok(context._findGeminiAllowEntry_(id, free), id + ' should be allowed');
  });
});

test('_findGeminiAllowEntry_ rejects unrelated sibling models sharing a common string prefix', () => {
  const { context } = createProject({ files: ['GeminiApi.js'] });
  const free = context._getDefaultFreeModels_();
  const reject = [
    'gemini-2.5-pro-preview-tts',  // sibling of gemini-2.5-pro, different (paid) model
    'gemini-2.5-flash',            // bare id blocked (404 for new accounts) — only -lite is allowed
    'gemini-2.5-flash-image',      // Nano Banana — sibling of gemini-2.5-flash-lite's prefix family
    'gemini-3.1-flash-image',      // Nano Banana 2
  ];
  reject.forEach((id) => {
    assert.equal(context._findGeminiAllowEntry_(id, free), null, id + ' should NOT be allowed');
  });
});

// ---------------------------------------------------------------------------
// listGeminiModels_ (GeminiApi.js) — ListModels fetch, allowlist filter,
// dedup, categorization, and caching.
// ---------------------------------------------------------------------------

function rawModel(name, displayName, description) {
  return { name: 'models/' + name, displayName, description, supportedGenerationMethods: ['generateContent'] };
}

test('listGeminiModels_ keeps only allowlisted, generateContent-capable models, sorted by displayName', () => {
  const { context, urlFetch } = createProject({ files: ['GeminiApi.js'] });
  urlFetch.fetch = () => ({
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({
      models: [
        rawModel('gemini-3.6-flash', 'Gemini 3.6 Flash', 'Our most cost-efficient model'),
        rawModel('gemini-2.5-pro', 'Gemini 2.5 Pro', 'State-of-the-art reasoning'),
        rawModel('gemini-3.1-pro-preview', 'Gemini 3.1 Pro Preview', 'Not free'), // not on allowlist
        { ...rawModel('embedding-001', 'Embedding 001', ''), supportedGenerationMethods: ['embedContent'] }, // wrong method
      ],
    }),
  });

  const models = context.listGeminiModels_();
  const names = models.map((m) => m.name);
  assert.deepEqual(names, ['gemini-2.5-pro', 'gemini-3.6-flash']); // sorted by displayName
  assert.ok(!names.includes('gemini-3.1-pro-preview'));
  assert.ok(!names.includes('embedding-001'));
});

test('listGeminiModels_ deduplicates models that share a displayName, keeping the first', () => {
  const { context, urlFetch } = createProject({ files: ['GeminiApi.js'] });
  urlFetch.fetch = () => ({
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({
      models: [
        rawModel('gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite', 'Cost effective'),
        rawModel('gemini-2.5-flash-lite-preview-09-2025', 'Gemini 2.5 Flash-Lite', 'Cost effective'),
      ],
    }),
  });
  const models = context.listGeminiModels_();
  assert.equal(models.length, 1);
  assert.equal(models[0].name, 'gemini-2.5-flash-lite');
});

test('listGeminiModels_ classifies by description and assigns fixed categories for audio', () => {
  const { context, urlFetch } = createProject({ files: ['GeminiApi.js'] });
  urlFetch.fetch = () => ({
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({
      models: [
        rawModel('gemini-3.6-flash', 'Gemini 3.6 Flash', 'Our most cost-efficient model'),
        rawModel('gemini-2.5-pro', 'Gemini 2.5 Pro', 'Best for state-of-the-art reasoning and coding'),
        rawModel('gemini-2.5-flash-preview-tts', 'Gemini 2.5 Flash Preview TTS', 'Text to speech'),
      ],
    }),
  });
  const byName = {};
  context.listGeminiModels_().forEach((m) => { byName[m.name] = m; });
  assert.equal(byName['gemini-3.6-flash'].category, 'Best for: fast & cheap analysis');
  assert.equal(byName['gemini-2.5-pro'].category, 'Best for: deep reasoning & coding');
  assert.equal(byName['gemini-2.5-flash-preview-tts'].category, 'Best for: audio narration');
  assert.equal(byName['gemini-2.5-flash-preview-tts'].modality, 'audio');
  assert.equal(byName['gemini-3.6-flash'].modality, 'text');
});

test('listGeminiModels_ caches its result; a second call does not re-fetch', () => {
  const { context, urlFetch } = createProject({ files: ['GeminiApi.js'] });
  urlFetch.fetch = (url, options) => {
    urlFetch.calls.push({ url, options });
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({ models: [rawModel('gemini-3.6-flash', 'Gemini 3.6 Flash', 'cost-efficient')] }),
    };
  };
  context.listGeminiModels_();
  context.listGeminiModels_();
  assert.equal(urlFetch.calls.length, 1);
});

test('clearGeminiModelsCache_ forces the next listGeminiModels_ call to re-fetch', () => {
  const { context, urlFetch } = createProject({ files: ['GeminiApi.js'] });
  urlFetch.fetch = (url, options) => {
    urlFetch.calls.push({ url, options });
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({ models: [rawModel('gemini-3.6-flash', 'Gemini 3.6 Flash', 'cost-efficient')] }),
    };
  };
  context.listGeminiModels_();
  context.clearGeminiModelsCache_();
  context.listGeminiModels_();
  assert.equal(urlFetch.calls.length, 2);
});

test('listGeminiModels_ throws a clear error when no models on the account are on the allowlist', () => {
  const { context, urlFetch } = createProject({ files: ['GeminiApi.js'] });
  urlFetch.fetch = () => ({
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({ models: [rawModel('gemini-3.1-pro-preview', 'Gemini 3.1 Pro Preview', 'Not free')] }),
  });
  assert.throws(() => context.listGeminiModels_(), /no free-tier models/);
});

// ---------------------------------------------------------------------------
// callGeminiAudio_ / callGeminiImage_ (GeminiApi.js)
// ---------------------------------------------------------------------------

test('callGeminiAudio_ sends AUDIO responseModalities and wraps the returned PCM as a WAV blob', () => {
  const { context, urlFetch } = createProject({ files: ['GeminiApi.js'] });
  const pcmBase64 = Buffer.from([1, 2, 3, 4]).toString('base64');
  urlFetch.fetch = (url, options) => {
    urlFetch.calls.push({ url, options, body: JSON.parse(options.payload) });
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcmBase64 } }] } }],
      }),
    };
  };

  const blob = context.callGeminiAudio_('Narrate this', 'gemini-2.5-flash-preview-tts');
  assert.equal(blob.mimeType, 'audio/wav');
  assert.equal(urlFetch.calls[0].body.generationConfig.responseModalities[0], 'AUDIO');
  // 44-byte RIFF/WAVE header + the 4 PCM bytes from above.
  assert.equal(blob.bytes.length, 44 + 4);
});

test('callGeminiAudio_ throws when Gemini does not return inline audio data', () => {
  const { context, urlFetch } = createProject({ files: ['GeminiApi.js'] });
  urlFetch.fetch = () => ({
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({ candidates: [{ content: { parts: [{ text: 'no audio here' }] } }] }),
  });
  assert.throws(() => context.callGeminiAudio_('x', 'gemini-2.5-flash-preview-tts'), /did not return audio data/);
});

test('callGeminiImage_ sends TEXT+IMAGE responseModalities and returns the image blob plus any caption text', () => {
  const { context, urlFetch } = createProject({ files: ['GeminiApi.js'] });
  const imgBase64 = Buffer.from([9, 9, 9]).toString('base64');
  urlFetch.fetch = (url, options) => {
    urlFetch.calls.push({ url, options, body: JSON.parse(options.payload) });
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{ content: { parts: [
          { inlineData: { mimeType: 'image/png', data: imgBase64 } },
          { text: 'A chart of the totals.' },
        ] } }],
      }),
    };
  };

  const result = context.callGeminiImage_('Draw this', 'gemini-x-flash-image');
  assert.deepEqual(urlFetch.calls[0].body.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
  assert.equal(result.blob.mimeType, 'image/png');
  assert.equal(result.caption, 'A chart of the totals.');
});

test('callGeminiImage_ throws when Gemini returns no image', () => {
  const { context, urlFetch } = createProject({ files: ['GeminiApi.js'] });
  urlFetch.fetch = () => ({
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({ candidates: [{ content: { parts: [{ text: 'just text, no image' }] } }] }),
  });
  assert.throws(() => context.callGeminiImage_('x', 'gemini-x-flash-image'), /did not return an image/);
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
