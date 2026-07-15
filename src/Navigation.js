/**
 * Navigation.js
 * Bot screens, keyboard generation, and all conversation-flow handlers.
 * Must not call DriveApp / SpreadsheetApp directly — all data access goes
 * through SheetActions.js → DataAccess.js.
 */

// ---------------------------------------------------------------------------
// Core rendering helpers
// ---------------------------------------------------------------------------

/**
 * Serialises keyboardRows into currentOptions on the state, persists the
 * state, then sends the message with the matching reply keyboard.
 *
 * @param {string} chatId
 * @param {Object} state
 * @param {string} text
 * @param {Array<Array<{label:string,value:string}>>} keyboardRows
 */
function _renderMenu(chatId, state, text, keyboardRows) {
  state.currentOptions = [].concat.apply([], keyboardRows);
  setState(chatId, state);

  if (!keyboardRows.length) {
    sendMessageNoKeyboard(chatId, text);
    return;
  }

  const labelRows = keyboardRows.map(row => row.map(o => o.label));
  sendMessageWithKeyboard(chatId, text, labelRows);
}

/**
 * Sends a ForceReply prompt so the user's next message is threaded as a
 * reply. Used before free-text input steps (field values, row numbers).
 */
function _renderForceReply(chatId, text, placeholderText) {
  return _callTelegram_('sendMessage', {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML',
    reply_markup: {
      force_reply: true,
      input_field_placeholder: placeholderText || 'Type here…',
    },
  });
}

// ---------------------------------------------------------------------------
// Main menu
// ---------------------------------------------------------------------------

function showMainMenu(chatId) {
  const state   = { step: 'main_menu' };
  const options = [];

  // "Continue" shortcut — last opened path
  const lastPath = getLastPath(chatId);
  if (lastPath) {
    options.push({ label: 'Continue: ' + formatPreview(lastPath.label, 40), value: 'continue' });
  }

  // Favourite documents (max MAX_FAV_DOCS)
  const favDocs = getFavDocs(chatId);
  favDocs.forEach((doc, idx) => {
    options.push({ label: '⭐ ' + formatPreview(doc.fileName, 35), value: 'openfavdoc:' + idx });
  });

  // Folder list
  CONFIG.FOLDER_IDS.forEach((id, idx) => {
    let label = CONFIG.FOLDER_LABELS[idx];
    if (!label) {
      try   { label = actionGetFolderName(id); }
      catch (e) { label = 'Folder ' + (idx + 1); }
    }
    if (!label.startsWith('📁')) label = '📁 ' + label;
    options.push({ label: label, value: 'folder:' + idx });
  });

  const text = CONFIG.FOLDER_IDS.length ? 'Choose a folder:' : 'No folders configured.';
  _renderMenu(chatId, state, text, options.map(o => [o]));
}

// ---------------------------------------------------------------------------
// Continue shortcut
// ---------------------------------------------------------------------------

function handleContinue(chatId) {
  const lastPath = getLastPath(chatId);
  if (!lastPath) { showMainMenu(chatId); return; }

  let sheets;
  try   { sheets = actionListSheets(lastPath.fileId); }
  catch (e) { sendMessage(chatId, '⚠️ ' + e.message); showMainMenu(chatId); return; }

  const state = {
    step:        'sheet_menu',
    folderIndex: lastPath.folderIndex,
    folderId:    lastPath.folderId,
    folderName:  lastPath.folderName,
    filePage:    0,
    fileId:      lastPath.fileId,
    fileName:    lastPath.fileName,
    sheetName:   lastPath.sheetName,
  };
  showSheetMenu(chatId, state);
}

// ---------------------------------------------------------------------------
// Folder → file list
// ---------------------------------------------------------------------------

function handleFolderSelect(chatId, folderIndex) {
  const folderId = CONFIG.FOLDER_IDS[folderIndex];
  if (!folderId) { showMainMenu(chatId); return; }

  let folderName = CONFIG.FOLDER_LABELS[folderIndex];
  if (!folderName) {
    try   { folderName = actionGetFolderName(folderId); }
    catch (e) { folderName = 'Folder ' + (folderIndex + 1); }
  }

  const state = { step: 'file_list', folderIndex: folderIndex, folderId: folderId, folderName: folderName, filePage: 0 };
  renderFileList(chatId, state);
}

function handleFilesPage(chatId, page) {
  const state  = getState(chatId);
  state.filePage = page;
  renderFileList(chatId, state);
}

