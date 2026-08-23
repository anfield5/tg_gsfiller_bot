/**
 * Wrapper around the Gemini generateContent REST endpoint, plus a helper
 * to list currently-available models so the bot never hardcodes one.
 *
 * NOTE (2026-08-23): Confirmed root cause of the earlier HTTP 404 via
 * Google's own error message: "gemini-2.5-flash is no longer available
 * to new users. Please update your code to use models/gemini-3.6-flash."
 * The generateContent endpoint itself is fine and still supported — only
 * the model id was stale, and model availability clearly changes over
 * time. That's why the model is now chosen interactively from
 * listGeminiModels_() instead of being fixed in code/config, and why the
 * picker has a Refresh button (clearGeminiModelsCache_) rather than only
 * trusting a 6h cache.
 */

// Google does not expose "is this free for my project" anywhere in the
// API (ListModels has no pricing/tier field), so there is no way to check
// this live. This is an ALLOWLIST (not a denylist) built from the official
// pricing page (https://ai.google.dev/gemini-api/docs/pricing, read
// 2026-08-24): only model ids confirmed to show "Free of charge" in the
// Free Tier column are listed. An allowlist is used deliberately — if
// Google adds a brand-new paid-only model tomorrow, a denylist would
// silently let it through, but this allowlist just won't show it until
// someone adds it below. It is NOT derivable from the model name — e.g.
// "Gemini 2.5 Pro" is free, "Gemini 3.1 Pro Preview" is not, despite both
// being "Pro" models. Matched by prefix so dated snapshots of an
// already-confirmed-free family (e.g. "gemini-2.5-flash-lite-preview-
// 09-2025") are covered without listing every snapshot individually.
//
// Each entry can set `modality` ('text' | 'audio' | 'image', default
// 'text') and an explicit `category` (skips the description-based
// classifier below — used for audio/image since their categories aren't
// about reasoning depth). Extend via CONFIG.GEMINI_EXTRA_FREE_MODELS in
// Config.js (same shape: [{ prefix, modality, category }]).
const DEFAULT_FREE_MODELS_ = [
  // --- Text ---
  { prefix: 'gemini-3.7-flash' },
  { prefix: 'gemini-3.6-flash' },
  { prefix: 'gemini-3.5-flash' },
  { prefix: 'gemini-3.5-flash-lite' },   // separate model id, not a suffix of gemini-3.5-flash — needs its own entry
  { prefix: 'gemini-3.1-flash-lite' },
  { prefix: 'gemini-3-flash-preview' },
  { prefix: 'gemini-2.5-pro' },
  // NOT 'gemini-2.5-flash' (bare) — confirmed via a live 404 on 2026-08-24:
  // "gemini-2.5-flash is no longer available to new users." It still shows
  // as free in the pricing table (presumably for grandfathered accounts),
  // but new API keys get rejected outright, so it's excluded here. Only
  // the -lite variant is offered. If your account still has access to the
  // bare model, add it back via CONFIG.GEMINI_EXTRA_FREE_MODELS.
  { prefix: 'gemini-2.5-flash-lite' },   // covers gemini-2.5-flash-lite(-preview-*)
  { prefix: 'gemma' },                   // open-weight models, free via the same API key
  // --- Audio (text-to-speech) ---
  // Only gemini-2.5-flash-preview-tts is free; gemini-2.5-pro-preview-tts
  // is paid-only (checked 2026-08-24) and is deliberately NOT listed here.
  { prefix: 'gemini-2.5-flash-preview-tts', modality: 'audio', category: 'Best for: audio narration' },
  // --- Image generation ---
  // No free image-generation model exists on the Gemini API right now —
  // both Nano Banana and Nano Banana 2 (gemini-2.5-flash-image,
  // gemini-3.1-flash-image) show "Not available" for Free Tier as of
  // 2026-08-24. The plumbing (callGeminiImage_ below) is ready; once
  // Google ships a free one, add a line here:
  //   { prefix: 'gemini-x-flash-image', modality: 'image', category: 'Best for: image generation' }
  // or, to use a paid one anyway, add it via CONFIG.GEMINI_EXTRA_FREE_MODELS
  // — no other code changes needed.
];

