'use strict';

/*
 * #46 — Pricing-page exit-intent modal.
 *
 * Two layers of coverage:
 *
 *   1. View-source assertions on the rendered pricing.ejs HTML — confirm the
 *      modal markup exists, the annual checkout form points where it should,
 *      Pro users are excluded, and the STORAGE_KEY constant is the stable
 *      'qi.exitIntent.shown'.
 *
 *   2. In-process behaviour — extract the exitIntentModal() factory out of
 *      the rendered HTML and exercise it inside a vm sandbox with stubbed
 *      sessionStorage, document, and event globals. Covers:
 *        - init() short-circuits when sessionStorage flag is '1' (no handlers)
 *        - init() registers mouseleave + visibilitychange handlers otherwise
 *        - trigger() opens the modal once, persists the flag, and is one-shot
 *        - mouseleave with clientY > 0 (cursor moving sideways) is ignored
 *        - visibilitychange only opens when document.visibilityState === 'hidden'
 *        - setItem throws are swallowed (modal still opens)
 *        - getItem throws on init are swallowed (handlers still register)
 *
 * Run: node tests/exit-intent-modal.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const ejs = require('ejs');
const http = require('http');
const express = require('express');

const VIEWS = path.join(__dirname, '..', 'views');
const PRICING_TPL = path.join(VIEWS, 'pricing.ejs');
const MODAL_PARTIAL = path.join(VIEWS, 'partials', 'exit-intent-modal.ejs');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function renderPricing(locals) {
  return ejs.renderFile(PRICING_TPL, {
    title: 'Upgrade to Pro',
    flash: null,
    csrfToken: 'TEST_CSRF',
    competitorPricing: null,
    user: null,
    trialCountdown: null,
    ...locals
  }, { views: [VIEWS], filename: PRICING_TPL });
}

function request(app, method, url) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const req = http.request({ hostname: '127.0.0.1', port, path: url, method }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => server.close(() => resolve({ status: res.statusCode, body: data })));
      });
      req.on('error', (err) => { server.close(); reject(err); });
      req.end();
    });
  });
}

// ---- Layer 1: structural assertions on the rendered HTML ----------------

test('view: pricing.ejs renders the exit-intent modal markup (id + dialog role)', async () => {
  const html = await renderPricing({ user: null });
  assert.match(html, /id="exit-intent-modal"/);
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /aria-labelledby="exit-intent-modal-title"/);
});

test('view: annual checkout form action + billing_cycle + CSRF token forwarded', async () => {
  const html = await renderPricing({ user: null, csrfToken: 'CSRF_FROM_REQ' });
  // Locate the form inside the exit-intent modal (search after the modal id).
  const modalStart = html.indexOf('id="exit-intent-modal"');
  assert.ok(modalStart !== -1, 'exit-intent modal must be present in rendered HTML');
  const modalHtml = html.slice(modalStart);
  assert.match(modalHtml, /<form\s+action="\/billing\/create-checkout"\s+method="POST"/);
  assert.match(modalHtml, /name="billing_cycle"\s+value="annual"/);
  assert.match(modalHtml, /name="_csrf"\s+value="CSRF_FROM_REQ"/);
});

test('view: Pro users do NOT see the exit-intent modal (markup absent)', async () => {
  const html = await renderPricing({ user: { plan: 'pro' } });
  assert.doesNotMatch(html, /id="exit-intent-modal"/,
    'Pro users are already converted — must NOT see a recovery modal');
  assert.doesNotMatch(html, /exitIntentModal\(\)/,
    'factory definition must not ship to Pro users either');
});

test('view: free / trial users see the modal markup', async () => {
  for (const plan of ['free', 'trial', undefined]) {
    const html = await renderPricing({ user: plan ? { plan } : { plan: 'free' } });
    assert.match(html, /id="exit-intent-modal"/, `plan="${plan}" must see the modal`);
  }
});

test('view: STORAGE_KEY constant is "qi.exitIntent.shown" (regression guard against silent rename)', async () => {
  const html = await renderPricing({ user: null });
  assert.match(html, /STORAGE_KEY\s*=\s*'qi\.exitIntent\.shown'/);
});

test('view: anonymous (no user) renders the modal', async () => {
  const html = await renderPricing({ user: null });
  assert.match(html, /id="exit-intent-modal"/);
  assert.match(html, /Wait — get 3 months free\./);
});

// ---- HTTP integration: pricing page renders the modal end-to-end ----------

test('http: /billing/upgrade response body contains the exit-intent modal id', async () => {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', VIEWS);
  app.use((req, res, next) => {
    res.locals.user = { plan: 'free' };
    res.locals.trialCountdown = null;
    next();
  });
  app.get('/billing/upgrade', (req, res) => {
    res.render('pricing', {
      title: 'Upgrade to Pro',
      flash: null,
      csrfToken: 'CSRF',
      competitorPricing: null,
      ogTitle: 't',
      ogDescription: 'd',
      ogPath: '/billing/upgrade'
    });
  });
  const res = await request(app, 'GET', '/billing/upgrade');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.includes('id="exit-intent-modal"'),
    'rendered pricing page must include exit-intent-modal markup');
  assert.ok(res.body.includes('billing_cycle'),
    'form must carry the billing_cycle hidden input');
});

// ---- Layer 2: vm-sandboxed factory behaviour -----------------------------

const renderedHtmlForFactory = (() => {
  return ejs.renderFileSync
    ? ejs.renderFileSync(PRICING_TPL, {
        title: 'Upgrade to Pro',
        flash: null,
        csrfToken: 'CSRF',
        competitorPricing: null,
        user: null,
        trialCountdown: null
      }, { views: [VIEWS], filename: PRICING_TPL })
    : null;
})();

function getRenderedHtml() {
  // ejs.renderFileSync is unavailable on older ejs; fall back to reading the
  // partial source directly. The factory definition lives in the partial.
  if (renderedHtmlForFactory) return renderedHtmlForFactory;
  return fs.readFileSync(MODAL_PARTIAL, 'utf8');
}

function extractFactorySource(html) {
  const start = html.indexOf('function exitIntentModal()');
  assert.ok(start !== -1, 'exitIntentModal factory must exist in the rendered HTML');
  let depth = 0;
  let i = start;
  let foundOpen = false;
  while (i < html.length) {
    const ch = html[i];
    if (ch === '{') { depth++; foundOpen = true; }
    else if (ch === '}') { depth--; if (foundOpen && depth === 0) { i++; break; } }
    i++;
  }
  return html.slice(start, i);
}

function makeSandbox({ storage = {}, throwOnGet = false, throwOnSet = false, noSessionStorage = false, visibilityState = 'visible' }) {
  const html = getRenderedHtml();
  const factorySrc = extractFactorySource(html);
  const handlers = { mouseleave: [], visibilitychange: [] };
  const sandbox = {};
  if (!noSessionStorage) {
    sandbox.sessionStorage = {
      getItem(k) {
        if (throwOnGet) throw new Error('SecurityError: getItem');
        return Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null;
      },
      setItem(k, v) {
        if (throwOnSet) throw new Error('QuotaExceededError');
        storage[k] = String(v);
      }
    };
  }
  sandbox.document = {
    visibilityState,
    addEventListener(name, fn) {
      if (!handlers[name]) handlers[name] = [];
      handlers[name].push(fn);
    }
  };
  sandbox.console = console;
  vm.createContext(sandbox);
  vm.runInContext(factorySrc + '\n; this.__factory = exitIntentModal;', sandbox);
  return { factory: sandbox.__factory, storage, handlers, sandbox };
}

test('factory: init() short-circuits when sessionStorage flag is "1" (no handlers registered)', () => {
  const { factory, handlers } = makeSandbox({ storage: { 'qi.exitIntent.shown': '1' } });
  const m = factory();
  m.init();
  assert.strictEqual(m.shown, true, 'shown must be set so subsequent triggers no-op');
  assert.strictEqual(m.open, false, 'modal must stay closed when flag is set');
  assert.strictEqual(handlers.mouseleave.length, 0, 'no mouseleave handler when already shown');
  assert.strictEqual(handlers.visibilitychange.length, 0, 'no visibilitychange handler when already shown');
});

test('factory: init() registers mouseleave + visibilitychange handlers when flag is absent', () => {
  const { factory, handlers } = makeSandbox({ storage: {} });
  const m = factory();
  m.init();
  assert.strictEqual(m.shown, false);
  assert.strictEqual(handlers.mouseleave.length, 1, 'one mouseleave handler attached');
  assert.strictEqual(handlers.visibilitychange.length, 1, 'one visibilitychange handler attached');
});

test('factory: trigger() opens the modal, persists the flag, and is one-shot', () => {
  const { factory, storage } = makeSandbox({ storage: {} });
  const m = factory();
  m.init();
  m.trigger('mouseleave');
  assert.strictEqual(m.open, true, 'modal must open after first trigger');
  assert.strictEqual(m.shown, true);
  assert.strictEqual(storage['qi.exitIntent.shown'], '1', 'sessionStorage flag must be persisted');

  // Second trigger after close() should NOT re-open.
  m.close();
  assert.strictEqual(m.open, false);
  m.trigger('visibility');
  assert.strictEqual(m.open, false, 'one-shot: second trigger must not re-open');
});

test('factory: mouseleave below the top edge (clientY > 0) is ignored', () => {
  const { factory, handlers } = makeSandbox({ storage: {} });
  const m = factory();
  m.init();
  // Cursor moves sideways — clientY positive — must NOT trigger.
  handlers.mouseleave[0]({ clientY: 250 });
  assert.strictEqual(m.open, false, 'mouseleave with clientY > 0 must not trigger');
  // Cursor exits at the top (clientY <= 0) — must trigger.
  handlers.mouseleave[0]({ clientY: 0 });
  assert.strictEqual(m.open, true, 'mouseleave with clientY <= 0 must trigger');
});

test('factory: visibilitychange only triggers when document.visibilityState === "hidden"', () => {
  const visibleCtx = makeSandbox({ storage: {}, visibilityState: 'visible' });
  const m1 = visibleCtx.factory();
  m1.init();
  visibleCtx.handlers.visibilitychange[0]();
  assert.strictEqual(m1.open, false, 'visibility=visible must NOT trigger');

  const hiddenCtx = makeSandbox({ storage: {}, visibilityState: 'hidden' });
  const m2 = hiddenCtx.factory();
  m2.init();
  hiddenCtx.handlers.visibilitychange[0]();
  assert.strictEqual(m2.open, true, 'visibility=hidden must trigger');
});

test('factory: setItem QuotaExceeded is swallowed — modal still opens', () => {
  const { factory } = makeSandbox({ storage: {}, throwOnSet: true });
  const m = factory();
  m.init();
  // Must not throw.
  m.trigger('mouseleave');
  assert.strictEqual(m.open, true, 'storage throw must not block the open state');
  assert.strictEqual(m.shown, true);
});

test('factory: getItem throw on init is swallowed — handlers still register', () => {
  const { factory, handlers } = makeSandbox({ storage: {}, throwOnGet: true });
  const m = factory();
  // Must not throw.
  m.init();
  assert.strictEqual(m.shown, false, 'read failure must be treated as "no saved flag"');
  assert.strictEqual(handlers.mouseleave.length, 1, 'handlers must still register after read failure');
  assert.strictEqual(handlers.visibilitychange.length, 1);
});

test('factory: sessionStorage entirely absent is handled cleanly (no throw)', () => {
  const { factory, handlers } = makeSandbox({ noSessionStorage: true });
  const m = factory();
  // Must not throw on init or trigger when sessionStorage is undefined.
  m.init();
  m.trigger('mouseleave');
  assert.strictEqual(m.open, true);
  assert.strictEqual(handlers.mouseleave.length, 1, 'handlers register even with no sessionStorage');
});

// ---- Runner -------------------------------------------------------------

async function run() {
  let passed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${t.name}`);
      console.error(err);
      process.exitCode = 1;
    }
  }
  console.log(`\nexit-intent-modal.test.js: ${passed}/${tests.length} passed`);
}

run();
