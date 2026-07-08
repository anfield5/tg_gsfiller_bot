/**
 * Navigation.js
 * Builds and transitions between bot screens. Talks to SheetActions.js for
 * data and TelegramApi.js for rendering — never to Drive/Sheets directly.
 *
 * Navigation uses a Telegram Reply Keyboard (buttons pinned to the bottom of
 * the chat) for every selection: folder, file, sheet, row, field, action.
 * Tapping a reply-keyboard button sends its label back as a normal text
 * message — there is no callback_query involved. To resolve which action a
 * tapped label corresponds to, every selection screen stores
 * state.currentOptions = [{label, value}, ...] right before sending its
 * keyboard; Code.js's handleMessage matches the incoming text against that
 * list and dispatches to routeAction().
 *
 * Displayed CONTENT (row values, previews, confirmations) is sent as plain
 * chat messages via sendMessage — these never touch the active reply
 * keyboard, so the keyboard from the last selection screen stays visible
 * underneath until the next selection screen replaces it.
 *
 * Internal action values (never shown to the user, just used internally to
 * resolve a tapped label back to what it means):
 *   folder:<folderIndex>   index into CONFIG.FOLDER_IDS
 *   page:<n>               file list pagination
 *   file:<fileIndex>       index into state.fileList
 *   sheet:<sheetIndex>     index into state.sheetList
 *   add / edit             action on the currently selected sheet
 *   editrow:<rowIndex>     actual 1-based sheet row number
 *   editfield:<colIndex>   actual 1-based sheet column number
 *   save / cancel_add      confirm/cancel the add-row flow
 *   back:<target>          folders | files | sheets | sheetmenu | editrow
 *   continue               resume the last fully-opened sheet
 *   refresh                bypass the folder cache and re-scan Drive
 */

// ---------- Menu rendering helper ----------

/**
 * Renders a selection screen: stores the valid options on state (for
 * handleMessage to match against later) and sends the reply keyboard.
 * @param {number|string} chatId
 * @param {Object} state
 * @param {string} text
 * @param {Array<Array<{label:string, value:string}>>} keyboardRows options
 *   grouped into visual rows (each row can hold 1+ buttons side by side)
 * @private
 */
function _renderMenu(chatId, state, text, keyboardRows) {
  state.currentOptions = [].concat.apply([], keyboardRows);
  setState(chatId, state);

  if (!keyboardRows.length) {
    sendMessageNoKeyboard(chatId, text);
    return;
  }

  const labelRows = keyboardRows.map((row) => row.map((o) => o.label));
  sendMessageWithKeyboard(chatId, text, labelRows);
}

// ---------- Main menu ----------

function showMainMenu(chatId) {
  const state = { step: 'main_menu' };
  const options = [];

  const lastPath = getLastPath(chatId);
  if (lastPath) {
    options.push({ label: 'Continue: ' + formatPreview(lastPath.label, 40), value: 'continue' });
  }

  CONFIG.FOLDER_IDS.forEach((id, idx) => {
    let label = CONFIG.FOLDER_LABELS[idx];
    if (!label) {
      try {
        label = actionGetFolderName(id);
      } catch (e) {
        // Drive lookup failed (e.g. folder deleted/inaccessible) — fall
        // back to a generic placeholder rather than breaking the menu.
        label = 'Folder ' + (idx + 1);
      }
    }
    options.push({ label: '📁 ' + label, value: 'folder:' + idx });
  });

  const text = CONFIG.FOLDER_IDS.length
    ? 'Choose a folder:'
    : 'No folders configured yet. Add folder IDs to Config.js.';

  const keyboardRows = options.map((o) => [o]);
  _renderMenu(chatId, state, text, keyboardRows);
}

function handleContinue(chatId) {
  const lastPath = getLastPath(chatId);
  if (!lastPath) {
    showMainMenu(chatId);
    return;
  }

  let files, sheets;
  try {
    files = actionListSpreadsheets(lastPath.folderId);
    sheets = actionListSheets(lastPath.fileId);
  } catch (e) {
    sendMessage(chatId, '⚠️ ' + e.message);
    showMainMenu(chatId);
    return;
  }

  const state = {
    step: 'sheet_menu',
    folderIndex: lastPath.folderIndex,
    folderId: lastPath.folderId,
    folderName: lastPath.folderName,
    fileList: files,
    filePage: 0,
    fileId: lastPath.fileId,
    fileName: lastPath.fileName,
    sheetList: sheets,
    sheetName: lastPath.sheetName,
  };

  showSheetMenu(chatId, state);
}

