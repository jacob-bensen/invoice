'use strict';

/*
 * Static "Suggested services" presets surfaced on /invoices/new for
 * brand-new users with no recent-items history (Milestone 2 — first
 * dashboard re-entry → first real invoice created).
 *
 * The existing recent-items dropdown on /invoices/new only shows when
 * `db.getRecentItemsForUser` returns at least one non-seed row. A day-zero
 * freelancer has zero non-seed invoices and therefore zero recent items,
 * which leaves the Line Items section as a blank set of fields. That blank-
 * form moment is one of the highest-friction beats in the activation
 * funnel: the user has to invent a description AND a price from scratch.
 *
 * This list seeds the eight most common freelance billing categories with
 * sensible mid-market unit prices, so the new user can pick one and edit
 * the result rather than starting from nothing. Descriptions are deliberately
 * generic ("Logo design", "Hourly consulting") and prices land in the
 * defensible-middle of the typical US freelance range — they're a starting
 * point the user is expected to override, not a recommendation.
 *
 * Shape mirrors db.getRecentItemsForUser so the Alpine factory can re-use
 * the same fill semantics: { description, quantity, unit_price } per row.
 */

const SERVICE_PRESETS = Object.freeze([
  Object.freeze({ description: 'Logo design', quantity: 1, unit_price: 250 }),
  Object.freeze({ description: 'Website design (per page)', quantity: 1, unit_price: 500 }),
  Object.freeze({ description: 'Hourly consulting', quantity: 1, unit_price: 100 }),
  Object.freeze({ description: 'Hourly development', quantity: 1, unit_price: 125 }),
  Object.freeze({ description: 'Social media post', quantity: 1, unit_price: 75 }),
  Object.freeze({ description: 'Blog article (500 words)', quantity: 1, unit_price: 200 }),
  Object.freeze({ description: 'Photography session', quantity: 1, unit_price: 300 }),
  Object.freeze({ description: 'Monthly retainer', quantity: 1, unit_price: 1000 })
]);

module.exports = { SERVICE_PRESETS };
