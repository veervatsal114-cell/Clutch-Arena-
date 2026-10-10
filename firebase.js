const admin = require('firebase-admin');
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)),
});
module.exports = { db: admin.firestore(), auth: admin.auth(), FieldValue: admin.firestore.FieldValue };
