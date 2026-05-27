'use strict';

/*
 * SQL contract tests for db.getRecentItemsForUser — the helper that powers
 * the "Recent items" quick-pick dropdown on /invoices/quick.
 *
 * The view tests in invoice-quick.test.js exercise the route + EJS + Alpine
 * layers via a stubbed helper. This file drives the real db.js function
 * through a stubbed pg pool to lock in the production SQL shape:
 *
 *   - jsonb_array_elements(items) LATERAL unpack of the per-invoice JSON
 *     items array
 *   - is_seed=false filter (the welcome sample's line must NEVER surface)
 *   - DISTINCT ON (LOWER(TRIM(description))) dedupe across runs of the
 *     same line item with different casing / surrounding whitespace
 *   - quantity * unit_price compute so a /new invoice with quantity>1
 *     surfaces the actual line total (which is what the /quick form
 *     stores as `amount`), not the per-unit price
 *   - unit_price regex guard so a malformed JSONB row can't throw the cast
 *   - amount > 0 outer filter so zero / negative lines never surface
 *   - ORDER BY used_at DESC + LIMIT for newest-first cap
 *   - parameter sanitisation: negative / non-numeric / zero limit
 *     coerces back to the default
 *
 * Run: NODE_ENV=test node tests/recent-items.test.js
 */

const assert = require('assert');

async function testRealHelperSqlShape() {
  delete require.cache[require.resolve('../db')];
  let captured = null;
  const original = require('pg').Pool.prototype.query;
  require('pg').Pool.prototype.query = async function (sql, params) {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    const { db } = require('../db');
    assert.strictEqual(typeof db.getRecentItemsForUser, 'function',
      'db.getRecentItemsForUser must be exported');
    await db.getRecentItemsForUser(42, 8);
    assert.ok(captured, 'pool.query must be invoked');
    const sql = captured.sql;
    assert.match(sql, /FROM\s+invoices\s+i/i, 'SQL must select FROM invoices i');
    assert.match(sql, /LATERAL\s+jsonb_array_elements\s*\(\s*i\.items\s*\)\s+AS\s+item/i,
      'SQL must LATERAL unpack items via jsonb_array_elements');
    assert.match(sql, /i\.user_id\s*=\s*\$1/i, 'SQL must filter by user_id = $1');
    assert.match(sql, /i\.is_seed\s*=\s*false/i,
      'SQL must filter out the seed invoice (no welcome-sample line in dropdown)');
    assert.match(sql, /item->>'description'\s+IS\s+NOT\s+NULL/i,
      'SQL must exclude rows with NULL description');
    assert.match(sql, /TRIM\(item->>'description'\)\s*<>\s*''/i,
      'SQL must exclude empty / whitespace-only descriptions');
    assert.match(sql, /\(item->>'unit_price'\)\s*~\s*'\^-\?\[0-9\]\+\(\\\.\[0-9\]\+\)\?\$'/,
      'SQL must regex-guard unit_price against malformed JSONB rows');
    assert.match(sql, /DISTINCT\s+ON\s*\(\s*LOWER\(\s*TRIM\(item->>'description'\)\s*\)\s*\)/i,
      'SQL must DISTINCT ON lowercased trimmed description (case+whitespace dedupe)');
    assert.match(sql,
      /COALESCE\(\s*NULLIF\(item->>'quantity',\s*''\),\s*'1'\)::numeric\s*\*\s*\(item->>'unit_price'\)::numeric/i,
      'SQL must compute amount = COALESCE(quantity,1) * unit_price');
    assert.match(sql, /amount\s*>\s*0/i,
      'SQL must filter out zero / negative line totals at the outer query');
    assert.match(sql, /ORDER\s+BY\s+used_at\s+DESC/i,
      'outer SQL must order by used_at DESC (newest-first)');
    assert.match(sql, /LIMIT\s+\$2/i, 'SQL must LIMIT $2');
    assert.deepStrictEqual(captured.params, [42, 8],
      'params must be [userId, cap]');
  } finally {
    require('pg').Pool.prototype.query = original;
    delete require.cache[require.resolve('../db')];
  }
}

