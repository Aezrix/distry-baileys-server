import { getDb, getTimestamp, fieldValue } from '../firebase/admin.js';

const LOGS_COL = 'whatsapp_logs';
const CONTADORES_COL = 'whatsapp_contadores';

/**
 * Registra un evento en whatsapp_logs.
 */
export async function registrarLog(campos) {
  await getDb().collection(LOGS_COL).add({
    ...campos,
    fecha: getTimestamp(),
  });
}

/**
 * Registra envío exitoso e incrementa contadores de rate limiting.
 *
 * @param {object} item - Documento de cola
 * @param {string} messageId - ID retornado por Baileys
 * @param {boolean} esSandbox
 * @param {string} fase
 */
export async function registrarEnvioExitoso(item, messageId, esSandbox, fase) {
  const hoy = fechaHoy();
  const horaActual = new Date().getHours().toString().padStart(2, '0');
  const db = getDb();

  const batch = db.batch();

  // Log de auditoría
  const logRef = db.collection(LOGS_COL).doc();
  batch.set(logRef, {
    tipo: esSandbox ? 'simulado' : 'enviado',
    clienteId: item.clienteId,
    creditoId: item.creditoId,
    cuotaId: item.cuotaId,
    telefono: item.telefono,
    hashId: item.hashId,
    messageId: messageId ?? null,
    mensajeResumen: (item.mensaje ?? '').substring(0, 100),
    razon: null,
    operadorId: null,
    origen: item.programadoPor?.startsWith('manual:') ? 'manual' : 'cron',
    fase,
    esSandbox,
    fecha: getTimestamp(),
  });

  if (!esSandbox) {
    // Incrementar contador diario
    const contRef = db.collection(CONTADORES_COL).doc(hoy);
    batch.set(contRef, {
      fecha: hoy,
      totalDia: fieldValue().increment(1),
      [`porHora.${horaActual}`]: fieldValue().increment(1),
      [`porCliente.${item.clienteId}`]: fieldValue().increment(1),
      updatedAt: getTimestamp(),
    }, { merge: true });
  }

  await batch.commit();
}

/**
 * Registra cualquier tipo de bloqueo u omisión.
 */
export async function registrarBloqueo(item, tipo, razon, config) {
  await registrarLog({
    tipo,
    clienteId: item?.clienteId ?? null,
    creditoId: item?.creditoId ?? null,
    cuotaId: item?.cuotaId ?? null,
    telefono: item?.telefono ?? null,
    hashId: item?.hashId ?? null,
    messageId: null,
    mensajeResumen: item?.mensaje ? item.mensaje.substring(0, 100) : null,
    razon,
    operadorId: null,
    origen: item?.programadoPor?.startsWith('manual:') ? 'manual' : 'cron',
    fase: config?.modoActivo ?? 'desconocido',
    esSandbox: config?.modoSandbox ?? false,
  });
}

/**
 * Registra activación del kill switch.
 */
export async function registrarKillSwitch(activadoPor = 'sistema') {
  await registrarLog({
    tipo: 'kill_switch_activado',
    clienteId: null,
    creditoId: null,
    cuotaId: null,
    telefono: null,
    hashId: null,
    messageId: null,
    mensajeResumen: null,
    razon: `Kill switch activado por: ${activadoPor}`,
    operadorId: activadoPor,
    origen: 'sistema',
    fase: 'desconocido',
    esSandbox: false,
  });
}

/**
 * Registra pérdida de sesión.
 */
export async function registrarSesionPerdida(reason) {
  await registrarLog({
    tipo: 'sesion_perdida',
    clienteId: null,
    creditoId: null,
    cuotaId: null,
    telefono: null,
    hashId: null,
    messageId: null,
    mensajeResumen: null,
    razon: `Sesión perdida: ${reason}`,
    operadorId: null,
    origen: 'sistema',
    fase: 'desconocido',
    esSandbox: false,
  });
}

/**
 * Lee el contador del día actual.
 */
export async function leerContadorHoy() {
  const hoy = fechaHoy();
  const snap = await getDb().collection(CONTADORES_COL).doc(hoy).get();
  return snap.exists ? snap.data() : { totalDia: 0, porHora: {}, porCliente: {} };
}

function fechaHoy() {
  const d = new Date();
  return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`;
}
