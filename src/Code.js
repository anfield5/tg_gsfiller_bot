/**
 * Code.js
 * Entry point. Routes Telegram webhook updates to Navigation.js handlers.
 *
 * Navigation is driven by a Telegram Reply Keyboard: tapping a button sends
 * its label back as a normal text message (no callback_query involved). To
 * resolve which action a tapped label corresponds to, the last screen
 * Navigation.js rendered stores state.currentOptions = [{label, value}, ...]
 * — handleMessage matches the incoming text against that list and dispatches
 * to routeAction(). Keep this file thin and fast — every doPost call must
 * return quickly.
 */

function doPost(e) {
  try {
    const update = JSON.parse(e.postData.contents);
    if (update.message) {
      handleMessage(update.message);
    }
  } catch (err) {
    console.error('doPost error: ' + err + (err.stack ? '\n' + err.stack : ''));
  }
  return ContentService.createTextOutput('ok');
}

/**
 * @param {Object} message Telegram message object
 */
function handleMessage(message) {
  const chatId = message.chat.id;
  const text = (message.text || '').trim();

  if (text === '/start') {
    clearState(chatId);
    showMainMenu(chatId);
    return;
  }

  if (text === '/cancel') {
    clearState(chatId);
    sendMessageNoKeyboard(chatId, 'Cancelled. Back to main menu.');
    showMainMenu(chatId);
    return;
  }

  const state = getState(chatId);

  // Free-text input steps take priority over option matching — these steps
  // expect an arbitrary typed value, not a tap on one of the known buttons.
  if (state.step === 'add_filling') {
    handleAddFieldInput(chatId, state, text);
    return;
  }
  if (state.step === 'edit_field_wait') {
    handleEditFieldInput(chatId, state, text);
    return;
  }

  // Otherwise, try to match the incoming text against the reply-keyboard
  // options the last screen presented.
  const options = state.currentOptions || [];
  const matched = options.find((o) => o.label === text);

  if (matched) {
    try {
      routeAction(chatId, matched.value);
    } catch (err) {
      console.error('routeAction error: ' + err + (err.stack ? '\n' + err.stack : ''));
      sendMessage(chatId, '⚠️ Something went wrong. Use /start to reset.');
    }
    return;
  }

  sendMessage(chatId, 'Please tap one of the buttons below, or use /start to reset.');
}

/**
 * @param {number|string} chatId
 * @param {string} value one of the internal action values (see the header
 *   comment in Navigation.js for the full list of formats)
 */
function routeAction(chatId, value) {
  const parts = value.split(':');
  const action = parts[0];

  switch (action) {
    case 'continue':
      handleContinue(chatId);
      break;
    case 'folder':
      handleFolderSelect(chatId, Number(parts[1]));
      break;
    case 'page':
      handleFilesPage(chatId, Number(parts[1]));
      break;
    case 'refresh':
      handleFilesRefresh(chatId);
      break;
    case 'file':
      handleFileSelect(chatId, Number(parts[1]));
      break;
    case 'sheet':
      handleSheetSelect(chatId, Number(parts[1]));
      break;
    case 'add':
      handleAddStart(chatId);
      break;
    case 'edit':
      handleEditStart(chatId);
      break;
    case 'editrow':
      handleEditRowSelect(chatId, Number(parts[1]));
      break;
    case 'editfield':
      handleEditFieldSelect(chatId, Number(parts[1]));
      break;
    case 'save':
      handleSaveAdd(chatId);
      break;
    case 'cancel_add':
      handleCancelAdd(chatId);
      break;
    case 'back':
      handleBack(chatId, parts[1]);
      break;
    default:
      console.error('Unknown action: ' + value);
  }
}
