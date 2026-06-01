'use strict';

/*
 * Operator-only routes (no nav surface, no full RBAC). Gated on
 * `OPERATOR_EMAIL` env var + the session user's email. When OPERATOR_EMAIL
 * is unset, or the requester's email doesn't match, the route renders a
 * 404 so the URL surface stays invisible — no enumeration of what an
 * operator can see.
 *
 * Currently hosts:
 *   GET /admin/activation        HTML funnel report
 *   GET /admin/activation.json   Machine-readable cohort counts + ratios
 *   GET /admin/activation.csv    Spreadsheet-ready CSV of all three sections
 *
 * All three accept ?from=YYYY-MM-DD&to=YYYY-MM-DD; default window is the
 * trailing 30 days. The CSV export is the trend-tracking surface for the
 * PLAN.md "Done means" gate: operators pull weekly snapshots into a
 * spreadsheet to verify positive day-over-day flow across cohorts.
 */

const express = require('express');
const { db } = require('../db');
const {
  buildReport,
  buildReportCsv,
  formatPct,
  isOperator
} = require('../lib/activation-funnel');

const router = express.Router();

function notFound(req, res) {
  res.status(404);
  const homeHref = req.session && req.session.user ? '/invoices' : '/';
  const homeLabel = req.session && req.session.user ? 'Back to your invoices' : 'Go to home page';
  return res.render('not-found', {
    title: 'Page not found — DecentInvoice',
    homeHref,
    homeLabel,
    noindex: true
  });
}

function gate(req, res) {
  if (!req.session || !req.session.user) return false;
  if (!isOperator(req.session.user)) return false;
  return true;
}

function csvFilename(report) {
  const safeFrom = (report && report.range && report.range.from) || 'unknown';
  const safeTo = (report && report.range && report.range.to) || 'unknown';
  return `decentinvoice-activation-${safeFrom}_${safeTo}.csv`;
}

async function handleActivation(req, res, format) {
  if (!gate(req, res)) {
    if (format === 'json') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (format === 'csv') {
      res.status(404).type('text/plain').send('not_found');
      return;
    }
    return notFound(req, res);
  }

  let report;
  try {
    report = await buildReport(db, req.query);
  } catch (err) {
    if (format === 'json') {
      res.status(500).json({ error: 'report_failed', message: err && err.message });
      return;
    }
    if (format === 'csv') {
      res.status(500).type('text/plain').send('report_failed');
      return;
    }
    res.status(500);
    return res.render('admin/activation', {
      title: 'Activation funnel — DecentInvoice',
      noindex: true,
      error: 'report_failed',
      errorMessage: err && err.message,
      report: null,
      formatPct
    });
  }

  if (report.error) {
    if (format === 'json') {
      res.status(400).json({ error: report.error });
      return;
    }
    if (format === 'csv') {
      res.status(400).type('text/plain').send(report.error);
      return;
    }
    res.status(400);
    return res.render('admin/activation', {
      title: 'Activation funnel — DecentInvoice',
      noindex: true,
      error: report.error,
      errorMessage: null,
      report: null,
      formatPct
    });
  }

  if (format === 'json') {
    res.json(report);
    return;
  }
  if (format === 'csv') {
    const csv = buildReportCsv(report);
    res.status(200);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${csvFilename(report)}"`);
    // Defence-in-depth: operator reports must never be cached by an
    // intermediate proxy — a stale CSV would silently mislead the
    // "positive day-over-day flow" verification.
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(csv);
    return;
  }
  res.render('admin/activation', {
    title: 'Activation funnel — DecentInvoice',
    noindex: true,
    error: null,
    errorMessage: null,
    report,
    formatPct
  });
}

router.get('/activation', (req, res) => handleActivation(req, res, 'html'));
router.get('/activation.json', (req, res) => handleActivation(req, res, 'json'));
router.get('/activation.csv', (req, res) => handleActivation(req, res, 'csv'));

module.exports = router;
module.exports.handleActivation = handleActivation;
