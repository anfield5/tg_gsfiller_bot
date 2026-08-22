# Telegram → Google Sheets navigator bot

A Telegram bot (Google Apps Script, V8) that lets you browse a fixed set of
Google Drive folders, open a spreadsheet, pick a sheet tab, and add or edit
rows — all from your phone, without opening Drive.

Runs entirely under your own Google account (no OAuth flow, no per-user
tokens): the script uses `DriveApp` / `SpreadsheetApp` as *you*, the deployer.

## Project layout

```
src/
  Code.js             entry point, doPost() routing
  Config.js.example    template — copy to Config.js (gitignored) and fill in
  Icons.js             all UI emoji in one place, with CONFIG.ICONS overrides
  State.js             per-user state (PropertiesService)
  Navigation.js        screens & the step-by-step flow
  SheetActions.js      business logic, calls DataAccess.js only
  DataAccess.js        the ONLY file that touches DriveApp/SpreadsheetApp
  TelegramApi.js        sendMessage / sendMessageWithKeyboard / escapeHtml_
  GeminiApi.js          thin wrapper around the Gemini generateContent API
  GeminiActions.js      builds the data dump + prompt, calls GeminiApi.js
  appsscript.json      manifest (scopes, runtime, web app config)
cloudflare-relay/
  worker.js            optional relay in front of the Apps Script /exec URL
tests/
  gas-mocks.js         lightweight fakes for DriveApp/SpreadsheetApp/etc.
  harness.js           loads src/*.js into a vm context for testing
  *.test.js            unit + integration tests (Node's built-in test runner)
```

`SheetActions.js` and `Navigation.js` never call `DriveApp` or
`SpreadsheetApp` directly — everything goes through `DataAccess.js`. If you
later want per-user OAuth or multi-tenant access, that's the only file you'll
need to touch.

## Setup

1. Copy `src/Config.js.example` to `src/Config.js` (gitignored — it holds
   folder IDs and your bot-token accessor) and fill in `FOLDER_IDS`.
2. In the Apps Script editor, set two Script Properties (Project Settings →
   Script Properties): `BOT_TOKEN` (your Telegram bot token) and `ADMIN_IDS`
   (comma-separated list of Telegram chat IDs allowed to use the bot).