// ---------- Folder -> file list ----------

function handleFolderSelect(chatId, folderIndex) {
  const folderId = CONFIG.FOLDER_IDS[folderIndex];
  if (!folderId) {
    showMainMenu(chatId);
    return;
  }
  const folderName = CONFIG.FOLDER_LABELS[folderIndex] || 'Folder ' + (folderIndex + 1);

  let files;
  try {
    files = actionListSpreadsheets(folderId);
  } catch (e) {
    sendMessage(chatId, '⚠️ ' + e.message);
    showMainMenu(chatId);
    return;
  }

  const state = {
    step: 'file_list',
    folderIndex: folderIndex,
    folderId: folderId,
    folderName: folderName,
    fileList: files,
    filePage: 0,
  };

  renderFileList(chatId, state);
}

function handleFilesPage(chatId, page) {
  const state = getState(chatId);
  state.filePage = page;
  renderFileList(chatId, state);
}

/**
 * Bypasses the folder cache and re-scans Drive from scratch.
 */
function handleFilesRefresh(chatId) {
  const state = getState(chatId);

  let files;
  try {
    clearFolderCache(state.folderId);
    files = actionListSpreadsheets(state.folderId, true);
  } catch (e) {
    sendMessage(chatId, '⚠️ ' + e.message);
    showMainMenu(chatId);
    return;
  }

  state.fileList = files;
  state.filePage = 0;
  renderFileList(chatId, state);
}

function renderFileList(chatId, state) {
  const files = state.fileList || [];
  const perPage = CONFIG.FILES_PER_PAGE;
  const page = state.filePage || 0;
  const start = page * perPage;
  const pageFiles = files.slice(start, start + perPage);

  const keyboardRows = pageFiles.map((f, i) => [
    { label: '📄 ' + f.name, value: 'file:' + (start + i) },
  ]);

  const navRow = [];
  if (page > 0) navRow.push({ label: '◀️ Prev', value: 'page:' + (page - 1) });
  if (start + perPage < files.length) navRow.push({ label: '▶️ Next', value: 'page:' + (page + 1) });
  if (navRow.length) keyboardRows.push(navRow);

  keyboardRows.push([
    { label: '🔄 Refresh', value: 'refresh' },
    { label: '⬅️ Back', value: 'back:folders' },
  ]);

  const text = files.length
    ? 'Spreadsheets in "' + state.folderName + '":'
    : 'No spreadsheets found in "' + state.folderName + '".';

  _renderMenu(chatId, state, text, keyboardRows);
}

// ---------- File -> sheet list ----------

function handleFileSelect(chatId, fileIndex) {
  const state = getState(chatId);
  const file = (state.fileList || [])[fileIndex];
  if (!file) {
    renderFileList(chatId, state);
    return;
  }

  let sheets;
  try {
    sheets = actionListSheets(file.id);
  } catch (e) {
    sendMessage(chatId, '⚠️ ' + e.message);
    renderFileList(chatId, state);
    return;
  }

  state.step = 'sheet_list';
  state.fileId = file.id;
  state.fileName = file.name;
  state.sheetList = sheets;

  renderSheetList(chatId, state);
}

function renderSheetList(chatId, state) {
  const sheets = state.sheetList || [];

  const keyboardRows = sheets.map((name, idx) => [
    { label: '📑 ' + name, value: 'sheet:' + idx },
  ]);
  keyboardRows.push([{ label: '⬅️ Back', value: 'back:files' }]);

  const text = sheets.length
    ? 'Sheets in "' + state.fileName + '":'
    : 'This file has no sheets.';

  _renderMenu(chatId, state, text, keyboardRows);
}

// ---------- Sheet -> add/edit menu ----------

function handleSheetSelect(chatId, sheetIndex) {
  const state = getState(chatId);
  const sheetName = (state.sheetList || [])[sheetIndex];
  if (!sheetName) {
    renderSheetList(chatId, state);
    return;
  }

  state.sheetName = sheetName;

  setLastPath(chatId, {
    folderIndex: state.folderIndex,
    folderId: state.folderId,
    folderName: state.folderName,
    fileId: state.fileId,
    fileName: state.fileName,
    sheetName: state.sheetName,
    label: state.folderName + ' / ' + state.fileName + ' / ' + state.sheetName,
  });

  showSheetMenu(chatId, state);
}

