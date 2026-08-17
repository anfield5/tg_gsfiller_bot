/**
 * Icons.js
 * Central registry of every emoji/icon used in the bot's UI.
 *
 * Nothing here is secret, so this file IS committed (unlike Config.js).
 * If you want to re-skin the bot, override individual keys via
 * `CONFIG.ICONS = { ... }` in your own Config.js — any key you don't set
 * falls back to DEFAULT_ICONS below, so existing deployments keep working
 * without touching Config.js at all.
 *
 * Resolution is lazy (getIcons_()) rather than a top-level `const`, because
 * Apps Script does not guarantee file load order across the project, and
 * CONFIG lives in a different file. Calling getIcons_() from inside a
 * function body (which always runs after the whole project has loaded) is
 * the only safe way to read CONFIG at this layer.
 */

const DEFAULT_ICONS = {
  // Navigation / lists
  FOLDER:     '📁',
  FILE:       '📄',
  SHEET:      '📑',
  BACK:       '⬅️',
  PREV_PAGE:  '◀️',
  NEXT_PAGE:  '▶️',
  REFRESH:    '🔄',
  LINK:       '🔗',

  // Sheet menu actions
  ADD:        '➕',
  EDIT:       '✏️',
  PREVIEW:    '🔍',
  ROW_NUMBER: '🔢',
  CHART:      '📊',
  BULLET:     '🔹',

  // Favorites
  FAV:        '⭐', // "this is favorited" / "add to favorites"
  UNFAV:      '★',  // "remove from favorites"

  // Add-row flow
  USE_LAST:    '🔘',
  LEAVE_EMPTY: '🔲',
  FINISH:      '🏁',
  PREV_FIELD:  '⏮️',
  CANCEL:      '❌',
  SAVE:        '✅',
  FORMULA:     '🧬',
  POINTER:     '👉',

  // Status
  WARNING: '⚠️',
  DENIED:  '🚫',
};

let _iconsCache = null;

/**
 * Returns the effective icon set: DEFAULT_ICONS with any keys present in
 * CONFIG.ICONS overridden. Result is memoised for the lifetime of the
 * execution (Apps Script re-evaluates the whole project per invocation
 * anyway, so this only saves repeated merges within a single request).
 *
 * @returns {Object<string,string>}
 */
function getIcons_() {
  if (_iconsCache) return _iconsCache;

  const overrides = (typeof CONFIG !== 'undefined' && CONFIG && CONFIG.ICONS) || {};
  const merged = {};
  Object.keys(DEFAULT_ICONS).forEach(function (key) { merged[key] = DEFAULT_ICONS[key]; });
  Object.keys(overrides).forEach(function (key) { merged[key] = overrides[key]; });

  _iconsCache = merged;
  return _iconsCache;
}

/**
 * The full placeholder text shown (and stored) for auto-filled formula
 * cells during the add-row flow. Defined once here so Navigation.js and
 * SheetActions.js never disagree on the literal string.
 * @returns {string}
 */
function formulaPlaceholderText_() {
  return getIcons_().FORMULA + ' (Calculated Formula)';
}
