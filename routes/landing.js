'use strict';

/*
 * SEO niche landing pages for freelancer verticals (INTERNAL_TODO #8).
 *
 * Each niche route renders the shared views/partials/lp-niche.ejs partial with
 * vertical-specific copy — headline, audience, benefits, example invoice
 * fields, and FAQ. The goal is long-tail organic search traffic for queries
 * like "invoice template freelance designer" or "consultant invoice template".
 *
 * The slug + metadata live in a single NICHES map so tests, the sitemap, and
 * the route handlers share one source of truth.
 */

const express = require('express');

const router = express.Router();

const NICHES = {
  'freelance-designer': {
    title: 'Free Invoice Template for Freelance Designers · QuickInvoice',
    audience: 'designers',
    singular: 'designer',
    headline: 'Invoicing built for freelance designers.',
    description:
      'Bill for logos, web design, and brand work with clean, professional invoices your clients actually look at. Download as PDF. No subscription to start.',
    subheadline:
      'Designers obsess over pixel-perfect work; their invoices shouldn\'t look like a Word doc from 2004.',
    benefits: [
      { icon: '🎨', title: 'Clean, on-brand PDFs', body: 'Professional invoice layout that matches the care you put into client work. Add your logo and brand color on Pro.' },
      { icon: '⚡', title: 'Line items in seconds', body: 'Add "Logo concepts · 3" or "Brand guidelines PDF" as separate lines. Quantities, rates, and totals update live.' },
      { icon: '💳', title: 'Get paid by card', body: 'Pro invoices carry a Stripe Payment Link so clients can pay by card in one click — no bank-transfer chasing.' }
    ],
    exampleInvoice: {
      businessName: 'Studio Lumen',
      businessTagline: 'Brand & visual identity',
      clientName: 'Greenleaf Bakery Co.',
      lineItems: [
        { description: 'Logo design — 3 concepts + 2 revisions', quantity: 1, rate: '1,800.00', amount: '1,800.00' },
        { description: 'Brand guidelines PDF', quantity: 1, rate: '650.00', amount: '650.00' },
        { description: 'Business card design', quantity: 1, rate: '250.00', amount: '250.00' }
      ],
      total: '2,700.00'
    },
    faq: [
      { q: 'Do I need to know accounting to use this?', a: 'No. Fill in client, line items, rates, and download the PDF. QuickInvoice does the math and tracks payment status for you.' },
      { q: 'Can I add a deposit or 50/50 split invoice?', a: 'Yes. Create two invoices — the first for the deposit amount, the second for the balance. Both live in the same client view so you can track totals.' },
      { q: 'Will clients see "QuickInvoice" on the PDF?', a: 'Free-plan PDFs carry a small attribution footer. Pro-plan invoices are 100% your brand — your logo, your color, your business info only.' }
    ]
  },

  'freelance-developer': {
    title: 'Free Invoice Template for Freelance Developers · QuickInvoice',
    audience: 'developers',
    singular: 'developer',
    headline: 'Invoicing that fits how developers work.',
    description:
      'Hourly, milestone, or retainer — QuickInvoice handles all three. Add line items, mark paid, move on to the next ticket.',
    subheadline:
      'Built for the side project that grew into three clients, not the agency with an accounting department.',
    benefits: [
      { icon: '⏱️', title: 'Hourly or fixed', body: 'Enter hours × rate, or a flat milestone fee. Tax, discount, and notes fields are optional — use them only when you need them.' },
      { icon: '🔁', title: 'Retainer-friendly', body: 'Clone last month\'s invoice and change the date. Repeat clients take 20 seconds to bill.' },
      { icon: '🔌', title: 'Payment + Zapier hooks', body: 'Pro tier fires a webhook the moment an invoice is paid — drop it into Zapier, Slack, or your accounting tool.' }
    ],
    exampleInvoice: {
      businessName: 'Kernel & Co.',
      businessTagline: 'Full-stack development',
      clientName: 'Orbit Labs Inc.',
      lineItems: [
        { description: 'Backend development — sprint 14', quantity: 28, rate: '95.00', amount: '2,660.00' },
        { description: 'Production incident response (after hours)', quantity: 3, rate: '150.00', amount: '450.00' },
        { description: 'Code review + pairing session', quantity: 2, rate: '95.00', amount: '190.00' }
      ],
      total: '3,300.00'
    },
    faq: [
      { q: 'Can I invoice in multiple currencies?', a: 'QuickInvoice invoices default to your business currency. You can override the currency per invoice in the line-item description if needed.' },
      { q: 'Is there an API?', a: 'Pro plans include an outbound webhook on invoice-paid events — the lowest-common-denominator integration for any tool on Earth.' },
      { q: 'Can I self-host this?', a: 'QuickInvoice is a hosted SaaS. If you need on-prem invoicing, the freelance-developer niche isn\'t the worst audience to ask about it — send us a note.' }
    ]
  },

  'freelance-writer': {
    title: 'Free Invoice Template for Freelance Writers · QuickInvoice',
    audience: 'writers',
    singular: 'writer',
    headline: 'Invoicing for freelance writers.',
    description:
      'Bill per word, per article, or per retainer. Send professional invoices that get paid faster — and stop chasing editors for late cheques.',
    subheadline:
      'You\'d rather be writing than chasing payment. QuickInvoice makes "send the invoice" a 60-second task.',
    benefits: [
      { icon: '✍️', title: 'Per-word or per-piece', body: 'Line items support any unit — "Words × $0.50", "Articles × $350", or a flat monthly retainer.' },
      { icon: '📬', title: 'Email-ready PDFs', body: 'Download the PDF, drop it into your email to the editor. Done. No printer, no scanner, no fax machine from 1997.' },
      { icon: '📅', title: 'Overdue alerts', body: 'QuickInvoice shows you what\'s outstanding on every dashboard load — no more "wait, did that March piece get paid?"' }
    ],
    exampleInvoice: {
      businessName: 'Margaret Cole',
      businessTagline: 'Writer · Editor · Copy strategy',
      clientName: 'Atlas Quarterly',
      lineItems: [
        { description: '"The Case for Slow Software" — 2,800 words', quantity: 2800, rate: '0.50', amount: '1,400.00' },
        { description: 'Editorial revisions (two rounds)', quantity: 1, rate: '200.00', amount: '200.00' },
        { description: 'Kill fee — spiked pitch', quantity: 1, rate: '150.00', amount: '150.00' }
      ],
      total: '1,750.00'
    },
    faq: [
      { q: 'How do I invoice for a kill fee?', a: 'Add a line item named "Kill fee" with the agreed amount. Most standard contracts put this between 25% and 50% of the assigned fee.' },
      { q: 'Can I add net-30 payment terms?', a: 'Yes. Set the due date on the invoice; the PDF shows "Due: [date]" and the dashboard flags overdue invoices automatically.' },
      { q: 'What if the publication pays via a third-party platform?', a: 'Send them the QuickInvoice PDF for their records, then mark the invoice paid manually once the platform deposit clears.' }
    ]
  },

  'freelance-photographer': {
    title: 'Free Invoice Template for Freelance Photographers · QuickInvoice',
    audience: 'photographers',
    singular: 'photographer',
    headline: 'Invoices for freelance photographers.',
    description:
      'Weddings, shoots, commercial licensing — line items, deposits, usage rights, and print add-ons. Ready for the next Saturday booking.',
    subheadline:
      'Your clients remember the photos; they also remember how easy the paperwork was.',
    benefits: [
      { icon: '📸', title: 'Shoot + edit + licence', body: 'Separate shoot day, post-production, and usage licence as three line items. Clients see exactly what they\'re paying for.' },
      { icon: '💰', title: 'Deposits made easy', body: 'Send a deposit invoice, mark it paid, then send the balance invoice after the shoot. Both live under the same client.' },
      { icon: '🖨️', title: 'Print & deliver', body: 'Every invoice downloads to a print-ready PDF. Hand it to the client in person or email it on the way home from the venue.' }
    ],
    exampleInvoice: {
      businessName: 'Rowan Pine Photography',
      businessTagline: 'Weddings · Events · Portraits',
      clientName: 'Sarah & James Whitlow',
      lineItems: [
        { description: 'Wedding day coverage — 8 hours', quantity: 1, rate: '2,400.00', amount: '2,400.00' },
        { description: 'Photo editing + online gallery', quantity: 1, rate: '600.00', amount: '600.00' },
        { description: '20×30 framed print (optional add-on)', quantity: 1, rate: '280.00', amount: '280.00' },
        { description: 'Travel & accommodation', quantity: 1, rate: '320.00', amount: '320.00' }
      ],
      total: '3,600.00'
    },
    faq: [
      { q: 'How do I invoice a deposit and the balance separately?', a: 'Create two invoices under the same client — the first for the deposit (often 25–50%) with an early due date, and the second for the balance due on the shoot date.' },
      { q: 'Can I charge for usage rights separately?', a: 'Yes. Add "Commercial usage licence — 1 year" as a dedicated line item with its own rate. Puts the value of the licence in front of the client in writing.' },
      { q: 'Do invoices include a contract?', a: 'QuickInvoice handles the invoice side only; use your usual contract tool for the shoot agreement and reference the invoice number in the contract.' }
    ]
  },

  'consultant': {
    title: 'Free Invoice Template for Consultants · QuickInvoice',
    audience: 'consultants',
    singular: 'consultant',
    headline: 'Consultant-grade invoices, without the agency overhead.',
    description:
      'Retainer, project, or hourly — QuickInvoice sends clean, professional invoices that match your day rate. Built for independent consultants.',
    subheadline:
      'You charge $200/hour. Your invoicing tool should not look like it was made for a lemonade stand.',
    benefits: [
      { icon: '💼', title: 'Retainer-ready', body: 'Monthly retainer invoices take 20 seconds — clone last month, change the date, send. The dashboard shows who\'s still on retainer.' },
      { icon: '📈', title: 'Revenue at a glance', body: 'Dashboard shows total invoiced, collected, and outstanding — ideal for the end-of-quarter tax conversation.' },
      { icon: '🏢', title: 'Enterprise-friendly', body: 'Custom PO numbers, NET-30 terms, and a tidy print-ready PDF that won\'t embarrass you in Accounts Payable\'s inbox.' }
    ],
    exampleInvoice: {
      businessName: 'Harbor Street Advisory',
      businessTagline: 'Strategy & operations consulting',
      clientName: 'Northwind Industries, Inc.',
      lineItems: [
        { description: 'Monthly retainer — strategy review', quantity: 1, rate: '4,500.00', amount: '4,500.00' },
        { description: 'Board prep session (2 hours)', quantity: 2, rate: '350.00', amount: '700.00' },
        { description: 'Executive workshop — Q2 planning', quantity: 1, rate: '2,800.00', amount: '2,800.00' }
      ],
      total: '8,000.00'
    },
    faq: [
      { q: 'Can I invoice against a PO number?', a: 'Yes — add the PO in the Notes field and it appears on the PDF. Accounts Payable teams need it to process payment.' },
      { q: 'Do you support NET-30, NET-60, or custom terms?', a: 'Set any due date you want on the invoice. The dashboard shows overdue amounts automatically once the due date passes.' },
      { q: 'Can I downgrade or cancel any time?', a: 'Yes. Pro is month-to-month via Stripe. Annual plans save 31%. Cancel in one click from the Stripe Customer Portal — your data stays.' }
    ]
  },

  'invoice-generator': {
    title: 'Free Online Invoice Generator · QuickInvoice',
    audience: 'freelancers',
    singular: 'freelancer',
    headline: 'Free online invoice generator.',
    description:
      'Create a professional invoice in 60 seconds. Download as PDF. Track which invoices are paid, sent, and overdue — all without a credit card.',
    subheadline:
      'The fastest way to go from "I need to invoice my client" to "the invoice is in their inbox."',
    benefits: [
      { icon: '⏱️', title: '60-second invoices', body: 'Client, line items, download. No setup wizard, no 20-field onboarding form, no sales call.' },
      { icon: '🧾', title: 'Print-ready PDFs', body: 'Every invoice downloads as a clean PDF your clients can archive, print, or forward to their accountant.' },
      { icon: '📊', title: 'Track what\'s paid', body: 'Mark invoices sent or paid. Dashboard shows total invoiced, collected, and outstanding at a glance.' }
    ],
    exampleInvoice: {
      businessName: 'Your Business',
      businessTagline: 'Freelance services',
      clientName: 'Acme Corp.',
      lineItems: [
        { description: 'Professional services', quantity: 10, rate: '75.00', amount: '750.00' },
        { description: 'Materials & expenses', quantity: 1, rate: '120.00', amount: '120.00' }
      ],
      total: '870.00'
    },
    faq: [
      { q: 'Is it really free?', a: 'The Free plan is free forever, up to 3 invoices. Upgrade to Pro for $12/month (or $99/year) when you need unlimited invoices, payment links, and custom branding.' },
      { q: 'Do I need to install anything?', a: 'No. QuickInvoice runs in your browser. Register, create an invoice, download the PDF — that\'s the whole flow.' },
      { q: 'Can I use this for my side business?', a: 'Yes — QuickInvoice is built for freelancers, side-hustlers, consultants, and small agencies. No business registration required.' }
    ]
  }
};