function showSheetMenu(chatId, state) {
  state.step = 'sheet_menu';

  const keyboardRows = [
    [{ label: '➕ Add row', value: 'add' }],
    [{ label: '✏️ Edit row', value: 'edit' }],
    [{ label: '⬅️ Back', value: 'back:sheets' }],
  ];

  const text =
    '"' + state.folderName + ' / ' + state.fileName + ' / ' + state.sheetName + '"\nWhat do you want to do?';

  _renderMenu(chatId, state, text, keyboardRows);
}

// ---------- Add row flow ----------

function handleAddStart(chatId) {
  const state = getState(chatId);
  let headers;
  try {
    headers = actionGetHeaders(state.fileId, state.sheetName);
  } catch (e) {
    sendMessage(chatId, '⚠️ ' + e.message);
    showSheetMenu(chatId, state);
    return;
  }

  state.step = 'add_filling';
  state.headers = headers;
  state.currentFieldIndex = 0;
  state.formData = {};
  setState(chatId, state);

  sendMessageNoKeyboard(
    chatId,
    'Adding a new row to "' + state.sheetName + '".\n\nEnter value for: <b>' + headers[0] + '</b>'
  );
}

function handleAddFieldInput(chatId, state, text) {
  const headers = state.headers || [];
  const idx = state.currentFieldIndex || 0;
  const fieldName = headers[idx];

  state.formData[fieldName] = text;
  state.currentFieldIndex = idx + 1;
  setState(chatId, state);

  if (state.currentFieldIndex < headers.length) {
    sendMessage(chatId, 'Enter value for: <b>' + headers[state.currentFieldIndex] + '</b>');
    return;
  }

  const preview = headers
    .map((h) => '<b>' + h + '</b>: ' + (state.formData[h] || '(empty)'))
    .join('\n');
  sendMessage(chatId, 'Review the new row:\n\n' + preview);

  const keyboardRows = [
    [
      { label: '✅ Save', value: 'save' },
      { label: '❌ Cancel', value: 'cancel_add' },
    ],
  ];
  _renderMenu(chatId, state, 'Save this row?', keyboardRows);
}

function handleSaveAdd(chatId) {
  const state = getState(chatId);
  try {
    actionAddRow(state.fileId, state.sheetName, state.formData, state.headers);
  } catch (e) {
    sendMessage(chatId, '⚠️ ' + e.message);
    showSheetMenu(chatId, state);
    return;
  }

  sendMessage(chatId, '✅ Row saved.');

  delete state.headers;
  delete state.formData;
  delete state.currentFieldIndex;
  showSheetMenu(chatId, state);
}

function handleCancelAdd(chatId) {
  const state = getState(chatId);
  delete state.headers;
  delete state.formData;
  delete state.currentFieldIndex;

  sendMessage(chatId, 'Cancelled. Row was not saved.');
  showSheetMenu(chatId, state);
}

// ---------- Edit row flow ----------

function handleEditStart(chatId) {
  const state = getState(chatId);
  let rows;
  try {
    rows = actionGetLastRows(state.fileId, state.sheetName, CONFIG.EDIT_ROWS_LIMIT);
  } catch (e) {
    sendMessage(chatId, '⚠️ ' + e.message);
    showSheetMenu(chatId, state);
    return;
  }

  state.rowList = rows;
  renderRowList(chatId, state);
}

function renderRowList(chatId, state) {
  const rows = state.rowList || [];

  if (!rows.length) {
    const keyboardRows = [[{ label: '⬅️ Back', value: 'back:sheetmenu' }]];
    _renderMenu(chatId, state, 'No data rows found in "' + state.sheetName + '".', keyboardRows);
    return;
  }

  // Compact preview in the text: first 3 columns only, capped at 25 chars.
  const PREVIEW_NUM_COLS = 3;
  const PREVIEW_COL_LEN = 25;

  const lines = rows.map((r) => {
    const preview = r.values
      .slice(0, PREVIEW_NUM_COLS)
      .map((v) => formatPreview(v, PREVIEW_COL_LEN))
      .join(' | ');
    return '<b>Row ' + r.rowIndex + '</b>: ' + preview;
  });

  let contentText = 'Recent rows in "' + state.sheetName + '":\n\n' + lines.join('\n');

  // Link highlights the FULL width (all columns) for these same rows —
  // the text preview above is trimmed, but the linked range in Sheets
  // shows everything.
  const rowIndices = rows.map((r) => r.rowIndex);
  const minRow = Math.min.apply(null, rowIndices);
  const maxRow = Math.max.apply(null, rowIndices);
  const allColsCount = rows[0].values.length;
  try {
    const gid = actionGetSheetGid(state.fileId, state.sheetName);
    const link = buildSheetRangeUrl(state.fileId, gid, minRow, maxRow, allColsCount);
    contentText += '\n\n🔗 <a href="' + link + '">Open this range in Google Sheets</a>';
  } catch (e) {
    // Non-fatal — just skip the link if the sheet's gid couldn't be resolved.
    console.error('Could not build sheet range link: ' + e);
  }

  sendMessage(chatId, contentText);

  const keyboardRows = rows.map((r) => [{ label: 'Row ' + r.rowIndex, value: 'editrow:' + r.rowIndex }]);
  keyboardRows.push([{ label: '⬅️ Back', value: 'back:sheetmenu' }]);

  _renderMenu(chatId, state, 'Tap a row to edit:', keyboardRows);
}