function handleFilesRefresh(chatId) {
  const state = getState(chatId);
  try {
    clearFolderCache(state.folderId);
    actionListSpreadsheets(state.folderId, true);
  } catch (e) { sendMessage(chatId, '⚠️ ' + e.message); showMainMenu(chatId); return; }
  state.filePage = 0;
  renderFileList(chatId, state);
}

function renderFileList(chatId, state) {
  let files = [];
  try   { files = actionListSpreadsheets(state.folderId); }
  catch (e) { sendMessage(chatId, '⚠️ Could not read files.'); return; }

  const perPage   = CONFIG.FILES_PER_PAGE || 10;
  const page      = state.filePage || 0;
  const start     = page * perPage;
  const pageFiles = files.slice(start, start + perPage);

  // Read favourites once (single PropertiesService read) instead of once per file.
  const favDocIds = new Set(getFavDocs(chatId).map(d => d.fileId));

  // Embed fileId and fileName in the button value so handleFileSelect can open
  // the file without re-fetching the entire folder file list.
  // Value format: "file:<fileId>:<fileName>"  — Drive IDs never contain ":",
  // and fileName is everything after the second ":" (joined with ":" if needed).
  const keyboardRows = pageFiles.map((f) => {
    const icon = favDocIds.has(f.id) ? '⭐ ' : '📄 ';
    return [{ label: icon + f.name, value: 'file:' + f.id + ':' + f.name }];
  });

  const navRow = [];
  if (page > 0)                      navRow.push({ label: '◀️ Prev', value: 'page:' + (page - 1) });
  if (start + perPage < files.length) navRow.push({ label: '▶️ Next', value: 'page:' + (page + 1) });
  if (navRow.length) keyboardRows.push(navRow);

  keyboardRows.push([{ label: '🔄 Refresh', value: 'refresh' }, { label: '⬅️ Back', value: 'back:folders' }]);
  _renderMenu(chatId, state, 'Spreadsheets in "' + state.folderName + '":', keyboardRows);
}

// ---------------------------------------------------------------------------
// File → sheet (tab) list
// ---------------------------------------------------------------------------

function handleFileSelect(chatId, fileId, fileName) {
  const state = getState(chatId);

  // fileId and fileName come directly from the button value — no need to
  // re-fetch the folder file list just to resolve an index.
  if (!fileId) { renderFileList(chatId, state); return; }

  let sheets;
  try   { sheets = actionListSheets(fileId); }
  catch (e) { sendMessage(chatId, '⚠️ ' + e.message); renderFileList(chatId, state); return; }

  state.step     = 'sheet_list';
  state.fileId   = fileId;
  state.fileName = fileName;
  setState(chatId, state);
  renderSheetList(chatId, state, sheets);
}

function renderSheetList(chatId, state, sheets) {
  if (!sheets) {
    try { sheets = actionListSheets(state.fileId); } catch (e) { sheets = []; }
  }

  // Read favourites once each (single PropertiesService read per call).
  const favNames = getFavSheets(chatId, state.fileId);
  const favSet   = new Set(favNames);

  // Favourite tabs bubble to the top; rest follow in original order.
  const favOrder = sheets.filter(n => favSet.has(n));
  const rest     = sheets.filter(n => !favSet.has(n));
  const ordered  = favOrder.concat(rest);

  const keyboardRows = ordered.map((name) => {
    const icon    = favSet.has(name) ? '⭐ ' : '📑 ';
    const origIdx = sheets.indexOf(name);
    return [{ label: icon + name, value: 'sheet:' + origIdx }];
  });

  // Fav Doc toggle lives here — document is chosen, tab is not yet selected,
  // so this is the correct level for document-level favouriting.
  const docFavLabel = isFavDoc(chatId, state.fileId) ? '★ Unfav Doc' : '⭐ Fav Doc';
  keyboardRows.push([{ label: docFavLabel, value: 'favdoc' }]);
  keyboardRows.push([{ label: '⬅️ Back', value: 'back:files' }]);
  _renderMenu(chatId, state, 'Tabs in "' + state.fileName + '":', keyboardRows);
}

