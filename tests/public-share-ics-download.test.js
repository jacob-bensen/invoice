'use strict';

/*
 * "Add to calendar" .ics download tests for the public invoice share page
 * (Milestone 4 — first invoice sent → first payment received).
 *
 * Covers three layers:
 *   1. lib/calendar — pure formatters, RFC 5545 shape, text escape, fold,
 *      filename safety, null/edge inputs.
 *   2. routes/share.js GET /i/<token>/calendar.ics — bad-format 404,
 *      unknown-token 404, paid 404, draft 404, no-due-date 404, happy-path
 *      200 + Content-Type + Content-Disposition + Cache-Control + body shape.
 *   3. views/invoice-public.ejs — link visibility on sent/overdue/paid/draft
 *      statuses, suppression when no due_date, accessible label.
 *
 * Run: NODE_ENV=test node tests/public-share-ics-download.test.js
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

const assert = require('assert');
const path = require('path');
const ejs = require('ejs');
const express = require('express');
const http = require('http');

const VIEWS = path.join(__dirname, '..', 'views');

// ---------- lib/calendar pure formatters ---------------------------------

function testFormatIcsDateUtc() {
  delete require.cache[require.resolve('../lib/calendar')];
  const { formatIcsDate } = require('../lib/calendar');
  assert.strictEqual(formatIcsDate(new Date('2026-05-31T00:00:00Z')), '20260531');
  assert.strictEqual(formatIcsDate(new Date('2026-01-05T23:59:59Z')), '20260105');
  assert.strictEqual(formatIcsDate(new Date('2027-12-09T12:34:00Z')), '20271209');
  // String inputs are tolerated — pg returns due_date as a Date but legacy
  // / test stubs may pass ISO strings.
  assert.strictEqual(formatIcsDate('2026-05-31'), '20260531');
}

function testFormatIcsDateReturnsNullOnBadInput() {
  delete require.cache[require.resolve('../lib/calendar')];
  const { formatIcsDate } = require('../lib/calendar');
  assert.strictEqual(formatIcsDate(null), null);
  assert.strictEqual(formatIcsDate(undefined), null);
  assert.strictEqual(formatIcsDate(''), null);
  assert.strictEqual(formatIcsDate('not-a-date'), null);
  assert.strictEqual(formatIcsDate(new Date('garbage')), null);
}

function testFormatIcsDateTimeUtc() {
  delete require.cache[require.resolve('../lib/calendar')];
  const { formatIcsDateTime } = require('../lib/calendar');
  assert.strictEqual(
    formatIcsDateTime(new Date('2026-05-22T15:30:45Z')),
    '20260522T153045Z'
  );
  assert.strictEqual(
    formatIcsDateTime(new Date('2026-01-01T00:00:00Z')),
    '20260101T000000Z'
  );
  assert.strictEqual(formatIcsDateTime(null), null);
}

function testEscapeIcsTextRfc5545() {
  delete require.cache[require.resolve('../lib/calendar')];
  const { escapeIcsText } = require('../lib/calendar');
  assert.strictEqual(escapeIcsText('hello, world'), 'hello\\, world');
  assert.strictEqual(escapeIcsText('a;b;c'), 'a\\;b\\;c');
  assert.strictEqual(escapeIcsText('back\\slash'), 'back\\\\slash');
  assert.strictEqual(escapeIcsText('line1\nline2'), 'line1\\nline2');
  assert.strictEqual(escapeIcsText('line1\r\nline2'), 'line1\\nline2');
  assert.strictEqual(escapeIcsText('line1\rline2'), 'line1\\nline2');
  assert.strictEqual(escapeIcsText(null), '');
  assert.strictEqual(escapeIcsText(undefined), '');
  // Backslash escape runs first — a comma after a backslash escapes both
  // independently, NOT as a compound sequence.
  assert.strictEqual(escapeIcsText('a\\,b'), 'a\\\\\\,b');
}

function testFoldLineUnder75CharsUnchanged() {
  delete require.cache[require.resolve('../lib/calendar')];
  const { foldLine } = require('../lib/calendar');
  const short = 'SUMMARY:Invoice due';
  assert.strictEqual(foldLine(short), short, 'lines <=75 chars stay as one line');
}

function testFoldLineLongIsFolded() {
  delete require.cache[require.resolve('../lib/calendar')];
  const { foldLine } = require('../lib/calendar');
  const long = 'DESCRIPTION:' + 'x'.repeat(200);
  const folded = foldLine(long);
  const lines = folded.split('\r\n');
  assert.ok(lines.length >= 3, 'a 212-char line should fold into 3+ pieces');
  assert.strictEqual(lines[0].length, 75, 'first segment must be exactly 75 chars');
  for (let i = 1; i < lines.length; i++) {
    assert.strictEqual(lines[i][0], ' ',
      'continuation lines must start with a single space (RFC 5545 §3.1)');
    assert.ok(lines[i].length <= 75,
      'each continuation must fit in 75 chars including the leading space');
  }
  // Reconstructing (strip CRLF + leading space) recovers the original.
  const recovered = lines.map((l, i) => i === 0 ? l : l.slice(1)).join('');
  assert.strictEqual(recovered, long);
}

// ---------- lib/calendar buildInvoiceIcs ---------------------------------

function buildSampleInvoice(overrides) {
  return Object.assign({
    id: 5,
    invoice_number: 'INV-2026-0042',
    client_name: 'Acme Co.',
    total: 300,
    currency: 'USD',
    status: 'sent',
    due_date: new Date('2026-05-31T00:00:00Z'),
    public_token: 'cafef00ddeadbeef',
    owner_id: 11,
    owner_name: 'Jordan Pine',
    owner_email: 'jordan@example.com',
    owner_business_name: 'Pine Studio',
    owner_plan: 'pro'
  }, overrides || {});
}

function testBuildInvoiceIcsHappyPath() {
  delete require.cache[require.resolve('../lib/calendar')];
  const { buildInvoiceIcs } = require('../lib/calendar');
  const body = buildInvoiceIcs(buildSampleInvoice(), {
    now: new Date('2026-05-22T10:00:00Z'),
    appUrl: 'https://decentinvoice.com'
  });
  assert.ok(body, 'must build a non-null body');
  // RFC 5545 lines are CRLF-separated.
  assert.ok(body.endsWith('\r\n'), 'body must end with a trailing CRLF');
  assert.ok(body.includes('\r\n'), 'separator must be CRLF, not bare LF');
  assert.ok(body.startsWith('BEGIN:VCALENDAR'), 'must start with BEGIN:VCALENDAR');
  assert.ok(body.includes('VERSION:2.0'), 'must declare VERSION:2.0');
  assert.ok(body.includes('PRODID:'), 'must declare PRODID');
  assert.ok(body.includes('BEGIN:VEVENT'), 'must contain a VEVENT');
  assert.ok(body.includes('END:VEVENT'), 'must close the VEVENT');
  assert.ok(body.trim().endsWith('END:VCALENDAR'), 'must close with END:VCALENDAR');
}

function testBuildInvoiceIcsDtStartEndAllDay() {
  delete require.cache[require.resolve('../lib/calendar')];
  const { buildInvoiceIcs } = require('../lib/calendar');
  const body = buildInvoiceIcs(buildSampleInvoice(), {
    now: new Date('2026-05-22T10:00:00Z')
  });
  assert.ok(/DTSTART;VALUE=DATE:20260531/.test(body),
    'DTSTART must be VALUE=DATE for an all-day event on the due day');
  assert.ok(/DTEND;VALUE=DATE:20260601/.test(body),
    'DTEND must be the day AFTER DTSTART (RFC 5545 exclusive end)');
}

function testBuildInvoiceIcsCarriesDtStamp() {
  delete require.cache[require.resolve('../lib/calendar')];
  const { buildInvoiceIcs } = require('../lib/calendar');
  const body = buildInvoiceIcs(buildSampleInvoice(), {
    now: new Date('2026-05-22T10:00:00Z')
  });
  assert.ok(/DTSTAMP:20260522T100000Z/.test(body),
    'DTSTAMP must be the supplied now in UTC date-time form');
}

// Reverse RFC 5545 §3.1 line folding so content-property assertions can
// match across long DESCRIPTION fields that the encoder split at 75 chars.
function unfoldIcs(body) {
  return body.replace(/\r\n[ \t]/g, '');
}

function testBuildInvoiceIcsHasSummaryAndDescription() {
  delete require.cache[require.resolve('../lib/calendar')];
  const { buildInvoiceIcs } = require('../lib/calendar');
  const body = buildInvoiceIcs(buildSampleInvoice(), {
    now: new Date('2026-05-22T10:00:00Z'),
    appUrl: 'https://decentinvoice.com'
  });
  const unfolded = unfoldIcs(body);
  assert.ok(unfolded.includes('SUMMARY:Invoice INV-2026-0042 due'),
    'SUMMARY must name the invoice');
  assert.ok(unfolded.includes('Pine Studio'),
    'SUMMARY/DESCRIPTION must name the sender');
  assert.ok(/DESCRIPTION:[^\r\n]*INV-2026-0042/.test(unfolded),
    'DESCRIPTION must name the invoice');
  assert.ok(unfolded.includes('USD 300.00'),
    'DESCRIPTION must include the amount (currency + total)');
  assert.ok(unfolded.includes('https://decentinvoice.com/i/cafef00ddeadbeef'),
    'DESCRIPTION + URL fields must include the public share link');
}

function testBuildInvoiceIcsHasUrlProperty() {
  delete require.cache[require.resolve('../lib/calendar')];
  const { buildInvoiceIcs } = require('../lib/calendar');
  const body = buildInvoiceIcs(buildSampleInvoice(), {
    appUrl: 'https://decentinvoice.com/'
  });
  assert.ok(/\r\nURL:https:\/\/decentinvoice\.com\/i\/cafef00ddeadbeef\r\n/.test(body),
    'URL property must be on its own line, trailing slash on appUrl stripped');
}

function testBuildInvoiceIcsUidDeterministic() {
  delete require.cache[require.resolve('../lib/calendar')];
  const { buildInvoiceIcs } = require('../lib/calendar');
  const opts = { now: new Date('2026-05-22T10:00:00Z'), appUrl: 'https://decentinvoice.com' };
  const a = buildInvoiceIcs(buildSampleInvoice(), opts);
  const b = buildInvoiceIcs(buildSampleInvoice(), opts);
  const uidA = a.match(/\r\nUID:([^\r\n]+)\r\n/);
  const uidB = b.match(/\r\nUID:([^\r\n]+)\r\n/);
  assert.ok(uidA && uidB, 'both bodies must carry a UID');
  assert.strictEqual(uidA[1], uidB[1],
    'UID must be deterministic for the same invoice — re-imports update, not duplicate');
  assert.ok(/invoice-5-cafef00ddeadbeef@/.test(uidA[1]),
    'UID must include the invoice id + token');
}

function testBuildInvoiceIcsHasValarm() {
  delete require.cache[require.resolve('../lib/calendar')];
  const { buildInvoiceIcs } = require('../lib/calendar');
  const body = buildInvoiceIcs(buildSampleInvoice());
  assert.ok(/BEGIN:VALARM[\s\S]+TRIGGER:-P0DT12H[\s\S]+ACTION:DISPLAY[\s\S]+END:VALARM/.test(body),
    'must include a VALARM firing ~12h before the due day');
}

function testBuildInvoiceIcsNullOnNoDueDate() {
  delete require.cache[require.resolve('../lib/calendar')];
  const { buildInvoiceIcs } = require('../lib/calendar');
  assert.strictEqual(
    buildInvoiceIcs(buildSampleInvoice({ due_date: null })),
    null,
    'no due_date → null (nothing to remind about)'
  );
  assert.strictEqual(
    buildInvoiceIcs(buildSampleInvoice({ due_date: undefined })),
    null
  );
  assert.strictEqual(
    buildInvoiceIcs(buildSampleInvoice({ due_date: 'garbage' })),
    null,
    'unparseable due_date → null'
  );
}

function testBuildInvoiceIcsNullOnNoInvoice() {
  delete require.cache[require.resolve('../lib/calendar')];
  const { buildInvoiceIcs } = require('../lib/calendar');
  assert.strictEqual(buildInvoiceIcs(null), null);
  assert.strictEqual(buildInvoiceIcs(undefined), null);
  assert.strictEqual(buildInvoiceIcs('not-an-object'), null);
}

function testBuildInvoiceIcsEscapesHostileInput() {
  delete require.cache[require.resolve('../lib/calendar')];
  const { buildInvoiceIcs } = require('../lib/calendar');
  const body = buildInvoiceIcs(buildSampleInvoice({
    invoice_number: 'INV;2026,0042',
    owner_business_name: 'Hostile, Studio;\\Bad\nLine'
  }));
  // The hostile chars MUST NOT survive un-escaped inside the SUMMARY /
  // DESCRIPTION lines — calendar parsers would otherwise truncate the
  // event or treat the second half as a new property.
  const summaryLine = body.split('\r\n').find((l) => l.startsWith('SUMMARY:'));
  assert.ok(summaryLine, 'must find a SUMMARY line');
  assert.ok(!/[^\\];/.test(summaryLine.slice('SUMMARY:'.length)),
    'unescaped semicolons must not appear in SUMMARY');
  assert.ok(!/[^\\],/.test(summaryLine.slice('SUMMARY:'.length)),
    'unescaped commas must not appear in SUMMARY');
  assert.ok(!summaryLine.includes('\n'),
    'unescaped newlines must not appear in SUMMARY');
  assert.ok(summaryLine.includes('\\;'), 'semicolons must be escaped');
  assert.ok(summaryLine.includes('\\,'), 'commas must be escaped');
}

function testBuildInvoiceIcsFallsBackToInvoiceNumberPlaceholder() {
  delete require.cache[require.resolve('../lib/calendar')];
  const { buildInvoiceIcs } = require('../lib/calendar');
  const body = buildInvoiceIcs(buildSampleInvoice({
    invoice_number: '',
    owner_business_name: null,
    owner_name: null,
    owner_email: null
  }));
  assert.ok(body, 'must still build something when branding fields are empty');
  assert.ok(/SUMMARY:[^\r\n]*DecentInvoice/.test(body),
    'sender label must fall back to "DecentInvoice" when all owner fields are blank');
}

function testBuildInvoiceIcsFilenameSafety() {
  delete require.cache[require.resolve('../lib/calendar')];
  const { buildIcsFilename } = require('../lib/calendar');
  assert.strictEqual(buildIcsFilename({ invoice_number: 'INV-2026-0042' }),
    'INV-2026-0042-due.ics');
  assert.strictEqual(buildIcsFilename({ invoice_number: 'INV/2026/0042' }),
    'INV_2026_0042-due.ics', 'forward slashes neutralised');
  assert.strictEqual(buildIcsFilename({ invoice_number: '../../../etc/passwd' }),
    '.._.._.._etc_passwd-due.ics', 'path traversal neutralised');
  assert.strictEqual(buildIcsFilename({ invoice_number: 'INV 你好' }),
    'invoice-due.ics', 'non-ASCII falls back to "invoice"');
  assert.strictEqual(buildIcsFilename({}), 'invoice-due.ics');
  assert.strictEqual(buildIcsFilename(null), 'invoice-due.ics');
}

// ---------- route: GET /i/:token/calendar.ics ----------------------------

function buildShareApp({ invoiceRow, lookupThrows }) {
  const dbStub = {
    pool: { query: async () => ({ rows: [] }) },
    db: {
      async getInvoiceByPublicToken(token) {
        if (lookupThrows) throw new Error('boom');
        if (!/^[a-f0-9]{8,32}$/i.test(token || '')) return null;
        return invoiceRow;
      },
      async recordPublicInvoiceView() { return null; }
    }
  };
  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'), filename: require.resolve('../db'),
    loaded: true, exports: dbStub
  };
  delete require.cache[require.resolve('../routes/share')];
  const shareRoutes = require('../routes/share');
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', VIEWS);
  app.use('/', shareRoutes);
  return app;
}

function getPath(app, urlPath) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      http.get({ hostname: '127.0.0.1', port, path: urlPath }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => server.close(() => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data
        })));
      }).on('error', (e) => { server.close(); reject(e); });
    });
  });
}

async function testRouteHappyPath() {
  process.env.APP_URL = 'https://decentinvoice.com';
  const app = buildShareApp({ invoiceRow: buildSampleInvoice() });
  const r = await getPath(app, '/i/cafef00ddeadbeef/calendar.ics');
  delete process.env.APP_URL;
  assert.strictEqual(r.status, 200, 'happy path returns 200');
  assert.ok(/text\/calendar/.test(r.headers['content-type'] || ''),
    'Content-Type must be text/calendar');
  assert.ok(/charset=utf-8/i.test(r.headers['content-type'] || ''),
    'Content-Type must declare utf-8');
  assert.ok(/attachment/.test(r.headers['content-disposition'] || ''),
    'Content-Disposition must be attachment (forces download, not inline render)');
  assert.ok(/filename="INV-2026-0042-due\.ics"/.test(r.headers['content-disposition'] || ''),
    'filename must include the invoice number');
  assert.strictEqual(r.headers['cache-control'], 'no-store',
    'Cache-Control must be no-store — due-date edits should not be cached');
  assert.strictEqual(r.headers['x-robots-tag'], 'noindex',
    'X-Robots-Tag must be noindex on the .ics artifact');
  assert.ok(r.body.includes('BEGIN:VCALENDAR'), 'body is RFC 5545');
  assert.ok(r.body.includes('INV-2026-0042'), 'body names the invoice');
  assert.ok(r.body.includes('DTSTART;VALUE=DATE:20260531'),
    'body carries the due date');
}

async function testRoute404OnBadTokenFormat() {
  const app = buildShareApp({ invoiceRow: buildSampleInvoice() });
  const r = await getPath(app, '/i/not-hex!/calendar.ics');
  assert.strictEqual(r.status, 404,
    'bad-format token returns 404, not 500');
}

async function testRoute404OnMissingInvoice() {
  const app = buildShareApp({ invoiceRow: null });
  const r = await getPath(app, '/i/cafef00ddeadbeef/calendar.ics');
  assert.strictEqual(r.status, 404,
    'valid-format but unknown token returns 404');
}

async function testRoute404OnPaidInvoice() {
  const app = buildShareApp({
    invoiceRow: buildSampleInvoice({ status: 'paid' })
  });
  const r = await getPath(app, '/i/cafef00ddeadbeef/calendar.ics');
  assert.strictEqual(r.status, 404,
    'paid invoices have no upcoming reminder — 404');
}

async function testRoute404OnDraftInvoice() {
  const app = buildShareApp({
    invoiceRow: buildSampleInvoice({ status: 'draft' })
  });
  const r = await getPath(app, '/i/cafef00ddeadbeef/calendar.ics');
  assert.strictEqual(r.status, 404,
    'draft invoices are pre-share state — 404');
}

async function testRoute404OnNoDueDate() {
  const app = buildShareApp({
    invoiceRow: buildSampleInvoice({ due_date: null })
  });
  const r = await getPath(app, '/i/cafef00ddeadbeef/calendar.ics');
  assert.strictEqual(r.status, 404,
    'no due_date → nothing to remind about → 404');
}

async function testRoute200OnOverdueInvoice() {
  // An overdue invoice still gets a calendar download — the due date is in
  // the past but the reminder context ("this was due") is still useful to
  // the client. The route exposes it; the view layer separately decides
  // whether to surface the link, which it does for both 'sent' and 'overdue'.
  const app = buildShareApp({
    invoiceRow: buildSampleInvoice({ status: 'overdue' })
  });
  const r = await getPath(app, '/i/cafef00ddeadbeef/calendar.ics');
  assert.strictEqual(r.status, 200,
    'overdue invoices still serve the .ics (status mirrors the view-layer affordance)');
  assert.ok(r.body.includes('BEGIN:VCALENDAR'));
}

async function testRoute500OnDbThrow() {
  const app = buildShareApp({ invoiceRow: null, lookupThrows: true });
  const r = await getPath(app, '/i/cafef00ddeadbeef/calendar.ics');
  assert.strictEqual(r.status, 500,
    'db throw renders a 500, not a 200 with empty body');
}

// ---------- view: views/invoice-public.ejs link visibility ---------------

async function renderPublic(invoiceRow, extras) {
  return ejs.renderFile(path.join(VIEWS, 'invoice-public.ejs'),
    Object.assign({
      invoice: invoiceRow,
      title: 't',
      noindex: true,
      csrfToken: 'csrf-test-token'
    }, extras || {}),
    { views: [VIEWS] }
  );
}

async function testViewShowsLinkOnSentInvoice() {
  const html = await renderPublic(buildSampleInvoice({ status: 'sent' }));
  assert.ok(html.includes('data-testid="public-calendar-download"'),
    'sent invoice with a due date must surface the calendar download link');
  assert.ok(/href="\/i\/cafef00ddeadbeef\/calendar\.ics"/.test(html),
    'href must point at the .ics route with the public token');
  // Locate the opening <a> tag of the calendar link and check that
  // `download` appears inside it (attribute order varies with EJS output).
  const anchorMatch = html.match(/<a\b([^>]*data-testid="public-calendar-download"[^>]*)>/);
  assert.ok(anchorMatch, 'must locate the <a> tag carrying the testid');
  assert.ok(/\bdownload\b/.test(anchorMatch[1]),
    'link must carry the download attribute so browsers save instead of navigating');
  assert.ok(/aria-label="[^"]*calendar[^"]*"/i.test(html),
    'link must carry an aria-label mentioning "calendar"');
}

async function testViewShowsLinkOnOverdueInvoice() {
  const html = await renderPublic(buildSampleInvoice({ status: 'overdue' }));
  assert.ok(html.includes('data-testid="public-calendar-download"'),
    'overdue invoices must still surface the calendar download (recovery context)');
}

async function testViewSuppressesLinkOnPaidInvoice() {
  const html = await renderPublic(buildSampleInvoice({ status: 'paid' }));
  assert.ok(!html.includes('data-testid="public-calendar-download"'),
    'paid invoices have no upcoming action — link must be suppressed');
}

async function testViewSuppressesLinkOnDraftInvoice() {
  const html = await renderPublic(buildSampleInvoice({ status: 'draft' }));
  assert.ok(!html.includes('data-testid="public-calendar-download"'),
    'draft invoices are pre-share state — link must be suppressed');
}

async function testViewSuppressesLinkWhenNoDueDate() {
  const html = await renderPublic(buildSampleInvoice({ due_date: null }));
  assert.ok(!html.includes('data-testid="public-calendar-download"'),
    'no due_date → no calendar event → link must be suppressed');
}

async function testViewSuppressesLinkWhenNoPublicToken() {
  // Belt-and-braces: the public template should only ever render for a
  // row with a public_token (the route fetches by token), but a future
  // refactor that calls the template via a different path mustn't ship a
  // broken `/i//calendar.ics` link.
  const html = await renderPublic(buildSampleInvoice({ public_token: null }));
  assert.ok(!html.includes('data-testid="public-calendar-download"'),
    'no public_token → no usable URL → link must be suppressed');
}

async function testViewLinkCarriesPrintHidden() {
  // The link lives inside the print bar wrapper which already carries
  // print:hidden. Assert by locating the wrapper + the class list.
  const html = await renderPublic(buildSampleInvoice({ status: 'sent' }));
  const m = html.match(/<div[^>]*data-testid="public-print-bar"[^>]*class="([^"]*)"/);
  const m2 = html.match(/<div[^>]*class="([^"]*)"[^>]*data-testid="public-print-bar"/);
  const classes = (m && m[1]) || (m2 && m2[1]) || '';
  assert.ok(/\bprint:hidden\b/.test(classes),
    'print bar (which wraps the calendar link) must carry print:hidden');
}

async function testViewLinkRendersBeforeSaveAsPdf() {
  const html = await renderPublic(buildSampleInvoice({ status: 'sent' }));
  const calIdx = html.indexOf('data-testid="public-calendar-download"');
  const pdfIdx = html.indexOf('data-testid="public-print-button"');
  assert.ok(calIdx > 0 && pdfIdx > 0, 'both surfaces present');
  assert.ok(calIdx < pdfIdx,
    'calendar link should render BEFORE the Save-as-PDF button (calendar is the action-bias surface, PDF is the archive surface)');
}

async function testViewPreservesExistingPdfButton() {
  // The calendar link must NOT have broken or replaced the existing
  // window.print() PDF button — regression guard against accidental
  // removal.
  const html = await renderPublic(buildSampleInvoice({ status: 'sent' }));
  assert.ok(html.includes('data-testid="public-print-button"'),
    'existing Save-as-PDF button must still render');
  assert.ok(/onclick="window\.print\(\)"/.test(html),
    'PDF button must still trigger window.print()');
}

// ---------- runner -------------------------------------------------------

async function run() {
  const tests = [
    // lib/calendar formatters
    ['lib: formatIcsDate emits YYYYMMDD UTC', testFormatIcsDateUtc],
    ['lib: formatIcsDate returns null on bad inputs', testFormatIcsDateReturnsNullOnBadInput],
    ['lib: formatIcsDateTime emits YYYYMMDDTHHMMSSZ UTC', testFormatIcsDateTimeUtc],
    ['lib: escapeIcsText handles RFC 5545 special chars', testEscapeIcsTextRfc5545],
    ['lib: foldLine leaves short lines unchanged', testFoldLineUnder75CharsUnchanged],
    ['lib: foldLine folds long lines per RFC 5545 §3.1', testFoldLineLongIsFolded],
    // buildInvoiceIcs
    ['lib: buildInvoiceIcs happy path emits RFC 5545 envelope', testBuildInvoiceIcsHappyPath],
    ['lib: buildInvoiceIcs DTSTART/DTEND span the all-day due date', testBuildInvoiceIcsDtStartEndAllDay],
    ['lib: buildInvoiceIcs DTSTAMP carries supplied now in UTC', testBuildInvoiceIcsCarriesDtStamp],
    ['lib: buildInvoiceIcs SUMMARY+DESCRIPTION name invoice/amount/URL', testBuildInvoiceIcsHasSummaryAndDescription],
    ['lib: buildInvoiceIcs URL property carries public share link', testBuildInvoiceIcsHasUrlProperty],
    ['lib: buildInvoiceIcs UID is deterministic per invoice+token', testBuildInvoiceIcsUidDeterministic],
    ['lib: buildInvoiceIcs includes VALARM with 12h trigger', testBuildInvoiceIcsHasValarm],
    ['lib: buildInvoiceIcs returns null when due_date missing/garbage', testBuildInvoiceIcsNullOnNoDueDate],
    ['lib: buildInvoiceIcs returns null when invoice missing', testBuildInvoiceIcsNullOnNoInvoice],
    ['lib: buildInvoiceIcs escapes hostile RFC 5545 chars', testBuildInvoiceIcsEscapesHostileInput],
    ['lib: buildInvoiceIcs falls back to DecentInvoice when branding empty', testBuildInvoiceIcsFallsBackToInvoiceNumberPlaceholder],
    ['lib: buildIcsFilename sanitises invoice numbers safely', testBuildInvoiceIcsFilenameSafety],
    // route
    ['route: 200 with Content-Type/Disposition/Cache headers + RFC body', testRouteHappyPath],
    ['route: 404 on bad-format token (no DB call)', testRoute404OnBadTokenFormat],
    ['route: 404 on valid-format but missing invoice', testRoute404OnMissingInvoice],
    ['route: 404 on paid invoice (nothing upcoming)', testRoute404OnPaidInvoice],
    ['route: 404 on draft invoice (pre-share state)', testRoute404OnDraftInvoice],
    ['route: 404 when invoice has no due_date', testRoute404OnNoDueDate],
    ['route: 200 on overdue invoice (recovery surface)', testRoute200OnOverdueInvoice],
    ['route: 500 on db throw (not silent empty body)', testRoute500OnDbThrow],
    // view
    ['view: link renders on sent invoice with due_date', testViewShowsLinkOnSentInvoice],
    ['view: link renders on overdue invoice', testViewShowsLinkOnOverdueInvoice],
    ['view: link suppressed on paid invoice', testViewSuppressesLinkOnPaidInvoice],
    ['view: link suppressed on draft invoice', testViewSuppressesLinkOnDraftInvoice],
    ['view: link suppressed when no due_date', testViewSuppressesLinkWhenNoDueDate],
    ['view: link suppressed when no public_token', testViewSuppressesLinkWhenNoPublicToken],
    ['view: print bar wrapping the link carries print:hidden', testViewLinkCarriesPrintHidden],
    ['view: calendar link renders before Save-as-PDF button', testViewLinkRendersBeforeSaveAsPdf],
    ['view: existing Save-as-PDF button untouched', testViewPreservesExistingPdfButton]
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