function handleEditRowSelect(chatId, rowIndex) {
  const state = getState(chatId);
  let values;
  try {
    values = actionGetRowValues(state.fileId, state.sheetName, rowIndex);
  } catch (e) {
    sendMessage(chatId, '⚠️ ' + e.message);
    renderRowList(chatId, state);
    return;
  }

  let headers;
  try {
    headers = actionGetHeaders(state.fileId, state.sheetName);
  } catch (e) {
    headers = values.map((_, i) => 'Column ' + (i + 1));
  }

  state.rowIndex = rowIndex;
  state.rowValues = values;
  state.headers = headers;

  renderRowView(chatId, state);
}

function renderRowView(chatId, state) {
  const headers = state.headers || [];
  const values = state.rowValues || [];

  let contentText =
    'Row ' +
    state.rowIndex +
    ':\n\n' +
    headers.map((h, i) => '<b>' + h + '</b>: ' + formatPreview(values[i], 100000)).join('\n');

  const TELEGRAM_MAX_MESSAGE_LEN = 4096;
  if (contentText.length > TELEGRAM_MAX_MESSAGE_LEN) {
    contentText =
      'Row ' +
      state.rowIndex +
      ' (some values shortened to fit):\n\n' +
      headers.map((h, i) => '<b>' + h + '</b>: ' + formatPreview(values[i], 200)).join('\n');
  }

  sendMessage(chatId, contentText);

  const keyboardRows = headers.map((h, i) => [
    { label: '✏️ ' + formatPreview(h, 30), value: 'editfield:' + (i + 1) },
  ]);
  keyboardRows.push([{ label: '⬅️ Back', value: 'back:editrow' }]);

  _renderMenu(chatId, state, 'Tap a field to edit it:', keyboardRows);
}

function handleEditFieldSelect(chatId, colIndex) {
  const state = getState(chatId);
  const headers = state.headers || [];
  const fieldName = headers[colIndex - 1] || 'Column ' + colIndex;

  state.step = 'edit_field_wait';
  state.colIndex = colIndex;
  setState(chatId, state);

  sendMessageNoKeyboard(
    chatId,
    'Editing "' + fieldName + '" in row ' + state.rowIndex + '.\n\nEnter new value for: <b>' + fieldName + '</b>'
  );
}

function handleEditFieldInput(chatId, state, text) {
  try {
    actionUpdateCell(state.fileId, state.sheetName, state.rowIndex, state.colIndex, text);
  } catch (e) {
    sendMessage(chatId, '⚠️ ' + e.message);
    return;
  }

  let values;
  try {
    values = actionGetRowValues(state.fileId, state.sheetName, state.rowIndex);
  } catch (e) {
    values = state.rowValues;
  }

  state.rowValues = values;
  delete state.colIndex;

  sendMessage(chatId, '✅ Saved.');
  renderRowView(chatId, state);
}

// ---------- Back navigation ----------

function handleBack(chatId, target) {
  const state = getState(chatId);
  switch (target) {
    case 'folders':
      showMainMenu(chatId);
      break;
    case 'files':
      renderFileList(chatId, state);
      break;
    case 'sheets':
      renderSheetList(chatId, state);
      break;
    case 'sheetmenu':
      showSheetMenu(chatId, state);
      break;
    case 'editrow':
      renderRowList(chatId, state);
      break;
    default:
      showMainMenu(chatId);
  }
}