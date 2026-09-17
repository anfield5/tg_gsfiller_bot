'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createProject } = require('./harness');

/**
 * End-to-end test of the "Recent TOP3 values" button added to the add-row
 * flow: pressing it should look at the last 10 values already in the
 * column currently being filled, return the 3 most frequent as a single
 * tap-to-copy <code> block, and leave the user on the same field/keyboard
 * (unlike Use-last/Leave-empty, which advance to the next field).
 *
 * Sheet has 3 columns: Name, Status, Notes. Status already has 5 historical
 * values (Open x3, Closed x1, Pending x1) so the ranking is unambiguous.
 */
function setupProject() {
  const sheet = {
    name: 'Sheet1',
    values: [
      ['Name', 'Status', 'Notes'],
      ['', '', ''],
      ['Alice', 'Open', 'n1'],
      ['Bob', 'Closed', 'n2'],
      ['Cara', 'Open', 'n3'],
      ['Dan', 'Open', 'n4'],
      ['Eve', 'Pending', 'n5'],
    ],
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

function keyboardLabels(body) {
  const rows = (body.reply_markup && body.reply_markup.keyboard) || [];
  return rows.flat().map((b) => b.text);
}

function startAtStatusField(context, chatId) {
  context.setState(chatId, {
    step: 'sheet_menu', folderIndex: 0, folderId: 'folderA', folderName: 'Test Folder',
    fileId: 'file1', fileName: 'Test Sheet', sheetName: 'Sheet1',
  });
  context.handleAddStart(chatId);                                    // prompts Name (index 0)
  context.handleAddFieldInput(chatId, context.getState(chatId), 'Frank'); // -> prompts Status (index 1)
  assert.equal(context.getState(chatId).currentFieldIndex, 1, 'setup: should now be prompting Status');
}

test('the "Recent TOP3 values" button is offered on every add-row field prompt', () => {
  const { context, urlFetch } = setupProject();
  const chatId = '111';
  startAtStatusField(context, chatId);

  const labels = keyboardLabels(lastCallBody(urlFetch));
  const icons = context.getIcons_();
  assert.ok(labels.includes(icons.CHART + ' Recent TOP3 values'));
});

test('handleTop3Values sends the 3 most frequent recent values as a tap-to-copy <code> block', () => {
  const { context, urlFetch } = setupProject();
  const chatId = '111';
  startAtStatusField(context, chatId);

  context.handleTop3Values(chatId);

  const calls = urlFetch.calls;
  const top3Call = calls[calls.length - 2].body; // last call re-renders the prompt; this one is the results message
  assert.match(top3Call.text, /Top 3 recent values for Status/);
  assert.match(top3Call.text, /<code>Open\nClosed\nPending<\/code>/, 'values must be newline-separated inside one <code> block for easy copy-paste');
});

test('handleTop3Values does not advance the field or clear entered data (stays on the same prompt)', () => {
  const { context, urlFetch } = setupProject();
  const chatId = '111';
  startAtStatusField(context, chatId);

  context.handleTop3Values(chatId);

  const state = context.getState(chatId);
  assert.equal(state.currentFieldIndex, 1, 'Top3 lookup must not move the flow forward');

  const labels = keyboardLabels(lastCallBody(urlFetch));
  const icons = context.getIcons_();
  assert.ok(labels.includes(icons.CHART + ' Recent TOP3 values'), 'the same field prompt (with the button) must be re-shown');
});

test('handleTop3Values reports no values found for a column with no history yet, without throwing', () => {
  // Dedicated fixture: Notes column has no prior data at all (blank cells).
  const sheet = {
    name: 'Sheet1',
    values: [
      ['Name', 'Status', 'Notes'],
      ['', '', ''],
      ['Alice', 'Open', ''],
      ['Bob', 'Closed', ''],
    ],
  };
  const { context, urlFetch } = createProject({
    CONFIG: {
      FOLDER_IDS: ['folderA'], FOLDER_LABELS: ['Test Folder'], FILES_PER_PAGE: 10,
      FOLDER_CACHE_TTL_SECONDS: 300, FOLDER_SCAN_DEPTH: 1,
    },
    DriveApp: { folderA: { name: 'Test Folder', files: [{ id: 'file1', name: 'Test Sheet' }], folders: {} } },
    SpreadsheetApp: { file1: { sheets: [sheet] } },
    initialProperties: { ADMIN_IDS: '111' },
  });
  const chatId = '111';
  startAtStatusField(context, chatId);
  context.handleAddFieldInput(chatId, context.getState(chatId), 'Pending'); // Status -> advance to Notes (index 2, empty history)

  context.handleTop3Values(chatId);

  const calls = urlFetch.calls;
  const resultCall = calls[calls.length - 2].body;
  assert.match(resultCall.text, /No recent values found for.*Notes/);
});

test('routeAction("top3_values") dispatches to handleTop3Values', () => {
  const { context, urlFetch } = setupProject();
  const chatId = '111';
  startAtStatusField(context, chatId);

  context.routeAction(chatId, 'top3_values');

  const calls = urlFetch.calls;
  const top3Call = calls[calls.length - 2].body;
  assert.match(top3Call.text, /Top 3 recent values for Status/);
});