const ROUTE_PREFIX = '/invoice-template';
const GENERATOR_SLUG = 'invoice-generator';

function buildLocals(slug) {
  const niche = NICHES[slug];
  if (!niche) return null;
  return {
    title: niche.title,
    nicheHeadline: niche.headline,
    nicheDescription: niche.description,
    nicheSubheadline: niche.subheadline,
    nicheAudience: niche.audience,
    nicheSingular: niche.singular,
    nicheBenefits: niche.benefits,
    nicheFaq: niche.faq,
    exampleInvoice: niche.exampleInvoice,
    screenshotAlt: `Example QuickInvoice invoice for a ${niche.singular}`
  };
}

function publicUrls(slug) {
  if (slug === GENERATOR_SLUG) return `/${GENERATOR_SLUG}`;
  return `${ROUTE_PREFIX}/${slug}`;
}

// /invoice-template/<slug>
Object.keys(NICHES).forEach(function (slug) {
  if (slug === GENERATOR_SLUG) return;
  router.get(`${ROUTE_PREFIX}/${slug}`, function (req, res) {
    res.render('partials/lp-niche', buildLocals(slug));
  });
});

// /invoice-generator (top-level — high-volume search term)
router.get(`/${GENERATOR_SLUG}`, function (req, res) {
  res.render('partials/lp-niche', buildLocals(GENERATOR_SLUG));
});

function listNiches() {
  return Object.keys(NICHES).map(function (slug) {
    return { slug, url: publicUrls(slug), title: NICHES[slug].title };
  });
}

module.exports = router;
module.exports.NICHES = NICHES;
module.exports.listNiches = listNiches;
module.exports.publicUrls = publicUrls;
