'use strict';

/**
 * gas-mocks.js
 * Minimal, dependency-free mocks for the Google Apps Script services the
 * bot uses (DriveApp, SpreadsheetApp, CacheService, PropertiesService,
 * LockService, UrlFetchApp). Only the surface area actually called from
 * src/*.js is implemented — this is a test double, not a full GAS shim.
 */

// ---------------------------------------------------------------------------
// Simple key/value services
// ---------------------------------------------------------------------------

function createCacheMock() {
  const store = new Map();
  return {
    get(key) { return store.has(key) ? store.get(key) : null; },
    put(key, value /* , ttlSeconds */) { store.set(key, value); },
    remove(key) { store.delete(key); },
    _store: store,
  };
}

function createPropertiesMock(initial) {
  const store = new Map(Object.entries(initial || {}));
  return {
    getProperty(key) { return store.has(key) ? store.get(key) : null; },
    setProperty(key, value) { store.set(key, value); },
    deleteProperty(key) { store.delete(key); },
    _store: store,
  };
}

function createLockMock() {
  return { waitLock() {}, releaseLock() {} };
}

function createUrlFetchMock() {
  const calls = [];
  return {
    calls,
    fetch(url, options) {
      let body = null;
      try { body = options && options.payload ? JSON.parse(options.payload) : null; } catch (e) { /* ignore */ }
      calls.push({ url, options, body });
      return { getResponseCode: () => 200, getContentText: () => '{}' };
    },
  };
}

// ---------------------------------------------------------------------------
// Drive mocks
// ---------------------------------------------------------------------------

/**
 * folderTree: { [folderId]: { name, files: [{id,name,trashed?}], folders: { [subId]: <spec> } } }
 */
function makeFolderMock(spec) {
  const files = spec.files || [];
  const subfolders = spec.folders || {};

  return {
    getName: () => spec.name,
    getFilesByType() {
      let i = 0;
      return {
        hasNext: () => i < files.length,
        next: () => {
          const f = files[i++];
          return { getId: () => f.id, getName: () => f.name, isTrashed: () => !!f.trashed };
        },
      };
    },
    getFolders() {
      const specs = Object.values(subfolders);
      let i = 0;
      return {
        hasNext: () => i < specs.length,
        next: () => makeFolderMock(specs[i++]),
      };
    },
  };
}

function createDriveAppMock(folderTree) {
  return {
    getFolderById(id) {
      const spec = folderTree[id];
      if (!spec) throw new Error('Mock folder not found: ' + id);
      return makeFolderMock(spec);
    },
  };
}

// ---------------------------------------------------------------------------
// Sheets mocks
// ---------------------------------------------------------------------------

/**
 * sheetSpec: {
 *   name, hidden?, gid?,
 *   values:   [[...row1], [...row2], ...]        // 1-indexed rows
 *   formulas: { "row,col": "=A1" }
 *   merges:   [{ row, col, numRows, numCols }]
 * }
 * Mutations (appendRow / setValue / merge / copyTo) write back into this
 * same spec object, so state persists across repeated getSheetByName() calls
 * — mirroring real Spreadsheet/Sheet objects being live handles.
 */
function makeRangeMock(sheet, row, col, numRows, numCols) {
  const cellValue = (r, c) => {
    const rowArr = sheet.values[r - 1] || [];
    const v = rowArr[c - 1];
    return v === undefined ? '' : v;
  };
  const cellFormula = (r, c) => (sheet.formulas && sheet.formulas[r + ',' + c]) || '';

  function overlappingMerges() {
    return (sheet.merges || []).filter(m =>
      m.row <= row + numRows - 1 && m.row + m.numRows - 1 >= row &&
      m.col <= col + numCols - 1 && m.col + m.numCols - 1 >= col
    );
  }

  const range = {
    getValues() {
      const out = [];
      for (let r = row; r < row + numRows; r++) {
        const rowOut = [];
        for (let c = col; c < col + numCols; c++) rowOut.push(cellValue(r, c));
        out.push(rowOut);
      }
      return out;
    },
    getDisplayValues() {
      return range.getValues().map(r => r.map(v => (v === null || v === undefined) ? '' : String(v)));
    },
    getMergedRanges() {
      return overlappingMerges().map(m => ({
        getRow: () => m.row,
        getColumn: () => m.col,
        getLastColumn: () => m.col + m.numCols - 1,
        getCell: (r, c) => makeRangeMock(sheet, m.row + r - 1, m.col + c - 1, 1, 1),
      }));
    },
    getFormula() { return cellFormula(row, col); },
    getValue() { return cellValue(row, col); },
    isPartOfMerge() { return overlappingMerges().length > 0; },
    getColumn: () => col,
    setValue(v) {
      sheet.values[row - 1] = sheet.values[row - 1] || [];
      sheet.values[row - 1][col - 1] = v;
    },
    merge() {
      sheet.merges = sheet.merges || [];
      sheet.merges.push({ row, col, numRows, numCols });
    },
    copyTo(dest) {
      sheet.formulas = sheet.formulas || {};
      sheet.formulas[dest._row + ',' + dest._col] = cellFormula(row, col);
    },
    _row: row,
    _col: col,
  };
  return range;
}

function makeSheetMock(spec) {
  return {
    getName: () => spec.name,
    isSheetHidden: () => !!spec.hidden,
    getLastColumn: () => Math.max(0, ...(spec.values || []).map(r => r.length)),
    getLastRow: () => (spec.values || []).length,
    getSheetId: () => spec.gid || 0,
    getRange(row, col, numRows, numCols) {
      return makeRangeMock(spec, row, col, numRows || 1, numCols || 1);
    },
    appendRow(values) {
      spec.values = spec.values || [];
      spec.values.push(values.slice());
    },
  };
}

/** filesSpec: { [fileId]: { sheets: [sheetSpec, ...] } } */
function createSpreadsheetAppMock(filesSpec) {
  return {
    CopyPasteType: { PASTE_FORMULA: 'PASTE_FORMULA' },
    openById(fileId) {
      const fileSpec = filesSpec[fileId];
      if (!fileSpec) throw new Error('Mock file not found: ' + fileId);
      return {
        getSheets: () => fileSpec.sheets.map(makeSheetMock),
        getSheetByName(name) {
          const s = fileSpec.sheets.find(sh => sh.name === name);
          return s ? makeSheetMock(s) : null;
        },
      };
    },
  };
}

module.exports = {
  createCacheMock,
  createPropertiesMock,
  createLockMock,
  createUrlFetchMock,
  createDriveAppMock,
  createSpreadsheetAppMock,
};
