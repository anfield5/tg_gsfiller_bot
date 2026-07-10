/**
 * Code.js
 * Telegram Webhook entry-point. Routes actions and user inputs.
 */

function doPost(e) {
  try {
    const update = JSON.parse(e.postData.contents);
    if (update.message) handleMessage(update.message);
  } catch (err) {
    console.error('doPost global crash: ' + err);
  }
  return ContentService.createTextOutput('ok');
}

function handleMessage(message) {
  const chatId = String(message.chat.id);
  
  // Security: Fetch allowed IDs from Script Properties to keep repository private
  const adminIds = PropertiesService.getScriptProperties().getProperty('ADMIN_IDS') || "";
  if (!adminIds.split(',').includes(chatId)) {
    sendMessage(message.chat.id, "🚫 Access denied. You are not authorized to use this bot.");
    return;
  }

  const text = (message.text || '').trim();

  if (text === '/start') { clearState(chatId); showMainMenu(chatId); return; }
  if (text === '/cancel') { clearState(chatId); sendMessageNoKeyboard(chatId, 'Reset to home.'); showMainMenu(chatId); return; }

  const state = getState(chatId);

  // 1. Check if user is actively writing an edit to a "Use Last" value
  if (state.step === 'add_filling_wait_edit') {
    handleAddFieldInput(chatId, state, text);
    return;
  }

  // 2. Check standard row addition phase
  if (state.step === 'add_filling') {
    const options = state.currentOptions || [];
    const matched = options.find((o) => o.label === text || (o.label.startsWith('🔘 Use:') && text.startsWith('🔘 Use:')));
    if (matched) {
      routeAction(chatId, matched.value);
    } else {
      handleAddFieldInput(chatId, state, text);
    }
    return;
  }
  
  // 3. Check inline cell editing phase
  if (state.step === 'edit_field_wait') {
    handleEditFieldInput(chatId, state, text);
    return;
  }

  // 4. Check manual row number input phase
  if (state.step === 'edit_row_manual_wait') {
    handleEditRowManualInput(chatId, state, text);
    return;
  }

  // 5. Default structural menu checks
  const options = state.currentOptions || [];
  const matched = options.find((o) => o.label === text);

  if (matched) {
    routeAction(chatId, matched.value);
    return;
  }

  sendMessage(chatId, 'Please pick an option from the menu buttons or use /start.');
}

function routeAction(chatId, value) {
  const state = getState(chatId);
  const parts = value.split(':');
  const action = parts[0];

  switch (action) {
    case 'continue': handleContinue(chatId); break;
    case 'folder': handleFolderSelect(chatId, Number(parts[1])); break;
    case 'page': handleFilesPage(chatId, Number(parts[1])); break;
    case 'refresh': handleFilesRefresh(chatId); break;
    case 'file': handleFileSelect(chatId, Number(parts[1])); break;
    case 'sheet': handleSheetSelect(chatId, Number(parts[1])); break;
    case 'add': handleAddStart(chatId); break;
    case 'edit': handleEditStart(chatId); break;
    case 'editpage': handleEditPage(chatId, Number(parts[1])); break;
    case 'edit_manual_request': handleEditRowManualRequest(chatId); break;
    
    case 'preview':
      try {
        const previewText = actionBuildPreviewText(state.fileId, state.sheetName);
        _callTelegram_('sendMessage', {
          chat_id: chatId,
          text: previewText,
          parse_mode: 'HTML'
        });
        showSheetMenu(chatId, state);
      } catch (e) {
        sendMessage(chatId, '⚠️ Error generating preview: ' + e.message);
        showSheetMenu(chatId, state);
      }
      break;
      
    case 'editrow': handleEditRowSelect(chatId, Number(parts[1])); break;
    case 'editfield': handleEditFieldSelect(chatId, Number(parts[1])); break;
    case 'save': handleSaveAdd(chatId); break;
    case 'cancel_add': handleCancelAdd(chatId); break;
    case 'back': handleBack(chatId, parts[1]); break;
    
    case 'use_last_direct':
      const idx = state.currentFieldIndex || 0;
      const lastVal = state.lastRowValues ? String(state.lastRowValues[idx]) : '';
      handleAddFieldInput(chatId, state, lastVal);
      break;
      
    case 'use_last_edit_request':
      handleUseLastEditRequest(chatId);
      break;
      
    case 'leave_empty':
      handleAddFieldInput(chatId, state, '');
      break;
      
    case 'finish_row':
      const headers = state.headers || [];
      for (let i = state.currentFieldIndex; i < headers.length; i++) {
        state.formData[headers[i]] = '';
      }
      state.currentFieldIndex = headers.length;
      proceedOrReviewAdd(chatId, state);
      break;
      
    default:
      console.error('Unknown global action caught: ' + value);
  }
}