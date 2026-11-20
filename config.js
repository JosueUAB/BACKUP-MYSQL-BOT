/**
 * config.js
 * 
 * Carga de configuración centralizada desde variables de entorno y archivo .env
 */

'use strict';

const fs = require('fs');
const path = require('path');

function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx !== -1) {
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim();
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
}

loadDotEnv();

module.exports = {
  port: Number(process.env.PORT || 3000),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 2500),
  batteryLow: Number(process.env.BATTERY_LOW || 20.8),
  batteryHigh: Number(process.env.BATTERY_HIGH || 27.4),
  nominalWatts: Number(process.env.NOMINAL_WATTS || 375),

  database: {
    type: (process.env.DB_TYPE || 'postgres').toLowerCase(),
    name: process.env.DB_NAME || 'sistema',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    primary: {
      host: process.env.PRIMARY_HOST || '192.168.1.50',
      port: Number(process.env.PRIMARY_PORT || 5432),
    },
    standby: {
      host: process.env.STANDBY_HOST || '10.8.0.2',
      port: Number(process.env.STANDBY_PORT || 5432),
    },
  },

  failover: {
    backupIntervalMinutes: Number(process.env.BACKUP_INTERVAL_MINUTES || 60),
    batteryThreshold: Number(process.env.FAILOVER_BATTERY_THRESHOLD || 30),
    autoFailoverOnOutage: process.env.AUTO_FAILOVER_ON_OUTAGE !== 'false',
    backupsDir: path.join(__dirname, 'backups'),
  },

  telegram: {
    enabled: process.env.TELEGRAM_ENABLED === 'true' && Boolean(process.env.TELEGRAM_BOT_TOKEN),
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },
};
