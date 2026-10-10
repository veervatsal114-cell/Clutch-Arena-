const { auth } = require('./firebase');
module.exports = async function requireAuth(req, res, next) {
  const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
  if (!m) return res.status(401).json({ error: 'Please sign in again.', code: 'NO_TOKEN' });
  try {
    req.user = await auth.verifyIdToken(m[1]);
    next();
  } catch {
    res.status(401).json({ error: 'Your session expired. Please sign in again.', code: 'BAD_TOKEN' });
  }
};
