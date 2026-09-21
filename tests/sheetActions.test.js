'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createProject } = require('./harness');

function projectWithSheet(sheetSpec) {
  return createProject({
    files: ['Logging.js', 'Timing.js', 'Icons.js', 'TelegramApi.js', 'DataAccess.js', 'SheetActions.js'],
    SpreadsheetApp: { file1: { sheets: [sheetSpec] } },
  });
}

test('actionGetHeaders: single header row', () => {
  const { context } = projectWithSheet({
    name: 'Sheet1',
    values: [['Name', 'Age', 'City']],
  });
  assert.deepEqual(context.actionGetHeaders('file1', 'Sheet1'), ['Name', 'Age', 'City']);
});

test('actionGetHeaders: two distinct header rows combine as "Top (Bottom)"', () => {
  const { context } = projectWithSheet({
    name: 'Sheet1',
    values: [['Sales', 'Sales'], ['Q1', 'Q2']],
  });
  assert.deepEqual(context.actionGetHeaders('file1', 'Sheet1'), ['Sales (Q1)', 'Sales (Q2)']);
});

test('actionGetHeaders: identical top/bottom values collapse to one label', () => {
  const { context } = projectWithSheet({
    name: 'Sheet1',
    values: [['Name', 'Name'], ['Name', 'Name']],
  });
  assert.deepEqual(context.actionGetHeaders('file1', 'Sheet1'), ['Name', 'Name']);
});

test('actionGetHeaders: empty column falls back to "Column N"', () => {
  const { context } = projectWithSheet({
    name: 'Sheet1',
    values: [['Name', '', 'City'], ['', '', '']],
  });
  assert.deepEqual(context.actionGetHeaders('file1', 'Sheet1'), ['Name', 'Column 2', 'City']);
});

test('actionGetHeaders: a row-1 merge spanning columns applies the anchor label to every spanned column', () => {
  const { context } = projectWithSheet({
    name: 'Sheet1',
    values: [['Contact', '', 'Other'], ['Phone', 'Email', '']],
    merges: [{ row: 1, col: 1, numRows: 1, numCols: 2 }],
  });
  assert.deepEqual(
    context.actionGetHeaders('file1', 'Sheet1'),
    ['Contact (Phone)', 'Contact (Email)', 'Other']
  );
});

// ---------------------------------------------------------------------------
// actionGetHeaders: header rows now come from Sheet.getFrozenRows(), not a
// hardcoded 2 — the tests above all rely on the mock's default frozenRows
// of 2 (see gas-mocks.js) to keep exercising that exact case unchanged.
// These tests set spec.frozenRows explicitly to cover the dynamic behavior.
// ---------------------------------------------------------------------------

test('actionGetHeaders: 1 frozen row reads only row 1, even when row 2 already holds real data', () => {
  // Under the old hardcoded "always read rows 1-2" behavior this would have
  // wrongly folded the first data row into the header — the whole point of
  // switching to getFrozenRows().
  const { context } = projectWithSheet({
    name: 'Sheet1',
    frozenRows: 1,
    values: [['Name', 'Status'], ['Alice', 'Open']],
  });
  assert.deepEqual(context.actionGetHeaders('file1', 'Sheet1'), ['Name', 'Status']);
});

test('actionGetHeaders: 0 frozen rows still falls back to row 1 alone as the header', () => {
  const { context } = projectWithSheet({
    name: 'Sheet1',
    frozenRows: 0,
    values: [['Name', 'Status'], ['Alice', 'Open']],
  });
  assert.deepEqual(context.actionGetHeaders('file1', 'Sheet1'), ['Name', 'Status']);
});

test('actionGetHeaders: 3 frozen rows combine as "First (Second, Third)"', () => {
  const { context } = projectWithSheet({
    name: 'Sheet1',
    frozenRows: 3,
    values: [['Sales', 'Sales'], ['2026', '2026'], ['Q1', 'Q2']],
  });
  assert.deepEqual(context.actionGetHeaders('file1', 'Sheet1'), ['Sales (2026, Q1)', 'Sales (2026, Q2)']);
});

