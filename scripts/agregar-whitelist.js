/**
 * Agrega un cliente a la whitelist de WhatsApp para Fase 1.
 *
 * Uso:
 *   node scripts/agregar-whitelist.js <clienteId> <nombre> <telefono>
 *
 * Ejemplo:
 *   node scripts/agregar-whitelist.js abc123 "Juan Perez" 3001234567
 */

import 'dotenv/config';
import { initFirebase, getDb, getTimestamp } from '../firebase/admin.js';

const [clienteId, nombre, telefono] = process.argv.slice(2);

if (!clienteId || !nombre || !telefono) {
  console.error('\nUso: node scripts/agregar-whitelist.js <clienteId> <nombre> <telefono>\n');
  console.error('Ejemplo: node scripts/agregar-whitelist.js abc123 "Juan Perez" 3001234567\n');
  process.exit(1);
}

function normalizarTelefono(t) {
  t = t.toString().trim().replace(/\s+/g, '');
  if (t.startsWith('+')) return t;
  if (t.startsWith('57') && t.length === 12) return '+' + t;
  if (t.length === 10 && t.startsWith('3')) return '+57' + t;
  return null;
}

initFirebase();
const db = getDb();

async function main() {
  const telefonoNorm = normalizarTelefono(telefono);
  if (!telefonoNorm) {
    console.error(`❌ Teléfono inválido: "${telefono}"`);
    console.error('   Formatos aceptados: 3001234567 | +573001234567 | 573001234567');
    process.exit(1);
  }

  // Verificar que el cliente existe en Firestore
  const clienteSnap = await db.collection('clientes').doc(clienteId).get();
  if (!clienteSnap.exists) {
    console.warn(`⚠️  Cliente "${clienteId}" no existe en /clientes. Agregando de todas formas...`);
  } else {
    const data = clienteSnap.data();
    console.log(`✅ Cliente encontrado: ${data.nombre} (${data.telefono})`);
  }

  await db.collection('whatsapp_whitelist').doc(clienteId).set({
    clienteId,
    clienteNombre: nombre,
    telefono: telefonoNorm,
    fase: 'fase1',
    habilitado: true,
    notas: 'Fase 1 - Prueba inicial',
    addedBy: 'script',
    addedAt: getTimestamp(),
    updatedAt: getTimestamp(),
  });

  console.log(`\n✅ Agregado a whitelist:`);
  console.log(`   clienteId : ${clienteId}`);
  console.log(`   Nombre    : ${nombre}`);
  console.log(`   Teléfono  : ${telefonoNorm}`);
  console.log(`   Fase      : fase1`);
  console.log(`   Habilitado: true\n`);

  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
