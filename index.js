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
  db.doc('whatsapp_session/status').onSnapshot((snap) => {
    if (!snap.exists) return;
    const requestTs = snap.data()?.requestNewQr;
    if (!requestTs) return;
    const tsMs = requestTs.toMillis?.() ?? 0;
    if (tsMs <= lastQrRequest) return; // ignorar solicitudes previas al arranque
    lastQrRequest = tsMs;
    logger.info('Solicitud de nuevo QR recibida desde Flutter — reconectando...');
    session.forceNewQr().catch((e) => logger.error({ err: e.message }, 'Error al forzar QR'));
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
  ejecutarCiclo(session);

  pollingTimer = setInterval(() => ejecutarCiclo(session), intervalMs);
}

function detenerPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
    logger.info('Polling detenido');
  }
}

async function ejecutarCiclo(session) {
  if (procesando) {
    logger.debug('Ciclo anterior aún en progreso — skip');
    return;
  }

  procesando = true;
  try {
    await procesarCola(session, logger);
  } catch (err) {
    logger.error({ err }, 'Error no controlado en ciclo de procesamiento');
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
