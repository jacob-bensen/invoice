'use strict';

const fs = require('fs');
const path = require('path');

// Load once at require-time. The fixture lives in data/competitor-pricing.json
// alongside the source so the comparison strip on /billing/upgrade and the
// homepage pricing section can read a single source of truth without per-
// request file I/O. Tests can call getCompetitorPricing() and walk the same
// shape the views see.
const FIXTURE_PATH = path.join(__dirname, '..', 'data', 'competitor-pricing.json');
const data = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
const FEATURE_KEYS = Object.keys(data.featureLabels || {});

function getCompetitorPricing() {
  return data;
}

function getFeatureKeys() {
  return FEATURE_KEYS.slice();
}

module.exports = {
  getCompetitorPricing,
  getFeatureKeys
};
