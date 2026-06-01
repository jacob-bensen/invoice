'use strict';

/*
 * Browser Accept-Language → default_currency derivation tests
 * (Milestone 2 — first dashboard re-entry → first real invoice created).
 *
 * Two layers:
 *   - Pure module (lib/locale-currency.js): tag parsing, region/language
 *     fallback chain, quality-weight tie-breaks, malformed/missing input.
 *   - Route integration (routes/auth.js): POST /auth/register and POST
 *     /auth/register/magic must thread the derived currency into
 *     db.createUser.
 *
 * Run: node tests/locale-currency.test.js
 */

const assert = require('assert');
const path = require('path');
const express = require('express');
const session = require('express-session');
const http = require('http');

// ---------- Pure module assertions --------------------------------------

const {
  currencyFromAcceptLanguage,
  regionToCurrency,
  languageToCurrency,
  DEFAULT_CURRENCY,
  EURO_REGIONS,
  REGION_TO_CURRENCY,
  LANGUAGE_TO_CURRENCY
} = require('../lib/locale-currency');
const { SUPPORTED_CODE_SET } = require('../lib/currency');

function testDefaultCurrencyIsUSD() {
  assert.strictEqual(DEFAULT_CURRENCY, 'USD',
    'fall-back must be USD so the no-header path matches the DB column default');
}

function testEveryMappedCurrencyIsSupported() {
  // Every code that the locale derivation can produce must round-trip
  // through `lib/currency.SUPPORTED_CODE_SET` — otherwise a non-US signup
  // would land on an unsupported code that the symbol resolver can't
  // render, defeating the whole point of the feature.
  const all = new Set([
    DEFAULT_CURRENCY,
    ...Object.values(REGION_TO_CURRENCY),
    ...Object.values(LANGUAGE_TO_CURRENCY),
    'EUR'
  ]);
  for (const code of all) {
    assert.ok(SUPPORTED_CODE_SET.has(code),
      `derived currency ${code} must be in lib/currency.SUPPORTED_CODE_SET`);
  }
}

function testHeaderMissingOrEmptyDefaultsToUSD() {
  assert.strictEqual(currencyFromAcceptLanguage(undefined), 'USD');
  assert.strictEqual(currencyFromAcceptLanguage(null), 'USD');
  assert.strictEqual(currencyFromAcceptLanguage(''), 'USD');
  assert.strictEqual(currencyFromAcceptLanguage('   '), 'USD');
}

function testHeaderNonStringDefaultsToUSD() {
  assert.strictEqual(currencyFromAcceptLanguage(42), 'USD');
  assert.strictEqual(currencyFromAcceptLanguage({}), 'USD');
  assert.strictEqual(currencyFromAcceptLanguage([]), 'USD');
}

function testRegionDirectMapping() {
  assert.strictEqual(currencyFromAcceptLanguage('en-US'), 'USD');
  assert.strictEqual(currencyFromAcceptLanguage('en-GB'), 'GBP');
  assert.strictEqual(currencyFromAcceptLanguage('en-CA'), 'CAD');
  assert.strictEqual(currencyFromAcceptLanguage('en-AU'), 'AUD');
  assert.strictEqual(currencyFromAcceptLanguage('en-NZ'), 'NZD');
  assert.strictEqual(currencyFromAcceptLanguage('ja-JP'), 'JPY');
  assert.strictEqual(currencyFromAcceptLanguage('de-CH'), 'CHF');
  assert.strictEqual(currencyFromAcceptLanguage('fr-CH'), 'CHF');
}

function testEurozoneRegionsMapToEUR() {
  assert.strictEqual(currencyFromAcceptLanguage('de-DE'), 'EUR');
  assert.strictEqual(currencyFromAcceptLanguage('fr-FR'), 'EUR');
  assert.strictEqual(currencyFromAcceptLanguage('es-ES'), 'EUR');
  assert.strictEqual(currencyFromAcceptLanguage('it-IT'), 'EUR');
  assert.strictEqual(currencyFromAcceptLanguage('nl-NL'), 'EUR');
  assert.strictEqual(currencyFromAcceptLanguage('pt-PT'), 'EUR');
  assert.strictEqual(currencyFromAcceptLanguage('en-IE'), 'EUR');
  assert.strictEqual(currencyFromAcceptLanguage('de-AT'), 'EUR');
}

