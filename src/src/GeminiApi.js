/**
 * GeminiApi.js
 * Thin wrapper around the Gemini generateContent REST API. Mirrors the
 * shape of TelegramApi.js: one low-level call function, callers build the
 * prompt and interpret the result.
 */

/**
 * Sends a single text prompt to Gemini and returns the response text.
 * Throws on transport errors, non-2xx responses, or an empty/blocked
 * response (e.g. safety filtering) so callers can show a clear message
 * instead of silently returning nothing.
 *
 * @param {string} prompt
 * @returns {string}
 */
function callGemini_(prompt) {
  const model = (CONFIG && CONFIG.GEMINI_MODEL) || 'gemini-2.5-flash';
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    model + ':generateContent?key=' + getGeminiApiKey_();

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
    }),
    muteHttpExceptions: true,
  };

  const response = UrlFetchApp.fetch(url, options);
  const code = response.getResponseCode();
  const body = response.getContentText();

  if (code < 200 || code >= 300) {
    console.error('Gemini API error: ' + code + ' ' + body);
    throw new Error('Gemini request failed (HTTP ' + code + ').');
  }

  let data;
  try {
    data = JSON.parse(body);
  } catch (e) {
    throw new Error('Gemini returned an unparseable response.');
  }

  const candidate = data.candidates && data.candidates[0];
  const finishReason = candidate && candidate.finishReason;
  const text = candidate && candidate.content && candidate.content.parts &&
    candidate.content.parts.map(function (p) { return p.text || ''; }).join('');

  if (!text) {
    if (finishReason === 'SAFETY' || finishReason === 'RECITATION') {
      throw new Error('Gemini declined to answer (finishReason: ' + finishReason + ').');
    }
    throw new Error('Gemini returned an empty response.');
  }

  return text;
}