function handleSheetSelect(chatId, sheetIndex) {
  const state = getState(chatId);
  let sheets  = [];
  try { sheets = actionListSheets(state.fileId); } catch (e) { /* ignore */ }

  const sheetName = sheets[sheetIndex];
  if (!sheetName) { renderSheetList(chatId, state, sheets); return; }

  state.sheetName = sheetName;
  setLastPath(chatId, {
    folderIndex: state.folderIndex,
    folderId:    state.folderId,
    folderName:  state.folderName,
    fileId:      state.fileId,
    fileName:    state.fileName,
    sheetName:   state.sheetName,
    label:       state.folderName + ' / ' + state.fileName + ' / ' + state.sheetName,
  });
  showSheetMenu(chatId, state);
}

// ---------------------------------------------------------------------------
// Sheet menu (main action hub for an open tab)
// ---------------------------------------------------------------------------

function showSheetMenu(chatId, state) {
  state.step = 'sheet_menu';

  const tabFavLabel = isFavSheet(chatId, state.fileId, state.sheetName) ? '★ Unfav Tab' : '⭐ Fav Tab';

  const keyboardRows = [
    [{ label: '➕ Add row',   value: 'add'     }],
    [{ label: '✏️ Edit row',  value: 'edit'    }],
    [{ label: '🔍 Preview',   value: 'preview' }],
    [{ label: tabFavLabel,    value: 'favtab'  }],
    [{ label: '⬅️ Back',     value: 'back:sheets' }],
  ];

  _renderMenu(
    chatId,
    state,
    '"' + state.folderName + ' / ' + state.fileName + ' / ' + state.sheetName + '"\nWhat do you want to do?',
    keyboardRows
  );
}

// ---------------------------------------------------------------------------
// Favourites handlers
// ---------------------------------------------------------------------------

/** Toggles the current document in the user's favourite-documents list. */
function handleToggleFavDoc(chatId) {
  const state = getState(chatId);
  if (isFavDoc(chatId, state.fileId)) {
    removeFavDoc(chatId, state.fileId);
    sendMessage(chatId, '★ Removed "' + state.fileName + '" from favourite docs.');
  } else {
    const added = addFavDoc(chatId, {
      fileId:      state.fileId,
      fileName:    state.fileName,
      folderId:    state.folderId,
      folderIndex: state.folderIndex,
      folderName:  state.folderName,
    });
    if (added) {
      sendMessage(chatId, '⭐ Added "' + state.fileName + '" to favourite docs.');
    } else {
      sendMessage(chatId, '⚠️ Favourite docs list is full (max ' + MAX_FAV_DOCS + '). Remove one first.');
    }
  }
  // Return to the sheet list — that is where the Fav Doc button lives.
  renderSheetList(chatId, state, null);
}

/** Toggles the current tab in the user's favourite-sheets list for this document. */
function handleToggleFavTab(chatId) {
  const state = getState(chatId);
  if (isFavSheet(chatId, state.fileId, state.sheetName)) {
    removeFavSheet(chatId, state.fileId, state.sheetName);
    sendMessage(chatId, '★ Removed tab "' + state.sheetName + '" from favourites.');
  } else {
    const added = addFavSheet(chatId, state.fileId, state.sheetName);
    if (added) {
      sendMessage(chatId, '⭐ Tab "' + state.sheetName + '" added to favourites.');
    } else {
      sendMessage(chatId, '⚠️ Favourite tabs list is full (max ' + MAX_FAV_SHEETS + '). Remove one first.');
    }
  }
  showSheetMenu(chatId, state);
}

/**
 * Opens a favourite document (jumps directly to its sheet list), bypassing
 * the folder → file navigation steps.
 */
function handleOpenFavDoc(chatId, favIndex) {
  const favDocs = getFavDocs(chatId);
  const doc     = favDocs[favIndex];
  if (!doc) { showMainMenu(chatId); return; }

  let sheets;
  try   { sheets = actionListSheets(doc.fileId); }
  catch (e) { sendMessage(chatId, '⚠️ Could not open document: ' + e.message); showMainMenu(chatId); return; }

  const state = {
    step:        'sheet_list',
    folderIndex: doc.folderIndex,
    folderId:    doc.folderId,
    folderName:  doc.folderName,
    filePage:    0,
    fileId:      doc.fileId,
    fileName:    doc.fileName,
  };
  setState(chatId, state);
  renderSheetList(chatId, state, sheets);
}

// ---------------------------------------------------------------------------
// Add-row flow
// ---------------------------------------------------------------------------

