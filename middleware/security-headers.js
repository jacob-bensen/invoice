const helmet = require('helmet');

const TAILWIND_CDN = 'https://cdn.tailwindcss.com';
const JSDELIVR_CDN = 'https://cdn.jsdelivr.net';

function buildContentSecurityPolicy() {
  return {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      formAction: ["'self'", 'https://checkout.stripe.com', 'https://billing.stripe.com'],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'", "'unsafe-inline'", TAILWIND_CDN, JSDELIVR_CDN],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", TAILWIND_CDN],
      imgSrc: ["'self'", 'data:', 'blob:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null
    }
  };
}

function securityHeaders() {
  const csp = buildContentSecurityPolicy();
  if (csp.directives.upgradeInsecureRequests === null) {
    delete csp.directives.upgradeInsecureRequests;
  }

  return helmet({
    contentSecurityPolicy: csp,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    strictTransportSecurity: process.env.NODE_ENV === 'production'
      ? { maxAge: 15552000, includeSubDomains: true, preload: false }
      : false
  });
}

module.exports = { securityHeaders, buildContentSecurityPolicy };
