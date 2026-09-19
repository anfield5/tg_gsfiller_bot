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
  'Logging.js',
  'Timing.js',
  'Icons.js',
  'TelegramApi.js',
  'GeminiApi.js',
  'State.js',
  'DataAccess.js',
  'SheetActions.js',
  'GeminiActions.js',
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

  // Node's vm module only proxies a context's OWN properties back to the
  // sandbox object handed to createContext — built-ins the new realm sets up
  // for itself (Date, Math, JSON, ...) are visible to code running *inside*
  // the context but not as `context.Date` from the outside. Several tests
  // fake the clock via `context.Date.now = ...` (Timing.js's _timed_, now
  // also exercised indirectly through Logging.js's timestamped ring buffer),
  // so Date must be seeded here explicitly. A per-call subclass (rather than
  // the real global Date itself) means a test overwriting `.now` only
  // affects its own context, not the real Date.now used by every other test
  // and by Node itself.
  class ContextDate extends Date {}
  ContextDate.now = Date.now.bind(Date);

  const sandbox = {
    console,
    Date: ContextDate,
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
      // Only the two patterns actually used in src/*.js are supported:
      // 'dd.MM.yyyy' (DataAccess.js) and 'HH:mm:ss' (Logging.js's timestamp
      // prefix).
      formatDate(date, timeZone, pattern) {
        const pad = (n) => String(n).padStart(2, '0');
        if (pattern === 'HH:mm:ss') {
          return pad(date.getUTCHours()) + ':' + pad(date.getUTCMinutes()) + ':' + pad(date.getUTCSeconds());
        }
        return pad(date.getUTCDate()) + '.' + pad(date.getUTCMonth() + 1) + '.' + date.getUTCFullYear();
      },
    },
    Session: { getScriptTimeZone: () => 'UTC' },
    MimeType: { GOOGLE_SHEETS: 'application/vnd.google-apps.spreadsheet' },
    // GAS's Logger.log — src/*.js calls this on API error paths (GeminiApi.js,
    // Navigation.js's _sendMediaBlob_). A no-op is fine; tests assert on
    // thrown errors/sent messages, not on what got logged.
    Logger: { log() {} },
    getBotToken_: overrides.getBotToken_ || (() => 'TEST_TOKEN'),
    getGeminiApiKey_: overrides.getGeminiApiKey_ || (() => 'TEST_GEMINI_KEY'),
  };

  // Utilities.base64Decode / newBlob — used by GeminiApi.js's _pcmToWavBlob_
  // and callGeminiImage_. Real GAS byte arrays are signed (-128..127); this
  // mock mirrors that so tests can exercise the actual sign-normalisation
  // logic in _pcmToWavBlob_ instead of a shortcut.
  sandbox.Utilities.base64Decode = function (base64) {
    const buf = Buffer.from(base64, 'base64');
    const out = [];
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      out.push(b > 127 ? b - 256 : b);
    }
    return out;
  };
  sandbox.Utilities.newBlob = function (bytes, mimeType, name) {
    return { bytes: bytes, mimeType: mimeType, name: name, getContentType: () => mimeType, getName: () => name };
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
