'use strict';

/**
 * harness.js
 * Loads the Apps Script source files (plain global-scope scripts, no module
 * system) into a shared vm context alongside GAS service mocks, so tests can
 * call the bot's global functions directly — e.g. context.handleAddStart(...).
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const mocks = require('./gas-mocks');

const SRC_DIR = path.join(__dirname, '..', 'src');

// Load order matters only in that a file must not be *executed* before a
// global it references at call time is *defined* — since every reference in
// this project happens inside function bodies (never at top-level besides
// `const` declarations with no cross-file dependency), any order that loads
// each file once works. Kept in rough dependency order for readability.
const DEFAULT_FILES = [
  'Icons.js',
  'TelegramApi.js',
  'State.js',
  'DataAccess.js',
  'SheetActions.js',
  'Navigation.js',
  'Code.js',
];

/**
 * @param {Object} [overrides]
 * @param {Object} [overrides.CONFIG]
 * @param {Object} [overrides.DriveApp]        raw folderTree, wrapped with createDriveAppMock
 * @param {Object} [overrides.SpreadsheetApp]  raw filesSpec, wrapped with createSpreadsheetAppMock
 * @param {Object} [overrides.initialProperties]
 * @param {string[]} [overrides.files]         subset of DEFAULT_FILES to load
 * @returns {{ context: Object, cache: Object, properties: Object, urlFetch: Object }}
 */
function createProject(overrides) {
  overrides = overrides || {};

  const cache      = overrides.cache      || mocks.createCacheMock();
  const properties = overrides.properties || mocks.createPropertiesMock(overrides.initialProperties);
  const urlFetch   = overrides.urlFetch   || mocks.createUrlFetchMock();

  const driveApp = overrides.DriveApp
    ? mocks.createDriveAppMock(overrides.DriveApp)
    : {};
  const spreadsheetApp = overrides.SpreadsheetApp
    ? mocks.createSpreadsheetAppMock(overrides.SpreadsheetApp)
    : {};

  const sandbox = {
    console,
    CONFIG: overrides.CONFIG || {
      FOLDER_IDS: [], FOLDER_LABELS: [], FILES_PER_PAGE: 10,
      FOLDER_CACHE_TTL_SECONDS: 300, FOLDER_SCAN_DEPTH: 1,
    },
    DriveApp: driveApp,
    SpreadsheetApp: spreadsheetApp,
    CacheService: { getScriptCache: () => cache },
    PropertiesService: { getScriptProperties: () => properties },
    LockService: { getScriptLock: () => mocks.createLockMock() },
    UrlFetchApp: urlFetch,
    ContentService: { createTextOutput: (t) => ({ text: t }) },
    Utilities: {
      // Deterministic, UTC-based stand-in for GAS's Utilities.formatDate.
      // Only the 'dd.MM.yyyy' pattern used by DataAccess.js is supported.
      formatDate(date /*, timeZone, pattern */) {
        const pad = (n) => String(n).padStart(2, '0');
        return pad(date.getUTCDate()) + '.' + pad(date.getUTCMonth() + 1) + '.' + date.getUTCFullYear();
      },
    },
    Session: { getScriptTimeZone: () => 'UTC' },
    MimeType: { GOOGLE_SHEETS: 'application/vnd.google-apps.spreadsheet' },
    getBotToken_: overrides.getBotToken_ || (() => 'TEST_TOKEN'),
  };

  const context = vm.createContext(sandbox);
  const files = overrides.files || DEFAULT_FILES;
  files.forEach((name) => {
    const code = fs.readFileSync(path.join(SRC_DIR, name), 'utf8');
    vm.runInContext(code, context, { filename: name });
  });

  return { context, cache, properties, urlFetch };
}

module.exports = { createProject, SRC_DIR };
