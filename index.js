/**
 * index.js
 * 
 * Servidor Web, Monitor de UPS y Orquestador de Alta Disponibilidad / Respaldos
 */

'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { UpsMonitor } = require('./ups-monitor');
const { DatabaseManager } = require('./services/database-manager');
const { TelegramBotService } = require('./services/telegram-bot');
const { FailoverOrchestrator } = require('./services/failover-orchestrator');

const args = process.argv.slice(2);
const CLI_MODE = args.includes('--cli');

// 1. Inicialización de componentes
const monitor = new UpsMonitor({
  pollIntervalMs: config.pollIntervalMs,
  batteryVoltageLow: config.batteryLow,
  batteryVoltageHigh: config.batteryHigh,
  nominalPowerWatts: config.nominalWatts,
});

const telegramBot = new TelegramBotService(config.telegram);
const dbManager = new DatabaseManager({
  type: config.database.type,
  name: config.database.name,
  user: config.database.user,
  password: config.database.password,
  backupsDir: config.failover.backupsDir,
});

const orchestrator = new FailoverOrchestrator({
  upsMonitor: monitor,
  dbManager,
  telegramBot,
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Clientes SSE conectados
const sseClients = new Set();

function broadcastState() {
  const payload = `data: ${JSON.stringify(getCombinedState())}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch (_) {
      sseClients.delete(res);
    }
  }
}

function getCombinedState() {
  const upsState = monitor.getFullState();
  const haState = orchestrator.getStatus();
  return {
    ...upsState,
    ha: haState,
    telegramEnabled: telegramBot.enabled,
  };
}

monitor.on('update', () => broadcastState());
monitor.on('error_state', () => broadcastState());
orchestrator.on('health_update', () => broadcastState());
orchestrator.on('backup_created', () => broadcastState());
orchestrator.on('node_switched', () => broadcastState());

// Rutas API Monitor UPS
app.get('/api/status', (req, res) => res.json(getCombinedState()));
app.get('/api/history', (req, res) => res.json(monitor.getHistory()));
app.get('/api/events', (req, res) => res.json(monitor.getEvents()));

// Rutas API Alta Disponibilidad y Respaldos
app.get('/api/failover/status', (req, res) => res.json(orchestrator.getStatus()));

app.post('/api/failover/backup-now', async (req, res) => {
  try {
    const result = await orchestrator.runBackup('manual_web');
    res.json({ success: true, backup: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/failover/switch', async (req, res) => {
  try {
    if (orchestrator.activeNode === 'PRIMARY') {
      await orchestrator.executeFailoverToStandby('Solicitud manual desde Dashboard Web');
    } else {
      await orchestrator.executeFailbackToPrimary('Solicitud manual desde Dashboard Web');
    }
    res.json({ success: true, activeNode: orchestrator.activeNode });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/backups', (req, res) => {
  res.json(dbManager.listBackups());
});

app.get('/api/backups/download/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(config.failover.backupsDir, filename);
  if (fs.existsSync(filePath)) {
    res.download(filePath);
  } else {
    res.status(404).send('Archivo no encontrado');
  }
});

// Endpoint SSE en tiempo real
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.add(res);
  res.write(`data: ${JSON.stringify(getCombinedState())}\n\n`);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

app.get('/ups', (req, res) => {
  const s = monitor.getFullState();
  res.json(s.telemetry || { error: s.message });
});

async function start() {
  app.listen(config.port, () => {
    console.log(`
=============================================================
  SISTEMA DE ALTA DISPONIBILIDAD & MONITOR UPS CDP INICIADO
=============================================================
  Dashboard Web en Vivo : http://localhost:${config.port}
  API REST              : http://localhost:${config.port}/api/status
  Respaldos Programados : Cada ${config.failover.backupIntervalMinutes} minutos
  Bot de Telegram       : ${telegramBot.enabled ? 'Activado (@' + telegramBot.chatId + ')' : 'Desactivado (configura .env)'}
=============================================================
`);
  });

  await monitor.start();
  telegramBot.start();
  await orchestrator.start();
}

process.on('SIGINT', () => {
  console.log('\nDeteniendo servicios...');
  monitor.stop();
  telegramBot.stop();
  orchestrator.stop();
  process.exit(0);
});

start().catch((err) => {
  console.error('Error al iniciar sistema:', err);
});
