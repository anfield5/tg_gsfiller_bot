/**
 * Navigation.js
 * Manages bot navigation screens and keyboard markup generation.
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

function _renderForceReply(chatId, text, placeholderText) {
  return _callTelegram_('sendMessage', {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML',
    reply_markup: {
      force_reply: true,
      input_field_placeholder: placeholderText || "Type here..."
    }
  });
}

// ---------- Main Menu ----------

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
        label = '📁 Folder ' + (idx + 1);
      }
    }
    options.push({ label: label.startsWith('📁') ? label : '📁 ' + label, value: 'folder:' + idx });
  });

  const text = CONFIG.FOLDER_IDS.length ? 'Choose a folder:' : 'No folders configured.';
  _renderMenu(chatId, state, text, options.map(o => [o]));
}

function handleContinue(chatId) {
  const lastPath = getLastPath(chatId);
  if (!lastPath) { 
    showMainMenu(chatId); 
    return; 
  }
  
  let sheets;
  try {
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
    filePage: 0,
    fileId: lastPath.fileId,
    fileName: lastPath.fileName,
    sheetName: lastPath.sheetName,
  };
  showSheetMenu(chatId, state);
}

function handleFolderSelect(chatId, folderIndex) {
  const folderId = CONFIG.FOLDER_IDS[folderIndex];
  if (!folderId) { 
    showMainMenu(chatId); 
    return; 
  }
  
  let folderName = CONFIG.FOLDER_LABELS[folderIndex];
  if (!folderName) {
    try {
      folderName = actionGetFolderName(folderId);
    } catch (e) {
      folderName = 'Folder ' + (folderIndex + 1);
    }
  }

  try {
    actionListSpreadsheets(folderId);
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
    filePage: 0 
  };
  renderFileList(chatId, state);
}

function handleFilesPage(chatId, page) {
  const state = getState(chatId);
  state.filePage = page;
  renderFileList(chatId, state);
}

function handleFilesRefresh(chatId) {
  const state = getState(chatId);
  try {
    clearFolderCache(state.folderId);
    actionListSpreadsheets(state.folderId, true);
  } catch (e) {
    sendMessage(chatId, '⚠️ ' + e.message);
    showMainMenu(chatId);
    return;
  }
  state.filePage = 0;
  renderFileList(chatId, state);
}

function renderFileList(chatId, state) {
  let files = [];
  try {
    files = actionListSpreadsheets(state.folderId);
  } catch (e) {
    sendMessage(chatId, '⚠️ Could not read files.');
    return;
  }

  const perPage = CONFIG.FILES_PER_PAGE || 10;
  const page = state.filePage || 0;
  const start = page * perPage;
  const pageFiles = files.slice(start, start + perPage);

  const keyboardRows = pageFiles.map((f, i) => [{ label: '📄 ' + f.name, value: 'file:' + (start + i) }]);
  const navRow = [];
  if (page > 0) navRow.push({ label: '◀️ Prev', value: 'page:' + (page - 1) });
  if (start + perPage < files.length) navRow.push({ label: '▶️ Next', value: 'page:' + (page + 1) });
  if (navRow.length) keyboardRows.push(navRow);

  keyboardRows.push([{ label: '🔄 Refresh', value: 'refresh' }, { label: '⬅️ Back', value: 'back:folders' }]);
  _renderMenu(chatId, state, 'Spreadsheets in "' + state.folderName + '":', keyboardRows);
}

function handleFileSelect(chatId, fileIndex) {
  const state = getState(chatId);
  
  let files = [];
  try { 
    files = actionListSpreadsheets(state.folderId); 
  } catch(e){}
  
  const file = files[fileIndex];
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
  setState(chatId, state);
  
  renderSheetList(chatId, state, sheets);
}

function renderSheetList(chatId, state, sheets) {
  if (!sheets) {
    try { 
      sheets = actionListSheets(state.fileId); 
    } catch(e){ 
      sheets = []; 
    }
  }
  
  const keyboardRows = sheets.map((name, idx) => [{ label: '📑 ' + name, value: 'sheet:' + idx }]);
  keyboardRows.push([{ label: '⬅️ Back', value: 'back:files' }]);
  _renderMenu(chatId, state, 'Sheets in "' + state.fileName + '":', keyboardRows);
}

function handleSheetSelect(chatId, sheetIndex) {
  const state = getState(chatId);
  
  let sheets = [];
  try { 
    sheets = actionListSheets(state.fileId); 
  } catch(e){}
  
  const sheetName = sheets[sheetIndex];
  if (!sheetName) { 
    renderSheetList(chatId, state, sheets); 
    return; 
  }
  
  state.sheetName = sheetName;
  setLastPath(chatId, {
    folderIndex: state.folderIndex, folderId: state.folderId, folderName: state.folderName,
    fileId: state.fileId, fileName: state.fileName, sheetName: state.sheetName,
    label: state.folderName + ' / ' + state.fileName + ' / ' + state.sheetName,
  });
  showSheetMenu(chatId, state);
}

function showSheetMenu(chatId, state) {
  state.step = 'sheet_menu';
  const keyboardRows = [
    [{ label: '➕ Add row', value: 'add' }],
    [{ label: '✏️ Edit row', value: 'edit' }],
    [{ label: '🔍 Preview', value: 'preview' }],
    [{ label: '⬅️ Back', value: 'back:sheets' }],
  ];
  _renderMenu(chatId, state, '"' + state.folderName + ' / ' + state.fileName + ' / ' + state.sheetName + '"\nWhat do you want to do?', keyboardRows);
}

// ---------- ADD ROW FLOW ----------

function handleAddStart(chatId) {
  const state = getState(chatId);
  let headers, lastRows = [];
  try {
    headers = actionGetHeaders(state.fileId, state.sheetName);
    lastRows = actionGetLastRows(state.fileId, state.sheetName, 1);
  } catch (e) {
    sendMessage(chatId, '⚠️ ' + e.message);
    showSheetMenu(chatId, state);
    return;
  }

  state.step = 'add_filling';
  state.headers = headers;
  state.currentFieldIndex = 0;
  state.formData = {};
  state.lastRowValues = (lastRows.length > 0) ? lastRows[0].values : null;
  state.lastRowIndex = (lastRows.length > 0) ? lastRows[0].rowIndex : 1;
  
  sendFieldPrompt(chatId, state);
}

function sendFieldPrompt(chatId, state) {
  const headers = state.headers || [];
  const idx = state.currentFieldIndex || 0;

  if (idx >= headers.length) {
    proceedOrReviewAdd(chatId, state);
    return;
  }

  // 1. Auto-flag formula positions from the row template and mark as formula
  if (state.lastRowValues && isCellFormula(state.fileId, state.sheetName, state.lastRowIndex, idx + 1)) {
    state.formData[headers[idx]] = '🧬 (Calculated Formula)';
    state.currentFieldIndex = idx + 1;
    sendFieldPrompt(chatId, state);
    return;
  }

  // 2. Skip columns that are horizontally merged into the previous column (e.g., Column E trailing Column D)
  if (state.lastRowIndex > 1) {
    try {
      const sheet = _getSheet(state.fileId, state.sheetName);
      const templateCell = sheet.getRange(state.lastRowIndex, idx + 1);
      if (templateCell.isPartOfMerge()) {
        const topLeftCell = templateCell.getMergedRanges()[0].getCell(1, 1);
        if (topLeftCell.getColumn() < (idx + 1)) {
          state.formData[headers[idx]] = ''; // Shared data cell
          state.currentFieldIndex = idx + 1;
          sendFieldPrompt(chatId, state);
          return;
        }
      }
    } catch(e) {
      console.error("Merge visual validation skipped: " + e);
    }
  }

  const fieldName = headers[idx];
  const keyboardRows = [];
  
  let lastVal = '';
  if (state.lastRowValues && state.lastRowValues[idx] !== undefined) {
    lastVal = String(state.lastRowValues[idx]);
  }

  if (lastVal.trim().length > 0) {
    keyboardRows.push([
      { label: '🔘 Use: ' + formatPreview(lastVal, 15), value: 'use_last_direct' },
      { label: '✏️ Edit Last Value', value: 'use_last_edit_request' }
    ]);
  }

  keyboardRows.push([
    { label: '🔲 Leave empty', value: 'leave_empty' },
    { label: '🏁 Finish row', value: 'finish_row' }
  ]);
  keyboardRows.push([{ label: '❌ Cancel', value: 'cancel_add' }]);

  const text = 'Adding to <b>' + state.sheetName + '</b>.\n\nEnter value for: <b>' + fieldName + '</b>';
  _renderMenu(chatId, state, text, keyboardRows);
}

function handleUseLastEditRequest(chatId) {
  const state = getState(chatId);
  const headers = state.headers || [];
  const idx = state.currentFieldIndex || 0;
  const fieldName = headers[idx];
  const lastVal = state.lastRowValues ? String(state.lastRowValues[idx]) : '';

  state.step = 'add_filling_wait_edit';
  setState(chatId, state);

  _renderMenu(chatId, state, 'Preparing editor...', []);

  const promptText = '✏️ Editing value for: <b>' + fieldName + '</b>\n\n' +
                     '👉 <b>Tap the box below to copy it instantly</b>, paste it into the chat input, modify it, and send:\n\n' +
                     '<code>' + lastVal + '</code>';
  
  _renderForceReply(chatId, promptText, "Paste and edit value...");
}

function handleAddFieldInput(chatId, state, text) {
  const headers = state.headers || [];
  let idx = state.currentFieldIndex || 0;
  const fieldName = headers[idx];

  state.formData[fieldName] = text;
  state.currentFieldIndex = idx + 1;
  state.step = 'add_filling';
  setState(chatId, state);

  proceedOrReviewAdd(chatId, state);
}

function proceedOrReviewAdd(chatId, state) {
  const headers = state.headers || [];
  if (state.currentFieldIndex < headers.length) {
    sendFieldPrompt(chatId, state);
    return;
  }

  const preview = headers.map((h) => '<b>' + h + '</b>: ' + (state.formData[h] || '(empty)')).join('\n');
  sendMessage(chatId, 'Review new row data:\n\n' + preview);

  const keyboardRows = [[{ label: '✅ Save', value: 'save' }, { label: '❌ Cancel', value: 'cancel_add' }]];
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
  sendMessage(chatId, '✅ Row successfully saved.');
  showSheetMenu(chatId, state);
}

function handleCancelAdd(chatId) {
  sendMessage(chatId, 'Cancelled. Data was not saved.');
  showSheetMenu(chatId, getState(chatId));
}

// ---------- EDIT ROW FLOW ----------

function handleEditStart(chatId) {
  const state = getState(chatId);
  state.editPage = 0;
  _loadAndRenderRowList(chatId, state);
}

function handleEditPage(chatId, page) {
  const state = getState(chatId);
  state.editPage = page;
  _loadAndRenderRowList(chatId, state);
}

function _loadAndRenderRowList(chatId, state) {
  let allRows;
  try {
    allRows = actionGetLastRows(state.fileId, state.sheetName, 1000);
  } catch (e) {
    sendMessage(chatId, '⚠️ ' + e.message);
    showSheetMenu(chatId, state);
    return;
  }
  state.rowList = allRows;
  renderRowList(chatId, state);
}

function renderRowList(chatId, state) {
  const rows = state.rowList || [];
  if (!rows.length) {
    _renderMenu(chatId, state, 'No data rows found.', [[{ label: '⬅️ Back', value: 'back:sheetmenu' }]]);
    return;
  }

  const perPage = 10;
  const page = state.editPage || 0;
  const start = page * perPage;
  const pageRows = rows.slice(start, start + perPage);

  const lines = pageRows.map((r) => '<b>Row ' + r.rowIndex + '</b>: ' + r.values.slice(0, 3).map(v => formatPreview(v, 20)).join(' | '));
  let contentText = 'Recent rows (Page ' + (page + 1) + '):\n\n' + lines.join('\n');

  try {
    const gid = actionGetSheetGid(state.fileId, state.sheetName);
    const link = buildSheetRangeUrl(state.fileId, gid, Math.min(...pageRows.map(r=>r.rowIndex)), Math.max(...pageRows.map(r=>r.rowIndex)), pageRows[0].values.length);
    contentText += '\n\n🔗 <a href="' + link + '">Open in Google Sheets</a>';
  } catch (e) {}

  sendMessage(chatId, contentText);
  
  const keyboardRows = pageRows.map((r) => [{ label: 'Row ' + r.rowIndex, value: 'editrow:' + r.rowIndex }]);
  
  const navRow = [];
  if (page > 0) navRow.push({ label: '◀️ Prev Rows', value: 'editpage:' + (page - 1) });
  if (start + perPage < rows.length) navRow.push({ label: '▶️ Next Rows', value: 'editpage:' + (page + 1) });
  if (navRow.length) keyboardRows.push(navRow);

  keyboardRows.push([{ label: '🔢 Fill row number manually', value: 'edit_manual_request' }]);
  keyboardRows.push([{ label: '⬅️ Back', value: 'back:sheetmenu' }]);
  _renderMenu(chatId, state, 'Tap a row to edit or enter number manually:', keyboardRows);
}

function handleEditRowManualRequest(chatId) {
  const state = getState(chatId);
  state.step = 'edit_row_manual_wait';
  setState(chatId, state);

  _renderMenu(chatId, state, 'Preparing manual input...', []);
  _renderForceReply(chatId, '🔢 <b>Enter the row number</b> you want to edit:', "e.g. 15");
}

function handleEditRowManualInput(chatId, state, text) {
  const rowIndex = parseInt(text, 10);
  
  if (isNaN(rowIndex) || rowIndex < 1) {
    sendMessage(chatId, '⚠️ Error: Please enter a valid positive row number.');
    renderRowList(chatId, state);
    return;
  }

  try {
    const values = actionGetRowValues(state.fileId, state.sheetName, rowIndex);
    const headers = actionGetHeaders(state.fileId, state.sheetName);
    
    if (!values || values.length === 0) {
      throw new Error('No row with such number');
    }

    state.rowIndex = rowIndex;
    state.rowValues = values;
    state.headers = headers;
    state.step = 'edit_row_view';
    setState(chatId, state);
    
    renderRowView(chatId, state);

  } catch (e) {
    sendMessage(chatId, '⚠️ No row with such number');
    renderRowList(chatId, state);
  }
}

function handleEditRowSelect(chatId, rowIndex) {
  const state = getState(chatId);
  let values, headers;
  try {
    values = actionGetRowValues(state.fileId, state.sheetName, rowIndex);
    headers = actionGetHeaders(state.fileId, state.sheetName);
  } catch (e) {
    sendMessage(chatId, '⚠️ ' + e.message);
    renderRowList(chatId, state);
    return;
  }

  state.rowIndex = rowIndex;
  state.rowValues = values;
  state.headers = headers;
  renderRowView(chatId, state);
}

function renderRowView(chatId, state) {
  const headers = state.headers || [];
  const values = state.rowValues || [];
  
  const keyboardRows = [];
  let contentLines = [];

  let sheet = null;
  try {
    sheet = _getSheet(state.fileId, state.sheetName);
  } catch(e) {
    console.error("Could not open sheet for edit validation: " + e);
  }

  headers.forEach((h, i) => {
    const colIndex = i + 1;
    let shouldSkip = false;

    // Filter layout structures so that trailing merged cells don't render options
    if (sheet && state.rowIndex) {
      try {
        const cell = sheet.getRange(state.rowIndex, colIndex);
        if (cell.isPartOfMerge()) {
          const topLeftCell = cell.getMergedRanges()[0].getCell(1, 1);
          if (topLeftCell.getColumn() < colIndex) {
            shouldSkip = true;
          }
        }
      } catch(e) {
        console.error("Error validating cell merge during edit render: " + e);
      }
    }

    if (!shouldSkip) {
      contentLines.push('<b>' + h + '</b>: ' + formatPreview(values[i], 100));
      keyboardRows.push([{ label: '✏️ ' + formatPreview(h, 30), value: 'editfield:' + colIndex }]);
    }
  });

  const contentText = 'Row ' + state.rowIndex + ' current data:\n\n' + contentLines.join('\n');
  sendMessage(chatId, contentText);

  keyboardRows.push([{ label: '⬅️ Back', value: 'back:editrow' }]);
  _renderMenu(chatId, state, 'Select a field to modify:', keyboardRows);
}

function handleEditFieldSelect(chatId, colIndex) {
  const state = getState(chatId);
  
  if (isCellFormula(state.fileId, state.sheetName, state.rowIndex, colIndex)) {
    sendMessage(chatId, '⚠️ <b>Cell contains a formula and is locked for inline editing.</b>');
    renderRowView(chatId, state);
    return;
  }

  const headers = state.headers || [];
  const currentValue = state.rowValues[colIndex - 1] || '';
  const fieldName = headers[colIndex - 1] || 'Column ' + colIndex;

  state.step = 'edit_field_wait';
  state.colIndex = colIndex;
  setState(chatId, state);

  _renderMenu(chatId, state, 'Opening editor for: ' + fieldName, []);

  const promptText = '✏️ Editing <b>' + fieldName + '</b> in row ' + state.rowIndex + '.\n\n' +
                     'Current value is listed below. Tap to copy, reply or write a new value:\n<code>' + currentValue + '</code>';
  
  _renderForceReply(chatId, promptText, "Type new cell value...");
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
  sendMessage(chatId, '✅ Cell updated successfully.');
  renderRowView(chatId, state);
}

// ---------- Backward Navigation ----------

function handleBack(chatId, target) {
  const state = getState(chatId);
  if (target === 'folders') {
    showMainMenu(chatId);
  } else if (target === 'files') {
    renderFileList(chatId, state);
  } else if (target === 'sheets') {
    renderSheetList(chatId, state, null);
  } else if (target === 'sheetmenu') {
    showSheetMenu(chatId, state);
  } else if (target === 'editrow') {
    renderRowList(chatId, state);
  } else {
    showMainMenu(chatId);
  }
}