/**
 * services/telegram-bot.js
 * 
 * Bot de Telegram interactivo con botones de teclado, captura automática de Chat ID
 * y notificaciones push en tiempo real.
 */

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

class TelegramBotService extends EventEmitter {
  constructor(config = {}) {
    super();
    this.token = config.token || '';
    this.chatId = this._sanitizeChatId(config.chatId);
    this.enabled = Boolean(config.enabled && this.token);

    this.lastUpdateId = 0;
    this.isPolling = false;
    this.pollTimeout = null;
    this.botInfo = null;

    // Teclado interactivo permanente en Telegram
    this.mainKeyboard = {
      keyboard: [
        [{ text: '📊 Estado General' }, { text: '⚡ Telemetría UPS' }],
        [{ text: '🔋 Nivel de Batería' }, { text: '💾 Respaldar Base de Datos' }],
        [{ text: '🔄 Conmutar Nodo (HA)' }, { text: '❓ Ayuda' }],
      ],
      resize_keyboard: true,
      persistent: true,
    };
  }

  _sanitizeChatId(chatId) {
    if (!chatId) return '';
    const str = String(chatId).trim();
    // Si el usuario puso la URL del bot por error, descartarla para auto-capturar el ID numérico
    if (str.startsWith('http') || str.startsWith('@')) return '';
    return str;
  }

  _saveChatIdToEnv(chatId) {
    try {
      const envPath = path.join(__dirname, '..', '.env');
      if (fs.existsSync(envPath)) {
        let content = fs.readFileSync(envPath, 'utf8');
        if (/TELEGRAM_CHAT_ID=.*/i.test(content)) {
          content = content.replace(/TELEGRAM_CHAT_ID=.*/i, `TELEGRAM_CHAT_ID=${chatId}`);
        } else {
          content += `\nTELEGRAM_CHAT_ID=${chatId}\n`;
        }
        fs.writeFileSync(envPath, content, 'utf8');
        console.log(`[TELEGRAM] CHAT_ID (${chatId}) guardado automáticamente en .env`);
      }
    } catch (err) {
      console.warn('[TELEGRAM] No se pudo guardar CHAT_ID en .env:', err.message);
    }
  }

  async start() {
    if (!this.token) {
      console.log('[TELEGRAM] Token no configurado en .env');
      return;
    }

    try {
      const me = await this._request('getMe');
      if (me && me.ok) {
        this.botInfo = me.result;
        console.log(`[TELEGRAM] Conectado exitosamente como @${this.botInfo.username} (${this.botInfo.first_name})`);
      } else {
        console.error('[TELEGRAM] Error al validar token de Telegram:', me);
        return;
      }
    } catch (err) {
      console.error('[TELEGRAM] Error de conexión con Telegram:', err.message);
      return;
    }

    this.isPolling = true;
    this._poll();

    if (this.chatId) {
      await this.sendAlert(
        '🤖 Bot de Control Conectado',
        `El sistema de monitoreo UPS y Alta Disponibilidad está en línea.\n` +
        `Usa los botones del teclado interactivo abajo para operar el sistema.`
      );
    } else {
      console.log(`[TELEGRAM] ⚠️ Esperando interacción: Abre https://t.me/${this.botInfo.username} en tu Telegram y presiona INICIAR (/start) para vincularte.`);
    }
  }

  stop() {
    this.isPolling = false;
    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }
  }

  _request(method, data = {}) {
    return new Promise((resolve) => {
      if (!this.token) return resolve(null);

      const payload = JSON.stringify(data);
      const options = {
        hostname: 'api.telegram.org',
        path: `/bot${this.token}/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 25000,
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (_) {
            resolve({ ok: false, error: body });
          }
        });
      });

      req.on('error', (err) => resolve({ ok: false, error: err.message }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, error: 'timeout' });
      });

      req.write(payload);
      req.end();
    });
  }

  async sendMessage(text, extra = {}) {
    if (!this.token || !this.chatId) return null;
    return this._request('sendMessage', {
      chat_id: this.chatId,
      text,
      parse_mode: 'Markdown',
      reply_markup: this.mainKeyboard,
      ...extra,
    });
  }

  async sendAlert(title, message) {
    if (!this.chatId) return;
    const time = new Date().toLocaleTimeString();
    const formatted = `*${title}*\n⏱ _${time}_\n\n${message}`;
    return this.sendMessage(formatted);
  }

  async _poll() {
    if (!this.isPolling) return;

    try {
      const res = await this._request('getUpdates', {
        offset: this.lastUpdateId + 1,
        timeout: 15,
      });

      if (res && res.ok && Array.isArray(res.result)) {
        for (const update of res.result) {
          this.lastUpdateId = update.update_id;
          if (update.message && update.message.text) {
            await this._handleMessage(update.message);
          }
        }
      }
    } catch (_) {}

    if (this.isPolling) {
      this.pollTimeout = setTimeout(() => this._poll(), 1200);
    }
  }

  async _handleMessage(message) {
    const text = message.text.trim();
    const chatId = String(message.chat.id);
    const user = message.from?.first_name || 'Usuario';

    // Captura automática del chat_id de quien hable con el bot
    if (!this.chatId || this.chatId !== chatId) {
      this.chatId = chatId;
      this._saveChatIdToEnv(chatId);
      console.log(`[TELEGRAM] Vinculado con éxito al usuario ${user} (Chat ID: ${chatId})`);
    }

    const tLower = text.toLowerCase();

    if (tLower.startsWith('/start') || tLower.includes('ayuda')) {
      const welcome =
`👋 *¡Hola ${user}!*

Bienvenido al sistema de control del **Monitor UPS CDP & Alta Disponibilidad**.

Usa los botones interactivos abajo para consultar y operar:
📊 *Estado General:* Resumen de red, batería y nodo activo
⚡ *Telemetría UPS:* Voltajes exactos, frecuencia y temperatura
🔋 *Nivel de Batería:* Carga, tensión y autonomía restante
💾 *Respaldar Base de Datos:* Respaldo inmediato de la BD
🔄 *Conmutar Nodo (HA):* Alternar entre HomeLab y Servidor Remoto`;
      await this.sendMessage(welcome);
    } else if (tLower.includes('estado') || tLower === '/estado') {
      this.emit('command_status');
    } else if (tLower.includes('telemetría') || tLower.includes('telemetria') || tLower === '/ups') {
      this.emit('command_ups');
    } else if (tLower.includes('batería') || tLower.includes('bateria')) {
      this.emit('command_battery');
    } else if (tLower.includes('respaldar') || tLower === '/respaldo') {
      await this.sendMessage('⏳ *Iniciando respaldo de base de datos solicitado...*');
      this.emit('command_backup');
    } else if (tLower.includes('conmutar') || tLower === '/conmutar') {
      this.emit('command_switch');
    } else {
      await this.sendMessage('🤖 Comando no reconocido. Puedes usar los botones abajo para elegir una acción.');
    }
  }
}

module.exports = { TelegramBotService };
