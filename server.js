const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const c = require('./config');
const cf = require('./cashfree');
const routes = require('./routes');
const { db, FieldValue } = require('./firebase');
const { creditOrder } = require('./wallet');

const app = express();
app.set('trust proxy', 1);
app.use(helmet());

// Webhook FIRST with the RAW body: the signature is computed over the exact bytes
app.post('/api/webhooks/cashfree', express.raw({ type: '*/*', limit: '100kb' }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  if (!cf.verifyWebhook(raw, req.get('x-webhook-signature'), req.get('x-webhook-timestamp'))) return res.sendStatus(401);
  let ev;
  try { ev = JSON.parse(raw); } catch { return res.sendStatus(400); }
  const orderId = ev && ev.data && ev.data.order && ev.data.order.order_id;
  if (typeof orderId !== 'string' || !/^ca_[a-f0-9]{24}$/.test(orderId)) return res.sendStatus(200); // not ours
  try {
    if (ev.type === 'PAYMENT_SUCCESS_WEBHOOK') {
      await creditOrder(orderId); // re-verifies with Cashfree, idempotent
    } else if (ev.type === 'PAYMENT_FAILED_WEBHOOK' || ev.type === 'PAYMENT_USER_DROPPED_WEBHOOK') {
      await db.collection('orders').doc(orderId).update({ lastAttempt: { type: ev.type, at: Date.now() }, updatedAt: FieldValue.serverTimestamp() }).catch(() => {});
    }
  } catch (e) {
    console.error('webhook processing failed', e.message);
    return res.sendStatus(500); // Cashfree retries
  }
  res.sendStatus(200);
});

app.use(cors({ origin: (origin, cb) => cb(null, !origin || c.corsOrigins.includes(origin)) }));
app.use(express.json({ limit: '10kb' }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 120 }));
app.get('/health', (_q, res) => res.json({ ok: true, env: c.cfEnv, paymentsEnabled: c.enabled }));
app.use('/api', routes);

app.use((err, _q, res, _n) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request.', code: 'BAD_JSON' });
  if (err.expose) return res.status(err.status || 400).json({ error: err.message, code: err.code, detail: err.detail });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.', code: 'SERVER_ERROR' });
});

module.exports = app;
if (require.main === module) app.listen(c.port, () => console.log(`Clutch Arena backend on :${c.port} (${c.cfEnv})`));
