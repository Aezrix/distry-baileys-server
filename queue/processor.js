import { getDb, getTimestamp } from '../firebase/admin.js';
import { readConfig } from '../config/reader.js';
import { validarEnvio, dentroDeVentanaHoraria } from '../validators/chain.js';
import { enviarMensaje } from '../sender/baileys.js';
import { withLock } from '../utils/lock.js';
import {
  leerContadorHoy,
  registrarEnvioExitoso,
  registrarBloqueo,
} from '../logger/firestore.js';

const COLA_COL = 'whatsapp_cola';
const LOCK_NAME = 'procesar_cola';

/**
 * Procesa UN mensaje de la cola por ciclo.
 * Diseño intencional: un mensaje a la vez = mayor seguridad y control.
 *
 * @param {object} session - Instancia de SessionManager
 * @param {object} logger
 */
export async function procesarCola(session, logger) {
  const config = await readConfig();

  // ── Guard 1: Kill switch ──────────────────────────────────────────────────
  if (!config.habilitado) {
    logger.debug('Sistema deshabilitado — skip ciclo');
    return;
  }

  // ── Guard 2: Sesión WhatsApp ──────────────────────────────────────────────
  if (!session.connected) {
    logger.warn('Sesión no conectada — skip ciclo');
    return;
  }

  // ── Guard 3: Ventana horaria ──────────────────────────────────────────────
  if (!dentroDeVentanaHoraria(config)) {
    logger.debug({ horaInicio: config.horaInicio, horaFin: config.horaFin }, 'Fuera de ventana horaria — skip');
    return;
  }

  // ── Guard 4: Límite diario ────────────────────────────────────────────────
  const contadorHoy = await leerContadorHoy();
  if ((contadorHoy.totalDia ?? 0) >= config.limiteDiario) {
    logger.info({ totalDia: contadorHoy.totalDia, limite: config.limiteDiario }, 'Límite diario alcanzado — skip');
    return;
  }

  // ── Adquirir lock y procesar ──────────────────────────────────────────────
  const result = await withLock(LOCK_NAME, 'servidor_baileys', async () => {
    const item = await leerSiguienteItem();
    if (!item) {
      logger.debug('Cola vacía');
      return { processed: false };
    }

    logger.info({ hashId: item.hashId, cliente: item.nombreCliente }, 'Procesando item de cola');

    // Marcar como "enviando" con transacción (previene doble proceso)
    const db = getDb();
    const itemRef = db.collection(COLA_COL).doc(item.hashId);

    const claimed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(itemRef);
      if (!snap.exists || snap.data().estado !== 'pendiente') {
        return false;
      }
      tx.update(itemRef, {
        estado: 'enviando',
        procesadoAt: getTimestamp(),
      });
      return true;
    });

    if (!claimed) {
      logger.debug({ hashId: item.hashId }, 'Item ya no está pendiente — skip');
      return { processed: false };
    }

    // ── Re-validación completa ────────────────────────────────────────────
    const validacion = await validarEnvio(item, config, contadorHoy);

    if (!validacion.ok) {
      logger.warn({ hashId: item.hashId, razon: validacion.razon }, 'Validación fallida — omitiendo');

      await itemRef.update({
        estado: 'omitido',
        error: validacion.razon,
        procesadoAt: getTimestamp(),
      });

      await registrarBloqueo(item, validacion.tipoLog, validacion.razon, config);
      return { processed: true, enviado: false };
    }

    // ── Modo sandbox: simular sin enviar ─────────────────────────────────
    if (config.modoSandbox) {
      logger.info({ hashId: item.hashId, telefono: item.telefono }, '[SANDBOX] Mensaje simulado — NO enviado');

      await itemRef.update({
        estado: 'simulado',
        messageId: null,
        procesadoAt: getTimestamp(),
        esSandbox: true,
      });

      await registrarEnvioExitoso(item, null, true, config.modoActivo);
      return { processed: true, enviado: false, sandbox: true };
    }

    // ── Envío real ────────────────────────────────────────────────────────
    const { messageId, error } = await enviarMensaje(
      session,
      item.telefono,
      item.mensaje,
      config
    );

    if (error) {
      const intentos = (item.intentos ?? 0) + 1;
      const nuevoEstado = intentos >= 3 ? 'fallido' : 'pendiente';

      logger.error({ hashId: item.hashId, error, intentos }, 'Error al enviar');

      await itemRef.update({
        estado: nuevoEstado,
        intentos,
        error,
        procesadoAt: getTimestamp(),
      });

      await registrarBloqueo(item, 'error', error, config);
      return { processed: true, enviado: false, error };
    }

    // ── Éxito ─────────────────────────────────────────────────────────────
    logger.info({ hashId: item.hashId, messageId, telefono: item.telefono }, 'Mensaje enviado');

    await itemRef.update({
      estado: 'enviado',
      messageId,
      error: null,
      procesadoAt: getTimestamp(),
    });

    await registrarEnvioExitoso(item, messageId, false, config.modoActivo);
    return { processed: true, enviado: true, messageId };
  });

  if (result?.skipped) {
    logger.debug({ reason: result.reason }, 'Lock no disponible — skip ciclo');
  }

  return result;
}

/**
 * Lee el siguiente item pendiente de la cola, ordenado por fecha de creación.
 */
async function leerSiguienteItem() {
  const snap = await getDb()
    .collection(COLA_COL)
    .where('estado', '==', 'pendiente')
    .orderBy('creadoAt', 'asc')
    .limit(1)
    .get();

  if (snap.empty) return null;

  const doc = snap.docs[0];
  return { hashId: doc.id, ...doc.data() };
}