test('actionGetHeaders: 3 frozen rows drop blank rows and dedupe exact repeats, not just adjacent ones', () => {
  const { context } = projectWithSheet({
    name: 'Sheet1',
    frozenRows: 3,
    values: [['Name', 'Total'], ['', ''], ['Name', 'USD']],
  });
  // Column 1: "Name" repeats (row 1 and row 3) with a blank row in between —
  // still collapses to a single "Name", not "Name (Name)".
  assert.deepEqual(context.actionGetHeaders('file1', 'Sheet1'), ['Name', 'Total (USD)']);
});

test('actionGetHeaders: results are cached (a second call does not re-read the sheet)', () => {
  const { context } = projectWithSheet({ name: 'Sheet1', values: [['A', 'B']] });
  let opens = 0;
  const realSpreadsheetApp = context.SpreadsheetApp;
  context.SpreadsheetApp = {
    openById(id) { opens++; return realSpreadsheetApp.openById(id); },
  };
  context.actionGetHeaders('file1', 'Sheet1');
  context.actionGetHeaders('file1', 'Sheet1');
  assert.equal(opens, 1);
});

test('actionAddRow appends values, replicates formulas and merges from the template row', () => {
  const sheet = {
    name: 'Sheet1',
    values: [
      ['Name', 'Total', 'Notes'],
      ['Alice', 10, 'first'],
    ],
    formulas: { '2,2': '=SUM(A2:A2)' },
    merges: [],
  };
  const { context } = createProject({
    files: ['Logging.js', 'Timing.js', 'Icons.js', 'TelegramApi.js', 'DataAccess.js', 'SheetActions.js'],
    SpreadsheetApp: { file1: { sheets: [sheet] } },
  });

  const headers = ['Name', 'Total', 'Notes'];
  context.actionAddRow('file1', 'Sheet1', { Name: 'Bob', Total: context.formulaPlaceholderText_(), Notes: 'second' }, headers);

  assert.deepEqual(sheet.values[2], ['Bob', '', 'second'], 'formula column is left blank, not overwritten with the placeholder text');
  assert.equal(sheet.formulas['3,2'], '=SUM(A2:A2)', 'formula from the template row was copied down to the new row');
});

test('actionAddRow replicates horizontal merges from the template row onto the new row', () => {
  const sheet = {
    name: 'Sheet1',
    values: [
      ['A', 'B', 'C'],
      ['x', 'x', 'y'],
    ],
    formulas: {},
    merges: [{ row: 2, col: 1, numRows: 1, numCols: 2 }],
  };
  const { context } = createProject({
    files: ['Logging.js', 'Timing.js', 'Icons.js', 'TelegramApi.js', 'DataAccess.js', 'SheetActions.js'],
    SpreadsheetApp: { file1: { sheets: [sheet] } },
  });

  context.actionAddRow('file1', 'Sheet1', { A: 'z', B: 'z', C: 'w' }, ['A', 'B', 'C']);

  const newRowMerge = sheet.merges.find((m) => m.row === 3);
  assert.ok(newRowMerge, 'a merge should have been created on the newly appended row');
  assert.equal(newRowMerge.col, 1);
  assert.equal(newRowMerge.numCols, 2);
});

test('actionAddRow reads the template row\'s formulas in one batched call, not one per column', () => {
  // 5 columns, only column 3 has a formula — before the getRowFormulaFlags_
  // optimization this used to cost 5 separate isCellFormula() opens just to
  // find that out.
  const sheet = {
    name: 'Sheet1',
    values: [
      ['A', 'B', 'C', 'D', 'E'],
      ['a', 'b', 'c', 'd', 'e'],
    ],
    formulas: { '2,3': '=UPPER(A2)' },
    merges: [],
  };
  const { context } = createProject({
    files: ['Logging.js', 'Timing.js', 'Icons.js', 'TelegramApi.js', 'DataAccess.js', 'SheetActions.js'],
    SpreadsheetApp: { file1: { sheets: [sheet] } },
  });

  let opens = 0;
  const realSpreadsheetApp = context.SpreadsheetApp;
  context.SpreadsheetApp = {
    CopyPasteType: realSpreadsheetApp.CopyPasteType,
    openById(id) { opens++; return realSpreadsheetApp.openById(id); },
  };

  const headers = ['A', 'B', 'C', 'D', 'E'];
  context.actionAddRow('file1', 'Sheet1', { A: '1', B: '2', C: context.formulaPlaceholderText_(), D: '4', E: '5' }, headers);

  assert.equal(sheet.formulas['3,3'], '=UPPER(A2)', 'the one formula column was still copied down correctly');
  // _getSheet_ is memoized per execution (resetSheetMemo_ resets it between
  // Telegram updates, not within one actionAddRow call), so the whole
  // append+formula-copy+merge-copy sequence should open the spreadsheet once.
  assert.equal(opens, 1, 'SpreadsheetApp.openById should be memoized across the whole actionAddRow call');
});

