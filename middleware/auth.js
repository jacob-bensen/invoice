function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/auth/login');
  }
  next();
}

function requirePro(req, res, next) {
  if (!req.session.user) return res.redirect('/auth/login');
  if (req.session.user.plan !== 'pro') {
    req.session.flash = { type: 'error', message: 'This feature requires a Pro plan.' };
    return res.redirect('/billing/upgrade');
  }
  next();
}

function redirectIfAuth(req, res, next) {
  if (req.session.user) return res.redirect('/dashboard');
  next();
}

module.exports = { requireAuth, requirePro, redirectIfAuth };
