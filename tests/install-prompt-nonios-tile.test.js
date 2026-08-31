'use strict';

/*
 * Chrome / Edge / Android install prompt tile — Alpine factory + view.
 * Sister surface to the iOS Safari "Add to Home Screen" tile
 * (covered in tests/pwa-install.test.js). Advances Milestone 1
 * (signup → first dashboard re-entry) by giving the non-iOS cohort a
 * first-party install path.
 *
 * Covers:
 *   Layer 1 (view): tile renders on the dashboard with the right testid,
 *                   both copy variants + the install/dismiss buttons,
 *                   print:hidden so it never leaks into a printed PDF.
 *   Layer 2 (factory): UA detection matrix, standalone-mode suppression,
 *                      dismissal persistence, beforeinstallprompt capture,
 *                      install() invokes prompt() + userChoice, appinstalled
 *                      hides + writes dismissed, missing-localStorage
 *                      soft-fail, iOS + in-app-webview exclusion.
 *
 * Run: node tests/install-prompt-nonios-tile.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ejs = require('ejs');

const VIEWS = path.join(__dirname, '..', 'views');
const dashboardTplPath = path.join(VIEWS, 'dashboard.ejs');
const dashboardTpl = fs.readFileSync(dashboardTplPath, 'utf8');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function renderDashboard(locals = {}) {
  return ejs.render(dashboardTpl, {
    title: 'Dashboard',
    flash: null,
    days_left_in_trial: 0,
    csrfToken: 'TEST_CSRF',
    invoices: [
      { id: 1, invoice_number: 'INV-2026-0001', client_name: 'Acme', issued_date: '2026-04-01', total: 500, status: 'draft', is_seed: false }
    ],
    user: { id: 1, plan: 'pro', invoice_count: 1, subscription_status: null, email: 'x@y.com', name: 'x' },
    onboarding: null,
    invoiceLimitProgress: null,
    recentRevenue: null,
    annualUpgradePrompt: null,
    socialProof: null,
    celebration: null,
    staleDraftPrompt: null,
    freshDraftPrompt: null,
    firstRealInvoicePrompt: null,
    clientViewedFollowupPrompt: null,
    recentViewPrompt: null,
    sentNotViewedPrompt: null,
    overduePrompt: null,
    paymentClaimPrompt: null,
    pendingQuickInvoiceBanner: null,
    repeatClientPrompt: null,
    ...locals
  }, {
    views: [VIEWS],
    filename: dashboardTplPath
  });
}

// ---- Layer 1: view render --------------------------------------------

test('dashboard renders the non-iOS install prompt tile with correct testids', () => {
  const html = renderDashboard();
  assert.match(html, /data-testid="install-prompt-nonios-tile"/,
    'the tile must render so non-iOS users discover the install path');
  assert.match(html, /data-testid="install-prompt-nonios-install"/,
    'the "Install app" button must be present for the native-event path');
  assert.match(html, /data-testid="install-prompt-nonios-dismiss"/,
    'a dismiss button must be present so users can hide the tile');
  assert.match(html, /data-testid="install-prompt-nonios-script"/,
    'the factory script must be present');
});

test('view renders both copy variants (native + instructional)', () => {
  const html = renderDashboard();
  assert.match(html, /Install DecentInvoice as an app/i,
    'headline copy must anchor the install intent');
  assert.match(html, /One-tap launcher on your home screen/i,
    'native-mode copy must be present for the beforeinstallprompt path');
  assert.match(html, /Add to Home screen/i,
    'instructional-mode copy must literally name the menu item users tap');
});

test('view: install button label and installing state are both present', () => {
  const html = renderDashboard();
  const btnMatch = html.match(/<button[^>]*data-testid="install-prompt-nonios-install"[\s\S]*?<\/button>/);
  assert.ok(btnMatch, 'install button block must be present');
  const btn = btnMatch[0];
  assert.match(btn, /Install app/i, 'button must carry an "Install app" label for the idle state');
  assert.match(btn, /Installing/i, 'button must carry an "Installing…" state so the tap feels responsive');
  assert.match(btn, /:disabled="installing"/, 'button must disable itself while the browser prompt is up');
});

test('view: tile is wrapped in print:hidden so printed invoices stay clean', () => {
  const html = renderDashboard();
  const m = html.match(/<div[^>]*data-testid="install-prompt-nonios-tile"[^>]*>/);
  assert.ok(m, 'must find the tile wrapper');
  assert.match(m[0], /print:hidden/, 'tile must be excluded from printed PDFs');
});

test('view: tile carries an aria-label and role="region" for screen readers', () => {
  const html = renderDashboard();
  const m = html.match(/<div[^>]*data-testid="install-prompt-nonios-tile"[^>]*>/);
  assert.ok(m);
  assert.match(m[0], /role="region"/);
  assert.match(m[0], /aria-label="Install DecentInvoice as an app"/i);
});

test('view: tile is x-cloak + x-show visible so it never flashes on load', () => {
  const html = renderDashboard();
  const m = html.match(/<div[^>]*data-testid="install-prompt-nonios-tile"[^>]*>/);
  assert.ok(m);
  assert.match(m[0], /x-cloak/);
  assert.match(m[0], /x-show="visible"/);
});

test('view: the two mode-copy branches are each x-show-gated by mode value', () => {
  const html = renderDashboard();
  assert.match(html, /x-show="mode === 'native'"[\s\S]{0,200}One-tap launcher/i,
    'native copy must be gated by mode === native');
  assert.match(html, /x-show="mode === 'instructional'"[\s\S]{0,200}Add to Home screen/i,
    'instructional copy must be gated by mode === instructional');
});

test('view: iOS tile and non-iOS tile both present and side-by-side', () => {
  const html = renderDashboard();
  const iosIdx = html.indexOf('data-testid="install-home-screen-tile"');
  const nonIosIdx = html.indexOf('data-testid="install-prompt-nonios-tile"');
  assert.ok(iosIdx >= 0, 'iOS tile must still render');
  assert.ok(nonIosIdx >= 0, 'non-iOS tile must render');
  assert.notStrictEqual(iosIdx, nonIosIdx, 'the two tiles must be separate elements');
});

// ---- Layer 2: factory --------------------------------------------------

function extractNonIosFactory() {
  const start = dashboardTpl.indexOf('function installPromptTileNonIOS()');
  assert.ok(start >= 0, 'must find installPromptTileNonIOS() in dashboard.ejs');
  const bodyOpen = dashboardTpl.indexOf('{', start);
  assert.ok(bodyOpen > 0);
  let depth = 0;
  for (let i = bodyOpen; i < dashboardTpl.length; i++) {
    const c = dashboardTpl[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return dashboardTpl.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces in installPromptTileNonIOS()');
}

function makeSandbox({ ua, standalone, displayModeMatches, lsValue, omitLocalStorage, listeners }) {
  const registered = listeners || {};
  const ls = omitLocalStorage ? undefined : {
    _v: lsValue == null ? null : String(lsValue),
    getItem(k) { return k === 'qi.installPromptNonIosDismissed' ? this._v : null; },
    setItem(k, v) { if (k === 'qi.installPromptNonIosDismissed') this._v = String(v); }
  };
  const sandbox = {
    navigator: { userAgent: ua, standalone: !!standalone },
    window: {
      matchMedia: (q) => ({ matches: q === '(display-mode: standalone)' && !!displayModeMatches }),
      addEventListener(name, fn) {
        registered[name] = registered[name] || [];
        registered[name].push(fn);
      }
    }
  };
  if (ls) sandbox.localStorage = ls;
  sandbox.__registered = registered;
  return sandbox;
}

function makeInstance(sandbox) {
  const src = extractNonIosFactory();
  const code = `'use strict'; ${src}; installPromptTileNonIOS();`;
  vm.createContext(sandbox);
  return vm.runInContext(code, sandbox);
}

const UA_ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const UA_DESKTOP_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const UA_IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';
const UA_ANDROID_SAMSUNG =
  'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36';
const UA_ANDROID_INSTAGRAM =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 Instagram 300.0.0.0 Android';

test('factory: Android Chrome without event fires → visible in instructional mode', () => {
  const sandbox = makeSandbox({ ua: UA_ANDROID_CHROME, standalone: false, displayModeMatches: false, lsValue: null });
  const inst = makeInstance(sandbox);
  inst.evaluate();
  assert.strictEqual(inst.visible, true, 'Android Chrome cohort must always see the tile');
  assert.strictEqual(inst.mode, 'instructional', 'no event → instructional fallback');
});

test('factory: Samsung Internet on Android → visible in instructional mode', () => {
  const sandbox = makeSandbox({ ua: UA_ANDROID_SAMSUNG, standalone: false, displayModeMatches: false, lsValue: null });
  const inst = makeInstance(sandbox);
  inst.evaluate();
  assert.strictEqual(inst.visible, true);
  assert.strictEqual(inst.mode, 'instructional');
});

test('factory: desktop Chrome without event fires → hidden (waits for beforeinstallprompt)', () => {
  const sandbox = makeSandbox({ ua: UA_DESKTOP_CHROME, standalone: false, displayModeMatches: false, lsValue: null });
  const inst = makeInstance(sandbox);
  inst.evaluate();
  assert.strictEqual(inst.visible, false, 'desktop must wait for the browser to signal installability');
  assert.strictEqual(inst.mode, 'none');
});

test('factory: desktop Chrome with beforeinstallprompt event → visible in native mode', () => {
  const listeners = {};
  const sandbox = makeSandbox({ ua: UA_DESKTOP_CHROME, standalone: false, displayModeMatches: false, lsValue: null, listeners });
  const inst = makeInstance(sandbox);
  inst.evaluate();
  assert.strictEqual(inst.visible, false, 'not visible before the event fires');
  assert.ok(listeners.beforeinstallprompt && listeners.beforeinstallprompt.length === 1,
    'must have registered exactly one beforeinstallprompt listener');
  let prevented = false;
  const fakeEvent = {
    preventDefault() { prevented = true; },
    prompt() {},
    userChoice: Promise.resolve({ outcome: 'accepted' })
  };
  listeners.beforeinstallprompt[0](fakeEvent);
  assert.strictEqual(prevented, true, 'must call event.preventDefault to keep the deferred handle alive');
  assert.strictEqual(inst.visible, true, 'tile appears when the event fires');
  assert.strictEqual(inst.mode, 'native', 'mode flips to native when the event is captured');
  assert.strictEqual(inst.deferredPrompt, fakeEvent, 'the event is stashed for the install() call');
});

test('factory: iOS Safari → never renders (iOS tile owns that cohort)', () => {
  const sandbox = makeSandbox({ ua: UA_IPHONE_SAFARI, standalone: false, displayModeMatches: false, lsValue: null });
  const inst = makeInstance(sandbox);
  inst.evaluate();
  assert.strictEqual(inst.visible, false);
  assert.strictEqual(sandbox.__registered.beforeinstallprompt, undefined,
    'iOS must not even register the listener — no wasted work');
});

test('factory: Android Instagram in-app webview → never renders', () => {
  const sandbox = makeSandbox({ ua: UA_ANDROID_INSTAGRAM, standalone: false, displayModeMatches: false, lsValue: null });
  const inst = makeInstance(sandbox);
  inst.evaluate();
  assert.strictEqual(inst.visible, false, 'in-app webviews cannot install PWAs — never nag');
});

test('factory: already-installed (matchMedia standalone) → hidden and no listener registered', () => {
  const sandbox = makeSandbox({ ua: UA_ANDROID_CHROME, standalone: false, displayModeMatches: true, lsValue: null });
  const inst = makeInstance(sandbox);
  inst.evaluate();
  assert.strictEqual(inst.visible, false, 'already installed — no nag');
  assert.strictEqual(sandbox.__registered.beforeinstallprompt, undefined);
});

test('factory: dismissed (localStorage=1) → hidden and no listener registered', () => {
  const sandbox = makeSandbox({ ua: UA_ANDROID_CHROME, standalone: false, displayModeMatches: false, lsValue: '1' });
  const inst = makeInstance(sandbox);
  inst.evaluate();
  assert.strictEqual(inst.visible, false, 'dismissed users stay dismissed across page loads');
  assert.strictEqual(sandbox.__registered.beforeinstallprompt, undefined);
});

test('factory: dismiss() hides the tile AND persists the flag', () => {
  const sandbox = makeSandbox({ ua: UA_ANDROID_CHROME, standalone: false, displayModeMatches: false, lsValue: null });
  const inst = makeInstance(sandbox);
  inst.evaluate();
  assert.strictEqual(inst.visible, true);
  inst.dismiss();
  assert.strictEqual(inst.visible, false, 'click → tile hides immediately');
  assert.strictEqual(sandbox.localStorage._v, '1',
    'dismissal must persist so the tile stays hidden on the next dashboard load');
});

test('factory: install() calls prompt() on the deferred event and clears it after userChoice', async () => {
  const listeners = {};
  const sandbox = makeSandbox({ ua: UA_DESKTOP_CHROME, standalone: false, displayModeMatches: false, lsValue: null, listeners });
  const inst = makeInstance(sandbox);
  inst.evaluate();
  let promptCalls = 0;
  const fakeEvent = {
    preventDefault() {},
    prompt() { promptCalls++; },
    userChoice: Promise.resolve({ outcome: 'accepted' })
  };
  listeners.beforeinstallprompt[0](fakeEvent);
  assert.strictEqual(inst.visible, true);
  assert.strictEqual(inst.mode, 'native');
  const p = inst.install();
  // install returns undefined, but the userChoice promise resolves asynchronously.
  // Give the microtask queue a chance to drain.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.strictEqual(promptCalls, 1, 'must call prompt() exactly once');
  assert.strictEqual(inst.deferredPrompt, null, 'deferred event must be cleared after use');
  assert.strictEqual(inst.installing, false, 'busy state must reset');
});

test('factory: appinstalled event hides the tile AND writes the dismissed flag', () => {
  const listeners = {};
  const sandbox = makeSandbox({ ua: UA_ANDROID_CHROME, standalone: false, displayModeMatches: false, lsValue: null, listeners });
  const inst = makeInstance(sandbox);
  inst.evaluate();
  assert.strictEqual(inst.visible, true, 'Android Chrome cohort starts with the tile visible');
  assert.ok(listeners.appinstalled && listeners.appinstalled.length === 1,
    'appinstalled listener must be registered');
  listeners.appinstalled[0]({});
  assert.strictEqual(inst.visible, false, 'installed → hide the tile');
  assert.strictEqual(sandbox.localStorage._v, '1',
    'installed → write dismissed so we never nag again after the user completes install');
});

test('factory: missing localStorage (private browsing) does not throw on evaluate() or dismiss()', () => {
  const sandbox = makeSandbox({ ua: UA_ANDROID_CHROME, standalone: false, displayModeMatches: false, omitLocalStorage: true });
  const inst = makeInstance(sandbox);
  assert.doesNotThrow(() => inst.evaluate(), 'evaluate() must soft-fail without localStorage');
  assert.doesNotThrow(() => inst.dismiss(), 'dismiss() must soft-fail without localStorage');
});

test('factory: STORAGE_KEY is namespaced separately from the iOS tile', () => {
  // A single-key collision would mean dismissing the iOS tile also dismisses
  // the non-iOS one (or vice versa) — different cohorts must not cross-silence.
  const src = extractNonIosFactory();
  assert.match(src, /qi\.installPromptNonIosDismissed/,
    'must use its own STORAGE_KEY distinct from the iOS tile');
  assert.ok(!/qi\.installTileDismissed/.test(src),
    'must not reuse the iOS tile STORAGE_KEY');
});

// ---- Run --------------------------------------------------------------

(async () => {
  let passed = 0, failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log(`  ✓ ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${t.name}`);
      console.error(`    ${err.message}`);
      if (err.stack) console.error(err.stack.split('\n').slice(0, 4).join('\n'));
    }
  }
  console.log(`\n${passed} passed, ${failed} failed (install-prompt-nonios-tile.test.js)`);
  if (failed > 0) process.exit(1);
})();
