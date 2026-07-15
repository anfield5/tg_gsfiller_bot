/**
 * Code.js
 * Telegram Webhook entry-point. Receives updates, enforces access control,
 * resolves the current conversation step, and dispatches to handlers.
 */

// ---------------------------------------------------------------------------
// Webhook entry-point
// ---------------------------------------------------------------------------

function doPost(e) {
  try {
    const update = JSON.parse(e.postData.contents);
    if (update.message) handleMessage(update.message);
  } catch (err) {
    console.error('doPost unhandled error: ' + err);
  }
  return ContentService.createTextOutput('ok');
}

// ---------------------------------------------------------------------------
// Message dispatcher
// ---------------------------------------------------------------------------

function handleMessage(message) {
  const chatId = String(message.chat.id);

  // Access control — allowed chat IDs are stored in Script Properties,
  // never committed to the repository.
  const adminIds = PropertiesService.getScriptProperties().getProperty('ADMIN_IDS') || '';
  if (!adminIds.split(',').map(s => s.trim()).includes(chatId)) {
    sendMessage(message.chat.id, '🚫 Access denied. You are not authorised to use this bot.');
    return;
  }

  const text = (message.text || '').trim();

  // Global commands always take priority.
  if (text === '/start')  { clearState(chatId); showMainMenu(chatId); return; }
  if (text === '/cancel') { clearState(chatId); sendMessageNoKeyboard(chatId, 'Reset to home.'); showMainMenu(chatId); return; }

  const state = getState(chatId);

  // --- Step-specific free-text input phases ---

  // User is editing a previous value before saving it to the add-row form.
  if (state.step === 'add_filling_wait_edit') {
    handleAddFieldInput(chatId, state, text);
    return;
  }

  // User is entering a field value for a new row.
  if (state.step === 'add_filling') {
    const options = state.currentOptions || [];
    const matched = options.find(
      o => o.label === text || (o.label.startsWith('🔘 Use:') && text.startsWith('🔘 Use:'))
    );
    if (matched) {
      routeAction(chatId, matched.value);
    } else {
      handleAddFieldInput(chatId, state, text);
    }
    return;
  }

  // User is typing a new value for an existing cell.
  if (state.step === 'edit_field_wait') {
    handleEditFieldInput(chatId, state, text);
    return;
  }

  // User is typing a row number manually for the edit flow.
  if (state.step === 'edit_row_manual_wait') {
    handleEditRowManualInput(chatId, state, text);
    return;
  }

  // --- Standard menu button match ---
  const options = state.currentOptions || [];
  const matched = options.find(o => o.label === text);
  if (matched) {
    routeAction(chatId, matched.value);
    return;
  }

  sendMessage(chatId, 'Please pick an option from the menu or use /start.');
}

// ---------------------------------------------------------------------------
// Action router
// ---------------------------------------------------------------------------

function routeAction(chatId, value) {
  const state  = getState(chatId);
  const parts  = value.split(':');
  const action = parts[0];

  switch (action) {
    case 'continue':          handleContinue(chatId);                    break;
    case 'folder':            handleFolderSelect(chatId, Number(parts[1]));   break;
    case 'page':              handleFilesPage(chatId, Number(parts[1]));       break;
    case 'refresh':           handleFilesRefresh(chatId);                break;
    // Value format: "file:<fileId>:<fileName>" — fileId has no ":", fileName is
    // everything after the second ":" reassembled (handles ":" in sheet names).
    case 'file':              handleFileSelect(chatId, parts[1], parts.slice(2).join(':')); break;
    case 'sheet':             handleSheetSelect(chatId, Number(parts[1]));     break;
    case 'add':               handleAddStart(chatId);                    break;
    case 'edit':              handleEditStart(chatId);                   break;
    case 'editpage':          handleEditPage(chatId, Number(parts[1]));        break;
    case 'edit_manual_request': handleEditRowManualRequest(chatId);      break;
    case 'editrow':           handleEditRowSelect(chatId, Number(parts[1]));   break;
    case 'editfield':         handleEditFieldSelect(chatId, Number(parts[1])); break;
    case 'save':              handleSaveAdd(chatId);                     break;
    case 'cancel_add':        handleCancelAdd(chatId);                   break;
    case 'back':              handleBack(chatId, parts[1]);              break;

    case 'preview': {
      try {
        const previewText = actionBuildPreviewText(state.fileId, state.sheetName);
        _callTelegram_('sendMessage', { chat_id: chatId, text: previewText, parse_mode: 'HTML' });
        showSheetMenu(chatId, state);
      } catch (e) {
        sendMessage(chatId, '⚠️ Error generating preview: ' + e.message);
        showSheetMenu(chatId, state);
      }
      break;
    }

    case 'use_last_direct': {
      const idx     = state.currentFieldIndex || 0;
      const lastVal = state.lastRowValues ? String(state.lastRowValues[idx]) : '';
      handleAddFieldInput(chatId, state, lastVal);
      break;
    }

    case 'use_last_edit_request':
      handleUseLastEditRequest(chatId);
      break;

    case 'leave_empty':
      handleAddFieldInput(chatId, state, '');
      break;

    case 'finish_row': {
      const headers = state.headers || [];
      for (let i = state.currentFieldIndex; i < headers.length; i++) {
        state.formData[headers[i]] = '';
      }
      state.currentFieldIndex = headers.length;
      proceedOrReviewAdd(chatId, state);
      break;
    }

    // --- Favorites ---
    case 'favdoc':        handleToggleFavDoc(chatId);              break;
    case 'favtab':        handleToggleFavTab(chatId);              break;
    case 'openfavdoc':    handleOpenFavDoc(chatId, Number(parts[1])); break;

    default:
      console.error('Unknown action: ' + value);
  }
}
