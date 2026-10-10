process.env.CREATE_RATE_LIMIT = '1000';
process.env.CASHFREE_CLIENT_ID = 'test_id'; process.env.CASHFREE_CLIENT_SECRET = 'test_secret';
process.env.PUBLIC_URL = 'https://api.test'; process.env.MIN_AMOUNT = '10'; process.env.MAX_AMOUNT = '5000';
process.env.COINS_PER_RUPEE = '2'; process.env.BONUS_RULES = '[[100,20]]'; process.env.PAYMENTS_ENABLED = 'true';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('crypto');
const { FakeDb, FieldValue, auth } = require('./fakes');
const db = new FakeDb();
const fbPath = require.resolve('../src/firebase');
require.cache[fbPath] = { id: fbPath, filename: fbPath, loaded: true, exports: { db, auth, FieldValue } };
const cf = require('../src/cashfree');
const app = require('../src/server');

// controllable fake Cashfree
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
let cfo = {}, pays = [], qrMode = 'ok', created = 0;
cf.createOrder = async (b) => { created++; cfo = { order_id: b.order_id, order_amount: b.order_amount, order_currency: 'INR', order_status: 'ACTIVE', customer_details: { customer_id: b.customer_details.customer_id } }; return { cf_order_id: 1, payment_session_id: 'sess' }; };
cf.payWithUpiQr = async () => { if (qrMode === 'throw') { const e = new Error('upi disabled'); e.code = 'x'; throw e; } return qrMode === 'noqr' ? { data: { payload: null } } : { cf_payment_id: 9, data: { payload: { qrcode: PNG, default: 'upi://pay?pa=x' } } }; };
cf.getOrder = async () => cfo; cf.getPayments = async () => pays; cf.terminateOrder = async () => ({});

