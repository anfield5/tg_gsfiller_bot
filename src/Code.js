/**
 * Code.js
 * Telegram Webhook entry-point. Receives updates, enforces access control,
 * resolves the current conversation step, and dispatches to handlers.
 */

// Bump this alongside the git tag on every release (see README.md /
// commit message convention). Checkable live via the /version command —
// deliberately not tied to package.json (that file is never pushed to
// Apps Script), so this is the one source of truth for "what code is
// actually running" without needing the Executions log or a manual
// diagnostic function.
//
// v1.7.2 — changes since v1.7.1 (no intermediate version was ever actually
// pushed/tagged, so this release folds it all in at once):
//  - Per-chat processing lock: a second update for a chat that's still
//    being processed is rejected instead of racing the first one.
//  - Fixes misrouted taps ("Please pick an option…" on a visible button)
//    and silently dropped double-taps caused by that race.
//  - /start and /cancel bypass the lock AND clear it if it's stuck.
//  - /version and /log bypass the lock too, but never touch it (read-only).
//  - Always-on timing diagnostics (Timing.js): logs duration for Drive
//    scans, SpreadsheetApp opens, LockService waits, Telegram/Gemini calls.
//  - Only logs when a call takes >=200ms, plus one total-per-request line.
//  - New /log[ N] command: replies with the last N log entries (default
//    10, max 100).
//  - Backed by a new persistent, script-wide log ring buffer
//    (Logging.js, CacheService-based).
//  - Every console.log/console.error/Logger.log call site now routes
//    through log_/logError_, so /log genuinely captures everything.
//  - New /help command: lists every command with a description and an
//    example invocation.
//  - Removed 2 dead, never-called functions: clearSheetListCache,
//    getHeaderRow.
//  - Test suite grew from 96 to 154 tests, covering all of the above.
const BOT_VERSION = '1.7.2';

// ---------------------------------------------------------------------------
// Webhook entry-point
// ---------------------------------------------------------------------------

