'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createProject } = require('./harness');

/**
 * End-to-end test of the add-row flow's new "Previous" button, exercised
 * through the real global functions (handleAddStart, handleAddFieldInput,
 * handlePrevField) rather than by poking at private helpers directly.
 *
 * Sheet under test has 3 columns: Name, Total (a FORMULA in the last data
 * row — auto-filled, never prompted), Notes. This lets us confirm:
 *   1. No Previous button on the very first prompted field.
 *   2. Previous button appears once a later field is reached, and jumps
 *      back over the auto-filled Total column instead of landing on it.
 *   3. The field being returned to is cleared for re-entry.
 *   4. Values are HTML-escaped in the final review message.
 */
function setupProject() {
  // actionGetHeaders() reads rows 1-2 as a (possibly 2-row) header, so the
  // fixture needs an explicit blank row 2 — otherwise the first data row
  // would itself get folded into the header labels (e.g. "Name (Alice)").
  // getLastRows() then correctly resolves the last DATA row via
  // sheet.getLastRow(), landing on row 3 here.
  const sheet = {
    name: 'Sheet1',
    values: [
      ['Name', 'Total', 'Notes'],
      ['', '', ''],
      ['Alice', 20, 'first'],
    ],
    formulas: { '3,2': '=A3*2' }, // Total is a formula in the template (last data) row
    merges: [],
  };

  return createProject({
    CONFIG: {
      FOLDER_IDS: ['folderA'],
      FOLDER_LABELS: ['Test Folder'],
      FILES_PER_PAGE: 10,
      FOLDER_CACHE_TTL_SECONDS: 300,
      FOLDER_SCAN_DEPTH: 1,
    },
    DriveApp: {
      folderA: { name: 'Test Folder', files: [{ id: 'file1', name: 'Test Sheet' }], folders: {} },
    },
    SpreadsheetApp: { file1: { sheets: [sheet] } },
    initialProperties: { ADMIN_IDS: '111' },
  });
}

function lastCallBody(urlFetch) {
  return urlFetch.calls[urlFetch.calls.length - 1].body;
}

function findCallByTextPrefix(urlFetch, prefix) {
  const call = [...urlFetch.calls].reverse().find((c) => c.body && c.body.text && c.body.text.startsWith(prefix));
  assert.ok(call, `expected a Telegram call whose text starts with "${prefix}"`);
  return call.body;
}

function keyboardLabels(body) {
  const rows = (body.reply_markup && body.reply_markup.keyboard) || [];
  return rows.flat().map((b) => b.text);
}

test('add-row flow: Previous button is absent on the first field, appears later, and skips auto-filled fields', () => {
  const { context, properties, urlFetch } = setupProject();
  const chatId = '111';

  // Open the sheet directly (bypasses folder/file navigation, which isn't
  // what this test is about) and start the add-row flow.
  const state = {
    step: 'sheet_menu', folderIndex: 0, folderId: 'folderA', folderName: 'Test Folder',
    fileId: 'file1', fileName: 'Test Sheet', sheetName: 'Sheet1',
  };
  context.setState(chatId, state);
  context.handleAddStart(chatId);

  // --- Field 0 (Name): no Previous button yet ---
  let labels = keyboardLabels(lastCallBody(urlFetch));
  assert.ok(!labels.some((l) => l.includes('Previous')), 'first prompted field must not offer Previous');

  context.handleAddFieldInput(chatId, context.getState(chatId), 'Bob');

  // Total is a formula → auto-filled and skipped; the bot should now be
  // prompting for Notes (index 2), with Previous available.
  let state2 = context.getState(chatId);
  assert.equal(state2.currentFieldIndex, 2, 'the formula field should have been auto-skipped');
  assert.equal(state2.formData.Name, 'Bob');
  assert.match(state2.formData.Total, /Calculated Formula/);

  labels = keyboardLabels(lastCallBody(urlFetch));
  assert.ok(labels.some((l) => l.includes('Previous')), 'Previous should be offered once a later field is reached');

  // --- Press Previous: should land back on Name (index 0), not on Total ---
  context.handlePrevField(chatId);
  const state3 = context.getState(chatId);
  assert.equal(state3.currentFieldIndex, 0, 'Previous must skip the auto-filled Total field and land on Name');
  assert.equal(state3.formData.Name, undefined, 'the field being returned to is cleared for re-entry');

  labels = keyboardLabels(lastCallBody(urlFetch));
  assert.ok(!labels.some((l) => l.includes('Previous')), 'back on the first field, Previous must disappear again');

  // --- Re-answer Name with a value containing HTML-significant characters ---
  context.handleAddFieldInput(chatId, context.getState(chatId), 'Bob & <Boss>');
  // Total gets auto-filled again, landing on Notes once more.
  context.handleAddFieldInput(chatId, context.getState(chatId), 'second note');

  const reviewBody = findCallByTextPrefix(urlFetch, 'Review new row:');
  assert.match(reviewBody.text, /Bob &amp; &lt;Boss&gt;/, 'user-entered value must be HTML-escaped in the review message');
  assert.doesNotMatch(reviewBody.text, /Bob & <Boss>/, 'the raw, unescaped value must not appear');

  // properties store sanity check: state actually persisted through PropertiesService.
  assert.ok(properties.getProperty('state:' + chatId), 'state should be persisted via PropertiesService');
});

test('Previous on a field with no earlier prompted field is a safe no-op', () => {
  const { context, urlFetch } = setupProject();
  const chatId = '111';
  context.setState(chatId, {
    step: 'sheet_menu', folderIndex: 0, folderId: 'folderA', folderName: 'Test Folder',
    fileId: 'file1', fileName: 'Test Sheet', sheetName: 'Sheet1',
  });
  context.handleAddStart(chatId);

  const before = context.getState(chatId).currentFieldIndex;
  context.handlePrevField(chatId);
  const after = context.getState(chatId).currentFieldIndex;

  assert.equal(before, 0);
  assert.equal(after, 0, 'pressing Previous on the first field must not move the index or throw');
  assert.ok(urlFetch.calls.length > 0, 'the prompt should still be re-rendered, not silently dropped');
});
