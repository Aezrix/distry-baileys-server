import { toWhatsAppJid } from '../utils/telefono.js';

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 3000;

/**
 * Envía un mensaje de texto por WhatsApp via Baileys.
 * Incluye delay humano configurable y reintentos limitados.
 *
 * @param {object} session - Instancia de SessionManager
 * @param {string} telefono - Número en formato E.164 (+57XXXXXXXXXX)
 * @param {string} mensaje - Texto del mensaje
 * @param {object} config - Configuración global (para delay)
 * @returns {{ messageId: string|null, error: string|null }}
 */
export async function enviarMensaje(session, telefono, mensaje, config) {
  if (!session.connected) {
    return { messageId: null, error: 'Sesión no conectada' };
  }

  const jid = toWhatsAppJid(telefono);

  // Delay humano aleatorio antes de enviar
  const delayMin = config.delayMinMs ?? 8000;
  const delayMax = config.delayMaxMs ?? 15000;
  const delay = Math.floor(Math.random() * (delayMax - delayMin) + delayMin);
  await sleep(delay);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const messageId = await session.sendMessage(jid, { text: mensaje });
      return { messageId, error: null };
    } catch (err) {
      const isLast = attempt === MAX_RETRIES;
      if (!isLast) {
        await sleep(RETRY_DELAY_MS);
      } else {
        return { messageId: null, error: err.message ?? 'Error desconocido' };
      }
    }
  }

  return { messageId: null, error: 'Agotados todos los reintentos' };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
