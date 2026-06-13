/**
 * Script de inicialización de Firestore.
 * Crea los documentos base de las colecciones whatsapp_* con valores seguros.
 *
 * Uso: node scripts/seed-firestore.js
 *
 * IMPORTANTE: Solo ejecutar una vez. Si los documentos ya existen,
 * usa --force para sobreescribir, o --check para solo verificar.
 */

import 'dotenv/config';
import { initFirebase, getDb } from '../firebase/admin.js';

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const CHECK_ONLY = args.includes('--check');

initFirebase();
const db = getDb();

const CONFIG_INICIAL = {
  habilitado: false,
  modoSandbox: true,
  modoActivo: 'fase1',
  limiteDiario: 5,
  limiteHorario: 2,
  limitePorCliente: 1,
  ventanaAntiDuplicados: 24,
  horaInicio: 7,
  horaFin: 20,
  delayMinMs: 2000,
  delayMaxMs: 5000,
  createdAt: new Date().toISOString(),
  updatedBy: 'seed-script',
};

const SESSION_INICIAL = {
  servidorActivo: false,
  sesionValida: false,
  qrPendiente: false,
  qrImagenBase64: null,
  numeroConectado: null,
  version: '1.0.0',
  ultimoHeartbeat: null,
};

const LOCK_INICIAL = {
  locked: false,
  lockedAt: null,
  lockedBy: null,
  ttlMinutes: 10,
};

async function seedDoc(path, data, label) {
  const ref = db.doc(path);
  const snap = await ref.get();

  if (snap.exists && !FORCE) {
    if (CHECK_ONLY) {
      console.log(`✅ [OK]     ${label} — ya existe`);
    } else {
      console.log(`⚠️  [SKIP]  ${label} — ya existe (usa --force para sobreescribir)`);
    }
    return;
  }

  if (CHECK_ONLY) {
    console.log(`❌ [FALTA] ${label} — no existe`);
    return;
  }

  await ref.set(data, { merge: !FORCE });
  console.log(`✅ [CREADO] ${label}`);
}

async function main() {
  console.log('\n=== DistrY Créditos — Inicialización de Firestore WhatsApp ===\n');

  if (CHECK_ONLY) {
    console.log('Modo: VERIFICACIÓN (no modifica nada)\n');
  } else if (FORCE) {
    console.log('Modo: FORCE (sobreescribe documentos existentes)\n');
  } else {
    console.log('Modo: SEED (omite documentos existentes)\n');
  }

  await seedDoc('whatsapp_config/global', CONFIG_INICIAL, 'whatsapp_config/global');
  await seedDoc('whatsapp_session/status', SESSION_INICIAL, 'whatsapp_session/status');
  await seedDoc('whatsapp_locks/construir_cola', LOCK_INICIAL, 'whatsapp_locks/construir_cola');
  await seedDoc('whatsapp_locks/procesar_cola', LOCK_INICIAL, 'whatsapp_locks/procesar_cola');

  console.log('\n=== Resumen ===');
  console.log('Colecciones que se crean automáticamente al primer uso:');
  console.log('  → whatsapp_whitelist/{clienteId}');
  console.log('  → whatsapp_cola/{hashId}');
  console.log('  → whatsapp_logs/{autoId}');
  console.log('  → whatsapp_contadores/{YYYY-MM-DD}');

  if (!CHECK_ONLY) {
    console.log('\nPróximos pasos:');
    console.log('  1. Agrega tu número a whatsapp_whitelist en Firestore Console');
    console.log('  2. Coloca firebase-service-account.json en la raíz del proyecto');
    console.log('  3. Copia .env.example a .env y completa los valores');
    console.log('  4. Ejecuta: npm start');
    console.log('  5. Escanea el QR con el número SECUNDARIO de WhatsApp\n');
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Error en seed:', err.message);
  process.exit(1);
});