// Groups TEXT models by what they're actually good at (per Google's own
// model descriptions, returned as `description` by ListModels) rather
// than by family name — "Flash" vs "Pro" tells you nothing useful when
// picking a model for text analysis, but "fast & cheap" vs "deep
// reasoning" does. First matching rule wins; anything that matches
// nothing falls back to the general-purpose bucket. Audio/image models
// skip this — they set an explicit `category` in DEFAULT_FREE_MODELS_
// above instead.
const GEMINI_CATEGORY_RULES_ = [
  { label: 'Best for: fast & cheap analysis',    pattern: /cost-effic|cost effective|smallest|most cost/i },
  { label: 'Best for: deep reasoning & coding',  pattern: /reasoning|coding|state-of-the-art/i },
  { label: 'Best for: agentic workflows',        pattern: /agentic/i },
];
const GEMINI_FALLBACK_CATEGORY_ = 'Best for: general analysis';

/** Fixed display order for the grouped model-picker keyboard. */
const GEMINI_MODEL_CATEGORY_ORDER_ = [
  'Best for: fast & cheap analysis',
  'Best for: deep reasoning & coding',
  'Best for: agentic workflows',
  GEMINI_FALLBACK_CATEGORY_,
  'Best for: audio narration',
  'Best for: image generation',
];

/**
 * Classifies a text model by its Google-provided description into one of
 * GEMINI_MODEL_CATEGORY_ORDER_.
 * @param {string} description
 * @returns {string}
 */
function _geminiModelCategory_(description) {
  const text = description || '';
  for (let i = 0; i < GEMINI_CATEGORY_RULES_.length; i++) {
    if (GEMINI_CATEGORY_RULES_[i].pattern.test(text)) return GEMINI_CATEGORY_RULES_[i].label;
  }
  return GEMINI_FALLBACK_CATEGORY_;
}

// Matches ONLY an exact id, or the prefix followed by what looks like a
// version/date suffix (e.g. "-001", "-preview-09-2025", or Gemma's
// "-4-26b-a4b-it"). A plain `indexOf(prefix) === 0` check is NOT enough:
// "gemini-2.5-pro" would then also match the unrelated sibling model
// "gemini-2.5-pro-preview-tts" (confirmed live — it showed up in the
// picker as a false positive on 2026-08-24), and the same trick would let
// "gemini-2.5-flash" match "gemini-2.5-flash-image" (Nano Banana). This
// requires the suffix after the prefix to look like OUR versioning
// pattern, not an arbitrary unrelated model name.
const GEMINI_PREFIX_SUFFIX_PATTERN_ = /^-(\d[\w.-]*|preview(-\d{2}-\d{4})?)$/;

function _geminiPrefixMatches_(modelId, prefix) {
  if (modelId === prefix) return true;
  if (modelId.indexOf(prefix) !== 0) return false;
  const rest = modelId.slice(prefix.length);
  return GEMINI_PREFIX_SUFFIX_PATTERN_.test(rest);
}

/** Finds the first allowlist entry whose prefix matches modelId, or null. */
function _findGeminiAllowEntry_(modelId, freeModels) {
  for (let i = 0; i < freeModels.length; i++) {
    if (_geminiPrefixMatches_(modelId, freeModels[i].prefix)) return freeModels[i];
  }
  return null;
}

const GEMINI_MODELS_CACHE_KEY_ = 'gemini_models_list_v7';

/**
 * Fetches the list of Gemini models that support generateContent AND are
 * on the free-tier allowlist above, for use in the model-picker keyboard.
 * Cached in the script cache (default 6h, override with
 * CONFIG.GEMINI_MODEL_CACHE_TTL_SECONDS) so pressing "Gemini Analysis"
 * repeatedly doesn't hit the ListModels endpoint every time — use the
 * picker's Refresh button (clearGeminiModelsCache_) to force a re-fetch.
 *
 * @returns {Array<{name: string, displayName: string, modality: string, category: string}>}
 *   name is the bare model id (no "models/" prefix), ready to pass to
 *   callGemini_/callGeminiAudio_/callGeminiImage_. modality is 'text',
 *   'audio', or 'image'. category is one of GEMINI_MODEL_CATEGORY_ORDER_.
 */
