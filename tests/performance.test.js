'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createProject } = require('./harness');

/**
 * Regression guards for the speed work: these assert how MANY slow Apps
 * Script calls (PropertiesService, Sheets reads, Telegram sends) common
 * actions make, since each one costs real latency in production. A future
 * change that quietly reintroduces an N+1 pattern fails here instead of
 * showing up as "the bot feels slow again".
 */

// ---------------------------------------------------------------------------
// State memoization (PropertiesService reads/writes)
// ---------------------------------------------------------------------------

function stateProject() {
  const { context, properties } = createProject({ files: ['Logging.js', 'State.js'] });
  const counts = { reads: 0, writes: 0 };
  const real = properties;
  context.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => { counts.reads++; return real.getProperty(k); },
      setProperty: (k, v) => { counts.writes++; return real.setProperty(k, v); },
      deleteProperty: (k) => real.deleteProperty(k),
    }),
  };
  return { context, counts };
}

test('getState reads PropertiesService once per execution, however many times it is called', () => {
  const { context, counts } = stateProject();
  context.getState('111'); context.getState('111'); context.getState('111');
  assert.equal(counts.reads, 1);
});

test('getState still returns a fresh object each call (mutating one does not leak into the next read)', () => {
  const { context } = stateProject();
  context.setState('111', { step: 'x', n: 1 });
  const a = context.getState('111');
  a.n = 999;
  assert.equal(context.getState('111').n, 1);
});

test('setState skips the write when nothing changed', () => {
  const { context, counts } = stateProject();
  context.setState('111', { step: 'x' });
  assert.equal(counts.writes, 1);
  context.setState('111', { step: 'x' });
  context.setState('111', context.getState('111'));
  assert.equal(counts.writes, 1, 'identical content must not be rewritten');
  context.setState('111', { step: 'y' });
  assert.equal(counts.writes, 2);
});

test('resetStateMemo_ forces a fresh read (what doPost does at the start of every webhook call)', () => {
  const { context, counts } = stateProject();
  context.getState('111');
  context.resetStateMemo_();
  context.getState('111');
  assert.equal(counts.reads, 2);
});

test('clearState is reflected immediately without another read', () => {
  const { context, counts } = stateProject();
  context.setState('111', { step: 'x' });
  context.clearState('111');
  assert.equal(context.getState('111').step, 'main_menu');
  assert.equal(counts.reads, 0);
});

// ---------------------------------------------------------------------------
// Last-row scan: small first read
// ---------------------------------------------------------------------------

function fakeSheet(totalRows, lastDataRow, cols) {
  const reads = [];
  return {
    reads,
    getRange(row, col, numRows) {
      reads.push({ row, numRows });
      return {
        getDisplayValues() {
          const out = [];
          for (let r = row; r < row + numRows; r++) {
            out.push(Array.from({ length: cols }, () => (r <= lastDataRow ? 'x' : '')));
          }
          return out;
        },
      };
    },
  };
}

test('_findLastNonEmptyRow_ finds a normal last row with one small (20-row) read, not the full 200-row window', () => {
  const { context } = createProject({ files: ['Logging.js', 'Timing.js', 'DataAccess.js'] });
  const sheet = fakeSheet(500, 500, 3);
  assert.equal(context._findLastNonEmptyRow_(sheet, 500, 3), 500);
  assert.deepEqual(sheet.reads, [{ row: 481, numRows: 20 }]);
});

test('_findLastNonEmptyRow_ falls back to the full window when the quick one is all blank (phantom rows)', () => {
  const { context } = createProject({ files: ['Logging.js', 'Timing.js', 'DataAccess.js'] });
  const sheet = fakeSheet(500, 450, 3); // 50 phantom blank rows below the real data
  assert.equal(context._findLastNonEmptyRow_(sheet, 500, 3), 450);
  assert.equal(sheet.reads.length, 2);
  assert.equal(sheet.reads[0].numRows, 20);
  assert.equal(sheet.reads[1].numRows, 200);
});

// ---------------------------------------------------------------------------
// Edit-row flow: Sheets calls and Telegram sends
// ---------------------------------------------------------------------------

