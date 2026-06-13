import { getDb } from '../firebase/admin.js';

const CONFIG_DOC = 'whatsapp_config/global';
const CACHE_TTL_MS = 10_000; // 10 segundos

let cachedConfig = null;
let cacheExpiry = 0;
let realtimeUnsubscribe = null;

// Valores por defecto — el sistema arranca completamente deshabilitado
const DEFAULTS = {
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
};

/**
 * Lee la configuración global. Usa caché de 10s para reducir lecturas.
 */
export async function readConfig() {
  const now = Date.now();
  if (cachedConfig && now < cacheExpiry) {
    return cachedConfig;
  }

  const snap = await getDb().doc(CONFIG_DOC).get();
  if (!snap.exists) {
    cachedConfig = { ...DEFAULTS };
  } else {
    cachedConfig = { ...DEFAULTS, ...snap.data() };
  }
  cacheExpiry = now + CACHE_TTL_MS;
  return cachedConfig;
}

/**
 * Invalida el caché inmediatamente (útil al recibir cambios por listener).
 */
export function invalidateCache() {
  cachedConfig = null;
  cacheExpiry = 0;
}

/**
 * Suscripción en tiempo real para detectar kill switch al instante.
 * Llama a onKillSwitch(config) cuando habilitado cambia a false.
 */
export function subscribeConfig(onKillSwitch, logger) {
  realtimeUnsubscribe = getDb().doc(CONFIG_DOC).onSnapshot((snap) => {
    const data = snap.exists ? { ...DEFAULTS, ...snap.data() } : { ...DEFAULTS };

    const wasEnabled = cachedConfig?.habilitado ?? true;
    invalidateCache();
    cachedConfig = data;
    cacheExpiry = Date.now() + CACHE_TTL_MS;

    if (wasEnabled && !data.habilitado) {
      logger.warn({ event: 'kill_switch_detectado' }, 'Kill switch activado — deteniendo envíos');
      onKillSwitch(data);
    }
  }, (err) => {
    logger.error({ err }, 'Error en listener de whatsapp_config');
  });
}

export function unsubscribeConfig() {
  if (realtimeUnsubscribe) {
    realtimeUnsubscribe();
    realtimeUnsubscribe = null;
  }
}
