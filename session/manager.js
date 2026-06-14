import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { existsSync, mkdirSync, rmSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import { getDb, getTimestamp } from '../firebase/admin.js';
import { saveSessionBackup, restoreSessionBackup, clearSessionBackup } from '../firebase/session-backup.js';

const SESSION_STATUS_DOC = 'whatsapp_session/status';

export class SessionManager {
  constructor(sessionDir, logger) {
    this.sessionDir = resolve(sessionDir);
    this.logger = logger;
    this.sock = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.MAX_RECONNECT_ATTEMPTS = 10;
    this.onReadyCallbacks = [];
    this.onDisconnectedCallbacks = [];
    this.loggedOutAttempts = 0;
    this.MAX_LOGOUT_ATTEMPTS = 3;
  }

  onReady(fn) {
    this.onReadyCallbacks.push(fn);
  }

  onDisconnected(fn) {
    this.onDisconnectedCallbacks.push(fn);
  }

  async connect() {
    // Evitar múltiples connect() en paralelo (ej. dos timers disparando a la vez)
    if (this.isConnecting) {
      this.logger.warn('connect() ya está en progreso — ignorando llamada duplicada');
      return;
    }
    this.isConnecting = true;
    try {
      await this._doConnect();
    } finally {
      this.isConnecting = false;
    }
  }

  async _doConnect() {
    if (!existsSync(this.sessionDir)) {
      mkdirSync(this.sessionDir, { recursive: true });
    }

    // Limpiar estado colgado de sesión anterior antes de intentar conectar
    await this._updateSessionStatus({
      servidorActivo: true,
      sesionValida: false,
      qrPendiente: false,
      qrString: null,
      qrImagenBase64: null,
      errorLogout: null,
      errorDesconexion: null,
    }).catch(() => {});

    // Restaurar sesión desde Firestore si el directorio está vacío (ej. Railway reinició)
    const existingFiles = existsSync(this.sessionDir) ? readdirSync(this.sessionDir) : [];
    if (!existingFiles.length) {
      const restored = await restoreSessionBackup(this.sessionDir);
      if (restored) {
        this.logger.info({ files: restored }, 'Sesión restaurada desde backup Firestore — sin necesidad de nuevo QR');
      }
    }

    const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);
    const { version } = await fetchLatestWaWebVersion();

    const sessionFiles = readdirSync(this.sessionDir);
    this.logger.info(
      { files: sessionFiles.length, registered: !!state.creds.me, dir: this.sessionDir },
      'Cargando sesión'
    );

    this.logger.info({ version }, 'Iniciando Baileys');

    // Silenciar correctamente los logs internos de Baileys
    const baileysSilentLog = this.logger.child({ module: 'baileys' });
    baileysSilentLog.level = 'silent';

    this.sock = makeWASocket({
      version,
      browser: Browsers.macOS('Chrome'),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, this.logger),
      },
      printQRInTerminal: false,
      logger: baileysSilentLog,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      retryRequestDelayMs: 2000,
      keepAliveIntervalMs: 25_000,
      connectTimeoutMs: 60_000,
      qrTimeout: 60_000,
    });

    this.sock.ev.on('creds.update', async () => {
      await saveCreds();
      await saveSessionBackup(this.sessionDir);
      const saved = readdirSync(this.sessionDir);
      this.logger.info({ files: saved.length }, 'Credenciales guardadas y backup en Firestore actualizado');
    });

    this.sock.ev.on('connection.update', async (update) => {
      await this._handleConnectionUpdate(update);
    });

    return this.sock;
  }

  async _handleConnectionUpdate(update) {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      this.logger.info('QR generado — escanear con el número secundario');
      qrcode.generate(qr, { small: true });
      const base64 = await this._qrToBase64(qr);
      await this._updateSessionStatus({
        sesionValida: false,
        qrPendiente: true,
        qrString: qr,
        qrImagenBase64: base64,
        servidorActivo: true,
      });
      this.logger.info({ hasBase64: !!base64, qrLength: qr.length }, 'QR guardado en Firestore');
    }

    if (connection === 'open') {
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.loggedOutAttempts = 0;
      const numero = this.sock?.user?.id?.split(':')[0] ?? null;
      this.logger.info({ numero }, 'Sesión WhatsApp conectada');

      await this._updateSessionStatus({
        sesionValida: true,
        qrPendiente: false,
        qrImagenBase64: null,
        qrString: null,
        servidorActivo: true,
        numeroConectado: numero,
        errorLogout: null,
        errorDesconexion: null,
      });

      this._startHeartbeat();

      for (const fn of this.onReadyCallbacks) {
        try { fn(this.sock); } catch (e) { this.logger.error(e); }
      }
    }

    if (connection === 'close') {
      this.isConnected = false;
      this._stopHeartbeat();

      // Cancelar cualquier reconexión pendiente para evitar duplicados
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = reason !== DisconnectReason.loggedOut;
      const errorMsg = lastDisconnect?.error?.message ?? 'unknown';

      this.logger.warn({ reason, errorMsg, shouldReconnect }, 'Conexión cerrada');

      for (const fn of this.onDisconnectedCallbacks) {
        try { fn(reason); } catch (e) { this.logger.error(e); }
      }

      // Limpiar listeners del socket viejo para evitar eventos duplicados en reconexión
      const oldSock = this.sock;
      this.sock = null;
      if (oldSock) {
        try { oldSock.ev.removeAllListeners(); } catch (_) {}
      }

      if (shouldReconnect) {
        // No auto-reconectar — esperar que el usuario presione "Solicitar nuevo QR"
        this.logger.info({ reason }, 'Sesión cerrada — esperando acción manual del usuario');

        await this._updateSessionStatus({
          sesionValida: false,
          servidorActivo: true,
          qrPendiente: false,
          qrString: null,
          qrImagenBase64: null,
          errorLogout: `Sesión desconectada (código ${reason}). Presiona "Solicitar nuevo QR" para reconectar.`,
          errorDesconexion: `Desconectado (código ${reason}).`,
        });
      } else if (reason === DisconnectReason.loggedOut) {
        this.loggedOutAttempts++;
        this.logger.error(
          { loggedOutAttempts: this.loggedOutAttempts },
          'Sesión rechazada por WhatsApp (401) — esperando acción manual'
        );

        this._clearSessionFiles();
        await clearSessionBackup();

        await this._updateSessionStatus({
          sesionValida: false,
          servidorActivo: true,
          qrPendiente: false,
          qrString: null,
          qrImagenBase64: null,
          numeroConectado: null,
          errorLogout: `Sesión rechazada (${this.loggedOutAttempts}x). Presiona "Solicitar QR" para reintentar.`,
        });
      } else {
        this.logger.error({ attempts: this.reconnectAttempts }, 'Máximo de reconexiones alcanzado');
        await this._updateSessionStatus({ sesionValida: false, servidorActivo: false });
      }
    }
  }

  async forceNewQr() {
    this.logger.info('Forzando nuevo QR — limpiando sesión y reconectando');

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.sock) {
      try { this.sock.ev.removeAllListeners(); } catch (_) {}
      try { await this.sock.ws?.close(); } catch (_) {}
      this.sock = null;
    }

    this.isConnected = false;
    this._stopHeartbeat();
    this._clearSessionFiles();
    this.reconnectAttempts = 0;
    this.isConnecting = false; // Resetear flag para permitir el nuevo connect
    setTimeout(() => this.connect(), 1000);
  }

  async sendMessage(jid, content) {
    if (!this.isConnected || !this.sock) {
      throw new Error('Sesión no disponible — no se puede enviar mensaje');
    }
    const result = await this.sock.sendMessage(jid, content);
    return result?.key?.id ?? null;
  }

  get connected() {
    return this.isConnected;
  }

  _startHeartbeat() {
    const intervalMs = parseInt(process.env.HEARTBEAT_INTERVAL_MS ?? '25000');
    this.heartbeatTimer = setInterval(async () => {
      try {
        await getDb().doc(SESSION_STATUS_DOC).set({
          ultimoHeartbeat: getTimestamp(),
          servidorActivo: true,
          sesionValida: this.isConnected,
        }, { merge: true });
      } catch (e) {
        this.logger.warn({ err: e.message }, 'Heartbeat falló');
      }
    }, intervalMs);
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async _updateSessionStatus(fields) {
    try {
      await getDb().doc(SESSION_STATUS_DOC).set({
        ...fields,
        ultimoHeartbeat: getTimestamp(),
        version: '1.0.0',
      }, { merge: true });
    } catch (e) {
      this.logger.warn({ err: e.message }, 'No se pudo actualizar estado de sesión');
    }
  }

  _clearSessionFiles() {
    try {
      if (!existsSync(this.sessionDir)) {
        mkdirSync(this.sessionDir, { recursive: true });
        return;
      }
      const entries = readdirSync(this.sessionDir);
      for (const entry of entries) {
        rmSync(join(this.sessionDir, entry), { recursive: true, force: true });
      }
      this.logger.info({ deleted: entries.length }, 'Archivos de sesión limpiados');
    } catch (e) {
      this.logger.error({ err: e.message, dir: this.sessionDir }, 'Error limpiando sesión');
    }
  }

  async _qrToBase64(qrData) {
    try {
      return await QRCode.toDataURL(qrData, { width: 600, margin: 2, color: { dark: '#000000', light: '#ffffff' } });
    } catch {
      return null;
    }
  }

  async shutdown() {
    this._stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.sock) {
      await this.sock.logout().catch(() => {});
    }
    await this._updateSessionStatus({ servidorActivo: false, sesionValida: false });
  }
}
