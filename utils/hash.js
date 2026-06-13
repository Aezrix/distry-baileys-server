import { createHash } from 'crypto';

/**
 * Genera el hashId que identifica unívocamente un recordatorio.
 * Es el document ID en whatsapp_cola y la clave de deduplicación.
 *
 * @param {string} clienteId
 * @param {string} cuotaId
 * @param {string} fechaVencISO - Fecha de vencimiento en formato YYYY-MM-DD
 */
export function generarHashId(clienteId, cuotaId, fechaVencISO) {
  const raw = `${clienteId}|${cuotaId}|${fechaVencISO}`;
  return createHash('sha256').update(raw).digest('hex');
}
