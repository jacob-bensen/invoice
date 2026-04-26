const stripeLib = require('stripe');

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  return stripeLib(process.env.STRIPE_SECRET_KEY);
}

const ALLOWED_PAYMENT_METHODS = new Set([
  'card',
  'us_bank_account',
  'sepa_debit',
  'au_becs_debit',
  'bacs_debit',
  'acss_debit',
  'link'
]);

function parsePaymentMethods(raw) {
  if (!raw || typeof raw !== 'string') return ['card'];
  const normalised = raw
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(s => s.length > 0 && ALLOWED_PAYMENT_METHODS.has(s));
  const unique = Array.from(new Set(normalised));
  return unique.length > 0 ? unique : ['card'];
}

async function createInvoicePaymentLink(invoice, user, stripeClient) {
  const stripe = stripeClient || getStripe();
  if (!stripe) return null;

  const amountCents = Math.round(parseFloat(invoice.total) * 100);
  if (!Number.isFinite(amountCents) || amountCents < 50) {
    throw new Error(`Invoice total ${invoice.total} is below Stripe minimum.`);
  }

  const product = await stripe.products.create({
    name: `Invoice ${invoice.invoice_number}`,
    metadata: {
      invoice_id: String(invoice.id),
      user_id: String(user.id)
    }
  });

  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: amountCents,
    currency: (invoice.currency || 'usd').toLowerCase()
  });

  const paymentMethods = parsePaymentMethods(process.env.STRIPE_PAYMENT_METHODS);
  const paymentLink = await stripe.paymentLinks.create({
    line_items: [{ price: price.id, quantity: 1 }],
    payment_method_types: paymentMethods,
    metadata: {
      invoice_id: String(invoice.id),
      user_id: String(user.id),
      invoice_number: invoice.invoice_number
    }
  });

  return { id: paymentLink.id, url: paymentLink.url };
}

module.exports = {
  createInvoicePaymentLink,
  parsePaymentMethods,
  ALLOWED_PAYMENT_METHODS
};
