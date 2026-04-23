const stripeLib = require('stripe');

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  return stripeLib(process.env.STRIPE_SECRET_KEY);
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

  const paymentLink = await stripe.paymentLinks.create({
    line_items: [{ price: price.id, quantity: 1 }],
    metadata: {
      invoice_id: String(invoice.id),
      user_id: String(user.id),
      invoice_number: invoice.invoice_number
    }
  });

  return { id: paymentLink.id, url: paymentLink.url };
}

module.exports = { createInvoicePaymentLink };