async function testParamSanitisation() {
  delete require.cache[require.resolve('../db')];
  const captures = [];
  const original = require('pg').Pool.prototype.query;
  require('pg').Pool.prototype.query = async function (sql, params) {
    captures.push({ sql, params });
    return { rows: [] };
  };
  try {
    const { db } = require('../db');
    await db.getRecentItemsForUser(1);             // omitted → default 8
    await db.getRecentItemsForUser(1, 0);          // zero → default 8
    await db.getRecentItemsForUser(1, -5);         // negative → default 8
    await db.getRecentItemsForUser(1, 'abc');      // NaN → default 8
    await db.getRecentItemsForUser(1, 100);        // overflow → capped at 50
    await db.getRecentItemsForUser(1, 3);          // valid → unchanged
    assert.strictEqual(captures.length, 6);
    assert.deepStrictEqual(captures[0].params, [1, 8], 'omitted limit → 8');
    assert.deepStrictEqual(captures[1].params, [1, 8], 'zero limit → 8');
    assert.deepStrictEqual(captures[2].params, [1, 8], 'negative limit → 8');
    assert.deepStrictEqual(captures[3].params, [1, 8], 'NaN limit → 8');
    assert.deepStrictEqual(captures[4].params, [1, 50], 'over-50 limit caps at 50');
    assert.deepStrictEqual(captures[5].params, [1, 3], 'valid limit passes through');
  } finally {
    require('pg').Pool.prototype.query = original;
    delete require.cache[require.resolve('../db')];
  }
}

async function testHelperCoercesStringAmount() {
  // Postgres NUMERIC columns come back as strings via pg by default. The
  // helper must coerce to JS numbers so the view layer's Number() check
  // sees a usable amount.
  delete require.cache[require.resolve('../db')];
  const original = require('pg').Pool.prototype.query;
  require('pg').Pool.prototype.query = async function () {
    return {
      rows: [
        { description: 'Logo design', amount: '500.00' },
        { description: 'Hourly rate', amount: '75.5' },
        { description: 'Photography', amount: 1200 } // already number
      ]
    };
  };
  try {
    const { db } = require('../db');
    const out = await db.getRecentItemsForUser(1, 10);
    assert.strictEqual(out.length, 3);
    assert.strictEqual(out[0].description, 'Logo design');
    assert.strictEqual(out[0].amount, 500, 'string numeric coerces to JS number');
    assert.strictEqual(typeof out[0].amount, 'number');
    assert.strictEqual(out[1].amount, 75.5, 'decimal string coerces to JS number');
    assert.strictEqual(out[2].amount, 1200, 'numeric input passes through');
  } finally {
    require('pg').Pool.prototype.query = original;
    delete require.cache[require.resolve('../db')];
  }
}

async function testHelperReturnsEmptyForUserWithNoInvoices() {
  delete require.cache[require.resolve('../db')];
  const original = require('pg').Pool.prototype.query;
  require('pg').Pool.prototype.query = async function () {
    return { rows: [] };
  };
  try {
    const { db } = require('../db');
    const out = await db.getRecentItemsForUser(9999, 10);
    assert.deepStrictEqual(out, [], 'day-zero user with no past invoices returns []');
  } finally {
    require('pg').Pool.prototype.query = original;
    delete require.cache[require.resolve('../db')];
  }
}

async function run() {
  const tests = [
    ['db.getRecentItemsForUser: production SQL shape locks in all gates', testRealHelperSqlShape],
    ['db.getRecentItemsForUser: limit sanitisation (default, zero, negative, NaN, over-cap)', testParamSanitisation],
    ['db.getRecentItemsForUser: string NUMERIC from pg coerces to JS number', testHelperCoercesStringAmount],
    ['db.getRecentItemsForUser: empty rows → empty array', testHelperReturnsEmptyForUserWithNoInvoices]
  ];
  let passed = 0;
  let failed = 0;
  for (const [label, fn] of tests) {
    try {
      await fn();
      console.log(`  ok  ${label}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL ${label}`);
      console.error('       ', err && err.message);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Runner threw:', err);
  process.exit(1);
});