function testLanguageOnlyFallback() {
  // No region subtag — fall back to the language map.
  assert.strictEqual(currencyFromAcceptLanguage('de'), 'EUR');
  assert.strictEqual(currencyFromAcceptLanguage('fr'), 'EUR');
  assert.strictEqual(currencyFromAcceptLanguage('it'), 'EUR');
  assert.strictEqual(currencyFromAcceptLanguage('nl'), 'EUR');
  assert.strictEqual(currencyFromAcceptLanguage('pt'), 'EUR');
  assert.strictEqual(currencyFromAcceptLanguage('ja'), 'JPY');
}

function testUnknownRegionFallsThroughToLanguage() {
  // en-PH (Philippines) → no region currency, language 'en' is intentionally
  // unmapped, so the result must default to USD rather than crash.
  assert.strictEqual(currencyFromAcceptLanguage('en-PH'), 'USD');
  // de-LI (Liechtenstein) → no region currency, language 'de' fallback wins.
  assert.strictEqual(currencyFromAcceptLanguage('de-LI'), 'EUR');
}

function testWildcardTagIgnored() {
  assert.strictEqual(currencyFromAcceptLanguage('*'), 'USD');
  assert.strictEqual(currencyFromAcceptLanguage('*, en-US'), 'USD');
  // Wildcard must not hijack a real subsequent tag.
  assert.strictEqual(currencyFromAcceptLanguage('*, de-DE'), 'EUR');
}

function testQualityWeightSelectsHighest() {
  // de-DE at q=0.9, en-US at q=1 (implicit) → en-US wins.
  assert.strictEqual(
    currencyFromAcceptLanguage('de-DE;q=0.9, en-US'),
    'USD'
  );
  // de-DE at q=1, en-US at q=0.8 → de-DE wins (EUR).
  assert.strictEqual(
    currencyFromAcceptLanguage('de-DE, en-US;q=0.8'),
    'EUR'
  );
  // q=0 must drop the tag entirely.
  assert.strictEqual(
    currencyFromAcceptLanguage('en-US;q=0, de-DE;q=0.5'),
    'EUR'
  );
}

function testTieBreaksUseInputOrder() {
  // Both at q=1: first-listed wins.
  assert.strictEqual(
    currencyFromAcceptLanguage('en-GB, en-AU'),
    'GBP'
  );
  assert.strictEqual(
    currencyFromAcceptLanguage('en-AU, en-GB'),
    'AUD'
  );
}

function testMultiTagFallsThroughUnsupported() {
  // First tag has unsupported region but second has supported one — second wins.
  // (es-MX → unsupported; en-CA → CAD).
  assert.strictEqual(
    currencyFromAcceptLanguage('es-MX, en-CA;q=0.9'),
    'CAD'
  );
}

function testMalformedTagsDontCrash() {
  // Garbage tags must be ignored, not throw.
  assert.strictEqual(currencyFromAcceptLanguage(',,,'), 'USD');
  assert.strictEqual(currencyFromAcceptLanguage('123-XX'), 'USD');
  assert.strictEqual(currencyFromAcceptLanguage('!@#$%^&*'), 'USD');
  // Real tag mixed with garbage still resolves.
  assert.strictEqual(currencyFromAcceptLanguage('!!, en-GB'), 'GBP');
}

function testCaseInsensitiveRegion() {
  assert.strictEqual(currencyFromAcceptLanguage('en-gb'), 'GBP');
  assert.strictEqual(currencyFromAcceptLanguage('DE-de'), 'EUR');
  assert.strictEqual(currencyFromAcceptLanguage('JA-jp'), 'JPY');
}

function testHostileHeaderLengthCapped() {
  // A multi-kilobyte header must not blow up the parser. Pad past 1 KB and
  // place a real tag at the very start to ensure the cap doesn't drop the
  // real signal.
  const huge = 'en-GB,' + 'x'.repeat(50000);
  assert.strictEqual(currencyFromAcceptLanguage(huge), 'GBP',
    'parser must remain functional under hostile header lengths');
}

function testRegionToCurrencyHelper() {
  assert.strictEqual(regionToCurrency('US'), 'USD');
  assert.strictEqual(regionToCurrency('DE'), 'EUR');
  assert.strictEqual(regionToCurrency('XX'), null);
  assert.strictEqual(regionToCurrency(null), null);
  assert.strictEqual(regionToCurrency(''), null);
}

