'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createProject } = require('./harness');

/**
 * Three-level folder tree used across these tests:
 *   root ("root")
 *     ├─ file "Root Sheet"
 *     └─ sub ("sub")
 *          ├─ file "Sub Sheet"
 *          └─ subsub ("subsub")
 *               └─ file "SubSub Sheet"
 */
function threeLevelTree() {
  return {
    root: {
      name: 'Root',
      files: [{ id: 'f-root', name: 'Root Sheet' }],
      folders: {
        sub: {
          name: 'Sub',
          files: [{ id: 'f-sub', name: 'Sub Sheet' }],
          folders: {
            subsub: {
              name: 'SubSub',
              files: [{ id: 'f-subsub', name: 'SubSub Sheet' }],
              folders: {},
            },
          },
        },
      },
    },
  };
}

test('FOLDER_SCAN_DEPTH 0 only scans the folder itself', () => {
  const { context } = createProject({
    files: ['DataAccess.js'],
    CONFIG: { FOLDER_SCAN_DEPTH: 0, FOLDER_CACHE_TTL_SECONDS: 300 },
    DriveApp: threeLevelTree(),
  });
  const files = context.listSpreadsheetsInFolder('root');
  assert.deepEqual(files.map((f) => f.name), ['Root Sheet']);
});

test('FOLDER_SCAN_DEPTH 1 scans the folder plus one level of subfolders (legacy default behavior)', () => {
  const { context } = createProject({
    files: ['DataAccess.js'],
    CONFIG: { FOLDER_SCAN_DEPTH: 1, FOLDER_CACHE_TTL_SECONDS: 300 },
    DriveApp: threeLevelTree(),
  });
  const files = context.listSpreadsheetsInFolder('root');
  assert.deepEqual(files.map((f) => f.name).sort(), ['Root Sheet', 'Sub Sheet']);
});

test('FOLDER_SCAN_DEPTH 2 recurses two levels deep', () => {
  const { context } = createProject({
    files: ['DataAccess.js'],
    CONFIG: { FOLDER_SCAN_DEPTH: 2, FOLDER_CACHE_TTL_SECONDS: 300 },
    DriveApp: threeLevelTree(),
  });
  const files = context.listSpreadsheetsInFolder('root');
  assert.deepEqual(
    files.map((f) => f.name).sort(),
    ['Root Sheet', 'Sub Sheet', 'SubSub Sheet']
  );
});

test('missing FOLDER_SCAN_DEPTH falls back to depth 1 for backward compatibility', () => {
  const { context } = createProject({
    files: ['DataAccess.js'],
    CONFIG: { FOLDER_CACHE_TTL_SECONDS: 300 }, // no FOLDER_SCAN_DEPTH key at all
    DriveApp: threeLevelTree(),
  });
  const files = context.listSpreadsheetsInFolder('root');
  assert.deepEqual(files.map((f) => f.name).sort(), ['Root Sheet', 'Sub Sheet']);
});

test('trashed files are excluded from folder scans', () => {
  const { context } = createProject({
    files: ['DataAccess.js'],
    CONFIG: { FOLDER_SCAN_DEPTH: 0, FOLDER_CACHE_TTL_SECONDS: 300 },
    DriveApp: {
      root: {
        name: 'Root',
        files: [
          { id: 'f1', name: 'Keep Me' },
          { id: 'f2', name: 'Trashed', trashed: true },
        ],
        folders: {},
      },
    },
  });
  const files = context.listSpreadsheetsInFolder('root');
  assert.deepEqual(files.map((f) => f.name), ['Keep Me']);
});

test('results are cached — a second call does not touch DriveApp again', () => {
  let driveCalls = 0;
  const project = createProject({
    files: ['DataAccess.js'],
    CONFIG: { FOLDER_SCAN_DEPTH: 0, FOLDER_CACHE_TTL_SECONDS: 300 },
  });
  // Wrap DriveApp with a call counter after load, then re-point the global.
  const realDrive = require('./gas-mocks').createDriveAppMock({
    root: { name: 'Root', files: [{ id: 'f1', name: 'A' }], folders: {} },
  });
  project.context.DriveApp = {
    getFolderById(id) { driveCalls++; return realDrive.getFolderById(id); },
  };

  const first = project.context.listSpreadsheetsInFolder('root');
  const second = project.context.listSpreadsheetsInFolder('root');
  assert.deepEqual(first, second);
  assert.equal(driveCalls, 1, 'DriveApp should only be hit once; the second call must be served from cache');
});

test('forceRefresh bypasses the cache', () => {
  let driveCalls = 0;
  const project = createProject({
    files: ['DataAccess.js'],
    CONFIG: { FOLDER_SCAN_DEPTH: 0, FOLDER_CACHE_TTL_SECONDS: 300 },
  });
  const realDrive = require('./gas-mocks').createDriveAppMock({
    root: { name: 'Root', files: [{ id: 'f1', name: 'A' }], folders: {} },
  });
  project.context.DriveApp = {
    getFolderById(id) { driveCalls++; return realDrive.getFolderById(id); },
  };

  project.context.listSpreadsheetsInFolder('root');
  project.context.listSpreadsheetsInFolder('root', true);
  assert.equal(driveCalls, 2);
});

// ---------------------------------------------------------------------------
// getLastRows — sheet.getLastRow() "phantom row" regression
//
// sheet.getLastRow() reports the last row that ever had content OR
// formatting, not the last row with actual data — a stray click/format far
// below the real data inflates it. That silently broke both the "Use last
// value" buttons (blank last row never passes the non-empty check in
// Navigation.js) and the add-row formula/merge auto-skip (isCellFormula
// checked the wrong, blank row) — a real bug caught live. getLastRows must
// walk back to the true last non-empty row before returning.
// ---------------------------------------------------------------------------

