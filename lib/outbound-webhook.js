'use strict';

const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const { URL } = require('url');

const DEFAULT_TIMEOUT_MS = 5000;

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
  '169.254.169.254'
]);

function ipv4ToLong(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let long = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    long = (long * 256) + n;
  }
  return long;
}

function isPrivateIPv4(ip) {
  const long = ipv4ToLong(ip);
  if (long === null) return false;
  // 0.0.0.0/8 — "this network"; often routable to localhost
  if ((long & 0xff000000) >>> 0 === 0x00000000) return true;
  // 10.0.0.0/8
  if ((long & 0xff000000) >>> 0 === 0x0a000000) return true;
  // 127.0.0.0/8 — loopback
  if ((long & 0xff000000) >>> 0 === 0x7f000000) return true;
  // 169.254.0.0/16 — link-local (AWS/GCP metadata sits here)
  if ((long & 0xffff0000) >>> 0 === 0xa9fe0000) return true;
  // 172.16.0.0/12
  if ((long & 0xfff00000) >>> 0 === 0xac100000) return true;
  // 192.168.0.0/16
  if ((long & 0xffff0000) >>> 0 === 0xc0a80000) return true;
  return false;
}

function isPrivateIPv6(ip) {
  const s = ip.toLowerCase();
  if (s === '::' || s === '::1') return true;
  // IPv4-mapped (::ffff:a.b.c.d) or IPv4-compatible addresses
  const mapped = s.match(/::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  // fc00::/7 — unique local addresses
  if (/^f[cd][0-9a-f]{0,2}(:|$)/.test(s)) return true;
  // fe80::/10 — link-local
  if (/^fe[89ab][0-9a-f]?(:|$)/.test(s)) return true;
  return false;
}

function isPrivateAddress(address, family) {
  if (family === 4) return isPrivateIPv4(address);
  if (family === 6) return isPrivateIPv6(address);
  return false;
}

let _lookup = function defaultLookup(hostname) {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses || []);
    });
  });
};

function setHostnameResolver(fn) {
  _lookup = fn;
}

async function isValidWebhookUrl(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return false;
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch (_) {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  // URL.hostname strips the brackets from IPv6 literals already.
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) return false;
  if (BLOCKED_HOSTNAMES.has(hostname)) return false;

  if (net.isIPv4(hostname)) return !isPrivateIPv4(hostname);
  if (net.isIPv6(hostname)) return !isPrivateIPv6(hostname);

  let addresses;
  try {
    addresses = await _lookup(hostname);
  } catch (_) {
    return false;
  }
  if (!addresses || addresses.length === 0) return false;
  for (const a of addresses) {
    if (isPrivateAddress(a.address, a.family)) return false;
  }
  return true;
}

function detectWebhookFormat(webhookUrl) {
  if (typeof webhookUrl !== 'string') return 'generic';
  let parsed;
  try {
    parsed = new URL(webhookUrl);
  } catch (_) {
    return 'generic';
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname || '';
  if (host === 'hooks.slack.com') return 'slack';
  if ((host === 'discord.com' || host === 'discordapp.com' || host === 'ptb.discord.com' || host === 'canary.discord.com') &&
      path.startsWith('/api/webhooks/')) {
    return 'discord';
  }
  return 'generic';
}

function formatAmount(amount, currency) {
  const n = Number(amount);
  const safe = Number.isFinite(n) ? n : 0;
  const code = (currency || 'usd').toUpperCase();
  const symbol = code === 'USD' ? '$'
    : code === 'EUR' ? '€'
    : code === 'GBP' ? '£'
    : code === 'CAD' ? 'CA$'
    : code === 'AUD' ? 'A$'
    : code === 'JPY' ? '¥'
    : '';
  const decimals = code === 'JPY' ? 0 : 2;
  return symbol + safe.toFixed(decimals) + (symbol ? '' : ' ' + code);
}

function formatPayloadForWebhook(webhookUrl, payload) {
  const format = detectWebhookFormat(webhookUrl);
  if (format === 'generic') return payload;
  const number = payload && payload.invoice_number ? String(payload.invoice_number) : 'invoice';
  const client = payload && payload.client_name ? String(payload.client_name) : 'a client';
  const amount = formatAmount(payload && payload.amount, payload && payload.currency);
  if (format === 'slack') {
    return { text: `💸 *Invoice ${number}* paid by *${client}* — ${amount}` };
  }
  if (format === 'discord') {
    return { content: `💸 **Invoice ${number}** paid by **${client}** — ${amount}` };
  }
  return payload;
}

async function firePaidWebhook(webhookUrl, payload, opts) {
  if (!(await isValidWebhookUrl(webhookUrl))) {
    return { ok: false, reason: 'invalid_url' };
  }

  let parsed;
  try {
    parsed = new URL(webhookUrl);
  } catch (_) {
    return { ok: false, reason: 'invalid_url' };
  }

  const shaped = formatPayloadForWebhook(webhookUrl, payload);

  return new Promise(resolve => {
    const transport = parsed.protocol === 'https:' ? https : http;
    const body = Buffer.from(JSON.stringify(shaped), 'utf8');
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

module.exports = {
  firePaidWebhook,
  buildPaidPayload,
  isValidWebhookUrl,
  setHostnameResolver,
  detectWebhookFormat,
  formatPayloadForWebhook
};
