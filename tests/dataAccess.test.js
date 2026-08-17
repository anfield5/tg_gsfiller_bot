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