function listGeminiModels_() {
  const cache  = CacheService.getScriptCache();
  const cached = cache.get(GEMINI_MODELS_CACHE_KEY_);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* stale/corrupt cache entry — refetch below */ }
  }

  const apiKey = getGeminiApiKey_();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set in Script Properties.');
  }

  const url = 'https://generativelanguage.googleapis.com/v1beta/models?key=' +
    encodeURIComponent(apiKey) + '&pageSize=200';

  const response = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true });
  const code     = response.getResponseCode();
  const bodyText = response.getContentText();

  if (code < 200 || code >= 300) {
    Logger.log('Gemini ListModels error (HTTP ' + code + '): ' + bodyText);
    throw new Error('Failed to fetch Gemini model list (HTTP ' + code + ').');
  }

  let data;
  try { data = JSON.parse(bodyText); }
  catch (e) { throw new Error('Gemini ListModels returned a non-JSON response.'); }

  const freeModels = DEFAULT_FREE_MODELS_.concat(
    (CONFIG && CONFIG.GEMINI_EXTRA_FREE_MODELS) || []
  );

  const seenDisplayNames = {};
  const models = (data.models || [])
    .filter(function (m) {
      return m.supportedGenerationMethods &&
        m.supportedGenerationMethods.indexOf('generateContent') !== -1;
    })
    .map(function (m) {
      const name = (m.name || '').replace(/^models\//, '');
      return { name: name, displayName: m.displayName || name, description: m.description || '' };
    })
    .map(function (m) {
      m.allowEntry = _findGeminiAllowEntry_(m.name, freeModels);
      return m;
    })
    .filter(function (m) { return !!m.allowEntry; }) // free-tier allowlist gate — see comment above
    .filter(function (m) {
      // Google's ListModels often returns several ids (dated snapshots,
      // preview aliases, agent-tool variants) that share the same
      // human-readable name — keep only the first so the picker isn't
      // full of visually-identical duplicates (e.g. "Nano Banana" x3).
      if (seenDisplayNames[m.displayName]) return false;
      seenDisplayNames[m.displayName] = true;
      return true;
    })
    .map(function (m) {
      const modality = m.allowEntry.modality || 'text';
      const category = m.allowEntry.category ||
        (modality === 'text' ? _geminiModelCategory_(m.description) : GEMINI_FALLBACK_CATEGORY_);
      return { name: m.name, displayName: m.displayName, modality: modality, category: category };
    })
    .sort(function (a, b) { return a.displayName.localeCompare(b.displayName); });

  if (!models.length) {
    throw new Error('Gemini returned no free-tier models for this API key.');
  }

  const ttl = (CONFIG && CONFIG.GEMINI_MODEL_CACHE_TTL_SECONDS) || 21600;
  try { cache.put(GEMINI_MODELS_CACHE_KEY_, JSON.stringify(models), Math.min(ttl, 21600)); }
  catch (e) { /* caching is best-effort; a failure here must not break the flow */ }

  return models;
}

/**
 * Clears the cached model list so the next listGeminiModels_() call hits
 * the ListModels API again instead of serving a stale cached list. Wired
 * to the Refresh button in the model picker (Navigation.js) — free-tier
 * availability changes over time (see the gemini-2.5-flash retirement
 * that caused the original HTTP 404 in this project) and the cache would
 * otherwise hide a change like that for up to 6 hours.
 */
function clearGeminiModelsCache_() {
  CacheService.getScriptCache().remove(GEMINI_MODELS_CACHE_KEY_);
}

// Google has no public "is model X overloaded right now" endpoint (checked
// 2026-08-24 — not in ListModels, not in the REST API, and the AI Studio
// status page is an authenticated client-rendered app with no public API).
// So this isn't a prediction — it's a memory: whenever THIS bot gets a 503
// "high demand" response for a model, that model is flagged for a few
// minutes so the picker can warn about it. It says nothing about models
// this bot hasn't tried recently.
const GEMINI_OVERLOAD_CACHE_PREFIX_ = 'gemini_overload_';
const GEMINI_OVERLOAD_TTL_SECONDS_  = 300; // 5 minutes

function _markGeminiModelOverloaded_(model) {
  try { CacheService.getScriptCache().put(GEMINI_OVERLOAD_CACHE_PREFIX_ + model, '1', GEMINI_OVERLOAD_TTL_SECONDS_); }
  catch (e) { /* best-effort, never let this break the real error handling */ }
}

/**
 * True if this model returned an HTTP 503 within the last
 * GEMINI_OVERLOAD_TTL_SECONDS_. Used by the model picker (Navigation.js)
 * to add a warning to the button label — see comment above for caveats.
 * @param {string} model
 * @returns {boolean}
 */
function isGeminiModelOverloaded_(model) {
  try { return !!CacheService.getScriptCache().get(GEMINI_OVERLOAD_CACHE_PREFIX_ + model); }
  catch (e) { return false; }
}

