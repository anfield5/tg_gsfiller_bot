'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createProject } = require('./harness');

test('columnNumberToLetter converts 1-based column numbers to letters', () => {
  const { context } = createProject({ files: ['Icons.js', 'TelegramApi.js', 'SheetActions.js'] });
  assert.equal(context.columnNumberToLetter(1), 'A');
  assert.equal(context.columnNumberToLetter(26), 'Z');
  assert.equal(context.columnNumberToLetter(27), 'AA');
  assert.equal(context.columnNumberToLetter(52), 'AZ');
  assert.equal(context.columnNumberToLetter(703), 'AAA');
});

test('formatPreview truncates long values and labels empties', () => {
  const { context } = createProject({ files: ['Icons.js', 'TelegramApi.js', 'SheetActions.js'] });
  assert.equal(context.formatPreview('', 10), '(empty)');
  assert.equal(context.formatPreview(null, 10), '(empty)');
  assert.equal(context.formatPreview(undefined, 10), '(empty)');
  assert.equal(context.formatPreview('short', 10), 'short');
  assert.equal(context.formatPreview('exactly-10', 10), 'exactly-10');
  assert.equal(context.formatPreview('this is definitely too long', 10), 'this is d…');
});

test('escapeHtml_ escapes &, < and > but leaves other characters alone', () => {
  const { context } = createProject({ files: ['Icons.js', 'TelegramApi.js'] });
  assert.equal(context.escapeHtml_('R&D'), 'R&amp;D');
  assert.equal(context.escapeHtml_('5 < 10 > 2'), '5 &lt; 10 &gt; 2');
  assert.equal(context.escapeHtml_('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(context.escapeHtml_(null), '');
  assert.equal(context.escapeHtml_(undefined), '');
  assert.equal(context.escapeHtml_(42), '42');
  // Already-safe text is unaffected.
  assert.equal(context.escapeHtml_('Иванов И.И.'), 'Иванов И.И.');
});

test('escapeHtml_ prevents a raw cell value from breaking Telegram HTML parse_mode', () => {
  const { context } = createProject({ files: ['Icons.js', 'TelegramApi.js'] });
  const cellValue = 'Q&A <urgent>';
  const message = '<b>' + context.escapeHtml_(cellValue) + '</b>';
  assert.equal(message, '<b>Q&amp;A &lt;urgent&gt;</b>');
  // The literal tags we added ourselves must survive untouched.
  assert.match(message, /^<b>.*<\/b>$/);
});

test('_sanitiseCellValue_ neutralises formula-injection prefixes', () => {
  const { context } = createProject({ files: ['DataAccess.js'] });
  assert.equal(context._sanitiseCellValue_('=SUM(A1:A2)'), "'=SUM(A1:A2)");
  assert.equal(context._sanitiseCellValue_('+1234'), "'+1234");
  assert.equal(context._sanitiseCellValue_('-1234'), "'-1234");
  assert.equal(context._sanitiseCellValue_('@mention'), "'@mention");
  assert.equal(context._sanitiseCellValue_('normal text'), 'normal text');
  assert.equal(context._sanitiseCellValue_(''), '');
  // Non-string values pass through untouched (numbers, booleans, etc.).
  assert.equal(context._sanitiseCellValue_(42), 42);
});

test('_normaliseDateString_ converts Date-toString values to dd.MM.yyyy and passes through everything else', () => {
  const { context } = createProject({ files: ['DataAccess.js'] });
  assert.equal(context._normaliseDateString_('2026-01-01T00:00:00.000Z'), '01.01.2026');
  assert.equal(context._normaliseDateString_('Hello World'), 'Hello World');
  // Looks date-ish (contains "00:00:00") but isn't parseable — falls through unchanged.
  assert.equal(context._normaliseDateString_('not a date 00:00:00 nonsense'), 'not a date 00:00:00 nonsense');
});

test('getIcons_ returns defaults, and CONFIG.ICONS overrides only the keys it sets', () => {
  const withDefaults = createProject({ files: ['Icons.js'] });
  const icons = withDefaults.context.getIcons_();
  assert.equal(icons.ADD, '➕');
  assert.equal(icons.CANCEL, '❌');

  const withOverride = createProject({
    files: ['Icons.js'],
    CONFIG: { ICONS: { ADD: '🆕' } },
  });
  const overridden = withOverride.context.getIcons_();
  assert.equal(overridden.ADD, '🆕', 'overridden key should change');
  assert.equal(overridden.CANCEL, '❌', 'keys not overridden should keep their default');
});

test('formulaPlaceholderText_ is defined once and reused by both Navigation and SheetActions', () => {
  const { context } = createProject({ files: ['Icons.js'] });
  const text = context.formulaPlaceholderText_();
  assert.match(text, /Calculated Formula/);
  assert.equal(text, context.getIcons_().FORMULA + ' (Calculated Formula)');
});