function doPost(e) {
  // Always logged (not gated by _timed_'s 200ms threshold) — the one number
  // to compare against the duration shown in the Apps Script Executions
  // list. If this total is much bigger than the sum of the [timing] lines
  // below it for the same request, the missing time is Apps Script's own
  // overhead (cold start, script load) rather than any single traceable
  // call — still useful to know, since no amount of app-code optimization
  // fixes that part.
  const requestStart = Date.now();
  try {
    // See DataAccess.js — never carry a stale sheet handle into a new
    // update. Guarded on its own: a missing/broken memo reset must never
    // take down message handling for the whole request.
    try { resetSheetMemo_(); } catch (memoErr) { logError_('resetSheetMemo_ failed: ' + memoErr); }

    const update = JSON.parse(e.postData.contents);
    if (update.message) handleMessage(update.message);
  } catch (err) {
    logError_('doPost unhandled error: ' + err);
  } finally {
    log_('[timing] doPost total: ' + (Date.now() - requestStart) + 'ms');
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
    sendMessage(message.chat.id, getIcons_().DENIED + ' Access denied. You are not authorised to use this bot.');
    return;
  }

  const text = (message.text || '').trim();

  // /start and /cancel are the explicit "get me out of here" commands, so
  // they always go through — including clearing a stuck lock below — even
  // if a previous update for this chat is still (or got stuck) processing.
  if (text === '/start')   { releaseChatLock_(chatId); clearState(chatId); showMainMenu(chatId); return; }
  if (text === '/cancel')  { releaseChatLock_(chatId); clearState(chatId); sendMessageNoKeyboard(chatId, 'Reset to home.'); showMainMenu(chatId); return; }
  if (text === '/version') { sendMessage(chatId, getIcons_().CHART + ' Bot version: <b>' + escapeHtml_(BOT_VERSION) + '</b>'); return; }
  if (text === '/help')    { sendMessage(chatId, buildHelpText_()); return; }

  // /log[ N] — read-only diagnostics (see Logging.js), so like /version it
  // never touches conversation state and bypasses the per-chat lock below:
  // it must still answer even while a real command is mid-flight/stuck.
  const logMatch = /^\/log(?:\s+(\S+))?$/i.exec(text);
  if (logMatch) { handleLogCommand_(chatId, logMatch[1] || ''); return; }

  // Serialize everything else per chat — see tryAcquireChatLock_ (State.js)
  // for why this exists: without it, two overlapping updates for the same
  // chat (a Telegram retry, or a user double-tapping before the keyboard
  // visibly changes) can race on the shared PropertiesService state below,
  // which silently misroutes a tapped button ("Please pick an option…" for
  // a button that's plainly on screen) or drops a reply entirely.
  const inProgress = tryAcquireChatLock_(chatId, text || 'Request');
  if (inProgress) {
    sendMessage(chatId, getIcons_().WARNING + ' <b>' + escapeHtml_(inProgress) + '</b> is still in progress. Please wait…');
    return;
  }

  try {
    const state = getState(chatId);

    // --- Step-specific free-text input phases ---

    // User is editing a previous value before saving it to the add-row form.
    if (state.step === 'add_filling_wait_edit') {
      handleAddFieldInput(chatId, state, text);
      return;
    }

    // User is entering a field value for a new row.
    if (state.step === 'add_filling') {
      const useLastPrefix = getIcons_().USE_LAST + ' Use:';
      const options = state.currentOptions || [];
      const matched = options.find(
        o => o.label === text || (o.label.startsWith(useLastPrefix) && text.startsWith(useLastPrefix))
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

    // --- Gemini Analysis free-text input phases ---
    if (state.step === 'gemini_wait_row') {
      handleGeminiRowInput(chatId, state, text);
      return;
    }
    if (state.step === 'gemini_wait_range') {
      handleGeminiRangeInput(chatId, state, text);
      return;
    }
    if (state.step === 'gemini_wait_prompt') {
      handleGeminiPromptInput(chatId, state, text);
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
  } finally {
    releaseChatLock_(chatId);
  }
}

/**
 * Builds the /help reply: every top-level slash command with a one-line
 * description and an example invocation. Kept as its own function (rather
 * than inlined at the call site, like /version is) so the full command list
 * lives in exactly one place and tests can assert on it directly.
 * @returns {string} HTML-formatted (sendMessage uses parse_mode HTML)
 */
function buildHelpText_() {
  const icons = getIcons_();
  return icons.HELP + ' <b>Available commands</b>\n\n' +
    '<b>/start</b> — reset and open the main menu.\n' +
    'Example: <code>/start</code>\n\n' +
    '<b>/cancel</b> — reset to the main menu from anywhere.\n' +
    'Example: <code>/cancel</code>\n\n' +
    '<b>/version</b> — show the currently deployed code version.\n' +
    'Example: <code>/version</code>\n\n' +
    '<b>/log[ N]</b> — show the last N log entries (default 10, max 100).\n' +
    'Example: <code>/log 20</code>\n\n' +
    '<b>/help</b> — show this list of commands.\n' +
    'Example: <code>/help</code>';
}

// ---------------------------------------------------------------------------
// Action router
// ---------------------------------------------------------------------------

function routeAction(chatId, value) {
  const state  = getState(chatId);
  const parts  = value.split(':');
  const action = parts[0];

  switch (action) {
    case 'continue': handleContinue(chatId); break;
    case 'folder':   handleFolderSelect(chatId, Number(parts[1])); break;
    case 'page':     handleFilesPage(chatId, Number(parts[1])); break;
    case 'refresh':  handleFilesRefresh(chatId); break;

    // Value format: "file:<fileId>:<fileName>" — fileId has no ":", fileName is
    // everything after the second ":" reassembled (handles ":" in sheet names).
    case 'file':  handleFileSelect(chatId, parts[1], parts.slice(2).join(':')); break;
    case 'sheet': handleSheetSelect(chatId, Number(parts[1])); break;

    case 'add':                  handleAddStart(chatId); break;
    case 'edit':                 handleEditStart(chatId); break;
    case 'editpage':             handleEditPage(chatId, Number(parts[1])); break;
    case 'edit_manual_request':  handleEditRowManualRequest(chatId); break;
    case 'editrow':              handleEditRowSelect(chatId, Number(parts[1])); break;
    case 'editfield':            handleEditFieldSelect(chatId, Number(parts[1])); break;

    case 'save':       handleSaveAdd(chatId); break;
    case 'cancel_add': handleCancelAdd(chatId); break;
    case 'prev_field': handlePrevField(chatId); break;
    case 'back':        handleBack(chatId, parts[1]); break;

    case 'preview': {
      try {
        const previewText = actionBuildPreviewText(state.fileId, state.sheetName);
        _callTelegram_('sendMessage', { chat_id: chatId, text: previewText, parse_mode: 'HTML' });
        showSheetMenu(chatId, state);
      } catch (e) {
        sendMessage(chatId, getIcons_().WARNING + ' Error generating preview: ' + escapeHtml_(e.message));
        showSheetMenu(chatId, state);
      }
      break;
    }

    case 'use_last_direct': {
      const idx = state.currentFieldIndex || 0;
      const lastVal = state.lastRowValues ? String(state.lastRowValues[idx]) : '';
      handleAddFieldInput(chatId, state, lastVal);
      break;
    }
    case 'use_last_edit_request':
      handleUseLastEditRequest(chatId);
      break;
    case 'top3_values':
      handleTop3Values(chatId);
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
    case 'favdoc':     handleToggleFavDoc(chatId); break;
    case 'favtab':      handleToggleFavTab(chatId); break;
    case 'openfavdoc':  handleOpenFavDoc(chatId, Number(parts[1])); break;

    // --- Gemini Analysis ---
    case 'gemini':               handleGeminiStart(chatId); break;
    case 'gemini_model':         handleGeminiModelSelect(chatId, Number(parts[1])); break;
    case 'gemini_model_refresh': handleGeminiModelRefresh(chatId); break;
    case 'gemini_noop':          break; // group header row in the model picker — not a real option
    case 'gemini_sheet':   handleGeminiSheetSelect(chatId, Number(parts[1])); break;
    case 'gemini_type':    handleGeminiTypeSelect(chatId, parts[1]); break;
    case 'gemini_col':     handleGeminiColumnSelect(chatId, Number(parts[1])); break;
    case 'gemini_cancel':  handleGeminiCancel(chatId); break;

    default:
      logError_('Unknown action: ' + value);
  }
}
