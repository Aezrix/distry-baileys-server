import { getDb, getTimestamp } from '../firebase/admin.js';

const LOCKS_COLLECTION = 'whatsapp_locks';

/**
 * Intenta adquirir un lock de Firestore.
 * Retorna true si se adquirió, false si ya estaba tomado por otro proceso.
 *
 * Usa transacción para garantizar atomicidad.
 * Tiene TTL automático: si el lock está tomado pero es más viejo que ttlMinutes, se ignora.
 */
export async function acquireLock(lockName, heldBy = 'servidor_baileys') {
  const db = getDb();
  const ref = db.collection(LOCKS_COLLECTION).doc(lockName);

  try {
    const acquired = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data() ?? {};

      if (data.locked) {
        // Verificar si el TTL expiró
        const lockedAt = data.lockedAt?.toDate?.() ?? null;
        const ttlMs = (data.ttlMinutes ?? 10) * 60 * 1000;
        const expired = lockedAt && (Date.now() - lockedAt.getTime()) > ttlMs;

        if (!expired) {
          return false; // Lock activo y no expirado
        }
        // Lock expirado — se puede tomar
      }

      tx.set(ref, {
        locked: true,
        lockedAt: getTimestamp(),
        lockedBy: heldBy,
        ttlMinutes: data.ttlMinutes ?? 10,
      });
      return true;
    });

    return acquired;
  } catch (err) {
    // Error en transacción — asumir que no pudimos tomar el lock
    return false;
  }
}

/**
 * Libera un lock. Siempre en bloque finally para garantizar liberación.
 */
export async function releaseLock(lockName) {
  const db = getDb();
  try {
    await db.collection(LOCKS_COLLECTION).doc(lockName).set({
      locked: false,
      lockedAt: null,
      lockedBy: null,
    }, { merge: true });
  } catch (err) {
    // Loguear pero no lanzar — el TTL se encargará de liberar eventualmente
    console.warn(`No se pudo liberar lock ${lockName}:`, err.message);
  }
}

/**
 * Helper para ejecutar una función con lock automático.
 * Siempre libera el lock en el finally, aunque haya errores.
 */
export async function withLock(lockName, heldBy, fn) {
  const acquired = await acquireLock(lockName, heldBy);
  if (!acquired) {
    return { skipped: true, reason: `Lock ${lockName} no disponible` };
  }

  try {
    return await fn();
  } finally {
    await releaseLock(lockName);
  }
}