/**
 * Calls Gemini's generateContent endpoint for plain text output.
 *
 * @param {string} prompt
 * @param {string} [modelOverride]  bare model id (no "models/" prefix),
 *   e.g. "gemini-3.6-flash". Falls back to CONFIG.GEMINI_MODEL, then a
 *   hardcoded default, only if not provided — normal flow always passes
 *   the model the user picked from listGeminiModels_().
 * @returns {string}
 */
function callGemini_(prompt, modelOverride) {
  const model  = modelOverride || (CONFIG && CONFIG.GEMINI_MODEL) || 'gemini-3.6-flash';
  const apiKey = getGeminiApiKey_();

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set in Script Properties.');
  }

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(apiKey);

  const payload = {
    contents: [{ parts: [{ text: prompt }] }]
  };

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code     = response.getResponseCode();
  const bodyText = response.getContentText();

  if (code < 200 || code >= 300) {
    // Surface Google's real error message instead of a bare status code.
    let reason = bodyText;
    try {
      const errJson = JSON.parse(bodyText);
      if (errJson && errJson.error && errJson.error.message) {
        reason = errJson.error.message;
      }
    } catch (parseErr) {
      // bodyText wasn't JSON; fall back to raw text below.
    }
    if (code === 503) _markGeminiModelOverloaded_(model);
    Logger.log('Gemini API error (HTTP ' + code + ') for model "' + model + '": ' + bodyText);
    throw new Error('Gemini request failed (HTTP ' + code + '): ' + reason);
  }

  let data;
  try {
    data = JSON.parse(bodyText);
  } catch (parseErr) {
    throw new Error('Gemini returned a non-JSON response: ' + bodyText);
  }

  const candidate = data.candidates && data.candidates[0];
  if (!candidate) {
    throw new Error('Gemini returned no candidates. Raw response: ' + bodyText);
  }
  if (candidate.finishReason === 'SAFETY' || candidate.finishReason === 'RECITATION') {
    throw new Error('Gemini blocked the response (finishReason: ' + candidate.finishReason + ').');
  }

  const parts = candidate.content && candidate.content.parts;
  const text  = (parts || []).map(function (p) { return p.text || ''; }).join('').trim();

  if (!text) {
    throw new Error('Gemini returned an empty response. Raw response: ' + bodyText);
  }

  return text;
}

/**
 * Converts raw 16-bit PCM audio (as returned by Gemini TTS — mime type
 * "audio/L16;codec=pcm;rate=...") into a playable WAV file. Apps Script
 * has no native audio support, so the 44-byte RIFF/WAVE header is built
 * by hand and prepended to the PCM bytes.
 *
 * @param {string} base64Pcm
 * @param {number} sampleRate
 * @param {number} numChannels
 * @param {number} bitsPerSample
 * @returns {GoogleAppsScript.Base.Blob}
 */
function _pcmToWavBlob_(base64Pcm, sampleRate, numChannels, bitsPerSample) {
  const pcmBytes   = Utilities.base64Decode(base64Pcm);
  const dataSize   = pcmBytes.length;
  const blockAlign = numChannels * (bitsPerSample / 8);
  const byteRate   = sampleRate * blockAlign;
  const header     = [];

  function writeString(str)   { for (let i = 0; i < str.length; i++) header.push(str.charCodeAt(i)); }
  function writeUint32LE(val) { header.push(val & 0xFF, (val >> 8) & 0xFF, (val >> 16) & 0xFF, (val >> 24) & 0xFF); }
  function writeUint16LE(val) { header.push(val & 0xFF, (val >> 8) & 0xFF); }

  writeString('RIFF');
  writeUint32LE(36 + dataSize);
  writeString('WAVE');
  writeString('fmt ');
  writeUint32LE(16);          // PCM fmt chunk size
  writeUint16LE(1);           // audio format = PCM
  writeUint16LE(numChannels);
  writeUint32LE(sampleRate);
  writeUint32LE(byteRate);
  writeUint16LE(blockAlign);
  writeUint16LE(bitsPerSample);
  writeString('data');
  writeUint32LE(dataSize);

  // GAS byte arrays are signed (-128..127); normalize our unsigned 0..255
  // header bytes before concatenating with the (already signed) PCM bytes.
  const headerSigned = header.map(function (b) { return b > 127 ? b - 256 : b; });
  const allBytes = headerSigned.concat(Array.prototype.slice.call(pcmBytes));
  return Utilities.newBlob(allBytes, 'audio/wav', 'gemini-narration.wav');
}

