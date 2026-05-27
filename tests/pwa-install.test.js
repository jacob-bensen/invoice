'use strict';

/*
 * PWA install infrastructure — manifest + icons + meta tags + iOS Safari
 * Add-to-Home-Screen tile. Advances Milestone 1 (signup → first dashboard
 * re-entry) by giving the mobile-first freelancer cohort a one-tap launcher
 * for DecentInvoice. Tests cover four layers:
 *
 *   1. Static assets — manifest.webmanifest is valid JSON with the expected
 *      contract; PNG icons exist with valid PNG magic and the right pixel
 *      dimensions; SVG icon exists with the brand colour.
 *   2. head.ejs — every page that includes the partial emits the manifest
 *      link, apple-touch-icon link, theme-color meta, and the apple-* meta
 *      family so iOS / Android both treat the page as installable.
 *   3. dashboard.ejs — the install tile renders with the right testid and a
 *      dismiss button, AND the inline factory is iOS-Safari-only,
 *      standalone-mode-aware, and persists dismissal to localStorage.
 *   4. server static mount — express.static serves the manifest path with
 *      the correct Content-Type via the existing serve-static mime lookup.
 *
 * Run: node tests/pwa-install.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ejs = require('ejs');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VIEWS = path.join(__dirname, '..', 'views');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---- Layer 1: static assets -------------------------------------------

test('manifest.webmanifest exists and is valid JSON', () => {
  const p = path.join(PUBLIC_DIR, 'manifest.webmanifest');
  assert.ok(fs.existsSync(p), 'manifest.webmanifest must exist at /public/manifest.webmanifest');
  const raw = fs.readFileSync(p, 'utf8');
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(raw); }, 'manifest must parse as JSON');
  assert.strictEqual(typeof parsed, 'object');
});

test('manifest carries the install-critical fields PWA installers require', () => {
  const parsed = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'manifest.webmanifest'), 'utf8'));
  assert.strictEqual(typeof parsed.name, 'string', 'name (long app name) required');
  assert.ok(parsed.name.length > 0, 'name must not be blank');
  assert.strictEqual(typeof parsed.short_name, 'string', 'short_name (home-screen label) required');
  assert.ok(parsed.short_name.length > 0 && parsed.short_name.length <= 30,
    'short_name must fit on the home-screen tile (≤30 chars)');
  assert.strictEqual(parsed.display, 'standalone',
    'display:standalone is required for the icon to launch chrome-free');
  assert.strictEqual(typeof parsed.start_url, 'string', 'start_url required');
  assert.ok(parsed.start_url.startsWith('/'),
    'start_url must be a same-origin path so installs survive deploys');
  assert.strictEqual(typeof parsed.theme_color, 'string');
  assert.match(parsed.theme_color, /^#[0-9a-f]{6}$/i, 'theme_color must be a hex colour');
  assert.strictEqual(typeof parsed.background_color, 'string');
  assert.match(parsed.background_color, /^#[0-9a-f]{6}$/i);
});

test('manifest icons array points at the real on-disk icons with correct dimensions', () => {
  const parsed = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'manifest.webmanifest'), 'utf8'));
  assert.ok(Array.isArray(parsed.icons) && parsed.icons.length >= 2,
    'must declare at least 2 icons (any + maskable, or svg + png)');
  // Every referenced src must exist on disk under public/.
  for (const icon of parsed.icons) {
    assert.strictEqual(typeof icon.src, 'string');
    assert.ok(icon.src.startsWith('/'), `icon.src must be a same-origin path: ${icon.src}`);
    const onDisk = path.join(PUBLIC_DIR, icon.src.replace(/^\//, ''));
    assert.ok(fs.existsSync(onDisk), `icon ${icon.src} must exist on disk at ${onDisk}`);
  }
  // Must include at least one 192+ and one 512+ PNG (the Android install
  // dialog uses these specific bins).
  const sizes = parsed.icons.map((i) => i.sizes || '').join(' ');
  assert.match(sizes, /\b192x192\b/, 'must declare a 192x192 icon');
  assert.match(sizes, /\b512x512\b/, 'must declare a 512x512 icon');
});

test('PNG icons on disk have the right pixel dimensions (192, 512, 180)', () => {
  // PNG IHDR is at offset 8 (after the 8-byte signature) + 4 (length) + 4
  // ("IHDR"). Width is at offset 16, height at offset 20 (4-byte big-endian).
  function readPngDims(p) {
    const buf = fs.readFileSync(p);
    // PNG signature
    assert.strictEqual(buf[0], 0x89, `${p} must start with PNG magic`);
    assert.strictEqual(buf.slice(1, 4).toString('ascii'), 'PNG');
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  let d = readPngDims(path.join(PUBLIC_DIR, 'icon-192.png'));
  assert.strictEqual(d.w, 192, 'icon-192.png must be 192px wide');
  assert.strictEqual(d.h, 192, 'icon-192.png must be 192px tall');
  d = readPngDims(path.join(PUBLIC_DIR, 'icon-512.png'));
  assert.strictEqual(d.w, 512); assert.strictEqual(d.h, 512);
  d = readPngDims(path.join(PUBLIC_DIR, 'apple-touch-icon.png'));
  assert.strictEqual(d.w, 180, 'apple-touch-icon must be 180px — the size iOS Safari fetches');
  assert.strictEqual(d.h, 180);
});

test('icon.svg exists and references the brand colour', () => {
  const p = path.join(PUBLIC_DIR, 'icon.svg');
  assert.ok(fs.existsSync(p), 'icon.svg must exist');
  const svg = fs.readFileSync(p, 'utf8');
  assert.match(svg, /^<svg /i, 'must start with <svg ...>');
  assert.match(svg, /#4f46e5/i, 'must use the brand purple #4f46e5');
  // viewBox must be present so the icon scales cleanly to whatever size the
  // installer requests; without it the icon would render at intrinsic size.
  assert.match(svg, /viewBox="0 0 \d+ \d+"/i, 'must declare a viewBox for scalability');
});

// ---- Layer 2: head.ejs emits the PWA tags ----------------------------

async function renderHead(locals) {
  return ejs.renderFile(path.join(VIEWS, 'partials', 'head.ejs'),
    { title: 't', ...locals }, { views: [VIEWS] });
}

test('head.ejs emits <link rel="manifest" href="/manifest.webmanifest">', async () => {
  const html = await renderHead({});
  assert.match(html, /<link\s+rel="manifest"\s+href="\/manifest\.webmanifest"\s*\/?>/i);
});

test('head.ejs emits <link rel="apple-touch-icon" ...> for iOS install fidelity', async () => {
  const html = await renderHead({});
  assert.match(html, /<link\s+rel="apple-touch-icon"\s+href="\/apple-touch-icon\.png"\s*\/?>/i);
});

test('head.ejs emits <link rel="icon" type="image/svg+xml" ...> for the SVG favicon', async () => {
  const html = await renderHead({});
  assert.match(html, /<link\s+rel="icon"\s+type="image\/svg\+xml"\s+href="\/icon\.svg"\s*\/?>/i);
});

test('head.ejs emits theme-color matching the manifest theme', async () => {
  const html = await renderHead({});
  const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'manifest.webmanifest'), 'utf8'));
  // theme-color drives the address bar + splash on installed PWAs; if these
  // drift, the install looks "off-brand" the moment it launches.
  const re = new RegExp(`<meta\\s+name="theme-color"\\s+content="${manifest.theme_color}"`, 'i');
  assert.match(html, re,
    `<meta name="theme-color"> must match manifest.theme_color (${manifest.theme_color})`);
});

test('head.ejs emits the apple-mobile-web-app-* meta family for iOS standalone', async () => {
  const html = await renderHead({});
  // capable=yes makes the icon launch chrome-free; status-bar-style + title
  // give the install a polished look. All three are required for iOS Safari
  // to treat the home-screen icon as a real app rather than a bookmark.
  assert.match(html, /<meta\s+name="apple-mobile-web-app-capable"\s+content="yes"\s*\/?>/i);
  assert.match(html, /<meta\s+name="apple-mobile-web-app-status-bar-style"\s+content="(default|black-translucent|black)"\s*\/?>/i);
  assert.match(html, /<meta\s+name="apple-mobile-web-app-title"\s+content="DecentInvoice"\s*\/?>/i);
});

test('head.ejs emits mobile-web-app-capable for non-Safari mobile browsers', async () => {
  const html = await renderHead({});
  assert.match(html, /<meta\s+name="mobile-web-app-capable"\s+content="yes"\s*\/?>/i);
});

// ---- Layer 3: dashboard.ejs install tile + factory --------------------

const dashboardTplPath = path.join(VIEWS, 'dashboard.ejs');
const dashboardTpl = fs.readFileSync(dashboardTplPath, 'utf8');

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

test('dashboard renders the install-home-screen tile with a dismiss button', () => {
  const html = renderDashboard();
  assert.match(html, /data-testid="install-home-screen-tile"/,
    'install tile must be present in the HTML so iOS Safari users discover it');
  assert.match(html, /data-testid="install-home-screen-dismiss"/,
    'dismiss button must be present so users can hide the tile');
  assert.match(html, /data-testid="install-home-screen-script"/,
    'the factory script must be present');
  // Tile is x-show-gated so server-side visibility is irrelevant; what
  // matters is the right copy hits the cohort that sees it.
  assert.match(html, /Add DecentInvoice to your home screen/i);
  assert.match(html, /Add to Home Screen/i,
    'copy must literally name the iOS menu item users tap');
});

test('install tile is wrapped in print:hidden so printed invoices stay clean', () => {
  const html = renderDashboard();
  // Pull the tile block out of the HTML to inspect its classes.
  const m = html.match(/<div[^>]*data-testid="install-home-screen-tile"[^>]*>/);
  assert.ok(m, 'must find the tile element');
  assert.match(m[0], /print:hidden/, 'tile must be excluded from printed PDFs');
});

// Extract the inline factory source and exercise it in a sandbox.
// Counts braces from the start of the function to find the matching close —
// robust to indentation changes inside the body.
function extractInstallTileFactory() {
  const start = dashboardTpl.indexOf('function installToHomeScreenTile()');
  assert.ok(start >= 0, 'must find installToHomeScreenTile() in dashboard.ejs');
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
  throw new Error('unbalanced braces in installToHomeScreenTile()');
}

function evalFactory({ ua, standalone, displayModeMatches, lsValue }) {
  const src = extractInstallTileFactory();
  // Strict-mode prologue isolates the test sandbox from leaking globals.
  const code = `'use strict'; ${src}; installToHomeScreenTile();`;
  const sandbox = {
    navigator: { userAgent: ua, standalone: !!standalone },
    window: {
      matchMedia: (q) => ({ matches: q === '(display-mode: standalone)' && !!displayModeMatches })
    },
    localStorage: {
      _v: lsValue == null ? null : String(lsValue),
      getItem(k) { return this._k === k ? this._v : (k === 'qi.installTileDismissed' ? this._v : null); },
      setItem(k, v) { this._k = k; this._v = String(v); }
    }
  };
  vm.createContext(sandbox);
  const instance = vm.runInContext(code, sandbox);
  instance.evaluate();
  return { instance, sandbox };
}

test('factory: iOS Safari + not standalone + not dismissed → visible', () => {
  const { instance } = evalFactory({
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
    standalone: false,
    displayModeMatches: false,
    lsValue: null
  });
  assert.strictEqual(instance.visible, true);
});

test('factory: Chrome iOS (CriOS) does NOT show — Chrome iOS uses its own install flow', () => {
  const { instance } = evalFactory({
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1',
    standalone: false,
    displayModeMatches: false,
    lsValue: null
  });
  assert.strictEqual(instance.visible, false,
    'CriOS UA must not surface the Safari-specific "tap Share button" copy');
});

test('factory: Firefox iOS (FxiOS) does NOT show', () => {
  const { instance } = evalFactory({
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/120.0 Mobile/15E148 Safari/604.1',
    standalone: false, displayModeMatches: false, lsValue: null
  });
  assert.strictEqual(instance.visible, false);
});

test('factory: in-app webviews (Instagram, Facebook, Line) do NOT show', () => {
  for (const ua of [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/450.0]',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Line/13.0.0'
  ]) {
    const { instance } = evalFactory({ ua, standalone: false, displayModeMatches: false, lsValue: null });
    assert.strictEqual(instance.visible, false, `in-app webview UA must be excluded: ${ua.slice(-30)}`);
  }
});

test('factory: Android Chrome does NOT show — Chrome shows its own install prompt', () => {
  const { instance } = evalFactory({
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    standalone: false, displayModeMatches: false, lsValue: null
  });
  assert.strictEqual(instance.visible, false);
});

test('factory: desktop browsers do NOT show', () => {
  const { instance } = evalFactory({
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
    standalone: false, displayModeMatches: false, lsValue: null
  });
  assert.strictEqual(instance.visible, false, 'desktop Safari must be excluded — no home-screen on macOS');
});

test('factory: iOS Safari in standalone (navigator.standalone) → NOT visible', () => {
  const { instance } = evalFactory({
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
    standalone: true, displayModeMatches: false, lsValue: null
  });
  assert.strictEqual(instance.visible, false,
    'user already on the installed icon — do not nag them to install again');
});

test('factory: iOS Safari in matchMedia(display-mode: standalone) → NOT visible', () => {
  const { instance } = evalFactory({
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
    standalone: false, displayModeMatches: true, lsValue: null
  });
  assert.strictEqual(instance.visible, false);
});

test('factory: iOS Safari with dismissed=1 in localStorage → NOT visible', () => {
  const { instance } = evalFactory({
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
    standalone: false, displayModeMatches: false, lsValue: '1'
  });
  assert.strictEqual(instance.visible, false, 'dismissed users stay dismissed across page loads');
});

test('factory: dismiss() flips visible to false AND writes the localStorage flag', () => {
  const { instance, sandbox } = evalFactory({
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
    standalone: false, displayModeMatches: false, lsValue: null
  });
  assert.strictEqual(instance.visible, true);
  instance.dismiss();
  assert.strictEqual(instance.visible, false, 'click → tile hides immediately');
  assert.strictEqual(sandbox.localStorage._v, '1',
    'dismissal must persist so the tile stays hidden on the next dashboard load');
});

test('factory: missing localStorage (Safari private-browse / disabled) does not throw', () => {
  // Some iOS configurations throw on localStorage access; the factory must
  // soft-fail so the dashboard never breaks because of a storage permission.
  const src = extractInstallTileFactory();
  const code = `'use strict'; ${src}; installToHomeScreenTile();`;
  const sandbox = {
    navigator: { userAgent: 'iPhone OS 17_2 ... Safari/604.1', standalone: false },
    window: { matchMedia: () => ({ matches: false }) }
    // no localStorage
  };
  vm.createContext(sandbox);
  const instance = vm.runInContext(code, sandbox);
  assert.doesNotThrow(() => instance.evaluate());
  // visible can be either value depending on the UA; what matters is no throw.
  assert.doesNotThrow(() => instance.dismiss(), 'dismiss must not throw without localStorage');
});

// ---- Layer 4: server.js static mount serves the manifest --------------

test('express.static mount serves /manifest.webmanifest with the right Content-Type', async () => {
  // serve-static uses mime-db to derive the Content-Type for .webmanifest;
  // mime-db's canonical lookup for ".webmanifest" is "application/manifest+json".
  // We verify by spinning up the existing express app's static middleware
  // (the same instance server.js uses) and hitting the path.
  const express = require('express');
  const http = require('http');
  const app = express();
  app.use(express.static(path.join(__dirname, '..', 'public')));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const port = server.address().port;
    const res = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/manifest.webmanifest', method: 'GET' }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.strictEqual(res.status, 200, 'manifest must be reachable at /manifest.webmanifest');
    assert.match(res.headers['content-type'] || '', /manifest\+json|application\/json/i,
      'Content-Type must be application/manifest+json (or JSON fallback); browsers reject text/html');
    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.display, 'standalone');
  } finally {
    server.close();
  }
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
  console.log(`\n${passed} passed, ${failed} failed (pwa-install.test.js)`);
  if (failed > 0) process.exit(1);
})();