function handleAddStart(chatId) {
  const state = getState(chatId);
  let headers, lastRows = [];
  try {
    headers  = actionGetHeaders(state.fileId, state.sheetName);
    lastRows = actionGetLastRows(state.fileId, state.sheetName, 1);
  } catch (e) {
    sendMessage(chatId, '⚠️ ' + e.message);
    showSheetMenu(chatId, state);
    return;
  }

  state.step              = 'add_filling';
  state.headers           = headers;
  state.currentFieldIndex = 0;
  state.formData          = {};
  state.lastRowValues     = (lastRows.length > 0) ? lastRows[0].values : null;
  state.lastRowIndex      = (lastRows.length > 0) ? lastRows[0].rowIndex : 1;

  sendFieldPrompt(chatId, state);
}

const FORMULA_PLACEHOLDER = '🧬 (Calculated Formula)';

function sendFieldPrompt(chatId, state) {
  const headers = state.headers || [];
  const idx     = state.currentFieldIndex || 0;

  if (idx >= headers.length) {
    proceedOrReviewAdd(chatId, state);
    return;
  }

  // Auto-fill formula cells — mark as placeholder and advance.
  if (state.lastRowValues && isCellFormula(state.fileId, state.sheetName, state.lastRowIndex, idx + 1)) {
    state.formData[headers[idx]] = FORMULA_PLACEHOLDER;
    state.currentFieldIndex      = idx + 1;
    sendFieldPrompt(chatId, state);
    return;
  }

  // Skip trailing merged cells (they share data with the cell to their left).
  // Uses DataAccess.isCellTrailingMerge — no direct _getSheet_ call here.
  if (state.lastRowIndex > 1 && isCellTrailingMerge(state.fileId, state.sheetName, state.lastRowIndex, idx + 1)) {
    state.formData[headers[idx]] = '';
    state.currentFieldIndex      = idx + 1;
    sendFieldPrompt(chatId, state);
    return;
  }

  const fieldName   = headers[idx];
  const keyboardRows = [];

  const lastVal = (state.lastRowValues && state.lastRowValues[idx] !== undefined)
    ? String(state.lastRowValues[idx])
    : '';

  if (lastVal.trim().length > 0) {
    keyboardRows.push([
      { label: '🔘 Use: ' + formatPreview(lastVal, 15), value: 'use_last_direct'     },
      { label: '✏️ Edit Last Value',                     value: 'use_last_edit_request' },
    ]);
  }

  keyboardRows.push([
    { label: '🔲 Leave empty', value: 'leave_empty' },
    { label: '🏁 Finish row',  value: 'finish_row'  },
  ]);
  keyboardRows.push([{ label: '❌ Cancel', value: 'cancel_add' }]);

  _renderMenu(
    chatId,
    state,
    'Adding to <b>' + state.sheetName + '</b>.\n\nEnter value for: <b>' + fieldName + '</b>',
    keyboardRows
  );
}

function handleUseLastEditRequest(chatId) {
  const state     = getState(chatId);
  const headers   = state.headers || [];
  const idx       = state.currentFieldIndex || 0;
  const fieldName = headers[idx];
  const lastVal   = state.lastRowValues ? String(state.lastRowValues[idx]) : '';

  state.step = 'add_filling_wait_edit';
  setState(chatId, state);

  _renderMenu(chatId, state, 'Preparing editor…', []);

  _renderForceReply(
    chatId,
    '✏️ Editing value for: <b>' + fieldName + '</b>\n\n' +
    '👉 <b>Tap the code block to copy</b>, paste into chat, edit, then send:\n\n' +
    '<code>' + lastVal + '</code>',
    'Paste and edit value…'
  );
}

function handleAddFieldInput(chatId, state, text) {
  const headers   = state.headers || [];
  const idx       = state.currentFieldIndex || 0;
  const fieldName = headers[idx];

  state.formData[fieldName]  = text;
  state.currentFieldIndex    = idx + 1;
  state.step                 = 'add_filling';
  setState(chatId, state);

  proceedOrReviewAdd(chatId, state);
}

function proceedOrReviewAdd(chatId, state) {
  const headers = state.headers || [];
  if (state.currentFieldIndex < headers.length) {
    sendFieldPrompt(chatId, state);
    return;
  }

  const preview = headers
    .map(h => '<b>' + h + '</b>: ' + (state.formData[h] || '(empty)'))
    .join('\n');
  sendMessage(chatId, 'Review new row:\n\n' + preview);

  _renderMenu(chatId, state, 'Save this row?', [
    [{ label: '✅ Save', value: 'save' }, { label: '❌ Cancel', value: 'cancel_add' }],
  ]);
}

