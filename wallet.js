const { db, FieldValue } = require('./firebase');
const cf = require('./cashfree');

// Safe to call from webhook, status polling and retries. Credits at most once.
async function creditOrder(orderId) {
  const oref = db.collection('orders').doc(orderId);
  const snap = await oref.get();
  if (!snap.exists) return { status: 'NOT_FOUND' };
  const o = snap.data();
  if (o.credited) return { status: 'PAID' };
  if (o.status === 'AMOUNT_MISMATCH') return { status: 'AMOUNT_MISMATCH' }; // manual review

  // Never trust the client or the webhook body: ask Cashfree directly.
  const cfo = await cf.getOrder(orderId);

  if (cfo.order_status === 'PAID') {
    const ok = cfo.order_id === orderId && Number(cfo.order_amount) === o.amount && cfo.order_currency === 'INR'
      && cfo.customer_details && cfo.customer_details.customer_id === o.uid;
    if (!ok) {
      await oref.update({ status: 'AMOUNT_MISMATCH', updatedAt: FieldValue.serverTimestamp() });
      return { status: 'AMOUNT_MISMATCH' };
    }
    const wref = db.collection('wallets').doc(o.uid);
    const tref = wref.collection('transactions').doc('deposit_' + orderId); // fixed id = idempotency key
    await db.runTransaction(async (t) => {
      const [os, ts] = await Promise.all([t.get(oref), t.get(tref)]);
      if (os.data().credited || ts.exists) return;
      t.set(tref, { type: 'deposit', orderId, amount: o.amount, coins: o.coins, status: 'SUCCESS', createdAt: FieldValue.serverTimestamp() });
      t.set(wref, { balance: FieldValue.increment(o.coins), activeOrder: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      t.update(oref, { status: 'PAID', credited: true, paidAt: FieldValue.serverTimestamp() });
    });
    return { status: 'PAID' };
  }
  if (cfo.order_status === 'EXPIRED') {
    await oref.update({ status: 'EXPIRED', updatedAt: FieldValue.serverTimestamp() });
    return { status: 'EXPIRED' };
  }
  if (['TERMINATED', 'TERMINATION_REQUESTED'].includes(cfo.order_status)) {
    await oref.update({ status: 'CANCELLED', updatedAt: FieldValue.serverTimestamp() });
    return { status: 'CANCELLED' };
  }
  // ACTIVE: pending, unless the latest attempt failed (the customer may still scan again)
  try {
    const pays = await cf.getPayments(orderId);
    if (Array.isArray(pays) && pays.length && !pays.some((p) => p.payment_status === 'SUCCESS')
      && ['FAILED', 'CANCELLED', 'USER_DROPPED', 'VOID'].includes(pays[0].payment_status)) return { status: 'FAILED' };
  } catch { /* stays pending if the payments list is unavailable */ }
  return { status: 'PENDING' };
}

async function getBalance(uid) {
  const s = await db.collection('wallets').doc(uid).get();
  return s.exists ? s.data().balance || 0 : 0;
}
module.exports = { creditOrder, getBalance };
