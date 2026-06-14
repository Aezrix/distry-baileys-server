import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getDb } from './admin.js';

const BACKUP_DOC = 'whatsapp_session/backup';

/**
 * Guarda todos los archivos de baileys-auth en Firestore.
 * Se llama cada vez que las credenciales se actualizan.
 */
export async function saveSessionBackup(sessionDir) {
  try {
    if (!existsSync(sessionDir)) return;
    const files = readdirSync(sessionDir);
    if (!files.length) return;

    const data = {};
    for (const file of files) {
      data[file] = readFileSync(join(sessionDir, file), 'utf8');
    }

    await getDb().doc(BACKUP_DOC).set({
      files: JSON.stringify(data),
      savedAt: new Date().toISOString(),
      fileCount: files.length,
    });
  } catch (e) {
    console.warn('[session-backup] Backup falló (no fatal):', e.message);
  }
}

/**
 * Restaura archivos de sesión desde Firestore si el directorio está vacío.
 * Retorna la cantidad de archivos restaurados, o 0 si no había backup.
 */
export async function restoreSessionBackup(sessionDir) {
  try {
    const snap = await getDb().doc(BACKUP_DOC).get();
    if (!snap.exists) return 0;

    const { files: filesJson } = snap.data();
    if (!filesJson) return 0;

    const files = JSON.parse(filesJson);
    const entries = Object.entries(files);
    if (!entries.length) return 0;

    if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });

    for (const [name, content] of entries) {
      writeFileSync(join(sessionDir, name), content, 'utf8');
    }

    return entries.length;
  } catch (e) {
    console.warn('[session-backup] Restore falló:', e.message);
    return 0;
  }
}

/**
 * Borra el backup de Firestore (llamar cuando la sesión es invalidada por WhatsApp).
 */
export async function clearSessionBackup() {
  try {
    await getDb().doc(BACKUP_DOC).delete();
  } catch (e) {
    console.warn('[session-backup] Clear falló:', e.message);
  }
}