function testLanguageToCurrencyHelper() {
  assert.strictEqual(languageToCurrency('de'), 'EUR');
  assert.strictEqual(languageToCurrency('ja'), 'JPY');
  assert.strictEqual(languageToCurrency('en'), null);
  assert.strictEqual(languageToCurrency('zz'), null);
  assert.strictEqual(languageToCurrency(null), null);
}

function testEurozoneSetIncludesCanonicalMembers() {
  // Spot-check: any future renaming of the Set must not lose these.
  ['DE', 'FR', 'IT', 'ES', 'NL', 'AT', 'BE', 'IE', 'FI', 'PT'].forEach((r) => {
    assert.ok(EURO_REGIONS.has(r), `EURO_REGIONS missing ${r}`);
  });
}

// ---------- Route integration scaffold ----------------------------------

require.cache[require.resolve('bcrypt')] = {
  id: require.resolve('bcrypt'),
  filename: require.resolve('bcrypt'),
  loaded: true,
  exports: {
    hash: async (pw) => `hashed:${pw}`,
    compare: async (pw, hash) => hash === `hashed:${pw}`
  }
};

const usersById = new Map();
const usersByEmail = new Map();
const createUserCalls = [];
let nextId = 200;

function resetStore() {
  usersById.clear();
  usersByEmail.clear();
  createUserCalls.length = 0;
  nextId = 200;
}

const dbStub = {
  db: {
    async getUserByEmail(email) { return usersByEmail.get(email) || null; },
    async getUserById(id) { return usersById.get(id) || null; },
    async createUser({ email, password_hash, name, default_currency }) {
      createUserCalls.push({ email, password_hash, name, default_currency });
      const user = {
        id: nextId++, email, password_hash, name,
        plan: 'free', invoice_count: 0,
        default_currency: default_currency || 'USD'
      };
      usersById.set(user.id, user);
      usersByEmail.set(email, user);
      return user;
    },
    async createSeedInvoice() { return { id: 1, is_seed: true }; },
    async updateUser() { return null; }
  },
  pool: { query: async () => ({ rows: [] }) }
};

require.cache[require.resolve('../db')] = {
  id: require.resolve('../db'),
  filename: require.resolve('../db'),
  loaded: true,
  exports: dbStub
};

function clearReq(mod) { delete require.cache[require.resolve(mod)]; }
clearReq('../routes/auth');
const authRoutes = require('../routes/auth');

function buildApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, res, next) => { res.locals.user = req.session.user || null; next(); });
  app.use('/auth', authRoutes);
  return app;
}

