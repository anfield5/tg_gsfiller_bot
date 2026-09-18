# Telegram → Google Sheets navigator bot

A Telegram bot (Google Apps Script, V8) that lets you browse a fixed set of
Google Drive folders, open a spreadsheet, pick a sheet tab, add or edit rows,
and ask Gemini to analyze (or narrate) your data — all from your phone,
without opening Drive. Runs entirely under your own Google account (no OAuth,
no per-user tokens) — the script uses `DriveApp`/`SpreadsheetApp` as *you*.

Setup: copy `src/Config.js.example` to `src/Config.js` and fill in your
folder IDs; set `BOT_TOKEN` / `ADMIN_IDS` (and optionally `GEMINI_API_KEY`)
as Script Properties. See comments in `Config.js.example` for every setting.

## Features

- **Folder → file → tab navigation** with pagination, a "Continue" shortcut
  to the last opened tab, and favourite documents/tabs that bubble to the top.
- **Add row**, prompted one field at a time: formula columns and merged
  cells are auto-filled from the previous row and never prompted; a
  **Previous** button steps back through already-answered fields; **Use
  last value** / **Edit last value** reuse the previous row's entry;
  **Recent TOP3 values** suggests the 3 most common of the last 10 values in
  the column being filled, as a tap-to-copy block.
- **Edit row** by picking from a paginated recent-rows list or typing a row
  number directly; formula cells are protected from inline editing.
- **Gemini Analysis**: pick a live-fetched free-tier model, a tab, and a
  Row/Column/Range to look at, then describe in plain language what you
  want (filtering included — Gemini applies it, the bot doesn't
  pre-filter). Text models reply as a message; TTS models narrate the
  answer as audio.
- Two-level caching (folder listings, sheet headers, Gemini model list) and
  in-execution batching keep repeat navigation and add-row fast.
- **`/version`** replies with the deployed code version (`BOT_VERSION` in
  `Code.js`) — a quick way to confirm the live deployment actually matches
  what you last pushed, without digging through the Executions log.

## Known limitations

- Single Google account, no per-user OAuth/multi-tenant access.
- No row deletion — only add and edit.
- Apps Script's `/exec` URL issues a redirect Telegram's webhook won't
  follow; use the included `cloudflare-relay/worker.js` in front of it.
  Its optional webhook secret-token check is off by default.
- No per-user rate limiting on Gemini Analysis — every request costs a
  Gemini API call.
- The Gemini free-tier model allowlist is manually curated
  (`DEFAULT_FREE_MODELS_` in `GeminiApi.js`) and can drift from Google's
  actual pricing/availability; use the model picker's Refresh button, and
  extend the allowlist via `CONFIG.GEMINI_EXTRA_FREE_MODELS` if needed.
- No free Gemini image-generation model currently exists, so image output
  isn't reachable from the picker yet (the code path exists and needs only
  an allowlist entry once one ships).
- `clasp push -f` mirrors local → remote exactly: files missing locally get
  **deleted** remotely, including files listed in `.claspignore`. Keep
  `Config.js` and everything else you need live in `src/` locally.

## Testing

```sh
npm test
```

Runs the full suite (Node's built-in test runner, no external dependencies)
against hand-written Apps Script service mocks in `tests/`.
