import 'dotenv/config';
import { createServer } from 'http';
import pino from 'pino';
import { initFirebase, getDb } from './firebase/admin.js';
import { subscribeConfig } from './config/reader.js';
import { SessionManager } from './session/manager.js';
import { procesarCola } from './queue/processor.js';
import { registrarKillSwitch, registrarSesionPerdida } from './logger/firestore.js';

// ── Logger ────────────────────────────────────────────────────────────────────
const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
    : undefined,
});

// ── Health check HTTP (Railway requiere un proceso escuchando en $PORT) ────────
const PORT = process.env.PORT || 3000;
createServer((req, res) => res.writeHead(200).end('OK')).listen(PORT);

// ── Estado global del servidor ────────────────────────────────────────────────
let pollingTimer = null;
let procesando = false;

// ── Inicialización ────────────────────────────────────────────────────────────
async function main() {
  logger.info('=== DistrY Créditos — Servidor WhatsApp Baileys ===');

  // 1. Inicializar Firebase
  initFirebase();
  logger.info('Firebase inicializado');

  // 2. Suscribirse a cambios de configuración (kill switch en tiempo real)
  subscribeConfig(async (config) => {
    await registrarKillSwitch('firestore_listener').catch(() => {});
    logger.warn('Kill switch detectado vía Firestore listener');
  }, logger);

  // 3. Inicializar sesión Baileys
  const sessionDir = process.env.SESSION_DIR ?? './baileys-auth';
  const session = new SessionManager(sessionDir, logger);

  session.onReady(() => {
    logger.info('Sesión lista — iniciando polling de cola');
    iniciarPolling(session);
  });

  session.onDisconnected(async (reason) => {
    logger.warn({ reason }, 'Sesión desconectada — deteniendo polling');
    detenerPolling();
    await registrarSesionPerdida(reason).catch(() => {});
  });

  await session.connect();

  // 4. Escuchar solicitudes de nuevo QR desde Flutter
  // Inicializamos con el tiempo de arranque del servidor para ignorar cualquier
  // requestNewQr antiguo que quedó en Firestore de sesiones anteriores.
  const db = getDb();
  const serverStartMs = Date.now();
  let lastQrRequest = serverStartMs;
  let lastReconnectRequest = serverStartMs;
  let lastPairingRequest = serverStartMs;
  let lastLogoutRequest = serverStartMs;

  db.doc('whatsapp_session/status').onSnapshot((snap) => {
    if (!snap.exists) return;
    const data = snap.data();

    // Solicitud de nuevo QR (borra sesión)
    const qrTs = data?.requestNewQr;
    if (qrTs) {
      const tsMs = qrTs.toMillis?.() ?? 0;
      if (tsMs > lastQrRequest) {
        lastQrRequest = tsMs;
        logger.info('Solicitud de nuevo QR recibida — forzando reconexión limpia');
        session.forceNewQr().catch((e) => logger.error({ err: e.message }, 'Error al forzar QR'));
      }
    }

    // Solicitud de reconexión con sesión existente (sin borrar ni pedir QR)
    const reconnectTs = data?.requestReconnect;
    if (reconnectTs) {
      const tsMs = reconnectTs.toMillis?.() ?? 0;
      if (tsMs > lastReconnectRequest) {
        lastReconnectRequest = tsMs;
        logger.info('Solicitud de reconexión con sesión existente recibida');
        session.reconnectExisting().catch((e) => logger.error({ err: e.message }, 'Error al reconectar'));
      }
    }

    // Solicitud de vinculación por número de teléfono
    const pairingTs = data?.requestPairingCode;
    if (pairingTs && data?.pairingPhone) {
      const tsMs = pairingTs.toMillis?.() ?? 0;
      if (tsMs > lastPairingRequest) {
        lastPairingRequest = tsMs;
        const phone = data.pairingPhone;
        logger.info({ phone }, 'Solicitud de código de vinculación recibida');
        session.startPhonePairing(phone).catch((e) => logger.error({ err: e.message }, 'Error al iniciar pairing'));
      }
    }

    // Solicitud de cerrar sesión
    const logoutTs = data?.requestLogout;
    if (logoutTs) {
      const tsMs = logoutTs.toMillis?.() ?? 0;
      if (tsMs > lastLogoutRequest) {
        lastLogoutRequest = tsMs;
        logger.info('Solicitud de cerrar sesión recibida');
        session.logoutSession().catch((e) => logger.error({ err: e.message }, 'Error al cerrar sesión'));
      }
    }
  });

  // ── Shutdown graceful ─────────────────────────────────────────────────────
  process.on('SIGTERM', () => gracefulShutdown(session));
  process.on('SIGINT', () => gracefulShutdown(session));
}

function iniciarPolling(session) {
  detenerPolling();

  const intervalMs = parseInt(process.env.POLL_INTERVAL_MS ?? '30000');
  logger.info({ intervalMs }, 'Polling de cola iniciado');

  // Ejecutar inmediatamente una vez al conectar, luego en intervalos
  ejecutarCicloConCadena(session, intervalMs);
}

/**
 * Ejecuta un ciclo y, si se procesó un item exitosamente, espera un delay
 * aleatorio entre mensajes para simular comportamiento humano y evitar
 * restricciones de WhatsApp por mensajería masiva.
 */
async function ejecutarCicloConCadena(session, intervalMs) {
  const result = await ejecutarCiclo(session);

  if (result?.processed && result?.enviado) {
    // Mensaje enviado exitosamente — esperar delay largo entre mensajes
    const minDelay = parseInt(process.env.INTER_MSG_DELAY_MIN ?? '45000');
    const maxDelay = parseInt(process.env.INTER_MSG_DELAY_MAX ?? '90000');
    const delay = Math.floor(Math.random() * (maxDelay - minDelay) + minDelay);
    logger.info({ delayMs: delay }, 'Esperando entre mensajes para evitar restricciones');
    pollingTimer = setTimeout(() => ejecutarCicloConCadena(session, intervalMs), delay);
  } else if (result?.processed) {
    // Procesado pero no enviado (omitido/sandbox) — delay corto
    pollingTimer = setTimeout(() => ejecutarCicloConCadena(session, intervalMs), 3000);
  } else {
    // Cola vacía o fuera de ventana — esperar el intervalo normal
    pollingTimer = setTimeout(() => ejecutarCicloConCadena(session, intervalMs), intervalMs);
  }
}

function detenerPolling() {
  if (pollingTimer) {
    clearTimeout(pollingTimer);
    pollingTimer = null;
    logger.info('Polling detenido');
  }
}

async function ejecutarCiclo(session) {
  if (procesando) {
    logger.debug('Ciclo anterior aún en progreso — skip');
    return null;
  }

  procesando = true;
  try {
    return await procesarCola(session, logger);
  } catch (err) {
    logger.error({ err }, 'Error no controlado en ciclo de procesamiento');
    return null;
  } finally {
    procesando = false;
  }
}

async function gracefulShutdown(session) {
  logger.info('Shutdown iniciado...');
  detenerPolling();
  await session.shutdown();
  logger.info('Shutdown completo');
  process.exit(0);
}

main().catch((err) => {
  logger.fatal({ err }, 'Error fatal al iniciar el servidor');
  process.exit(1);
});