function editProject(extraRows) {
  const values = [['Name', 'Status', 'Merged', 'Merged2', 'Total']];
  const formulas = {};
  const merges = [];
  const n = 3 + (extraRows || 0);
  for (let i = 0; i < n; i++) {
    const r = i + 2;
    values.push(['N' + r, i % 2 ? 'Open' : 'Closed', 'Y', 'Y', String(r)]);
    formulas[r + ',5'] = '=A' + r;
    merges.push({ row: r, col: 3, numRows: 1, numCols: 2 });
  }
  const sheet = { name: 'Sheet1', frozenRows: 1, values, formulas, merges };

  const project = createProject({
    CONFIG: {
      FOLDER_IDS: ['folderA'], FOLDER_LABELS: ['Test Folder'], FILES_PER_PAGE: 10,
      FOLDER_CACHE_TTL_SECONDS: 300, FOLDER_SCAN_DEPTH: 1,
    },
    DriveApp: { folderA: { name: 'Test Folder', files: [{ id: 'file1', name: 'Test Sheet' }], folders: {} } },
    SpreadsheetApp: { file1: { sheets: [sheet] } },
    initialProperties: { ADMIN_IDS: '111' },
  });

  // Count every Sheets getRange call and the biggest row span requested.
  const stats = { getRange: 0, maxRows: 0 };
  const realOpen = project.context.SpreadsheetApp.openById;
  project.context.SpreadsheetApp.openById = (id) => {
    const ss = realOpen(id);
    return {
      getSheets: () => ss.getSheets(),
      getSheetByName(name) {
        const sh = ss.getSheetByName(name);
        return new Proxy(sh, {
          get(t, k) {
            if (k === 'getRange') {
              return (row, col, numRows, numCols) => {
                stats.getRange++;
                stats.maxRows = Math.max(stats.maxRows, numRows || 1);
                return t.getRange(row, col, numRows, numCols);
              };
            }
            return t[k];
          },
        });
      },
    };
  };
  return Object.assign(project, { stats });
}

function selectRow(context, chatId, rowIndex) {
  context.setState(chatId, {
    step: 'sheet_menu', folderIndex: 0, folderId: 'folderA', folderName: 'Test Folder',
    fileId: 'file1', fileName: 'Test Sheet', sheetName: 'Sheet1',
  });
  context.handleEditRowSelect(chatId, rowIndex);
}

test('after a row is selected, opening a field and using Next/Previous/All fields costs ZERO further Sheets reads', () => {
  const { context, stats } = editProject();
  selectRow(context, '111', 3);
  const afterSelect = stats.getRange;

  context.handleEditFieldSelect('111', 1);
  context.routeAction('111', 'edit_next_field');
  context.routeAction('111', 'edit_prev_field');
  context.routeAction('111', 'back:rowview');
  context.handleEditFieldSelect('111', 2);

  assert.equal(stats.getRange, afterSelect, 'formula/merge flags are precomputed once per row — no per-column probing');
});

test('selecting a row reads the sheet a small, fixed number of times (not per column)', () => {
  const { context, stats } = editProject();
  selectRow(context, '111', 3);
  // headers, row values, last-row scan (quick window + data read),
  // formula flags, merge flags = 6, regardless of column count.
  assert.ok(stats.getRange <= 6, 'got ' + stats.getRange + ' getRange calls');
});

test('the row view goes out as ONE Telegram message (data + prompt together)', () => {
  const { context, urlFetch } = editProject();
  selectRow(context, '111', 3);
  const before = urlFetch.calls.length;
  context.renderRowView('111', context.getState('111'));
  const sent = urlFetch.calls.slice(before);
  assert.equal(sent.length, 1);
  assert.match(sent[0].body.text, /Row 3 current data/);
  assert.match(sent[0].body.text, /Select a field to edit/);
});

test('the recent-rows list for page 1 reads only about one page of rows, not 1000', () => {
  const { context, stats, urlFetch } = editProject(40); // 43 data rows
  context.setState('111', {
    step: 'sheet_menu', folderIndex: 0, folderId: 'folderA', folderName: 'Test Folder',
    fileId: 'file1', fileName: 'Test Sheet', sheetName: 'Sheet1',
  });
  context.handleEditStart('111');

  assert.ok(stats.maxRows <= 20, 'largest read was ' + stats.maxRows + ' rows');
  const body = urlFetch.calls[urlFetch.calls.length - 1].body;
  assert.match(body.text, /Recent rows \(page 1\)/);
  assert.match(body.text, /Tap a row to edit/);
  const labels = body.reply_markup.keyboard.flat().map((b) => b.text);
  assert.ok(labels.some((l) => /Next Rows/.test(l)), 'more rows exist, so Next Rows must still be offered');
});

test('paging forward still works with the smaller fetch', () => {
  const { context, urlFetch } = editProject(40);
  context.setState('111', {
    step: 'sheet_menu', folderIndex: 0, folderId: 'folderA', folderName: 'Test Folder',
    fileId: 'file1', fileName: 'Test Sheet', sheetName: 'Sheet1',
  });
  context.handleEditPage('111', 2);
  const body = urlFetch.calls[urlFetch.calls.length - 1].body;
  assert.match(body.text, /Recent rows \(page 3\)/);
  // Newest-first: 43 data rows end at row 44, so page 3 starts at 44 - 20 = row 24.
  assert.match(body.text, /<b>Row 24<\/b>/);
});