function handleSaveAdd(chatId) {
  const state = getState(chatId);
  try   { actionAddRow(state.fileId, state.sheetName, state.formData, state.headers); }
  catch (e) { sendMessage(chatId, '⚠️ ' + e.message); showSheetMenu(chatId, state); return; }
  sendMessage(chatId, '✅ Row saved successfully.');
  showSheetMenu(chatId, state);
}

function handleCancelAdd(chatId) {
  sendMessage(chatId, 'Cancelled. No data was saved.');
  showSheetMenu(chatId, getState(chatId));
}

// ---------------------------------------------------------------------------
// Edit-row flow
// ---------------------------------------------------------------------------

function handleEditStart(chatId) {
  const state    = getState(chatId);
  state.editPage = 0;
  _loadAndRenderRowList(chatId, state);
}

function handleEditPage(chatId, page) {
  const state    = getState(chatId);
  state.editPage = page;
  _loadAndRenderRowList(chatId, state);
}

/**
 * Loads the row list into a LOCAL variable (never persisted to state) then
 * renders the paginated list. Keeping rowList out of persisted state avoids
 * the 9 KB PropertiesService per-property limit.
 */
function _loadAndRenderRowList(chatId, state) {
  let allRows;
  try   { allRows = actionGetLastRows(state.fileId, state.sheetName, 1000); }
  catch (e) { sendMessage(chatId, '⚠️ ' + e.message); showSheetMenu(chatId, state); return; }
  // Store only page index and row count hint; the full rowList is passed
  // as a parameter rather than through persisted state.
  state.rowCount = allRows.length;
  renderRowList(chatId, state, allRows);
}

function renderRowList(chatId, state, rows) {
  if (!rows || !rows.length) {
    _renderMenu(chatId, state, 'No data rows found.', [[{ label: '⬅️ Back', value: 'back:sheetmenu' }]]);
    return;
  }

  const perPage  = 10;
  const page     = state.editPage || 0;
  const start    = page * perPage;
  const pageRows = rows.slice(start, start + perPage);

  const lines = pageRows.map(r =>
    '<b>Row ' + r.rowIndex + '</b>: ' + r.values.slice(0, 3).map(v => formatPreview(v, 20)).join(' | ')
  );
  let contentText = 'Recent rows (page ' + (page + 1) + '):\n\n' + lines.join('\n');

  try {
    const gid  = actionGetSheetGid(state.fileId, state.sheetName);
    const rMin = Math.min.apply(null, pageRows.map(r => r.rowIndex));
    const rMax = Math.max.apply(null, pageRows.map(r => r.rowIndex));
    const url  = buildSheetRangeUrl(state.fileId, gid, rMin, rMax, pageRows[0].values.length);
    contentText += '\n\n🔗 <a href="' + url + '">Open in Google Sheets</a>';
  } catch (e) { /* link is optional */ }

  sendMessage(chatId, contentText);

  const keyboardRows = pageRows.map(r => [{ label: 'Row ' + r.rowIndex, value: 'editrow:' + r.rowIndex }]);

  const navRow = [];
  if (page > 0)                       navRow.push({ label: '◀️ Prev Rows', value: 'editpage:' + (page - 1) });
  if (start + perPage < rows.length)   navRow.push({ label: '▶️ Next Rows', value: 'editpage:' + (page + 1) });
  if (navRow.length) keyboardRows.push(navRow);

  keyboardRows.push([{ label: '🔢 Enter row number', value: 'edit_manual_request' }]);
  keyboardRows.push([{ label: '⬅️ Back',              value: 'back:sheetmenu'      }]);
  _renderMenu(chatId, state, 'Tap a row to edit:', keyboardRows);
}

function handleEditRowManualRequest(chatId) {
  const state = getState(chatId);
  state.step  = 'edit_row_manual_wait';
  setState(chatId, state);

  _renderMenu(chatId, state, 'Preparing manual input…', []);
  _renderForceReply(chatId, '🔢 <b>Enter the row number</b> to edit:', 'e.g. 15');
}

