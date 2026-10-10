// In-memory stand-ins so the logic can be tested without Firebase or Cashfree credentials.
// NOTE: transactions here are serialized, so they prove the idempotency LOGIC, not Firestore's real contention handling.
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
class FakeDb {
  constructor() { this.d = new Map(); this.q = Promise.resolve(); }
  collection(n) { return this.col(n); }
  doc(path) {
    const db = this;
    return {
      path, collection: (n) => db.col(path + '/' + n),
      async get() { const v = db.d.get(path); return { exists: v !== undefined, data: () => clone(v) }; },
      async set(x, o) { db._set(path, x, o && o.merge); },
      async update(x) { if (!db.d.has(path)) throw new Error('NOT_FOUND'); db._set(path, x, true); },
    };
  }
  col(path) {
    const db = this;
    return { doc: (id) => db.doc(path + '/' + id), orderBy() { return this; }, limit() { return this; },
      async get() { const n = path.split('/').length + 1;
        return { docs: [...db.d.keys()].filter((k) => k.startsWith(path + '/') && k.split('/').length === n).map((k) => ({ id: k.split('/').pop(), data: () => clone(db.d.get(k)) })) }; } };
  }
  _set(path, x, merge) {
    const cur = merge ? clone(this.d.get(path) || {}) : {};
    for (const [k, v] of Object.entries(x)) {
      if (v && v.__op === 'inc') cur[k] = (cur[k] || 0) + v.n;
      else if (v && v.__op === 'del') delete cur[k];
      else if (v && v.__op === 'ts') cur[k] = Date.now();
      else cur[k] = v;
    }
    this.d.set(path, cur);
  }
  runTransaction(fn) {
    const p = this.q.then(() => fn({ get: (r) => r.get(), set: (r, x, o) => r.set(x, o), update: (r, x) => r.update(x) }));
    this.q = p.catch(() => {});
    return p;
  }
}
const FieldValue = { increment: (n) => ({ __op: 'inc', n }), serverTimestamp: () => ({ __op: 'ts' }), delete: () => ({ __op: 'del' }) };
const auth = { verifyIdToken: async (t) => {
  if (t === 'tokA') return { uid: 'userA', email: 'a@x.com' };
  if (t === 'tokB') return { uid: 'userB' };
  throw new Error('bad token'); } };
module.exports = { FakeDb, FieldValue, auth };