function request(app, method, url, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const payload = body ? new URLSearchParams(body).toString() : '';
      const headers = Object.assign({}, extraHeaders || {});
      if (payload) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      const req = http.request({ hostname: '127.0.0.1', port, path: url, method, headers }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => {
          server.close(() => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
      });
      req.on('error', (err) => { server.close(); reject(err); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

async function testRegisterThreadsCurrencyFromAcceptLanguage() {
  resetStore();
  const app = buildApp();
  const res = await request(app, 'POST', '/auth/register',
    { name: 'Hans', email: 'hans@de.example', password: 'password123' },
    { 'Accept-Language': 'de-DE, en-US;q=0.8' });
  assert.strictEqual(res.status, 302, 'successful signup must redirect');
  assert.strictEqual(createUserCalls.length, 1, 'db.createUser must fire once');
  assert.strictEqual(createUserCalls[0].default_currency, 'EUR',
    'POST /auth/register must thread de-DE → EUR into createUser');
}

async function testRegisterDefaultsToUSDWithNoHeader() {
  resetStore();
  const app = buildApp();
  const res = await request(app, 'POST', '/auth/register',
    { name: 'Alice', email: 'alice@us.example', password: 'password123' },
    {} /* no Accept-Language */);
  assert.strictEqual(res.status, 302, 'successful signup must redirect');
  assert.strictEqual(createUserCalls[0].default_currency, 'USD',
    'missing Accept-Language must collapse to USD');
}

async function testRegisterGBPathThreadedThrough() {
  resetStore();
  const app = buildApp();
  await request(app, 'POST', '/auth/register',
    { name: 'Liz', email: 'liz@uk.example', password: 'password123' },
    { 'Accept-Language': 'en-GB,en;q=0.9' });
  assert.strictEqual(createUserCalls[0].default_currency, 'GBP');
}

async function testRegisterMagicThreadsCurrencyFromAcceptLanguage() {
  resetStore();
  const app = buildApp();
  const res = await request(app, 'POST', '/auth/register/magic',
    { name: 'Yuki', email: 'yuki@jp.example' },
    { 'Accept-Language': 'ja-JP' });
  // Magic registration renders an HTML "check your inbox" page (status 200)
  // rather than redirecting, but the user-create side-effect still fires.
  assert.ok(res.status === 200 || res.status === 302,
    `magic registration responded ${res.status}`);
  assert.strictEqual(createUserCalls.length, 1, 'db.createUser must fire on new magic signup');
  assert.strictEqual(createUserCalls[0].default_currency, 'JPY',
    'POST /auth/register/magic must thread ja-JP → JPY into createUser');
}

async function testRegisterMagicCollisionDoesNotCreateUser() {
  resetStore();
  // Pre-populate an existing user — magic signup must NOT create a duplicate
  // and therefore must NOT push a createUser call (where the currency would
  // overwrite an established preference).
  usersByEmail.set('existing@x.com', {
    id: 50, email: 'existing@x.com', password_hash: 'hashed:old',
    name: 'Old', plan: 'free', invoice_count: 0, default_currency: 'EUR'
  });
  const app = buildApp();
  await request(app, 'POST', '/auth/register/magic',
    { name: 'Imposter', email: 'existing@x.com' },
    { 'Accept-Language': 'en-US' });
  assert.strictEqual(createUserCalls.length, 0,
    'existing-account collision on magic register must not call createUser');
}

async function testRegisterValidationErrorSkipsCreateUser() {
  resetStore();
  const app = buildApp();
  await request(app, 'POST', '/auth/register',
    { name: '', email: 'bad', password: 'short' },
    { 'Accept-Language': 'fr-FR' });
  assert.strictEqual(createUserCalls.length, 0,
    'validation failure must short-circuit before db.createUser');
}

// ---------- Runner ------------------------------------------------------

async function run() {
  const tests = [
    ['DEFAULT_CURRENCY is USD', testDefaultCurrencyIsUSD],
    ['every derived currency is in the supported set', testEveryMappedCurrencyIsSupported],
    ['missing / empty header → USD', testHeaderMissingOrEmptyDefaultsToUSD],
    ['non-string header → USD', testHeaderNonStringDefaultsToUSD],
    ['direct region mapping (US/GB/CA/AU/NZ/JP/CH)', testRegionDirectMapping],
    ['eurozone regions → EUR', testEurozoneRegionsMapToEUR],
    ['language-only fallback (de/fr/it/nl/pt/ja)', testLanguageOnlyFallback],
    ['unknown region falls through to language map', testUnknownRegionFallsThroughToLanguage],
    ['wildcard tag is ignored', testWildcardTagIgnored],
    ['quality weight selects highest', testQualityWeightSelectsHighest],
    ['ties use input order', testTieBreaksUseInputOrder],
    ['multi-tag falls through unsupported region', testMultiTagFallsThroughUnsupported],
    ['malformed tags do not crash', testMalformedTagsDontCrash],
    ['case-insensitive region/language', testCaseInsensitiveRegion],
    ['hostile header length capped', testHostileHeaderLengthCapped],
    ['regionToCurrency helper', testRegionToCurrencyHelper],
    ['languageToCurrency helper', testLanguageToCurrencyHelper],
    ['EURO_REGIONS includes canonical members', testEurozoneSetIncludesCanonicalMembers],
    ['POST /auth/register threads de-DE → EUR', testRegisterThreadsCurrencyFromAcceptLanguage],
    ['POST /auth/register defaults to USD with no header', testRegisterDefaultsToUSDWithNoHeader],
    ['POST /auth/register threads en-GB → GBP', testRegisterGBPathThreadedThrough],
    ['POST /auth/register/magic threads ja-JP → JPY', testRegisterMagicThreadsCurrencyFromAcceptLanguage],
    ['POST /auth/register/magic existing-account collision skips createUser', testRegisterMagicCollisionDoesNotCreateUser],
    ['POST /auth/register validation error skips createUser', testRegisterValidationErrorSkipsCreateUser]
  ];

  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
      pass++;
    } catch (err) {
      console.error(`  FAIL ${name}`);
      console.error(err && err.stack ? err.stack : err);
      fail++;
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run().catch((err) => { console.error(err); process.exit(1); });
