'use strict';

/*
 * #122 — localStorage persistence for the recent-revenue window toggle.
 *
 * Two layers of coverage, mirroring the structure of recent-revenue-window-toggle.test.js:
 *
 *   1. View-source regex assertions — confirm the new pieces exist in
 *      views/dashboard.ejs (STORAGE_KEY constant, [7, 30, 90] whitelist,
 *      init() lifecycle hook, readSavedWindow + writeSavedWindow helpers,
 *      and the writeSavedWindow call inside select()'s success branch).
 *      Pure regex on the rendered HTML — fast and stable.
 *
 *   2. In-process behaviour — extract the recentRevenueCard() factory from
 *      the EJS source and run it inside a vm sandbox with stubbed
 *      localStorage + fetch globals. This exercises:
 *        - init() restores a saved window via select()
 *        - init() is a no-op when saved === SSR initial (zero fetches)
 *        - init() is a no-op when localStorage holds garbage / out-of-whitelist values
 *        - select() persists to localStorage on success
 *        - select() does NOT persist on fetch failure (network blip)
 *        - writeSavedWindow swallows quota-exceeded throws
 *        - readSavedWindow swallows getItem() throws (private mode read fail)
 *        - localStorage absence (typeof localStorage === 'undefined') returns null cleanly
 *
 * Run: node tests/recent-revenue-window-storage.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const ejs = require('ejs');

const dashboardTplPath = path.join(__dirname, '..', 'views', 'dashboard.ejs');
const dashboardTpl = fs.readFileSync(dashboardTplPath, 'utf8');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---- Layer 1: structural regex assertions on the rendered HTML ----------

function renderDashboard(locals) {
  return ejs.render(dashboardTpl, {
    title: 'Dashboard',
    flash: null,
    days_left_in_trial: 0,
    csrfToken: 'TEST_CSRF',
    invoices: [
      { id: 1, invoice_number: 'INV-2026-0001', client_name: 'Acme', issued_date: '2026-04-01', total: 500, status: 'paid' }
    ],
    user: { plan: 'pro', invoice_count: 5, subscription_status: null },
    onboarding: null,
    invoiceLimitProgress: null,
    recentRevenue: { days: 30, totalPaid: 1234.56, invoiceCount: 4, clientCount: 2 },
    ...locals
  }, {
    views: [path.join(__dirname, '..', 'views')],
    filename: dashboardTplPath
  });
}

test('view: STORAGE_KEY constant is "qi.recentRevenueDays" (regression guard against silent rename)', () => {
  const html = renderDashboard({});
  assert.match(html, /STORAGE_KEY\s*=\s*'qi\.recentRevenueDays'/);
});

test('view: ALLOWED whitelist literal is [7, 30, 90] inside the factory closure', () => {
  const html = renderDashboard({});
  assert.match(html, /ALLOWED\s*=\s*\[7,\s*30,\s*90\]/);
});

test('view: factory exposes an init() lifecycle hook that calls readSavedWindow', () => {
  const html = renderDashboard({});
  assert.match(html, /init\(\)\s*\{[\s\S]*?readSavedWindow\(\)/);
});

test('view: select() persists via writeSavedWindow only AFTER successful fetch (not in catch / finally)', () => {
  const html = renderDashboard({});
  // Locate the select() body and assert writeSavedWindow appears after the
  // try-block populates state but before the catch block. Catch only sets
  // errored = true — never writes localStorage. This regex pins the order.
  const selectBody = html.match(/async select\(window(?:,\s*opts)?\)\s*\{[\s\S]*?finally\s*\{[\s\S]*?\}\s*\}/);
  assert.ok(selectBody, 'select() body must be findable');
  const body = selectBody[0];
  assert.match(body, /writeSavedWindow\(this\.days\)/);
  // Make sure writeSavedWindow does NOT appear inside the catch block.
  const catchBlock = body.match(/catch\s*\(e\)\s*\{[\s\S]*?\}/);
  assert.ok(catchBlock, 'catch block must exist');
  assert.doesNotMatch(catchBlock[0], /writeSavedWindow/, 'writeSavedWindow must NOT fire on fetch failure');
});

test('view: readSavedWindow + writeSavedWindow are wrapped in try/catch (private-mode safe)', () => {
  const html = renderDashboard({});
  // Both helpers must contain a try { ... } catch — regex tolerates whitespace.
  assert.match(html, /function readSavedWindow\(\)\s*\{\s*try\s*\{/);
  assert.match(html, /function writeSavedWindow\(n\)\s*\{\s*try\s*\{/);
});

test('view: typeof localStorage === \'undefined\' guard exists in both helpers', () => {
  const html = renderDashboard({});
  // Each helper short-circuits when localStorage is unavailable. Two matches expected.
  const matches = html.match(/typeof localStorage === 'undefined'/g) || [];
  assert.ok(matches.length >= 2, 'expected localStorage availability guard in both read + write helpers');
});

// ---- Layer 2: in-process behaviour via vm sandbox -----------------------

// Pull the factory definition out of the EJS source and re-emit it as
// standalone JS that we can run inside a sandbox. We capture from
// "function recentRevenueCard(initial)" through the matching closing brace.
function extractFactorySource(tpl) {
  const start = tpl.indexOf('function recentRevenueCard(initial)');
  assert.ok(start !== -1, 'recentRevenueCard factory must exist in dashboard.ejs');
  // Walk forward, balancing braces, to find the closing one.
  let depth = 0;
  let i = start;
  let foundOpen = false;
  while (i < tpl.length) {
    const ch = tpl[i];
    if (ch === '{') { depth++; foundOpen = true; }
    else if (ch === '}') { depth--; if (foundOpen && depth === 0) { i++; break; } }
    i++;
  }
  return tpl.slice(start, i);
}

function makeStubbedFactory({ storage = {}, throwOnGet = false, throwOnSet = false, noLocalStorage = false, fetchImpl }) {
  const factorySource = extractFactorySource(dashboardTpl);
  // Build a sandbox. localStorage is exposed as a global; fetch is exposed
  // as a global. The function definition is executed; we then return the
  // factory itself for the caller to invoke with an `initial` arg.
  const sandbox = {};
  if (!noLocalStorage) {
    sandbox.localStorage = {
      getItem(k) {
        if (throwOnGet) throw new Error('SecurityError: getItem');
        return Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null;
      },
      setItem(k, v) {
        if (throwOnSet) throw new Error('QuotaExceededError');
        storage[k] = String(v);
      },
      removeItem(k) { delete storage[k]; }
    };
  }
  sandbox.fetch = fetchImpl || (() => Promise.reject(new Error('no fetch stub')));
  sandbox.console = console;
  vm.createContext(sandbox);
  vm.runInContext(factorySource + '\n; this.recentRevenueCard = recentRevenueCard;', sandbox);
  return { factory: sandbox.recentRevenueCard, storage };
}

function jsonResponse(card, days) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ days, card })
  });
}

test('factory: init() with no saved value is a no-op (zero fetches, zero state change)', async () => {
  let fetchCalls = 0;
  const { factory } = makeStubbedFactory({
    storage: {},
    fetchImpl: () => { fetchCalls++; return jsonResponse({ days: 7, totalPaid: 0, invoiceCount: 0, clientCount: 0 }, 7); }
  });
  const c = factory({ days: 30, totalPaid: 100, invoiceCount: 1, clientCount: 1 });
  c.init();
  // Init synchronously decides "do nothing". Wait a microtask cycle so any
  // accidental async work would surface.
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(fetchCalls, 0, 'no saved window → no fetch on init');
  assert.strictEqual(c.days, 30, 'days unchanged');
});

test('factory: init() restores a valid saved window (7d) by calling select() which fetches', async () => {
  let fetchUrl = null;
  const { factory } = makeStubbedFactory({
    storage: { 'qi.recentRevenueDays': '7' },
    fetchImpl: (url) => { fetchUrl = url; return jsonResponse({ days: 7, totalPaid: 200, invoiceCount: 2, clientCount: 1 }, 7); }
  });
  const c = factory({ days: 30, totalPaid: 100, invoiceCount: 1, clientCount: 1 });
  await c.init();
  // init returns synchronously (it's not async itself), but it kicks off
  // an async select(). Wait for the select fetch to settle.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  assert.match(fetchUrl || '', /\/invoices\/api\/recent-revenue\?days=7/);
  assert.strictEqual(c.days, 7);
  assert.strictEqual(c.totalPaid, 200);
});

test('factory: init() does nothing when saved === initial.days (zero network calls)', async () => {
  let fetchCalls = 0;
  const { factory } = makeStubbedFactory({
    storage: { 'qi.recentRevenueDays': '30' },
    fetchImpl: () => { fetchCalls++; return jsonResponse({ days: 30, totalPaid: 100, invoiceCount: 1, clientCount: 1 }, 30); }
  });
  const c = factory({ days: 30, totalPaid: 100, invoiceCount: 1, clientCount: 1 });
  c.init();
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(fetchCalls, 0, 'saved === initial → no redundant fetch');
});

test('factory: init() ignores corrupt / out-of-whitelist localStorage values (60, 365, "garbage", "")', async () => {
  for (const garbage of ['60', '365', 'garbage', '', '0', '-1', '99999']) {
    let fetchCalls = 0;
    const { factory } = makeStubbedFactory({
      storage: { 'qi.recentRevenueDays': garbage },
      fetchImpl: () => { fetchCalls++; return jsonResponse(null, 30); }
    });
    const c = factory({ days: 30, totalPaid: 100, invoiceCount: 1, clientCount: 1 });
    c.init();
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(fetchCalls, 0, `garbage value ${JSON.stringify(garbage)} must NOT trigger fetch`);
    assert.strictEqual(c.days, 30, `garbage value ${JSON.stringify(garbage)} must NOT mutate days`);
  }
});

test('factory: select() persists the chosen window to localStorage on success', async () => {
  const { factory, storage } = makeStubbedFactory({
    storage: {},
    fetchImpl: () => jsonResponse({ days: 90, totalPaid: 5000, invoiceCount: 10, clientCount: 3 }, 90)
  });
  const c = factory({ days: 30, totalPaid: 100, invoiceCount: 1, clientCount: 1 });
  await c.select(90);
  assert.strictEqual(storage['qi.recentRevenueDays'], '90', 'localStorage must hold the new window after success');
  assert.strictEqual(c.days, 90);
});

test('factory: select() does NOT persist on fetch failure (transient network blip safe)', async () => {
  const { factory, storage } = makeStubbedFactory({
    storage: { 'qi.recentRevenueDays': '7' },
    fetchImpl: () => Promise.reject(new Error('network down'))
  });
  const c = factory({ days: 7, totalPaid: 0, invoiceCount: 0, clientCount: 0 });
  await c.select(90);
  // Persisted value stays at the previous successful selection (7).
  assert.strictEqual(storage['qi.recentRevenueDays'], '7', 'fetch failure must not overwrite localStorage');
  assert.strictEqual(c.errored, true, 'errored flag must be set on fetch failure');
});

test('factory: select() does NOT persist on non-2xx response (server-side window rejection safe)', async () => {
  const { factory, storage } = makeStubbedFactory({
    storage: {},
    fetchImpl: () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) })
  });
  const c = factory({ days: 30, totalPaid: 100, invoiceCount: 1, clientCount: 1 });
  await c.select(7);
  assert.strictEqual(storage['qi.recentRevenueDays'], undefined, 'non-2xx must NOT persist');
  assert.strictEqual(c.errored, true);
});

test('factory: writeSavedWindow swallows QuotaExceeded throws (Safari ITP / private mode)', async () => {
  const { factory } = makeStubbedFactory({
    storage: {},
    throwOnSet: true,
    fetchImpl: () => jsonResponse({ days: 7, totalPaid: 100, invoiceCount: 1, clientCount: 1 }, 7)
  });
  const c = factory({ days: 30, totalPaid: 100, invoiceCount: 1, clientCount: 1 });
  // Should NOT throw even though setItem will throw.
  await c.select(7);
  assert.strictEqual(c.days, 7, 'state still updates even when persistence throws');
  assert.strictEqual(c.errored, false, 'storage throw must NOT surface as a fetch error');
});

test('factory: readSavedWindow swallows getItem() throws (Firefox dom.storage.access blocked)', async () => {
  let fetchCalls = 0;
  const { factory } = makeStubbedFactory({
    storage: {},
    throwOnGet: true,
    fetchImpl: () => { fetchCalls++; return jsonResponse(null, 30); }
  });
  const c = factory({ days: 30, totalPaid: 100, invoiceCount: 1, clientCount: 1 });
  // init() must not throw; must treat the read failure as "no saved value".
  c.init();
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(fetchCalls, 0, 'getItem throw must be treated as no saved value (no fetch)');
});

test('factory: works when localStorage global is entirely absent (typeof === undefined branch)', async () => {
  let fetchCalls = 0;
  const { factory } = makeStubbedFactory({
    noLocalStorage: true,
    fetchImpl: () => { fetchCalls++; return jsonResponse({ days: 7, totalPaid: 100, invoiceCount: 1, clientCount: 1 }, 7); }
  });
  const c = factory({ days: 30, totalPaid: 100, invoiceCount: 1, clientCount: 1 });
  c.init();
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(fetchCalls, 0, 'no localStorage → no saved value → no fetch');
  // select() must also not throw without localStorage.
  await c.select(7);
  assert.strictEqual(c.days, 7);
});

test('factory: init-driven restoration is silent on fetch failure (no errored flag for background restore)', async () => {
  // User has saved=7. Dashboard loads while offline. init() fires select(7)
  // with {silent: true}. fetch fails. The user didn't click anything — they
  // shouldn't see a red error line for a background restoration attempt.
  const { factory } = makeStubbedFactory({
    storage: { 'qi.recentRevenueDays': '7' },
    fetchImpl: () => Promise.reject(new Error('offline'))
  });
  const c = factory({ days: 30, totalPaid: 100, invoiceCount: 1, clientCount: 1 });
  c.init();
  await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(c.errored, false, 'init-driven restoration must NOT surface the red error line');
  assert.strictEqual(c.days, 30, 'days stays at SSR fallback (graceful degrade)');
});

test('factory: user-clicked select() still surfaces errored on fetch failure (regression guard for the silent: true narrowing)', async () => {
  // Make sure the silent-on-error behaviour is scoped to init() and didn't
  // accidentally globalize. User clicks should still see the error line.
  const { factory } = makeStubbedFactory({
    storage: {},
    fetchImpl: () => Promise.reject(new Error('network down'))
  });
  const c = factory({ days: 30, totalPaid: 100, invoiceCount: 1, clientCount: 1 });
  await c.select(7); // user click — no opts arg means silent stays false
  assert.strictEqual(c.errored, true, 'user-clicked toggle must STILL surface error on failure');
});

test('factory: empty-window response (card=null) still persists the user\'s chosen window', async () => {
  // Truthful "no paid invoices in this window" is a SUCCESSFUL response —
  // the user explicitly asked for 7d, the server honoured it, the answer
  // is $0/0/0. localStorage MUST persist 7 (not stay on 30).
  const { factory, storage } = makeStubbedFactory({
    storage: {},
    fetchImpl: () => jsonResponse(null, 7)
  });
  const c = factory({ days: 30, totalPaid: 100, invoiceCount: 1, clientCount: 1 });
  await c.select(7);
  assert.strictEqual(storage['qi.recentRevenueDays'], '7', 'empty-window success must persist');
  assert.strictEqual(c.days, 7);
  assert.strictEqual(c.totalPaid, 0);
  assert.strictEqual(c.invoiceCount, 0);
  assert.strictEqual(c.clientCount, 0);
});

// ---- Run ---------------------------------------------------------------

(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log(`  ✓ ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${t.name}`);
      console.error(`    ${err.message}`);
      if (err.stack) console.error(err.stack.split('\n').slice(0, 3).join('\n'));
    }
  }
  console.log(`\n${passed} passed, ${failed} failed (recent-revenue-window-storage.test.js)`);
  if (failed > 0) process.exit(1);
})();
