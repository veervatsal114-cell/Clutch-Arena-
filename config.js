require('dotenv').config();
const need = (k) => {
  if (!process.env[k] || !String(process.env[k]).trim()) throw new Error(`Missing env var: ${k}`);
  return process.env[k].trim();
};
const num = (k) => {
  const n = Number(need(k));
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${k} must be a positive number`);
  return n;
};
const env = process.env.CASHFREE_ENV || 'sandbox';
if (!['sandbox', 'production'].includes(env)) throw new Error('CASHFREE_ENV must be sandbox or production');
if (env === 'production' && process.env.PRODUCTION_APPROVED !== 'yes') {
  throw new Error('Production blocked. Set PRODUCTION_APPROVED=yes only after Cashfree approval.');
}
let bonus = [];
if ((process.env.BONUS_RULES || '').trim()) {
  bonus = JSON.parse(process.env.BONUS_RULES);
  if (!Array.isArray(bonus) || !bonus.every((r) => Array.isArray(r) && r.length === 2 && r.every((n) => Number.isInteger(n) && n > 0))) {
    throw new Error('BONUS_RULES must look like [[100,20],[200,40]]');
  }
}
const min = num('MIN_AMOUNT'), max = num('MAX_AMOUNT');
if (min > max) throw new Error('MIN_AMOUNT cannot exceed MAX_AMOUNT');
module.exports = {
  port: process.env.PORT || 3000,
  cfEnv: env,
  cfBase: env === 'production' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg',
  apiVersion: '2023-08-01', // use the same version for your webhook in the Cashfree dashboard
  clientId: need('CASHFREE_CLIENT_ID'),
  clientSecret: need('CASHFREE_CLIENT_SECRET'),
  publicUrl: need('PUBLIC_URL').replace(/\/$/, ''),
  returnUrl: (process.env.RETURN_URL || '').trim(),
  corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  min, max, coinsPerRupee: num('COINS_PER_RUPEE'), bonus,
  expiryMin: Number(process.env.ORDER_EXPIRY_MINUTES || 20),
  enabled: process.env.PAYMENTS_ENABLED === 'true',
};