3. If you want the Gemini Analysis button, also set `GEMINI_API_KEY` (from
   [Google AI Studio](https://aistudio.google.com/apikey)) as a Script
   Property. Skip this if you don't need it — the rest of the bot works
   without it.
4. Deploy as a web app (`Execute as: Me`, `Who has access: Anyone`).
5. Apps Script's `/exec` URL replies with a redirect that Telegram's webhook
   delivery doesn't follow. Either register the `/exec` URL directly and
   accept the resulting duplicate-delivery retries, or deploy
   `cloudflare-relay/worker.js` in front of it (recommended — see the
   comments in that file, including the optional webhook secret-token
   check).
6. Call `setWebhook('<your relay or /exec URL>')` once from the Apps Script
   editor.

## Configuration (`Config.js`)

| Key | Meaning |
| --- | --- |
| `FOLDER_IDS` | Drive folder IDs shown as top-level menu options |
| `FOLDER_LABELS` | Optional display name per folder (same order as `FOLDER_IDS`); falls back to the live Drive folder name if omitted |
| `FOLDER_SCAN_DEPTH` | How many levels of subfolders to scan for spreadsheets, in addition to the folder itself. `0` = folder only, `1` = folder + immediate subfolders (previous hardcoded behavior, still the default), `2`+ = deeper. Higher values cost more Drive API calls per uncached folder open |
| `FILES_PER_PAGE` | Spreadsheets listed per page in the file picker |
| `FOLDER_CACHE_TTL_SECONDS` | How long a folder's file listing is cached |
| `ICONS` | Optional partial override of the bot's emoji (see below) |
| `GEMINI_MODEL` | Gemini model used by the Gemini Analysis button, e.g. `gemini-2.5-flash` |
| `GEMINI_MAX_ROWS` | Safety cap on rows sent to Gemini per request (large columns/ranges are truncated, and the response says so) |

`ADMIN_IDS` and `BOT_TOKEN` are **not** set in `Config.js` — they live in
Script Properties so they can be rotated without a deploy and never risk
being committed.

### Icons

Every emoji used in the UI lives in `src/Icons.js` (`DEFAULT_ICONS`), resolved
lazily at runtime through `getIcons_()`. To re-skin the bot, override any
subset of keys in `Config.js`:

```js
const CONFIG = {
  // ...
  ICONS: {
    ADD:  '🆕',
    SAVE: '💾',
  },
};
```

Any key you don't set falls back to the default, so existing deployments
keep working unchanged after pulling an update to this file.

## Add-row flow

Fields are prompted one at a time, in header order. Formula columns and
trailing merged cells are detected from the previous row and auto-filled
without prompting.

A **Previous** button appears to the left of Cancel as soon as there is an
earlier field to go back to, and is hidden on the very first prompted field.
Pressing it returns to the nearest field you actually answered — skipping
back over any auto-filled formula/merge columns — and clears that field so
you can re-enter it.

## Gemini Analysis

On the "Tabs in ..." screen (a document is chosen, a tab isn't yet) there's
a **Gemini Analysis** button, above Fav Doc. It starts its own short flow:

1. Pick which tab to analyze.
2. Pick what to look at: **Row** (a row number), **Column** (pick from the
   header list), or **Range** (type an A1 range like `A2:C10`).
3. Type free-form instructions for Gemini — filtering is just part of what
   you ask for in plain language (e.g. "only rows where Status is Done,
   then summarise the totals"); the bot doesn't pre-filter rows itself, it
   sends the data plus your instructions and lets Gemini apply them.

The result comes back as a plain-text Telegram message (chunked if it's
long) — never `parse_mode: HTML`, since model output is arbitrary text that
must never be able to break message delivery or be misread as markup.

Requires `GEMINI_API_KEY` in Script Properties; without it, the button still
appears but the final step returns a clear error instead of failing silently.

## Testing

Tests run against Node's built-in test runner, with hand-written mocks for
the Google Apps Script services (`DriveApp`, `SpreadsheetApp`, `CacheService`,
`PropertiesService`, `LockService`, `UrlFetchApp`) — no external
dependencies, no `node_modules`. `src/*.js` files are plain global-scope
scripts (Apps Script has no module system), so `tests/harness.js` loads them
into a shared `vm` context and tests call the resulting global functions
directly (e.g. `context.handleAddStart(chatId)`).

```sh
npm test
```

Coverage includes: formula-injection sanitisation, date normalisation,
column-letter conversion, HTML escaping (the fix that stops raw cell values
like `"R&D"` or `"5 < 10"` from breaking Telegram's `parse_mode: HTML`
delivery), icon default/override resolution, recursive folder scanning at
each `FOLDER_SCAN_DEPTH`, two-row/merged header parsing, formula and merge
replication on add-row, an end-to-end test of the Previous-button
navigation (including that it's hidden on the first field and correctly
skips auto-filled columns), A1-range parsing, column/range extraction with
truncation at `GEMINI_MAX_ROWS`, a mocked Gemini API call (success, HTTP
error, safety-block, empty-response), and an end-to-end test of the Gemini
Analysis flow (button position, all three selection types, and that model
output is always sent without `parse_mode`).

## Known limitations

- Single Google account, no per-user OAuth (see `DataAccess.js` for the
  intended extension point).
- No row deletion — only add and edit.
- Webhook secret-token validation in `cloudflare-relay/worker.js` is
  supported but off by default; enable it if the relay URL could otherwise
  be discovered.
- Gemini Analysis has no per-user rate limiting — each request costs a
  Gemini API call; keep that in mind if several people share ADMIN_IDS.
