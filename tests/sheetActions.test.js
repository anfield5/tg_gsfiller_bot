'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createProject } = require('./harness');

function projectWithSheet(sheetSpec) {
  return createProject({
    files: ['Icons.js', 'TelegramApi.js', 'DataAccess.js', 'SheetActions.js'],
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
    files: ['Icons.js', 'TelegramApi.js', 'DataAccess.js', 'SheetActions.js'],
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
    files: ['Icons.js', 'TelegramApi.js', 'DataAccess.js', 'SheetActions.js'],
    SpreadsheetApp: { file1: { sheets: [sheet] } },
  });

  context.actionAddRow('file1', 'Sheet1', { A: 'z', B: 'z', C: 'w' }, ['A', 'B', 'C']);

  const newRowMerge = sheet.merges.find((m) => m.row === 3);
  assert.ok(newRowMerge, 'a merge should have been created on the newly appended row');
  assert.equal(newRowMerge.col, 1);
  assert.equal(newRowMerge.numCols, 2);
});
