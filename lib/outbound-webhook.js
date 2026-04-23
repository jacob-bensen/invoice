'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const DEFAULT_TIMEOUT_MS = 5000;

function isValidWebhookUrl(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return false;
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch (_) {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

function firePaidWebhook(webhookUrl, payload, opts) {
  return new Promise(resolve => {
    if (!isValidWebhookUrl(webhookUrl)) {
      resolve({ ok: false, reason: 'invalid_url' });
      return;
    }

    let parsed;
    try {
      parsed = new URL(webhookUrl);
    } catch (_) {
      resolve({ ok: false, reason: 'invalid_url' });
      return;
    }

    const transport = parsed.protocol === 'https:' ? https : http;
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const httpClient = (opts && opts.httpClient) || transport;
    const timeoutMs = (opts && opts.timeoutMs) || DEFAULT_TIMEOUT_MS;

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = httpClient.request({
      method: 'POST',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        'User-Agent': 'QuickInvoice-Webhook/1.0'
      },
      timeout: timeoutMs
    }, res => {
      res.on('data', () => {});
      res.on('end', () => finish({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }));
    });

    req.on('timeout', () => {
      req.destroy();
      finish({ ok: false, reason: 'timeout' });
    });
    req.on('error', err => {
      finish({ ok: false, reason: 'error', error: err && err.message });
    });

    req.write(body);
    req.end();
  });
}

function buildPaidPayload(invoice) {
  return {
    event: 'invoice.paid',
    invoice_id: invoice.id,
    invoice_number: invoice.invoice_number,
    amount: Number(invoice.total),
    currency: (invoice.currency || 'usd').toLowerCase(),
    client_name: invoice.client_name,
    client_email: invoice.client_email || null,
    paid_at: new Date().toISOString()
  };
}

module.exports = { firePaidWebhook, buildPaidPayload, isValidWebhookUrl };
