/**
 * worker.js — Cloudflare Worker relay for Telegram → Apps Script
 *
 * WHY THIS EXISTS
 * ---------------
 * Apps Script /exec URLs respond with a 302 redirect before returning the
 * real response. Telegram's webhook delivery does NOT follow redirects — it
 * treats a 302 as a failed delivery and retries, causing duplicate updates.
 * This Worker sits in front of Apps Script, follows the redirect, and returns
 * a clean 200 to Telegram.
 *
 * OPTIONAL: SECRET TOKEN VALIDATION
 * ----------------------------------
 * Telegram can send a custom header X-Telegram-Bot-Api-Secret-Token with
 * every webhook request, letting you reject requests that don't come from
 * Telegram. To enable this:
 *
 *   1. Pick a strong random string for WEBHOOK_SECRET (store it as a
 *      Cloudflare Worker secret via Dashboard → Settings → Variables, or
 *      via `wrangler secret put WEBHOOK_SECRET`).
 *   2. Register the webhook with the secret:
 *        setWebhook('<worker-url>', '<same-secret>')
 *      — or call the Telegram API directly:
 *        https://api.telegram.org/bot<TOKEN>/setWebhook
 *          ?url=<worker-url>&secret_token=<same-secret>
 *   3. Set ENABLE_SECRET_CHECK = true below.
 *
 * DEPLOYMENT (no wrangler CLI needed)
 * ------------------------------------
 *   1. dash.cloudflare.com → Workers & Pages → Create application
 *   2. Deploy the basic JS template, then click "Edit code"
 *   3. Replace the placeholder APPS_SCRIPT_URL below with your real /exec URL
 *   4. (Optional) Add WEBHOOK_SECRET as a Worker secret and set
 *      ENABLE_SECRET_CHECK = true
 *   5. Save and Deploy
 *   6. Copy the resulting *.workers.dev URL and call setWebhook() with it
 *
 * This file is committed as a reference — Cloudflare does not auto-deploy
 * from the repository. Paste updated contents into the dashboard editor
 * whenever you make changes here.
 */

// ---------------------------------------------------------------------------
// Configuration — edit these two lines
// ---------------------------------------------------------------------------

// TODO: replace with your real Apps Script /exec deployment URL
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/PASTE_YOUR_DEPLOYMENT_ID_HERE/exec';

// Set to true once you have configured the WEBHOOK_SECRET Worker secret.
const ENABLE_SECRET_CHECK = false;

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    // Only accept POST requests (Telegram sends updates as POST).
    if (request.method !== 'POST') {
      return new Response('ok', { status: 200 });
    }

    // Optional: reject requests that lack the expected secret token header.
    if (ENABLE_SECRET_CHECK) {
      const incoming = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
      const expected = env.WEBHOOK_SECRET || '';
      if (!expected) {
        console.error('WEBHOOK_SECRET is not configured but ENABLE_SECRET_CHECK is true.');
        return new Response('Server misconfiguration', { status: 500 });
      }
      if (incoming !== expected) {
        return new Response('Forbidden', { status: 403 });
      }
    }

    const body = await request.text();

    // Forward to Apps Script, following the 302 redirect that /exec always
    // issues before returning the actual response.
    const resp = await fetch(APPS_SCRIPT_URL, {
      method:   'POST',
      headers:  { 'Content-Type': 'application/json' },
      body:     body,
      redirect: 'follow',
    });

    const text = await resp.text();
    // Always return 200 to Telegram — any non-2xx would trigger retries.
    return new Response(text, { status: 200 });
  },
};
