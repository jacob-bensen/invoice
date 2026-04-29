'use strict';

/*
 * INTERNAL_TODO H5: the users.plan CHECK constraint must accept every plan
 * value that route/job code branches on. Before this commit the constraint
 * pinned `plan IN ('free', 'pro')` while routes/billing.js, routes/invoices.js,
 * jobs/reminders.js and the reminder query in db.js all referenced 'agency'
 * (and #10 will soon write 'business'). No current code path actually
 * persisted those values, so the constraint was a latent trip wire — it would
 * have surfaced as a Postgres 23514 error the first time anyone tried to
 * upgrade a user to Agency.
 *
 * This test is a static lint of the schema + the call sites:
 *
 *   1. The inline CREATE TABLE CHECK lists all 4 canonical plans.
 *   2. The idempotent migration block both DROPs the old constraint and ADDs
 *      the wide one — drop-then-add is the only safe way to widen a CHECK on
 *      an existing table without renaming the constraint.
 *   3. The migration's CHECK definition matches the inline definition exactly
 *      (so a future schema edit can't drift one without the other).
 *   4. Every plan value referenced in routes/*.js, db.js, and
 *      jobs/reminders.js exists in the whitelist (defence-in-depth: a future
 *      typo like `'agnecy'` would slip past the constraint and silently
 *      always-evaluate-false, which is harder to spot than a 23514).
 *
 * Run: node tests/plan-check-constraint.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCHEMA = fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8');

// Canonical, ordered list. Same order as in the schema and routes.
const ALLOWED_PLANS = ['free', 'pro', 'business', 'agency'];

// ---------- Schema assertions ---------------------------------------------

(function inlineCheckHasAllFourPlans() {
  // Match the CREATE TABLE inline CHECK on the `plan` column.
  const m = SCHEMA.match(
    /plan\s+VARCHAR\(\d+\)\s+DEFAULT\s+'free'\s+CHECK\s*\(\s*plan\s+IN\s*\(([^)]+)\)\s*\)/i
  );
  assert.ok(m, 'CREATE TABLE users inline CHECK on plan not found');
  const values = m[1]
    .split(',')
    .map(s => s.trim().replace(/^'|'$/g, ''));
  assert.deepStrictEqual(
    values,
    ALLOWED_PLANS,
    `inline CHECK plan list mismatch — expected ${JSON.stringify(ALLOWED_PLANS)}, got ${JSON.stringify(values)}`
  );
})();

(function migrationDropsOldConstraint() {
  assert.ok(
    /ALTER\s+TABLE\s+users\s+DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+users_plan_check/i.test(SCHEMA),
    'idempotent migration must DROP CONSTRAINT IF EXISTS users_plan_check before re-adding'
  );
})();

(function migrationAddsWideConstraint() {
  // Match the ADD CONSTRAINT block (may span lines).
  const m = SCHEMA.match(
    /ALTER\s+TABLE\s+users\s+ADD\s+CONSTRAINT\s+users_plan_check\s+CHECK\s*\(\s*plan\s+IN\s*\(([^)]+)\)\s*\)/i
  );
  assert.ok(m, 'idempotent migration must ADD CONSTRAINT users_plan_check with the wide CHECK');
  const values = m[1]
    .split(',')
    .map(s => s.trim().replace(/^'|'$/g, ''));
  assert.deepStrictEqual(
    values,
    ALLOWED_PLANS,
    `migration ADD CONSTRAINT plan list mismatch — expected ${JSON.stringify(ALLOWED_PLANS)}, got ${JSON.stringify(values)}`
  );
})();

(function dropPrecedesAdd() {
  // Order matters. ADD before DROP would no-op-fail on first install and then
  // hit an "already exists" error on the second psql run.
  const dropIdx = SCHEMA.search(/ALTER\s+TABLE\s+users\s+DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+users_plan_check/i);
  const addIdx = SCHEMA.search(/ALTER\s+TABLE\s+users\s+ADD\s+CONSTRAINT\s+users_plan_check/i);
  assert.ok(dropIdx >= 0 && addIdx >= 0, 'both DROP and ADD must be present');
  assert.ok(dropIdx < addIdx, 'DROP CONSTRAINT must precede ADD CONSTRAINT');
})();

// ---------- Call-site assertions ------------------------------------------

function planLiteralsIn(file) {
  const src = fs.readFileSync(file, 'utf8');
  // Match `plan === 'X'`, `plan !== 'X'`, `plan IN ('X', 'Y', ...)` (SQL),
  // and JS array/Set literals like ['pro', 'business', 'agency'] when on a
  // line that mentions `plan` (avoids false positives from unrelated
  // strings).
  const literals = new Set();

  // JS equality: plan === 'X' / plan !== 'X' / .plan === 'X'
  for (const m of src.matchAll(/\bplan\s*[!=]==\s*['"]([a-z_]+)['"]/g)) {
    literals.add(m[1]);
  }

  // SQL IN list: plan IN ('a', 'b', ...)
  for (const m of src.matchAll(/\bplan\s+IN\s*\(\s*([^)]+)\s*\)/gi)) {
    for (const tok of m[1].split(',')) {
      const v = tok.trim().replace(/^'|'$/g, '');
      if (/^[a-z_]+$/.test(v)) literals.add(v);
    }
  }

  // PAID_PLANS-style literal sets: any line that defines a Set / array of
  // plan strings on the same line as `PLAN`/`PLANS`.
  for (const m of src.matchAll(/PAID_PLANS\s*=\s*new\s+Set\(\s*\[([^\]]+)\]/g)) {
    for (const tok of m[1].split(',')) {
      const v = tok.trim().replace(/^['"]|['"]$/g, '');
      if (/^[a-z_]+$/.test(v)) literals.add(v);
    }
  }

  return literals;
}

(function routePlanValuesAreInWhitelist() {
  const targets = [
    path.join(ROOT, 'routes', 'billing.js'),
    path.join(ROOT, 'routes', 'invoices.js'),
    path.join(ROOT, 'db.js'),
    path.join(ROOT, 'jobs', 'reminders.js'),
  ];
  const seen = new Set();
  for (const f of targets) {
    for (const v of planLiteralsIn(f)) seen.add(v);
  }
  // We expect at least 'pro' and 'agency' (already referenced today).
  assert.ok(seen.has('pro'), 'expected at least one reference to plan === \'pro\'');
  assert.ok(seen.has('agency'), 'expected at least one reference to plan === \'agency\'');
  // Every observed literal must be in the whitelist.
  for (const v of seen) {
    assert.ok(
      ALLOWED_PLANS.includes(v),
      `plan value '${v}' referenced in source but not in CHECK constraint whitelist (${ALLOWED_PLANS.join(',')}). ` +
      `Either add it to the schema constraint or fix the typo.`
    );
  }
})();

(function reminderJobPaidPlansSubsetOfWhitelist() {
  // jobs/reminders.js declares PAID_PLANS as a Set; verify it's exactly the
  // paid subset (everything except 'free').
  const src = fs.readFileSync(path.join(ROOT, 'jobs', 'reminders.js'), 'utf8');
  const m = src.match(/PAID_PLANS\s*=\s*new\s+Set\(\s*\[([^\]]+)\]/);
  assert.ok(m, 'jobs/reminders.js must declare a PAID_PLANS Set');
  const declared = m[1]
    .split(',')
    .map(t => t.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
  const expected = ALLOWED_PLANS.filter(p => p !== 'free');
  assert.deepStrictEqual(
    declared.slice().sort(),
    expected.slice().sort(),
    `PAID_PLANS must be the paid subset of the whitelist — got ${JSON.stringify(declared)}, expected ${JSON.stringify(expected)}`
  );
})();

(function dbReminderQueryPlanFilterMatchesPaidSubset() {
  const src = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
  const m = src.match(/u\.plan\s+IN\s*\(\s*([^)]+)\s*\)/i);
  assert.ok(m, 'db.js getOverdueInvoicesForReminders must filter on u.plan IN (...)');
  const values = m[1]
    .split(',')
    .map(t => t.trim().replace(/^'|'$/g, ''))
    .filter(Boolean);
  const expected = ALLOWED_PLANS.filter(p => p !== 'free');
  assert.deepStrictEqual(
    values.slice().sort(),
    expected.slice().sort(),
    `db.js reminder query plan filter must match paid subset — got ${JSON.stringify(values)}, expected ${JSON.stringify(expected)}`
  );
})();

console.log('plan-check-constraint.test.js: all assertions passed');