function handleEditRowManualInput(chatId, state, text) {
  const rowIndex = parseInt(text, 10);
  if (isNaN(rowIndex) || rowIndex < 1) {
    sendMessage(chatId, '⚠️ Please enter a valid positive row number.');
    _loadAndRenderRowList(chatId, state);
    return;
  }

  try {
    const values  = actionGetRowValues(state.fileId, state.sheetName, rowIndex);
    const headers = actionGetHeaders(state.fileId, state.sheetName);
    if (!values || values.length === 0) throw new Error('Row not found');

    state.rowIndex  = rowIndex;
    state.rowValues = values;
    state.headers   = headers;
    state.step      = 'edit_row_view';
    setState(chatId, state);
    renderRowView(chatId, state);
  } catch (e) {
    sendMessage(chatId, '⚠️ No row with that number.');
    _loadAndRenderRowList(chatId, state);
  }
}

function handleEditRowSelect(chatId, rowIndex) {
  const state = getState(chatId);
  let values, headers;
  try {
    values  = actionGetRowValues(state.fileId, state.sheetName, rowIndex);
    headers = actionGetHeaders(state.fileId, state.sheetName);
  } catch (e) {
    sendMessage(chatId, '⚠️ ' + e.message);
    _loadAndRenderRowList(chatId, state);
    return;
  }

  state.rowIndex  = rowIndex;
  state.rowValues = values;
  state.headers   = headers;
  renderRowView(chatId, state);
}

function renderRowView(chatId, state) {
  const headers      = state.headers || [];
  const values       = state.rowValues || [];
  const keyboardRows = [];
  const contentLines = [];

  headers.forEach((h, i) => {
    const colIndex = i + 1;

    // Skip trailing merged cells using the DataAccess helper (no _getSheet_ here).
    if (state.rowIndex && isCellTrailingMerge(state.fileId, state.sheetName, state.rowIndex, colIndex)) {
      return;
    }

    contentLines.push('<b>' + h + '</b>: ' + formatPreview(values[i], 100));
    keyboardRows.push([{ label: '✏️ ' + formatPreview(h, 30), value: 'editfield:' + colIndex }]);
  });

  sendMessage(chatId, 'Row ' + state.rowIndex + ' current data:\n\n' + contentLines.join('\n'));
  keyboardRows.push([{ label: '⬅️ Back', value: 'back:editrow' }]);
  _renderMenu(chatId, state, 'Select a field to edit:', keyboardRows);
}

function handleEditFieldSelect(chatId, colIndex) {
  const state = getState(chatId);

  if (isCellFormula(state.fileId, state.sheetName, state.rowIndex, colIndex)) {
    sendMessage(chatId, '⚠️ <b>This cell contains a formula and cannot be edited inline.</b>');
    renderRowView(chatId, state);
    return;
  }

  const headers      = state.headers || [];
  const currentValue = state.rowValues[colIndex - 1] || '';
  const fieldName    = headers[colIndex - 1] || 'Column ' + colIndex;

  state.step     = 'edit_field_wait';
  state.colIndex = colIndex;
  setState(chatId, state);

  _renderMenu(chatId, state, 'Opening editor for: ' + fieldName, []);

  _renderForceReply(
    chatId,
    '✏️ Editing <b>' + fieldName + '</b> in row ' + state.rowIndex + '.\n\n' +
    'Current value — tap to copy, then reply with the new value:\n<code>' + currentValue + '</code>',
    'Type new value…'
  );
}

function handleEditFieldInput(chatId, state, text) {
  try {
    actionUpdateCell(state.fileId, state.sheetName, state.rowIndex, state.colIndex, text);
    state.rowValues = actionGetRowValues(state.fileId, state.sheetName, state.rowIndex);
  } catch (e) {
    sendMessage(chatId, '⚠️ ' + e.message);
    return;
  }
  delete state.colIndex;
  state.step = 'edit_row_view';
  sendMessage(chatId, '✅ Cell updated.');
  renderRowView(chatId, state);
}

// ---------------------------------------------------------------------------
// Back navigation
// ---------------------------------------------------------------------------

function handleBack(chatId, target) {
  const state = getState(chatId);
  switch (target) {
    case 'folders':   showMainMenu(chatId);                       break;
    case 'files':     renderFileList(chatId, state);              break;
    case 'sheets':    renderSheetList(chatId, state, null);       break;
    case 'sheetmenu': showSheetMenu(chatId, state);               break;
    case 'editrow':   _loadAndRenderRowList(chatId, state);       break;
    default:          showMainMenu(chatId);
  }
}
