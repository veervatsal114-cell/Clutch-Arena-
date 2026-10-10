const crypto = require('crypto');
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const c = require('./config');
const cf = require('./cashfree');
const requireAuth = require('./middleware');
const { db, FieldValue } = require('./firebase');
const { creditOrder, getBalance } = require('./wallet');

const fail = (status, error, code, detail) => Object.assign(new Error(error), { status, expose: true, code, detail });
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const pub = (id, o) => ({ orderId: id, amount: o.amount, coins: o.coins, expiresAt: o.expiresAt, status: o.status, qrImage: o.qrImage || null, upiLink: o.upiLink || null });
// The server decides the coins from YOUR .env rules. BONUS_RULES apply on exact amounts only.
const coinsFor = (a) => a * c.coinsPerRupee + (c.bonus.find((r) => r[0] === a) || [0, 0])[1];
const detail = (e) => (c.cfEnv === 'sandbox' ? e.message : undefined);

async function ownOrder(req) {
  const id = String(req.params.orderId || '');
  if (!/^ca_[a-f0-9]{24}$/.test(id)) throw fail(404, 'Order not found', 'NOT_FOUND');
  const s = await db.collection('orders').doc(id).get();
  if (!s.exists || s.data().uid !== req.user.uid) throw fail(404, 'Order not found', 'NOT_FOUND'); // same answer for "not yours"
  return { id, o: s.data() };
}

const createLimit = rateLimit({ windowMs: 60_000, limit: Number(process.env.CREATE_RATE_LIMIT || 10), keyGenerator: (req) => req.user.uid, validate: false });

// 1) Create the order AND its UPI QR in one call
router.post('/payments/create-order', requireAuth, createLimit, wrap(async (req, res) => {
  if (!c.enabled) throw fail(503, 'Payments are currently disabled.', 'DISABLED');
  const amount = req.body.amount;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < c.min || amount > c.max) {
    throw fail(400, `Enter a whole-rupee amount from ${c.min} to ${c.max}.`, 'BAD_AMOUNT');
  }
  const phone = String(req.body.phone || req.user.phone_number || '').replace(/^\+91/, '');
  if (!/^[6-9]\d{9}$/.test(phone)) throw fail(400, 'A valid 10-digit mobile number is required.', 'BAD_PHONE');

  // Double-tap protection: reuse the user's open order for the same amount
  const wref = db.collection('wallets').doc(req.user.uid);
  const ws = await wref.get();
  const act = ws.exists && ws.data().activeOrder;
  if (act && act.amount === amount) {
    const os = await db.collection('orders').doc(act.orderId).get();
    const o = os.exists && os.data();
    if (o && o.uid === req.user.uid && o.status === 'ACTIVE' && o.qrImage && o.expiresAt > Date.now() + 30_000) {
      return res.json(pub(act.orderId, o));
    }
  }

  const orderId = 'ca_' + crypto.randomBytes(12).toString('hex');
  const expiresAt = Date.now() + c.expiryMin * 60_000;
  const oref = db.collection('orders').doc(orderId);
  await oref.set({ uid: req.user.uid, amount, coins: coinsFor(amount), currency: 'INR', status: 'CREATED', credited: false, expiresAt, createdAt: FieldValue.serverTimestamp() });

  try {
    const cfo = await cf.createOrder({
      order_id: orderId, order_amount: amount, order_currency: 'INR',
      customer_details: { customer_id: req.user.uid, customer_phone: phone, ...(req.user.email ? { customer_email: req.user.email } : {}) },
      order_meta: { notify_url: `${c.publicUrl}/api/webhooks/cashfree`, ...(c.returnUrl ? { return_url: `${c.returnUrl}?order_id={order_id}` } : {}) },
      order_expiry_time: new Date(expiresAt).toISOString(),
      order_note: 'Clutch Arena coins',
    });
    const pay = await cf.payWithUpiQr(cfo.payment_session_id);
    const qr = cf.extractQr(pay);
    if (!qr) {
      await oref.update({ status: 'QR_FAILED', cfOrderId: cfo.cf_order_id || null });
      cf.terminateOrder(orderId).catch(() => {});
      throw fail(502, 'UPI QR is not available on this payment account. Contact support.', 'QR_UNAVAILABLE');
    }
    await oref.update({ status: 'ACTIVE', cfOrderId: cfo.cf_order_id || null, ...qr });
    await wref.set({ activeOrder: { orderId, amount } }, { merge: true });
    res.json(pub(orderId, (await oref.get()).data()));
  } catch (e) {
    if (e.expose) throw e;
    await oref.update({ status: 'CREATE_FAILED', error: String(e.message).slice(0, 200) }).catch(() => {});
    throw fail(502, 'Could not create the payment QR. Please try again.', e.code || 'CASHFREE_ERROR', detail(e));
  }
}));

// 2) Status: verifies with Cashfree and credits if paid (safe to poll)
router.get('/payments/:orderId/status', requireAuth, wrap(async (req, res) => {
  const { id, o } = await ownOrder(req);
  const r = await creditOrder(id);
  res.json({ orderId: id, status: r.status, expiresAt: o.expiresAt, balance: await getBalance(req.user.uid) });
}));

// 3) Cancel button. Never cancels an order that was already paid.
router.post('/payments/:orderId/cancel', requireAuth, wrap(async (req, res) => {
  const { id } = await ownOrder(req);
  let r = await creditOrder(id);
  if (r.status !== 'PAID' && r.status !== 'AMOUNT_MISMATCH') {
    await cf.terminateOrder(id).catch(() => {});
    await db.collection('orders').doc(id).update({ status: 'CANCELLED', updatedAt: FieldValue.serverTimestamp() });
    await db.collection('wallets').doc(req.user.uid).set({ activeOrder: FieldValue.delete() }, { merge: true });
    r = { status: 'CANCELLED' };
  }
  res.json({ orderId: id, status: r.status, balance: await getBalance(req.user.uid) });
}));

router.get('/wallet', requireAuth, wrap(async (req, res) => res.json({ balance: await getBalance(req.user.uid) })));
router.get('/wallet/transactions', requireAuth, wrap(async (req, res) => {
  const q = await db.collection('wallets').doc(req.user.uid).collection('transactions').orderBy('createdAt', 'desc').limit(50).get();
  res.json({ transactions: q.docs.map((d) => ({ id: d.id, ...d.data() })) });
}));

module.exports = router;
