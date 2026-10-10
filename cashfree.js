const crypto = require('crypto');
const c = require('./config');

const headers = {
  'x-client-id': c.clientId,
  'x-client-secret': c.clientSecret, // server-side only, never sent to the browser
  'x-api-version': c.apiVersion,
  'Content-Type': 'application/json',
};

async function call(path, opts = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000); // never hang forever
  try {
    const r = await fetch(c.cfBase + path, { ...opts, headers, signal: ctl.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(j.message || 'Cashfree request failed');
      e.status = r.status; e.code = j.code;
      throw e;
    }
    return j;
  } catch (e) {
    if (e.name === 'AbortError') { const t = new Error('Cashfree timed out'); t.status = 504; t.code = 'TIMEOUT'; throw t; }
    throw e;
  } finally { clearTimeout(timer); }
}

const q = encodeURIComponent;
exports.createOrder = (body) => call('/orders', { method: 'POST', body: JSON.stringify(body) });
exports.getOrder = (id) => call('/orders/' + q(id));
exports.getPayments = (id) => call(`/orders/${q(id)}/payments`);
exports.terminateOrder = (id) => call('/orders/' + q(id), { method: 'PATCH', body: JSON.stringify({ order_status: 'TERMINATED' }) });

// Order Pay API: turns the payment_session_id into a transaction-specific UPI QR.
exports.payWithUpiQr = (sessionId) =>
  call('/orders/sessions', {
    method: 'POST',
    body: JSON.stringify({ payment_session_id: sessionId, payment_method: { upi: { channel: 'qrcode' } } }),
  });

// Reads the QR from Cashfree's response. Returns null if Cashfree did not return one.
exports.extractQr = (resp) => {
  const p = resp && resp.data && resp.data.payload;
  if (!p || typeof p.qrcode !== 'string' || !p.qrcode) return null;
  const img = p.qrcode.startsWith('data:image/') ? p.qrcode : 'data:image/png;base64,' + p.qrcode;
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(img)) return null;
  const upi = typeof p.default === 'string' && p.default.startsWith('upi://') ? p.default : null;
  return { qrImage: img, upiLink: upi, cfPaymentId: resp.cf_payment_id ? String(resp.cf_payment_id) : null };
};

// signature = base64(HMAC_SHA256(timestamp + rawBody, clientSecret))
exports.verifyWebhook = (rawBody, signature, timestamp) => {
  if (!signature || !timestamp) return false;
  const expected = crypto.createHmac('sha256', c.clientSecret).update(timestamp + rawBody).digest('base64');
  const a = Buffer.from(expected), b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
