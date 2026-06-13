import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { resolve } from 'path';

let initialized = false;

export function initFirebase() {
  if (initialized) return admin;

  let serviceAccount;

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    // Railway / cloud: JSON completo como variable de entorno
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } else {
    // Local: archivo JSON referenciado por ruta
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!credPath) {
      throw new Error('Define FIREBASE_SERVICE_ACCOUNT_JSON o GOOGLE_APPLICATION_CREDENTIALS');
    }
    serviceAccount = JSON.parse(readFileSync(resolve(credPath), 'utf8'));
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: process.env.FIREBASE_PROJECT_ID,
  });

  initialized = true;
  return admin;
}

export function getDb() {
  return admin.firestore();
}

export function getTimestamp() {
  return admin.firestore.FieldValue.serverTimestamp();
}

export function fieldValue() {
  return admin.firestore.FieldValue;
}