/**
 * Calls Gemini's generateContent endpoint requesting spoken-audio output
 * (text-to-speech) instead of text. Only usable with TTS-capable models
 * (currently just gemini-2.5-flash-preview-tts on the free allowlist).
 * The raw PCM Gemini returns is wrapped into a WAV blob before returning,
 * since Telegram can't play headerless PCM directly.
 *
 * @param {string} prompt  text to narrate
 * @param {string} model   bare TTS-capable model id
 * @returns {GoogleAppsScript.Base.Blob}  WAV audio, ready for sendAudio
 */
function callGeminiAudio_(prompt, model) {
  const apiKey = getGeminiApiKey_();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set in Script Properties.');
  }

  // See https://ai.google.dev/gemini-api/docs/speech-generation for the
  // full list of prebuilt voice names; override the default via
  // CONFIG.GEMINI_TTS_VOICE in Config.js.
  const voiceName = (CONFIG && CONFIG.GEMINI_TTS_VOICE) || 'Kore';
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(apiKey);

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceName } } }
    }
  };

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code     = response.getResponseCode();
  const bodyText = response.getContentText();

  if (code < 200 || code >= 300) {
    let reason = bodyText;
    try {
      const errJson = JSON.parse(bodyText);
      if (errJson && errJson.error && errJson.error.message) reason = errJson.error.message;
    } catch (parseErr) { /* not JSON, fall back to raw text */ }
    if (code === 503) _markGeminiModelOverloaded_(model);
    Logger.log('Gemini audio error (HTTP ' + code + ') for model "' + model + '": ' + bodyText);
    throw new Error('Gemini audio request failed (HTTP ' + code + '): ' + reason);
  }

  let data;
  try { data = JSON.parse(bodyText); }
  catch (parseErr) { throw new Error('Gemini returned a non-JSON response: ' + bodyText); }

  const candidate  = data.candidates && data.candidates[0];
  const part       = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0];
  const inlineData = part && part.inlineData;

  if (!inlineData || !inlineData.data) {
    throw new Error('Gemini did not return audio data. Raw response: ' + bodyText);
  }

  const rateMatch  = /rate=(\d+)/.exec(inlineData.mimeType || '');
  const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;

  return _pcmToWavBlob_(inlineData.data, sampleRate, 1, 16);
}

/**
 * Calls Gemini's generateContent endpoint requesting image output.
 * Not currently reachable from the model picker — no free image-gen
 * model exists yet (see DEFAULT_FREE_MODELS_ comment above) — but fully
 * implemented so enabling it later is a one-line allowlist addition, no
 * code changes.
 *
 * @param {string} prompt
 * @param {string} model  bare image-generation-capable model id
 * @returns {{blob: GoogleAppsScript.Base.Blob, caption: string}}
 */
function callGeminiImage_(prompt, model) {
  const apiKey = getGeminiApiKey_();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set in Script Properties.');
  }

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(apiKey);

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
  };

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code     = response.getResponseCode();
  const bodyText = response.getContentText();

  if (code < 200 || code >= 300) {
    let reason = bodyText;
    try {
      const errJson = JSON.parse(bodyText);
      if (errJson && errJson.error && errJson.error.message) reason = errJson.error.message;
    } catch (parseErr) { /* not JSON, fall back to raw text */ }
    if (code === 503) _markGeminiModelOverloaded_(model);
    Logger.log('Gemini image error (HTTP ' + code + ') for model "' + model + '": ' + bodyText);
    throw new Error('Gemini image request failed (HTTP ' + code + '): ' + reason);
  }

  let data;
  try { data = JSON.parse(bodyText); }
  catch (parseErr) { throw new Error('Gemini returned a non-JSON response: ' + bodyText); }

  const candidate = data.candidates && data.candidates[0];
  const parts     = (candidate && candidate.content && candidate.content.parts) || [];

  let imagePart = null;
  const textChunks = [];
  parts.forEach(function (p) {
    if (!imagePart && p.inlineData && p.inlineData.data) imagePart = p.inlineData;
    else if (p.text) textChunks.push(p.text);
  });

  if (!imagePart) {
    throw new Error('Gemini did not return an image. Raw response: ' + bodyText);
  }

  const mimeType = imagePart.mimeType || 'image/png';
  const ext = mimeType.indexOf('png') !== -1 ? 'png' : (mimeType.indexOf('jpeg') !== -1 ? 'jpg' : 'img');
  const bytes = Utilities.base64Decode(imagePart.data);

  return {
    blob: Utilities.newBlob(bytes, mimeType, 'gemini-image.' + ext),
    caption: textChunks.join('\n').trim()
  };
}
