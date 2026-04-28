'use strict';

/*
 * Tests for INTERNAL_TODO #106 — trial-countdown timer in the global nav.
 *
 * Two layers:
 *
 *   1. Pure-helper tests on lib/html.js#formatTrialCountdown — the fn that
 *      decides whether a pill renders, the days/hours split, and the
 *      `urgent` flag (drives red vs amber styling).
 *
 *   2. End-to-end render tests on views/partials/nav.ejs — confirms the
 *      pill is wired correctly when locals.trialCountdown is truthy
 *      (no pill for non-trialing users; correct href + utm + a11y attrs;
 *      red-pill styling on the urgent branch).
 *
 *   3. Wiring tests for the server-level res.locals middleware that
 *      computes trialCountdown from session.user.trial_ends_at — confirms
 *      the pill is persistent across every authed page (nav.ejs is
 *      included on all of them via the head/dashboard/etc partials).
 *
 * Run: NODE_ENV=test node tests/trial-countdown-nav.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

const { formatTrialCountdown } = require('../lib/html');

let pass = 0;
let fail = 0;

function run(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  FAIL ${name}`);
    console.log(`        ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n        ') : err && err.message}`);
  }
}

const NOW = Date.UTC(2026, 3, 28, 12, 0, 0); // 2026-04-28T12:00:00Z
const ONE_HOUR = 3600000;
const ONE_DAY = 86400000;

// ---------- formatTrialCountdown -----------------------------------------

run('returns null for null/undefined trial_ends_at', () => {
  assert.strictEqual(formatTrialCountdown(null, NOW), null);
  assert.strictEqual(formatTrialCountdown(undefined, NOW), null);
});

run('returns null for invalid date input', () => {
  assert.strictEqual(formatTrialCountdown('not-a-date', NOW), null);
});

run('returns null when trial has already ended (past)', () => {
  assert.strictEqual(formatTrialCountdown(new Date(NOW - ONE_DAY), NOW), null);
});

run('returns null when trial ends exactly now (boundary)', () => {
  assert.strictEqual(formatTrialCountdown(new Date(NOW), NOW), null);
});

run('6d 5h remaining → "6d 5h left", not urgent', () => {
  const ends = new Date(NOW + 6 * ONE_DAY + 5 * ONE_HOUR);
  const out = formatTrialCountdown(ends, NOW);
  assert.deepStrictEqual(out, { days: 6, hours: 5, label: '6d 5h left', urgent: false });
});

run('exactly 1 day → "1d left" (no hours suffix), not urgent', () => {
  const ends = new Date(NOW + ONE_DAY);
  const out = formatTrialCountdown(ends, NOW);
  assert.strictEqual(out.days, 1);
  assert.strictEqual(out.hours, 0);
  assert.strictEqual(out.label, '1d left');
  assert.strictEqual(out.urgent, false);
});

run('23h 30m remaining → "23h left", urgent (sub-day)', () => {
  const ends = new Date(NOW + 23 * ONE_HOUR + 30 * 60 * 1000);
  const out = formatTrialCountdown(ends, NOW);
  assert.strictEqual(out.days, 0);
  assert.strictEqual(out.hours, 23);
  assert.strictEqual(out.label, '23h left');
  assert.strictEqual(out.urgent, true);
});

run('30m remaining → "<1h left", urgent', () => {
  const ends = new Date(NOW + 30 * 60 * 1000);
  const out = formatTrialCountdown(ends, NOW);
  assert.strictEqual(out.days, 0);
  assert.strictEqual(out.hours, 0);
  assert.strictEqual(out.label, '<1h left');
  assert.strictEqual(out.urgent, true);
});

run('accepts ISO string input', () => {
  const ends = new Date(NOW + 3 * ONE_DAY).toISOString();
  const out = formatTrialCountdown(ends, NOW);
  assert.strictEqual(out.days, 3);
  assert.strictEqual(out.urgent, false);
});

run('accepts numeric epoch input', () => {
  const ends = NOW + 2 * ONE_DAY;
  const out = formatTrialCountdown(ends, NOW);
  assert.strictEqual(out.days, 2);
});

run('uses Date.now() when no `now` arg provided', () => {
  const ends = new Date(Date.now() + 3 * ONE_DAY + ONE_HOUR);
  const out = formatTrialCountdown(ends);
  assert.ok(out, 'expected a pill object');
  assert.strictEqual(out.days, 3);
});

run('module exports formatTrialCountdown', () => {
  const html = require('../lib/html');
  assert.strictEqual(typeof html.formatTrialCountdown, 'function');
});

// ---------- nav.ejs render tests -----------------------------------------

const navPath = path.join(__dirname, '..', 'views', 'partials', 'nav.ejs');
const navTemplate = fs.readFileSync(navPath, 'utf8');

function renderNav(locals) {
  return ejs.render(navTemplate, locals, { filename: navPath });
}

const TRIAL_USER = {
  id: 7, email: 't@x.io', name: 'T',
  plan: 'pro', invoice_count: 1,
  subscription_status: 'trialing'
};

run('nav renders pill when trialCountdown is set (calm 5d branch)', () => {
  const html = renderNav({
    user: TRIAL_USER,
    trialCountdown: { days: 5, hours: 3, label: '5d 3h left', urgent: false },
    csrfToken: 't'
  });
  assert.ok(html.includes('data-testid="nav-trial-countdown"'),
    'pill anchor must carry stable testid');
  assert.ok(html.includes('5d 3h left in trial'),
    'pill label must include the human-readable countdown');
  assert.ok(html.includes('data-trial-urgent="false"'),
    'urgent flag must surface in markup for tests/styling');
});

run('nav pill links to /billing/upgrade with annual + utm tag', () => {
  const html = renderNav({
    user: TRIAL_USER,
    trialCountdown: { days: 4, hours: 1, label: '4d 1h left', urgent: false },
    csrfToken: 't'
  });
  // utm propagates through the existing checkout flow so analytics can
  // attribute trial→paid conversions to the nav pill specifically.
  assert.ok(html.includes('href="/billing/upgrade?cycle=annual&amp;utm=nav-countdown"')
    || html.includes('href="/billing/upgrade?cycle=annual&utm=nav-countdown"'),
    'pill href must point at /billing/upgrade with cycle=annual + utm=nav-countdown');
});

run('nav pill uses red styling on urgent branch (<24h)', () => {
  const html = renderNav({
    user: TRIAL_USER,
    trialCountdown: { days: 0, hours: 5, label: '5h left', urgent: true },
    csrfToken: 't'
  });
  assert.ok(html.includes('data-trial-urgent="true"'),
    'urgent flag must be emitted for urgent countdowns');
  assert.ok(/bg-red-50|text-red-700/.test(html),
    'urgent pill must use red Tailwind classes');
  assert.ok(html.includes('⏱'),
    'urgent pill must use the timer emoji (matches the urgent dashboard banner)');
});

run('nav pill uses amber styling on calm branch (≥24h)', () => {
  const html = renderNav({
    user: TRIAL_USER,
    trialCountdown: { days: 6, hours: 0, label: '6d left', urgent: false },
    csrfToken: 't'
  });
  assert.ok(/bg-amber-50|text-amber-800/.test(html),
    'calm pill must use amber Tailwind classes (not red, not blue)');
  assert.ok(html.includes('⏳'),
    'calm pill uses the hourglass emoji');
});

run('nav omits pill when trialCountdown is null (post-trial Pro user)', () => {
  const html = renderNav({
    user: { ...TRIAL_USER, subscription_status: 'active' },
    trialCountdown: null,
    csrfToken: 't'
  });
  assert.ok(!html.includes('data-testid="nav-trial-countdown"'),
    'no pill should render once trial is over');
});

run('nav omits pill for anon (signed-out) visitors', () => {
  const html = renderNav({ user: null, trialCountdown: null, csrfToken: '' });
  assert.ok(!html.includes('data-testid="nav-trial-countdown"'),
    'anonymous nav has no trial pill');
});

run('nav omits pill for free-plan user with no trial', () => {
  const html = renderNav({
    user: { id: 1, plan: 'free', invoice_count: 0, email: 'f@x.io', name: 'F' },
    trialCountdown: null,
    csrfToken: ''
  });
  assert.ok(!html.includes('data-testid="nav-trial-countdown"'),
    'free user without trial has no pill');
});

run('nav pill is hidden on smallest mobile (sm:inline-flex)', () => {
  // The pill carries `hidden sm:inline-flex` — at <640px the pill yields
  // to the rest of the nav (Invoices/Settings/Logout), preserving mobile
  // hit-target room. The "Add card · Xd Yh left" affordance still surfaces
  // through the dashboard banner on those viewports.
  const html = renderNav({
    user: TRIAL_USER,
    trialCountdown: { days: 3, hours: 0, label: '3d left', urgent: false },
    csrfToken: 't'
  });
  assert.ok(html.includes('hidden sm:inline-flex'),
    'pill must be `hidden sm:inline-flex` for mobile breathing room');
});

run('nav pill carries an accessible title attribute', () => {
  const html = renderNav({
    user: TRIAL_USER,
    trialCountdown: { days: 2, hours: 1, label: '2d 1h left', urgent: false },
    csrfToken: 't'
  });
  assert.ok(/title=".*card.*Pro/.test(html),
    'pill must have an explanatory title (call-to-action for sighted hover + AT)');
});

run('nav pill render is HTML-escape-safe (label only contains expected literals)', () => {
  // Defence-in-depth: even though label is server-computed from numbers,
  // EJS's <%= renders it escaped. Confirm no raw HTML can sneak in.
  const html = renderNav({
    user: TRIAL_USER,
    trialCountdown: { days: 1, hours: 2, label: '<script>x</script>', urgent: false },
    csrfToken: 't'
  });
  assert.ok(!html.includes('<script>x</script>'),
    'pill label must be HTML-escaped — no raw script tag passthrough');
  assert.ok(html.includes('&lt;script&gt;'),
    'escaped form must appear instead');
});

// ---------- res.locals middleware wiring ---------------------------------
// Confirm the server.js middleware computes trialCountdown from
// session.user.trial_ends_at on every request (so every authed page surfaces
// the pill, not just the dashboard).

run('server.js wires formatTrialCountdown into res.locals.trialCountdown', () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(serverSrc.includes("require('./lib/html')"),
    'server.js must import from lib/html');
  assert.ok(serverSrc.includes('formatTrialCountdown'),
    'server.js must reference formatTrialCountdown');
  assert.ok(serverSrc.includes('res.locals.trialCountdown'),
    'server.js must assign res.locals.trialCountdown');
  assert.ok(serverSrc.includes('trial_ends_at'),
    'server.js must read trial_ends_at off session.user');
});

run('routes/auth.js login + register persist trial_ends_at on session.user', () => {
  const authSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');
  // Both register and login set req.session.user — both must include
  // trial_ends_at so the pill renders correctly the moment the user is
  // returning to a trial mid-flight (login from a different device).
  const matches = authSrc.match(/trial_ends_at:/g) || [];
  assert.ok(matches.length >= 2,
    `auth.js must set trial_ends_at on both login and register session shapes (found ${matches.length})`);
});

run('routes/invoices.js dashboard refresh keeps trial_ends_at fresh', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'invoices.js'), 'utf8');
  assert.ok(src.includes('trial_ends_at: user.trial_ends_at'),
    'invoices.js must refresh trial_ends_at into the session on dashboard load (Stripe webhook updates DB → session sees it on next dashboard hit)');
});

console.log(`\ntrial-countdown-nav.test.js: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
