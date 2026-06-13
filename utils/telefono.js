/**
 * Normaliza un número de teléfono colombiano al formato E.164 (+57XXXXXXXXXX).
 * Retorna null si el formato es inválido.
 */
export function normalizarTelefono(telefono) {
  if (!telefono) return null;

  let t = telefono.toString().trim().replace(/\s+/g, '');

  // Ya viene en formato internacional
  if (t.startsWith('+')) {
    return t.length >= 10 ? t : null;
  }

  // 57xxxxxxxxxx (12 dígitos)
  if (t.startsWith('57') && t.length === 12) {
    return '+' + t;
  }

  // 3xxxxxxxxx (10 dígitos, Colombia)
  if (t.length === 10 && t.startsWith('3')) {
    return '+57' + t;
  }

  return null;
}

/**
 * Convierte un número E.164 al JID de WhatsApp.
 * Ejemplo: +573001234567 → 573001234567@s.whatsapp.net
 */
export function toWhatsAppJid(telefonoE164) {
  const digits = telefonoE164.replace('+', '');
  return `${digits}@s.whatsapp.net`;
}
