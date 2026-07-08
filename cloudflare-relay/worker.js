/**
 * worker.js
 *
 * Relay proxy for the Telegram webhook -> Apps Script Web App.
 *
 * WHY THIS EXISTS:
 * Apps Script Web App /exec URLs always respond with a 302 redirect to an
 * internal script.googleusercontent.com URL before returning the real
 * response. Most HTTP clients (browsers, curl) silently follow redirects,
 * but Telegram's webhook delivery does NOT — it treats the 302 as a failed
 * delivery and retries, causing duplicate messages. This worker sits in
 * front of Apps Script, follows the redirect itself, and hands Telegram a
 * clean 200 response.
 *
 * DEPLOYMENT (manual, via Cloudflare Dashboard — no wrangler CLI needed):
 *   1. dash.cloudflare.com -> Workers & Pages -> Create application
 *   2. Pick a basic JS template, deploy it, then "Edit code"
 *   3. Replace the placeholder below with your real Apps Script /exec URL
 *   4. Save and Deploy
 *   5. Copy the resulting workers.dev URL and set it as the Telegram
 *      webhook (see the main README's setWebhook instructions)
 *
 * This file is committed as a backup / reference — Cloudflare doesn't
 * auto-deploy from this repo. If you ever need to recreate the worker,
 * paste this file's contents (with your real URL filled in) into the
 * Cloudflare dashboard editor again.
 */

export default {
  async fetch(request) {
    // TODO: replace with your Apps Script Web App /exec URL
    const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/PASTE_YOUR_DEPLOYMENT_ID_HERE/exec';

    if (request.method !== 'POST') {
      return new Response('ok');
    }

    const body = await request.text();

    const resp = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
      redirect: 'follow',
    });

    const text = await resp.text();
    return new Response(text, { status: 200 });
  },
};
