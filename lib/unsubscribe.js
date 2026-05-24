'use strict';

/*
 * Self-serve lifecycle-email unsubscribe (CAN-SPAM compliance + RFC 8058
 * one-click `List-Unsubscribe` support).
 *
 * Every lifecycle/re-engagement/activation email the platform sends to its
 * users carries:
 *   - a visible "Unsubscribe" footer link → `GET /unsubscribe/<token>`
 *     which renders a confirm-then-POST page (defence against email
 *     scanners + accidental drive-by clicks).
 *   - a `List-Unsubscribe` header pair pointing at
 *     `POST /unsubscribe/<token>` so RFC-8058-aware mail clients (Gmail,
 *     Apple Mail, Outlook) can offer their native one-click "Unsubscribe"
 *     button. The POST is CSRF-exempt because the token itself is the
 *     auth and mail clients don't carry session cookies.
 *
 * On opt-out we stamp `users.lifecycle_emails_opted_out_at = NOW()` and
 * every lifecycle cron's cohort SELECT gates with
 * `AND lifecycle_emails_opted_out_at IS NULL`. The user permanently drops
 * off the marketing-email cohort, can resubscribe via `POST
 * /unsubscribe/<token>/resubscribe`, and transactional emails (invoices
 * to clients, paid receipts, magic-login, password-reset, real-time
 * client-action notifications, first-sent-celebration) are never gated.
 *
 * The token itself is 16 hex chars (8 random bytes), UNIQUE for O(1)
 * lookup, lazy-generated on first need. Stable per user — never rotated
 * — because the value of an unsubscribe link rises with age (an email
 * from 6 months ago must still let the user opt out today).
 */

const crypto = require('crypto');

const TOKEN_PATTERN = /^[a-f0-9]{8,32}$/i;

function isValidToken(raw) {
  return typeof raw === 'string' && TOKEN_PATTERN.test(raw);
}

function buildUnsubscribeUrl(token) {
  if (!token) return '';
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  const safe = encodeURIComponent(token);
  return base ? `${base}/unsubscribe/${safe}` : `/unsubscribe/${safe}`;
}

/*
 * RFC 2369 + RFC 8058 headers for one-click unsubscribe. The mailto:
 * fallback satisfies RFC 2369 for legacy clients; the https POST link +
 * `List-Unsubscribe-Post: List-Unsubscribe=One-Click` enables the
 * native "Unsubscribe" button in Gmail/Apple Mail/Outlook. Returns an
 * empty object when no URL — caller spreads it into the email payload
 * unconditionally so omitting the URL never breaks the send.
 */
function unsubscribeHeaders(unsubscribeUrl) {
  if (!unsubscribeUrl || typeof unsubscribeUrl !== 'string') return {};
  return {
    'List-Unsubscribe': `<${unsubscribeUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
  };
}

/*
 * Append a small "Don't want these? Unsubscribe" footer to both the html
 * and text bodies of a lifecycle email. The HTML footer slots in BEFORE
 * the closing </body> if present (so the email's outer chrome wraps it
 * cleanly), otherwise appended. The text footer is two blank lines + a
 * single-line opt-out URL. Returns a fresh { html, text } pair — does
 * not mutate the inputs.
 */
function appendUnsubscribeFooter(html, text, unsubscribeUrl) {
  if (!unsubscribeUrl || typeof unsubscribeUrl !== 'string') {
    return { html: html || '', text: text || '' };
  }
  const safeUrl = unsubscribeUrl.replace(/"/g, '&quot;');
  const htmlBlock =
    `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#999;font-size:11px;text-align:center;padding:16px 8px 4px 8px;">` +
    `You're receiving this lifecycle email from DecentInvoice. ` +
    `<a href="${safeUrl}" style="color:#999;text-decoration:underline;">Unsubscribe</a>` +
    `</div>`;
  let nextHtml = html || '';
  if (nextHtml) {
    const idx = nextHtml.toLowerCase().lastIndexOf('</body>');
    if (idx >= 0) {
      nextHtml = nextHtml.slice(0, idx) + htmlBlock + nextHtml.slice(idx);
    } else {
      nextHtml = nextHtml + htmlBlock;
    }
  } else {
    nextHtml = htmlBlock;
  }
  const textFooter = `\n\n---\nDon't want these? Unsubscribe: ${unsubscribeUrl}`;
  const nextText = (text || '') + textFooter;
  return { html: nextHtml, text: nextText };
}

/*
 * Helper for cron orchestrators: takes a cohort row that may or may not
 * already carry `unsubscribe_token` (whether the column was in the
 * SELECT, and whether the user has one yet). Returns the URL or '' on
 * any failure. Best-effort: a mint hiccup must NEVER drop the email.
 */
async function resolveUnsubscribeUrlForRow(db, row) {
  if (!row || !row.id && !row.user_id) return '';
  const userId = row.id || row.user_id;
  let token = row.unsubscribe_token || '';
  if (!token && db && typeof db.getOrCreateUnsubscribeToken === 'function') {
    try {
      token = await db.getOrCreateUnsubscribeToken(userId);
    } catch (_err) {
      // Mint hiccup must not sacrifice the email send.
      token = '';
    }
  }
  return token ? buildUnsubscribeUrl(token) : '';
}

/*
 * Generate a fresh raw token. Exposed so db.js can call it without
 * importing crypto a second time, and so tests can stub it.
 */
function generateToken() {
  return crypto.randomBytes(8).toString('hex');
}

module.exports = {
  TOKEN_PATTERN,
  isValidToken,
  buildUnsubscribeUrl,
  unsubscribeHeaders,
  appendUnsubscribeFooter,
  resolveUnsubscribeUrlForRow,
  generateToken
};