let server, base;
test.before(() => new Promise((r) => { server = app.listen(0, () => { base = 'http://127.0.0.1:' + server.address().port; r(); }); }));
test.after(() => server.close());
const api = async (m, p, tok, body) => { const r = await fetch(base + '/api' + p, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { s: r.status, j: await r.json().catch(() => ({})) }; };
const mk = async (amount = 100, tok = 'tokA') => api('POST', '/payments/create-order', tok, { amount, phone: '9876543210' });
const bal = async (tok = 'tokA') => (await api('GET', '/wallet', tok)).j.balance;
const hook = async (type, orderId, sig) => { const raw = JSON.stringify({ type, data: { order: { order_id: orderId } } }), ts = String(Date.now());
  const s = sig || crypto.createHmac('sha256', 'test_secret').update(ts + raw).digest('base64');
  return (await fetch(base + '/api/webhooks/cashfree', { method: 'POST', headers: { 'x-webhook-signature': s, 'x-webhook-timestamp': ts, 'Content-Type': 'application/json' }, body: raw })).status; };
const paid = () => { cfo.order_status = 'PAID'; };

test('requires login', async () => { assert.equal((await api('POST', '/payments/create-order', null, { amount: 100 })).s, 401); assert.equal((await api('GET', '/wallet', 'nope')).s, 401); });
test('rejects invalid amounts', async () => {
  for (const a of [0, -5, 1.5, 9, 5001, '100', null, NaN]) { const r = await api('POST', '/payments/create-order', 'tokA', { amount: a, phone: '9876543210' }); assert.equal(r.s, 400, 'amount ' + a); }
  assert.equal((await api('POST', '/payments/create-order', 'tokA', { amount: 100, phone: '123' })).s, 400);
});
test('creates order + real QR payload; coins computed by server, client coins ignored', async () => {
  const r = await api('POST', '/payments/create-order', 'tokA', { amount: 100, phone: '9876543210', coins: 999999 });
  assert.equal(r.s, 200); assert.equal(r.j.qrImage, PNG); assert.equal(r.j.coins, 220); assert.match(r.j.orderId, /^ca_[a-f0-9]{24}$/); assert.ok(r.j.expiresAt > Date.now());
  assert.equal(await bal(), 0, 'no coins before payment');
});
test('double tap reuses the same open order', async () => { const n = created; const a = await mk(100), b = await mk(100); assert.equal(a.j.orderId, b.j.orderId); assert.equal(created, n); });
test('QR failure gives a clear error, no endless loading', async () => {
  qrMode = 'noqr'; let r = await mk(200); assert.equal(r.s, 502); assert.equal(r.j.code, 'QR_UNAVAILABLE');
  qrMode = 'throw'; r = await mk(300); assert.equal(r.s, 502); assert.match(r.j.error, /Could not create/); qrMode = 'ok';
});
test('pending stays pending, nothing credited', async () => { const { j } = await mk(150); const s = await api('GET', `/payments/${j.orderId}/status`, 'tokA'); assert.equal(s.j.status, 'PENDING'); assert.equal(await bal(), 0); });
test("cannot read or cancel another user's order", async () => { const { j } = await mk(160); assert.equal((await api('GET', `/payments/${j.orderId}/status`, 'tokB')).s, 404); assert.equal((await api('POST', `/payments/${j.orderId}/cancel`, 'tokB')).s, 404); });
test('failed attempt reported as FAILED, still not credited', async () => { const { j } = await mk(170); pays = [{ payment_status: 'FAILED' }]; const s = await api('GET', `/payments/${j.orderId}/status`, 'tokA'); assert.equal(s.j.status, 'FAILED'); assert.equal(await bal(), 0); pays = []; });
test('expired order', async () => { const { j } = await mk(180); cfo.order_status = 'EXPIRED'; assert.equal((await api('GET', `/payments/${j.orderId}/status`, 'tokA')).j.status, 'EXPIRED'); });
test('invalid webhook signature rejected, no credit', async () => { const { j } = await mk(190); paid(); assert.equal(await hook('PAYMENT_SUCCESS_WEBHOOK', j.orderId, 'AAAA'), 401); assert.equal(await bal(), 0); });
test('success: verified credit once across status polls, webhook, duplicate webhook', async () => {
  const { j } = await mk(200); const before = await bal(); paid();
  assert.equal((await api('GET', `/payments/${j.orderId}/status`, 'tokA')).j.status, 'PAID');
  assert.equal(await hook('PAYMENT_SUCCESS_WEBHOOK', j.orderId), 200); assert.equal(await hook('PAYMENT_SUCCESS_WEBHOOK', j.orderId), 200);
  await api('GET', `/payments/${j.orderId}/status`, 'tokA');
  assert.equal(await bal() - before, 400, '200 rupees x 2 coins, exactly once');
  assert.equal((await api('GET', '/wallet/transactions', 'tokA')).j.transactions.filter((t) => t.orderId === j.orderId).length, 1);
});
test('10 simultaneous credit attempts credit once', async () => {
  const { j } = await mk(250); const before = await bal(); paid();
  await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? api('GET', `/payments/${j.orderId}/status`, 'tokA') : hook('PAYMENT_SUCCESS_WEBHOOK', j.orderId))));
  assert.equal(await bal() - before, 500);
});
test('amount mismatch is not credited', async () => { const { j } = await mk(300); cfo.order_amount = 30; paid(); const s = await api('GET', `/payments/${j.orderId}/status`, 'tokA'); assert.equal(s.j.status, 'AMOUNT_MISMATCH'); const b = await bal(); await hook('PAYMENT_SUCCESS_WEBHOOK', j.orderId); assert.equal(await bal(), b); });
test('customer mismatch is not credited', async () => { const { j } = await mk(310); cfo.customer_details.customer_id = 'someoneElse'; paid(); assert.equal((await api('GET', `/payments/${j.orderId}/status`, 'tokA')).j.status, 'AMOUNT_MISMATCH'); });
test('cancel an unpaid order; cancel after payment keeps the credit', async () => {
  let { j } = await mk(320); assert.equal((await api('POST', `/payments/${j.orderId}/cancel`, 'tokA')).j.status, 'CANCELLED');
  ({ j } = await mk(330)); const b = await bal(); paid(); assert.equal((await api('POST', `/payments/${j.orderId}/cancel`, 'tokA')).j.status, 'PAID'); assert.equal(await bal() - b, 660);
});
test('webhook for unknown order id is ignored safely', async () => { assert.equal(await hook('PAYMENT_SUCCESS_WEBHOOK', 'ca_' + 'a'.repeat(24)), 200); assert.equal(await hook('PAYMENT_SUCCESS_WEBHOOK', 'not-ours'), 200); });