function sheetWithRows(dataRows, trailingBlankRows) {
  const values = [['Name', 'Total']].concat(dataRows);
  for (let i = 0; i < (trailingBlankRows || 0); i++) values.push(['', '']);
  return { name: 'Sheet1', values };
}

test('getLastRows returns the real last row when there is no phantom gap', () => {
  const sheet = sheetWithRows([['Alice', '100'], ['Bob', '200']]);
  const { context } = createProject({
    files: ['DataAccess.js'],
    SpreadsheetApp: { file1: { sheets: [sheet] } },
  });
  const rows = context.getLastRows('file1', 'Sheet1', 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rowIndex, 3);
  assert.deepEqual(rows[0].values, ['Bob', '200']);
});

test('getLastRows skips trailing blank "phantom" rows left by stray formatting', () => {
  // Real data ends at row 3 ("Bob"); rows 4-8 are blank but still count
  // toward sheet.getLastRow() in real Sheets (and in this mock, which
  // mirrors that by using the raw values array length).
  const sheet = sheetWithRows([['Alice', '100'], ['Bob', '200']], 5);
  const { context } = createProject({
    files: ['DataAccess.js'],
    SpreadsheetApp: { file1: { sheets: [sheet] } },
  });

  const rows = context.getLastRows('file1', 'Sheet1', 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rowIndex, 3, 'must resolve to the real last data row, not the inflated phantom row');
  assert.deepEqual(rows[0].values, ['Bob', '200']);
});

test('getLastRows(n=2) still returns newest-first after skipping a phantom gap', () => {
  const sheet = sheetWithRows([['Alice', '100'], ['Bob', '200'], ['Cara', '300']], 4);
  const { context } = createProject({
    files: ['DataAccess.js'],
    SpreadsheetApp: { file1: { sheets: [sheet] } },
  });
  const rows = context.getLastRows('file1', 'Sheet1', 2);
  assert.deepEqual(rows.map((r) => r.values), [['Cara', '300'], ['Bob', '200']]);
});

test('getLastRows returns [] when everything within the scan window is blank', () => {
  // Header + 10 blank rows, nothing real to find within the lookback window.
  const sheet = sheetWithRows([], 10);
  const { context } = createProject({
    files: ['DataAccess.js'],
    SpreadsheetApp: { file1: { sheets: [sheet] } },
  });
  assert.deepEqual(context.getLastRows('file1', 'Sheet1', 1), []);
});

test('_findLastNonEmptyRow_ is capped to LAST_ROW_SCAN_WINDOW_ rows — a single bounded read, not a full-sheet scan', () => {
  // Real data at row 3, but the phantom gap (300 blank rows) is far wider
  // than the scan window, so the real row is legitimately out of reach —
  // this documents the bound rather than scanning arbitrarily far back.
  const sheet = sheetWithRows([['Alice', '100'], ['Bob', '200']], 300);
  const { context } = createProject({
    files: ['DataAccess.js'],
    SpreadsheetApp: { file1: { sheets: [sheet] } },
  });
  assert.deepEqual(context.getLastRows('file1', 'Sheet1', 1), []);
});

// ---------------------------------------------------------------------------
// getLastColumnValues — feeds the "Recent TOP3 values" button. Shares the
// same real-last-row resolution as getLastRows, so the phantom-row fix must
// carry over to a single-column read too.
// ---------------------------------------------------------------------------

test('getLastColumnValues returns the last n values of one column, oldest-first', () => {
  const sheet = sheetWithRows([
    ['Alice', 'Open'],
    ['Bob', 'Closed'],
    ['Cara', 'Open'],
    ['Dan', 'Pending'],
  ]);
  const { context } = createProject({
    files: ['DataAccess.js'],
    SpreadsheetApp: { file1: { sheets: [sheet] } },
  });
  // Column 2 ("Total" header slot, holding status strings here), last 3 values.
  assert.deepEqual(
    context.getLastColumnValues('file1', 'Sheet1', 2, 3),
    ['Closed', 'Open', 'Pending']
  );
});

test('getLastColumnValues skips trailing blank "phantom" rows like getLastRows does', () => {
  const sheet = sheetWithRows([['Alice', 'Open'], ['Bob', 'Closed'], ['Cara', 'Open']], 6);
  const { context } = createProject({
    files: ['DataAccess.js'],
    SpreadsheetApp: { file1: { sheets: [sheet] } },
  });
  assert.deepEqual(context.getLastColumnValues('file1', 'Sheet1', 2, 10), ['Open', 'Closed', 'Open']);
});

test('getLastColumnValues returns [] when the sheet has no data rows', () => {
  const sheet = sheetWithRows([]);
  const { context } = createProject({
    files: ['DataAccess.js'],
    SpreadsheetApp: { file1: { sheets: [sheet] } },
  });
  assert.deepEqual(context.getLastColumnValues('file1', 'Sheet1', 1, 10), []);
});

test('getLastColumnValues returns [] when colIndex is past the last column', () => {
  const sheet = sheetWithRows([['Alice', 'Open']]);
  const { context } = createProject({
    files: ['DataAccess.js'],
    SpreadsheetApp: { file1: { sheets: [sheet] } },
  });
  assert.deepEqual(context.getLastColumnValues('file1', 'Sheet1', 5, 10), []);
});
