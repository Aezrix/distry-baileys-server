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
    this.backupTimer = null;
    this.reconnectAttempts = 0;
    this.MAX_RECONNECT_ATTEMPTS = 10;
    this.onReadyCallbacks = [];
    this.onDisconnectedCallbacks = [];
    this.loggedOutAttempts = 0;
    this.MAX_LOGOUT_ATTEMPTS = 3;
    this.pendingPairingPhone = null;
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

    // Limpiar estado colgado de sesión anterior antes de intentar conectar.
    // Incluye requestReconnect y requestNewQr para que solicitudes de sesiones
    // previas no vuelvan a dispararse cuando el servidor arranca de nuevo.
    await this._updateSessionStatus({
      servidorActivo: true,
      sesionValida: false,
      qrPendiente: false,
      qrString: null,
      qrImagenBase64: null,
      errorLogout: null,
      errorDesconexion: null,
      requestReconnect: null,
      requestNewQr: null,
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

    // Obtener versión actual de WA Web — si falla usar la última conocida que funciona
    let version;
    try {
      const result = await fetchLatestWaWebVersion();
      version = result.version;
      this.logger.info({ version }, 'Versión WA Web obtenida');
    } catch (e) {
      version = [2, 3000, 1023254234];
      this.logger.warn({ version, err: e.message }, 'fetchLatestWaWebVersion falló — usando versión fija');
    }

    const sessionFiles = readdirSync(this.sessionDir);
    this.logger.info(
      { files: sessionFiles.length, registered: !!state.creds.me, version, dir: this.sessionDir },
      'Cargando sesión'
    );

    // Mostrar solo warnings/errors de Baileys — suficiente para diagnosticar sin spam
    const baileysSilentLog = this.logger.child({ module: 'baileys' });
    baileysSilentLog.level = 'warn';

    this.sock = makeWASocket({
      version,
      browser: Browsers.ubuntu('Chrome'),
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
      connectTimeoutMs: 90_000,
      defaultQueryTimeoutMs: 60_000,
      qrTimeout: 120_000,
    });

    this.sock.ev.on('creds.update', async () => {
      await saveCreds();
      this._scheduleBackup();
    });

    this.sock.ev.on('connection.update', async (update) => {
      await this._handleConnectionUpdate(update);
    });

    // Vinculación por número de teléfono (alternativa al QR)
    if (this.pendingPairingPhone && !state.creds.registered) {
      const phone = this.pendingPairingPhone;
      this.pendingPairingPhone = null;
      setTimeout(async () => {
        try {
          const code = await this.sock.requestPairingCode(phone);
          this.logger.info({ code, phone }, 'Código de vinculación generado');
          await this._updateSessionStatus({ codigoVinculacion: code });
        } catch (e) {
          this.logger.error({ err: e.message }, 'Error al generar código de vinculación');
          await this._updateSessionStatus({ codigoVinculacion: null, errorDesconexion: 'No se pudo generar el código. Intenta de nuevo.' });
        }
      }, 2000);
    }

    return this.sock;
  }

  async _handleConnectionUpdate(update) {
    const { connection, lastDisconnect, qr, isNewLogin, receivedPendingNotifications } = update;

    this.logger.info(
      { connection: connection ?? 'null', hasQr: !!qr, isNewLogin, receivedPendingNotifications },
      '[WA] connection.update'
    );

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
      // Guardar backup una sola vez cuando la sesión queda completamente establecida
      await saveSessionBackup(this.sessionDir).catch(() => {});

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

      const boom = new Boom(lastDisconnect?.error);
      const reason = boom?.output?.statusCode;
      const errorMsg = lastDisconnect?.error?.message ?? 'unknown';

      this.logger.warn({ reason, errorMsg }, '[WA] Conexión cerrada');

      for (const fn of this.onDisconnectedCallbacks) {
        try { fn(reason); } catch (e) { this.logger.error(e); }
      }

      // Limpiar listeners del socket viejo para evitar eventos duplicados en reconexión
      const oldSock = this.sock;
      this.sock = null;
      if (oldSock) {
        try { oldSock.ev.removeAllListeners(); } catch (_) {}
      }

      // 515 restartRequired, 408 connectionLost, 428 connectionClosed → auto-reconectar
      const autoReconnectCodes = [
        DisconnectReason.restartRequired,  // 515
        DisconnectReason.connectionLost,   // 408
        DisconnectReason.connectionClosed, // 428
        DisconnectReason.timedOut,         // 408
      ];
      if (autoReconnectCodes.includes(reason)) {
        this.reconnectAttempts++;
        if (this.reconnectAttempts <= this.MAX_RECONNECT_ATTEMPTS) {
          const delay = Math.min(3000 * this.reconnectAttempts, 30000);
          this.logger.info({ reason, attempt: this.reconnectAttempts, delay }, 'Auto-reconectando...');
          await this._updateSessionStatus({ sesionValida: false, servidorActivo: true });
          this.reconnectTimer = setTimeout(() => this.connect(), delay);
        } else {
          this.logger.error({ attempts: this.reconnectAttempts }, 'Máximo de reconexiones alcanzado');
          await this._updateSessionStatus({
            sesionValida: false,
            servidorActivo: true,
            errorDesconexion: `Sin conexión tras ${this.reconnectAttempts} intentos. Usa "Nuevo QR".`,
          });
        }
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
        // 403 forbidden, 500 badSession, 411 multideviceMismatch → error manual
        this.logger.error({ reason }, 'Error permanente — acción manual requerida');
        this._clearSessionFiles();
        await clearSessionBackup();
        await this._updateSessionStatus({
          sesionValida: false,
          servidorActivo: true,
          qrPendiente: false,
          qrString: null,
          qrImagenBase64: null,
          numeroConectado: null,
          errorLogout: `Sesión inválida (código ${reason}). Usa "Nuevo QR" para vincular de nuevo.`,
        });
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

  // Vincular por número de teléfono en lugar de QR
  async startPhonePairing(phoneNumber) {
    this.logger.info({ phoneNumber }, 'Iniciando vinculación por número de teléfono');
    this.pendingPairingPhone = phoneNumber;
    await this._updateSessionStatus({ codigoVinculacion: null, qrPendiente: false });
    await this.forceNewQr();
  }

  // Cerrar sesión limpiamente y limpiar todo
  async logoutSession() {
    this.logger.info('Cerrando sesión de WhatsApp...');
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sock) {
      try { await this.sock.logout(); } catch (_) {}
      try { this.sock.ev.removeAllListeners(); } catch (_) {}
      this.sock = null;
    }
    this.isConnected = false;
    this._stopHeartbeat();
    this._clearSessionFiles();
    await clearSessionBackup();
    await this._updateSessionStatus({
      sesionValida: false,
      qrPendiente: false,
      qrString: null,
      qrImagenBase64: null,
      numeroConectado: null,
      errorLogout: null,
      errorDesconexion: null,
      codigoVinculacion: null,
    });
  }

  // Reconectar usando credenciales existentes — SIN borrar sesión ni pedir QR
  async reconnectExisting() {
    this.logger.info('Reconectando con sesión existente (sin QR)...');

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
    this.reconnectAttempts = 0;
    this.isConnecting = false;
    // No borra los archivos de sesión — intenta reconectar con los existentes
    setTimeout(() => this.connect(), 500);
  }

  // Throttle backup: guarda como máximo una vez por minuto
  _scheduleBackup() {
    if (this.backupTimer) return;
    this.backupTimer = setTimeout(async () => {
      this.backupTimer = null;
      if (this.isConnected) {
        await saveSessionBackup(this.sessionDir).catch(
          (e) => this.logger.warn({ err: e.message }, 'Backup programado falló')
        );
        this.logger.debug('Backup de sesión actualizado');
      }
    }, 60_000); // 1 minuto
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
    const intervalMs = parseInt(process.env.HEARTBEAT_INTERVAL_MS ?? '120000');
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
