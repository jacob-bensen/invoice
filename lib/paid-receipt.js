'use strict';

/*
 * Paid-receipt orchestrator (Milestone 4 — first sent → first paid).
 *
 * The freelancer-facing "cha-ching" path is already covered by
 * sendPaidNotificationEmail (Stripe webhook only) and the first-paid
 * celebration banner + referral email. This module closes the
 * CLIENT-facing half: when an invoice flips to paid (via manual mark-paid
 * or via the Stripe Payment Link webhook), email the client a
 * confirmation receipt so the close-the-loop moment isn't silent.
 *
 * Design:
 *   - Idempotent: db.markClientPaidReceiptSent stamps once per invoice
 *     using an `IS NULL` guard. A second flip (e.g. unpaid→paid→
 *     unpaid→paid via Stripe webhook retry) never re-sends.
 *   - Stamp THEN send: we stamp first to prevent double-emails under a
 *     race. If the email send subsequently fails (Resend outage, invalid
 *     recipient), we leave the stamp in place — silent retries on the
 *     same flip would be more annoying to the client than a single
 *     missed receipt is to the freelancer.
 *   - not_configured (RESEND_API_KEY unset) does NOT stamp. The next
 *     mark-paid flip on the next invoice will retry once Master
 *     provisions the key. A given invoice only fires its mark-paid
 *     event once, so this isn't a per-invoice retry loop — it's a
 *     "Resend wasn't configured at the time" graceful degrade.
 *   - Fire-and-forget at the call site. Errors are caught and logged.
 *     A Resend rejection must never block the freelancer's redirect or
 *     the Stripe webhook's 200-OK.
 *
 * Skip conditions (no stamp, no send):
 *   - invoice.client_email is missing or blank.
 *   - invoice.is_seed (defence-in-depth — seed sample is never a real
 *     paid invoice).
 *   - invoice.client_paid_receipt_sent_at is already set.
 *   - owner row is missing (defence-in-depth — should not happen).
 */

const { sendPaidReceiptEmail } = require('./email');

async function triggerPaidReceipt(db, invoice, owner) {
  if (!db || !invoice || !owner) return null;
  if (typeof db.markClientPaidReceiptSent !== 'function') return null;
  // Guard rails — never email seed-sample invoices, never email when we
  // have no recipient.
  if (invoice.is_seed) return null;
  const clientEmail = typeof invoice.client_email === 'string'
    ? invoice.client_email.trim() : '';
  if (!clientEmail) return null;
  // Already sent? Short-circuit before even hitting the DB so a busy
  // status-update path doesn't pay for a redundant UPDATE.
  if (invoice.client_paid_receipt_sent_at) return null;

  let stamped;
  try {
    stamped = await db.markClientPaidReceiptSent(invoice.id);
  } catch (err) {
    console.error('Paid-receipt stamp failed:', err && err.message);
    return null;
  }
  if (!stamped) return null; // Concurrent stamp won the race.

  let send;
  try {
    send = await sendPaidReceiptEmail({ ...invoice, client_email: clientEmail }, owner);
  } catch (err) {
    console.error('Paid-receipt send threw:', err && err.message);
    return { stamped, send: { ok: false, reason: 'error', error: err && err.message } };
  }
  if (!send.ok && send.reason === 'not_configured') {
    // Resend isn't provisioned yet — unstamp so a future tick can retry
    // on the same invoice if the owner re-flips it.
    try {
      await db.pool.query(
        'UPDATE invoices SET client_paid_receipt_sent_at = NULL WHERE id = $1',
        [invoice.id]
      );
    } catch (err) {
      console.error('Paid-receipt unstamp on not_configured failed:', err && err.message);
    }
  } else if (!send.ok) {
    console.warn(`Paid receipt to ${clientEmail} failed:`, send.reason || send.error);
  }
  return { stamped, send };
}

module.exports = {
  triggerPaidReceipt
};
