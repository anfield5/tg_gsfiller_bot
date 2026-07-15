# Telegram → Google Sheets navigator bot

A Telegram bot (Google Apps Script, V8) that lets you browse a fixed set of
Google Drive folders, open a spreadsheet, pick a sheet tab, and add or edit
rows — all from your phone, without opening Drive.

Runs entirely under your own Google account (no OAuth flow, no per-user
tokens): the script uses `DriveApp` / `SpreadsheetApp` as *you*, the deployer.

## Project layout

```
src/
  Code.js          entry point, doPost() routing
  Config.js        folder IDs + bot token accessor
  State.js         per-user state (PropertiesService)
  Navigation.js     screens & the step-by-step flow
  SheetActions.js   business logic, calls DataAccess.js only
  DataAccess.js     the ONLY file that touches DriveApp/SpreadsheetApp
  TelegramApi.js    sendMessage / sendMessageWithKeyboard / sendMessageNoKeyboard
  appsscript.json   manifest (scopes, runtime, web app config)
```

`SheetActions.js` and `Navigation.js` never call `DriveApp` or
`SpreadsheetApp` directly — everything goes through `DataAccess.js`. If you
later want per-user OAuth or multi-tenant access, that's the only file you'll
need to touch.
