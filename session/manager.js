import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import { getDb, getTimestamp } from '../firebase/admin.js';

const SESSION_STATUS_DOC = 'whatsapp_session/status';

export class SessionManager {
  constructor(sessionDir, logger) {
    this.sessionDir = resolve(sessionDir);
    this.logger = logger;
    this.sock = null;
    this.isConnected = false;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.MAX_RECONNECT_ATTEMPTS = 10;
    this.onReadyCallbacks = [];
    this.onDisconnectedCallbacks = [];
  }

  /**
   * Registra callback que se llama cuando la sesión está lista para enviar mensajes.
   */
  onReady(fn) {
    this.onReadyCallbacks.push(fn);
  }

  onDisconnected(fn) {
    this.onDisconnectedCallbacks.push(fn);
  }

  async connect() {
    if (!existsSync(this.sessionDir)) {
      mkdirSync(this.sessionDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);
    const { version } = await fetchLatestWaWebVersion();

    this.logger.info({ version }, 'Iniciando Baileys');

    this.sock = makeWASocket({
      version,
      browser: Browsers.macOS('Safari'),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, this.logger),
      },
      printQRInTerminal: false,
      logger: this.logger.child({ module: 'baileys', level: 'silent' }),
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      retryRequestDelayMs: 350,
    });

    this.sock.ev.on('creds.update', saveCreds);

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
      await this._updateSessionStatus({
        sesionValida: false,
        qrPendiente: true,
        qrImagenBase64: await this._qrToBase64(qr),
        servidorActivo: true,
      });
    }

    if (connection === 'open') {
      this.isConnected = true;
      this.reconnectAttempts = 0;
      const numero = this.sock.user?.id?.split(':')[0] ?? null;
      this.logger.info({ numero }, 'Sesión WhatsApp conectada');

      await this._updateSessionStatus({
        sesionValida: true,
        qrPendiente: false,
        qrImagenBase64: null,
        servidorActivo: true,
        numeroConectado: numero,
      });

      this._startHeartbeat();

      for (const fn of this.onReadyCallbacks) {
        try { fn(this.sock); } catch (e) { this.logger.error(e); }
      }
    }

    if (connection === 'close') {
      this.isConnected = false;
      this._stopHeartbeat();

      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = reason !== DisconnectReason.loggedOut;

      this.logger.warn({ reason, shouldReconnect }, 'Conexión cerrada');

      for (const fn of this.onDisconnectedCallbacks) {
        try { fn(reason); } catch (e) { this.logger.error(e); }
      }

      if (shouldReconnect && this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
        this.reconnectAttempts++;
        const delay = Math.min(5000 * this.reconnectAttempts, 60_000);
        this.logger.info({ attempt: this.reconnectAttempts, delayMs: delay }, 'Reconectando...');

        await this._updateSessionStatus({
          sesionValida: false,
          servidorActivo: true,
          qrPendiente: false,
        });

        this.reconnectTimer = setTimeout(() => this.connect(), delay);
      } else if (reason === DisconnectReason.loggedOut) {
        this.logger.error('Sesión cerrada por logout — se requiere escanear QR nuevamente');
        await this._updateSessionStatus({
          sesionValida: false,
          servidorActivo: true,
          qrPendiente: true,
          numeroConectado: null,
        });
        // Re-conectar para mostrar nuevo QR
        setTimeout(() => this.connect(), 3000);
      } else {
        this.logger.error({ attempts: this.reconnectAttempts }, 'Máximo de reconexiones alcanzado');
        await this._updateSessionStatus({ sesionValida: false, servidorActivo: false });
      }
    }
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
