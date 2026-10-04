'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createProject } = require('./harness');

/**
 * The edit-row flow's "pick a field, then edit its value" step used to be a
 * bare ForceReply prompt — free text only, no buttons. This gives it the
 * same conveniences the add-row flow already has: Recent TOP3 values,
 * Use/Edit last value (from the sheet's most recent row), and Next/Previous
 * to jump directly between this row's editable columns without returning to
 * the full field list each time.
 *
 * Sheet layout (1 frozen header row, so actionGetHeaders doesn't fold a data
 * row into the header):
 *   col1 Name     — plain, editable
 *   col2 Status   — plain, editable (Open x2, Closed x1 across data rows)
 *   col3 Merged   — merge anchor on every data row — editable (anchor cell)
 *   col4 Merged2  — trailing half of that merge — NOT editable, skipped
 *   col5 Total    — formula on every data row — NOT editable
 *
 * Row 3 (Bob) is the one under edit throughout; row 4 (Cara) is the sheet's
 * most recent row, so lastRowValues = ['Cara','Open','Z','Z','30'].
 */
function setupProject() {
  const sheet = {
    name: 'Sheet1',
    frozenRows: 1,
    values: [
      ['Name', 'Status', 'Merged', 'Merged2', 'Total'],
      ['Alice', 'Open', 'X', 'X', '10'],
      ['Bob', 'Closed', 'Y', 'Y', '20'],
      ['Cara', 'Open', 'Z', 'Z', '30'],
    ],
    formulas: { '2,5': '=A2*2', '3,5': '=A3*2', '4,5': '=A4*2' },
    merges: [
      { row: 2, col: 3, numRows: 1, numCols: 2 },
      { row: 3, col: 3, numRows: 1, numCols: 2 },
      { row: 4, col: 3, numRows: 1, numCols: 2 },
    ],
  };

  return createProject({
    CONFIG: {
      FOLDER_IDS: ['folderA'], FOLDER_LABELS: ['Test Folder'], FILES_PER_PAGE: 10,
      FOLDER_CACHE_TTL_SECONDS: 300, FOLDER_SCAN_DEPTH: 1,
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

/** Jumps straight to editing row 3, field `colIndex` — bypasses the row list/manual-entry UI. */
function startEditingField(context, chatId, colIndex) {
  context.setState(chatId, {
    step: 'sheet_menu', folderIndex: 0, folderId: 'folderA', folderName: 'Test Folder',
    fileId: 'file1', fileName: 'Test Sheet', sheetName: 'Sheet1',
  });
  context.handleEditRowSelect(chatId, 3);
  context.handleEditFieldSelect(chatId, colIndex);
}

test('the edit-field prompt offers Recent TOP3 values, Use Last/Edit Last, and a Next button on the first column', () => {
  const { context, urlFetch } = setupProject();
  const chatId = '111';
  startEditingField(context, chatId, 1); // Name

  const body = lastCallBody(urlFetch);
  const labels = keyboardLabels(body);
  const icons = context.getIcons_();

  assert.ok(labels.includes(icons.CHART + ' Recent TOP3 values'));
  assert.ok(labels.includes(icons.USE_LAST + ' Use: Cara'), "last row's Name value (Cara) should be offered");
  assert.ok(labels.includes(icons.EDIT + ' Edit Last Value'));
  assert.ok(labels.includes(icons.NEXT_PAGE + ' Next'), 'column 2 is editable, so Next must be offered');
  assert.ok(!labels.includes(icons.PREV_FIELD + ' Previous'), 'column 1 is the first field — there is nothing before it');
  assert.equal(context.getState(chatId).step, 'edit_filling');
});

test('Next/Previous skip the trailing-merge column and the formula column, landing only on real editable fields', () => {
  const { context, urlFetch } = setupProject();
  const chatId = '111';
  const icons = context.getIcons_();
  startEditingField(context, chatId, 3); // Merged (anchor cell — editable)

  let labels = keyboardLabels(lastCallBody(urlFetch));
  assert.ok(labels.includes(icons.PREV_FIELD + ' Previous'), 'column 2 is editable, Previous must be offered');
  assert.ok(!labels.includes(icons.NEXT_PAGE + ' Next'), 'col4 (trailing merge) and col5 (formula) are both unselectable — no Next');

  context.routeAction(chatId, 'edit_prev_field');
  assert.equal(context.getState(chatId).colIndex, 2, 'Previous from col3 must land on col2, not col1');

  context.routeAction(chatId, 'edit_next_field');
  assert.equal(context.getState(chatId).colIndex, 3, 'Next from col2 must land back on col3 (skipping nothing in this direction)');
});

test('Next with nothing left to advance to is a safe no-op (stays on the same field)', () => {
  const { context } = setupProject();
  const chatId = '111';
  startEditingField(context, chatId, 3); // Merged — no reachable next field

  context.routeAction(chatId, 'edit_next_field');
  assert.equal(context.getState(chatId).colIndex, 3);
  assert.equal(context.getState(chatId).step, 'edit_filling');
});

test('"Recent TOP3 values" reports the top values for the field being edited and stays on the same prompt', () => {
  const { context, urlFetch } = setupProject();
  const chatId = '111';
  startEditingField(context, chatId, 2); // Status: Open, Closed, Open across the 3 data rows

  context.routeAction(chatId, 'top3_values_edit');

  const calls = urlFetch.calls;
  const top3Call = calls[calls.length - 2].body; // last call re-renders the prompt; this one is the results message
  assert.match(top3Call.text, /Top 2 recent values for Status/);
  assert.match(top3Call.text, /<code>Open<\/code>\n<code>Closed<\/code>/);

  const state = context.getState(chatId);
  assert.equal(state.step, 'edit_filling', 'must not advance or leave the field prompt');
  assert.equal(state.colIndex, 2);
});

test('"Use: <value>" saves the sheet\'s last row value directly and returns to the row view', () => {
  const { context } = setupProject();
  const chatId = '111';
  startEditingField(context, chatId, 1); // Name

  context.routeAction(chatId, 'use_last_direct_edit');

  assert.deepEqual(context.actionGetRowValues('file1', 'Sheet1', 3)[0], 'Cara');
  const state = context.getState(chatId);
  assert.equal(state.step, 'edit_row_view');
  assert.equal(state.colIndex, undefined, 'colIndex is cleared once the cell is saved');
});

test('"Edit Last Value" pre-fills the last value for editing, and the follow-up reply saves the edited text', () => {
  const { context, urlFetch } = setupProject();
  const chatId = '111';
  startEditingField(context, chatId, 1); // Name

  context.routeAction(chatId, 'use_last_edit_request_edit');

  const forceReplyBody = lastCallBody(urlFetch);
  assert.match(forceReplyBody.text, /<code>Cara<\/code>/);
  assert.equal(context.getState(chatId).step, 'edit_field_wait');

  context.handleEditFieldInput(chatId, context.getState(chatId), 'Cara Jr.');
  assert.equal(context.actionGetRowValues('file1', 'Sheet1', 3)[0], 'Cara Jr.');
});

test('a plain typed reply (no button) still saves the cell directly, like before', () => {
  const { context } = setupProject();
  const chatId = '111';
  startEditingField(context, chatId, 1); // Name

  context.handleMessage({ chat: { id: '111' }, text: 'Zed' });

  assert.equal(context.actionGetRowValues('file1', 'Sheet1', 3)[0], 'Zed');
  assert.equal(context.getState(chatId).step, 'edit_row_view');
});

test('the "All fields" button is offered, and tapping it returns to the row view without changing the row\'s data', () => {
  const { context, urlFetch } = setupProject();
  const chatId = '111';
  startEditingField(context, chatId, 1); // Name

  const icons = context.getIcons_();
  const label = icons.FIELDS + ' All fields';
  assert.ok(keyboardLabels(lastCallBody(urlFetch)).includes(label));

  // Tap it the way a real user does: send the button's label as a message.
  context.handleMessage({ chat: { id: '111' }, text: label });

  assert.match(lastCallBody(urlFetch).text, /Select a field to edit/);
  assert.equal(context.actionGetRowValues('file1', 'Sheet1', 3)[0], 'Bob', 'nothing should have been saved');
});

test('selecting a formula column directly still shows the warning and returns to the row view (unchanged behavior)', () => {
  const { context, urlFetch } = setupProject();
  const chatId = '111';
  context.setState(chatId, {
    step: 'sheet_menu', folderIndex: 0, folderId: 'folderA', folderName: 'Test Folder',
    fileId: 'file1', fileName: 'Test Sheet', sheetName: 'Sheet1',
  });
  context.handleEditRowSelect(chatId, 3);

  context.handleEditFieldSelect(chatId, 5); // Total — formula column

  const warningCall = urlFetch.calls.find(c => /cannot be edited inline/.test(c.body.text));
  assert.ok(warningCall, 'the formula-column warning must still be sent');
  assert.match(lastCallBody(urlFetch).text, /Select a field to edit/, 'must fall back to the row view, not a field prompt');
  assert.notEqual(context.getState(chatId).step, 'edit_filling', 'must never enter the field-prompt step for a formula column');
});