test('_getSheet_ memo is cleared by resetSheetMemo_ (simulates a fresh doPost)', () => {
  const { context } = projectWithSheet({ name: 'Sheet1', values: [['A', 'B']] });
  let opens = 0;
  const realSpreadsheetApp = context.SpreadsheetApp;
  context.SpreadsheetApp = {
    openById(id) { opens++; return realSpreadsheetApp.openById(id); },
  };

  context.actionGetHeaders('file1', 'Sheet1'); // headers cache is separate from the sheet memo — force a real open
  context._getSheet_('file1', 'Sheet1');
  assert.equal(opens, 1, 'second _getSheet_ call within the same execution should reuse the memoized handle');

  context.resetSheetMemo_();
  context._getSheet_('file1', 'Sheet1');
  assert.equal(opens, 2, 'a fresh execution (post-reset) must not reuse a handle from a previous update');
});

// ---------------------------------------------------------------------------
// _topFrequentValues_ / actionTopFrequentColumnValues — "Recent TOP3 values"
// ---------------------------------------------------------------------------

test('_topFrequentValues_ ranks by occurrence count, most frequent first', () => {
  const { context } = projectWithSheet({ name: 'Sheet1', values: [['A']] });
  const values = ['Open', 'Closed', 'Open', 'Pending', 'Open', 'Closed'];
  assert.deepEqual(context._topFrequentValues_(values, 3), ['Open', 'Closed', 'Pending']);
});

test('_topFrequentValues_ keeps first-seen order for ties (stable sort)', () => {
  const { context } = projectWithSheet({ name: 'Sheet1', values: [['A']] });
  // "Pending", "Approved" and "Draft" all occur exactly once — first-seen order wins.
  const values = ['Pending', 'Approved', 'Draft'];
  assert.deepEqual(context._topFrequentValues_(values, 3), ['Pending', 'Approved', 'Draft']);
});

test('_topFrequentValues_ ignores empty/whitespace-only values', () => {
  const { context } = projectWithSheet({ name: 'Sheet1', values: [['A']] });
  const values = ['Open', '', '  ', 'Open', null, undefined, 'Closed'];
  assert.deepEqual(context._topFrequentValues_(values, 3), ['Open', 'Closed']);
});

test('_topFrequentValues_ respects topN even with more distinct values available', () => {
  const { context } = projectWithSheet({ name: 'Sheet1', values: [['A']] });
  const values = ['A', 'B', 'C', 'D', 'A', 'B'];
  assert.deepEqual(context._topFrequentValues_(values, 2), ['A', 'B']);
});

test('actionTopFrequentColumnValues reads the last `lookbackRows` values of a column and ranks them', () => {
  const sheet = {
    name: 'Sheet1',
    values: [
      ['Name', 'Status'],
      ['Alice', 'Open'],
      ['Bob', 'Closed'],
      ['Cara', 'Open'],
      ['Dan', 'Open'],
      ['Eve', 'Pending'],
    ],
  };
  const { context } = projectWithSheet(sheet);
  assert.deepEqual(
    context.actionTopFrequentColumnValues('file1', 'Sheet1', 2, 10, 3),
    ['Open', 'Closed', 'Pending']
  );
});

test('actionTopFrequentColumnValues defaults to lookback=10 / topN=3 when not specified', () => {
  const sheet = {
    name: 'Sheet1',
    values: [['Name', 'Status'], ['Alice', 'Open'], ['Bob', 'Open']],
  };
  const { context } = projectWithSheet(sheet);
  assert.deepEqual(context.actionTopFrequentColumnValues('file1', 'Sheet1', 2), ['Open']);
});

test('actionTopFrequentColumnValues returns [] for a column with no recent data', () => {
  const sheet = { name: 'Sheet1', values: [['Name', 'Status']] };
  const { context } = projectWithSheet(sheet);
  assert.deepEqual(context.actionTopFrequentColumnValues('file1', 'Sheet1', 2, 10, 3), []);
});
