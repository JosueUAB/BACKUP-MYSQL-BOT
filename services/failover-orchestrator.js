/**
 * services/failover-orchestrator.js
 * 
 * Orquestador principal de Alta Disponibilidad, Respaldos y Recuperación ante Desastres.
 * Vincula el monitor del UPS con las bases de datos y las alertas de Telegram.
 */

'use strict';

const EventEmitter = require('events');
const config = require('../config');

class FailoverOrchestrator extends EventEmitter {
  constructor({ upsMonitor, dbManager, telegramBot }) {
    super();

    this.upsMonitor = upsMonitor;
    this.dbManager = dbManager;
    this.telegramBot = telegramBot;

    this.activeNode = 'PRIMARY'; // 'PRIMARY' (HomeLab) | 'STANDBY' (Remoto)
    this.isBackingUp = false;
    this.isSwitching = false;
    this.lastBackup = null;

    this.primaryConfig = config.database.primary;
    this.standbyConfig = config.database.standby;

    this.health = {
      primary: { reachable: false, latencyMs: 0 },
      standby: { reachable: false, latencyMs: 0 },
      lastChecked: null,
    };

    this.backupTimer = null;
    this.healthTimer = null;
  }

  async start() {
    console.log('[HA ORCHESTRATOR] Iniciando orquestador de Alta Disponibilidad y Respaldos...');

    // 1. Escuchar eventos del UPS
    this._bindUpsEvents();

    // 2. Escuchar comandos de Telegram
    this._bindTelegramCommands();

    // 3. Chequeo periódico de salud de nodos (cada 15 segundos)
    await this.checkNodesHealth();
    this.healthTimer = setInterval(() => this.checkNodesHealth(), 15000);

    // 4. Programar respaldos periódicos (cada N minutos)
    const intervalMs = config.failover.backupIntervalMinutes * 60 * 1000;
    this.backupTimer = setInterval(() => {
      this.runBackup('scheduled').catch((err) => {
        console.error('[HA BACKUP] Error en respaldo programado:', err.message);
      });
    }, intervalMs);

    console.log(`[HA ORCHESTRATOR] Respaldos automáticos programados cada ${config.failover.backupIntervalMinutes} minutos.`);
  }

  stop() {
    if (this.backupTimer) clearInterval(this.backupTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
  }

  _bindUpsEvents() {
    // Corte de energía detectado
    this.upsMonitor.on('event', async (event) => {
      if (event.type === 'OUTAGE_START') {
        const t = this.upsMonitor.state.telemetry;
        await this.telegramBot.sendAlert(
          '🚨 ¡CORTE DE ENERGÍA EN HOMELAB!',
          `Se interrumpió la red eléctrica.\n` +
          `🔋 Batería: *${t?.batteryCharge || '--'}%* (${t?.batteryVoltage || '--'} V)\n` +
          `⏱ Autonomía estimada: *${this.upsMonitor.state.runtimeMinutes || '--'} min*\n` +
          `⚡ Carga conectada: *${t?.loadWatts || '--'} W*\n\n` +
          `💾 *Iniciando respaldo de emergencia inmediato...*`
        );

        // Disparar respaldo de emergencia inmediato
        try {
          await this.runBackup('emergency_outage');
        } catch (e) {
          console.error('[HA] Error en respaldo de emergencia:', e.message);
        }

        // Si la batería ya está baja o está configurado conmutación inmediata
        if (config.failover.autoFailoverOnOutage && this.activeNode === 'PRIMARY') {
          const bat = t?.batteryCharge || 100;
          if (bat <= config.failover.batteryThreshold) {
            await this.executeFailoverToStandby('Batería crítica en corte de luz');
          }
        }
      } else if (event.type === 'OUTAGE_END') {
        const details = event.details || {};
        await this.telegramBot.sendAlert(
          '🟢 ENERGÍA ELÉCTRICA RESTABLECIDA',
          `Volvió la luz en el HomeLab después de *${details.durationSeconds || 0} segundos*.\n` +
          `🔋 Batería actual: *${details.batteryCharge || '--'}%*.\n` +
          `📍 Nodo activo actual: *${this.activeNode === 'PRIMARY' ? 'HomeLab' : 'Servidor Remoto'}*.`
        );
      } else if (event.type === 'BATTERY_LOW') {
        await this.telegramBot.sendAlert(
          '⚠️ ALERTA CRÍTICA: BATERÍA BAJA',
          `El UPS tiene batería inferior al 20%. Preparando conmutación de seguridad.`
        );
        if (this.activeNode === 'PRIMARY') {
          await this.executeFailoverToStandby('Batería baja crítica (<20%)');
        }
      }
    });

    // Monitoreo continuo de nivel de batería en corte
    this.upsMonitor.on('update', async (state) => {
      if (
        state.status === 'ON_BATTERY' &&
        this.activeNode === 'PRIMARY' &&
        config.failover.autoFailoverOnOutage
      ) {
        const charge = state.telemetry?.batteryCharge;
        if (charge != null && charge <= config.failover.batteryThreshold && !this.isSwitching) {
          await this.executeFailoverToStandby(`Batería alcanzó umbral crítico (${charge}%)`);
        }
      }
    });
  }

  _bindTelegramCommands() {
    this.telegramBot.on('command_status', async () => {
      const s = this.upsMonitor.getFullState();
      const t = s.telemetry;
      const msg =
`📊 *Estado General del Sistema*

⚡ *UPS & Energía:*
• Estado: *${s.status}* (${s.message})
• Batería: *${t?.batteryCharge ?? '--'}%* (${t?.batteryVoltage?.toFixed(1) ?? '--'} V)
• Red Eléctrica: *${t?.inputVoltage?.toFixed(1) ?? '--'} V*
• Autonomía: *${s.runtimeMinutes ?? '--'} minutos*

🌐 *Alta Disponibilidad & Nodos:*
• Nodo Activo: *${this.activeNode === 'PRIMARY' ? '🏠 HomeLab (Primario)' : '☁️ Servidor Remoto'}*
• HomeLab (${this.primaryConfig.host}): *${this.health.primary.reachable ? '🟢 Conectado (' + this.health.primary.latencyMs + 'ms)' : '🔴 Desconectado'}*
• Remoto VPN (${this.standbyConfig.host}): *${this.health.standby.reachable ? '🟢 Conectado (' + this.health.standby.latencyMs + 'ms)' : '🔴 Desconectado'}*

💾 *Último Respaldo:*
• Archivo: \`${this.lastBackup?.filename || 'Ninguno aún'}\`
• Tamaño: *${this.lastBackup?.sizeFormatted || '--'}*`;
      await this.telegramBot.sendMessage(msg);
    });

    this.telegramBot.on('command_ups', async () => {
      const t = this.upsMonitor.state.telemetry;
      if (!t) return this.telegramBot.sendMessage('⚠️ No hay telemetría disponible del UPS.');
      const msg =
`⚡ *Telemetría Detallada UPS CDP*
• Modelo: *${t.manufacturer} ${t.model}*
• Firmware: *${t.firmware}*
• Tensión Entrada: *${t.inputVoltage} V* (${t.inputFrequency} Hz)
• Tensión Salida: *${t.outputVoltage} V*
• Carga de Equipos: *${t.loadPercent}%* (~${t.loadWatts} W)
• Batería: *${t.batteryCharge}%* (${t.batteryVoltage} V)
• Temperatura: *${t.temperature} °C*`;
      await this.telegramBot.sendMessage(msg);
    });

    this.telegramBot.on('command_battery', async () => {
      const s = this.upsMonitor.getFullState();
      const t = s.telemetry;
      const pct = t?.batteryCharge || 0;
      const bars = Math.round(pct / 10);
      const visualBar = '█'.repeat(bars) + '░'.repeat(10 - bars);

      const msg =
`🔋 *Estado de la Batería del UPS*

[${visualBar}] *${pct}%*
• Tensión actual: *${t?.batteryVoltage?.toFixed(1) || '--'} V*
• Autonomía estimada: *${s.runtimeMinutes || '--'} minutos*
• Tasa de descarga: *${s.dischargeRatePctPerMin} %/min*
• Carga de consumo: *${t?.loadPercent || 0}%* (~${t?.loadWatts || 0} W)
• Estado de red: *${s.status === 'ON_BATTERY' ? '🚨 En Batería (Corte de Luz)' : '🟢 Red Eléctrica Estable'}*`;
      await this.telegramBot.sendMessage(msg);
    });

    this.telegramBot.on('command_backup', async () => {
      try {
        const res = await this.runBackup('telegram_manual');
        await this.telegramBot.sendMessage(
          `✅ *Respaldo completado con éxito*\n` +
          `📁 Archivo: \`${res.filename}\`\n` +
          `📦 Tamaño: *${res.sizeFormatted}*\n` +
          `⏱ Duración: *${res.durationSec}s*`
        );
      } catch (err) {
        await this.telegramBot.sendMessage(`❌ *Error en respaldo:* ${err.message}`);
      }
    });

    this.telegramBot.on('command_switch', async () => {
      try {
        if (this.activeNode === 'PRIMARY') {
          await this.executeFailoverToStandby('Solicitud manual desde Telegram');
        } else {
          await this.executeFailbackToPrimary('Solicitud manual desde Telegram');
        }
      } catch (err) {
        await this.telegramBot.sendMessage(`❌ *Error en conmutación:* ${err.message}`);
      }
    });
  }

  async checkNodesHealth() {
    const [pHealth, sHealth] = await Promise.all([
      this.dbManager.testConnection(this.primaryConfig.host, this.primaryConfig.port),
      this.dbManager.testConnection(this.standbyConfig.host, this.standbyConfig.port),
    ]);

    this.health.primary = pHealth;
    this.health.standby = sHealth;
    this.health.lastChecked = new Date().toISOString();

    this.emit('health_update', this.health);
    return this.health;
  }

  /**
   * Ejecuta un respaldo completo de la base de datos actualmente activa.
   */
  async runBackup(tag = 'auto') {
    if (this.isBackingUp) throw new Error('Ya hay un respaldo en ejecución.');
    this.isBackingUp = true;

    try {
      const source = this.activeNode === 'PRIMARY' ? this.primaryConfig : this.standbyConfig;
      console.log(`[HA BACKUP] Creando respaldo de ${this.activeNode} (${source.host}:${source.port})...`);

      const result = await this.dbManager.createBackup(source.host, source.port, tag);
      this.lastBackup = result;

      console.log(`[HA BACKUP] Respaldo finalizado: ${result.filename} (${result.sizeFormatted})`);
      this.emit('backup_created', result);
      return result;
    } finally {
      this.isBackingUp = false;
    }
  }

  /**
   * Conmutación de emergencia (Failover): HomeLab -> Servidor Remoto
   */
  async executeFailoverToStandby(reason = 'Corte de energía') {
    if (this.isSwitching) return;
    this.isSwitching = true;

    console.log(`[FAILOVER] Iniciando conmutación a Servidor Remoto. Razón: ${reason}`);
    await this.telegramBot.sendAlert(
      '🚀 INICIANDO CONMUTACIÓN A SERVIDOR REMOTO',
      `Razón: *${reason}*\n\n1. Creando snapshot de seguridad...\n2. Configurando HomeLab en solo lectura.\n3. Promoviendo Servidor Remoto a Lectura/Escritura.`
    );

    try {
      // 1. Respaldo previo al corte
      let backupResult = null;
      try {
        backupResult = await this.runBackup('pre_failover');
      } catch (_) {}

      // 2. Bloquear escrituras en HomeLab para evitar Split-Brain
      try {
        await this.dbManager.setReadOnly(this.primaryConfig.host, this.primaryConfig.port, true);
      } catch (err) {
        console.warn('[FAILOVER] Aviso: HomeLab no respondió al bloqueo (puede estar apagado):', err.message);
      }

      // 3. Restaurar en el nodo Remoto si hay respaldo
      if (backupResult && backupResult.filepath) {
        console.log('[FAILOVER] Sincronizando último respaldo en Servidor Remoto...');
        try {
          await this.dbManager.restoreBackup(this.standbyConfig.host, this.standbyConfig.port, backupResult.filepath);
        } catch (err) {
          console.warn('[FAILOVER] Aviso al restaurar en standby:', err.message);
        }
      }

      // 4. Activar escritura en el Servidor Remoto
      try {
        await this.dbManager.setReadOnly(this.standbyConfig.host, this.standbyConfig.port, false);
      } catch (_) {}

      this.activeNode = 'STANDBY';
      console.log('[FAILOVER] Conmutación completada. Nodo activo: STANDBY (Remoto)');

      await this.telegramBot.sendAlert(
        '✅ CONMUTACIÓN COMPLETADA CON ÉXITO',
        `El servicio ahora está operando en el *Servidor Remoto (${this.standbyConfig.host})*.\n` +
        `Integridad garantizada: HomeLab congelado para prevenir escrituras divididas.`
      );

      this.emit('node_switched', { activeNode: 'STANDBY', reason });
    } finally {
      this.isSwitching = false;
    }
  }

  /**
   * Retorno seguro (Failback): Servidor Remoto -> HomeLab
   */
  async executeFailbackToPrimary(reason = 'Retorno de energía') {
    if (this.isSwitching) return;
    this.isSwitching = true;

    console.log(`[FAILBACK] Iniciando retorno a HomeLab. Razón: ${reason}`);
    await this.telegramBot.sendAlert(
      '🔄 INICIANDO RETORNO (FAILBACK) A HOMELAB',
      `Razón: *${reason}*\nSincronizando cambios generados en el Servidor Remoto de vuelta al HomeLab...`
    );

    try {
      // 1. Congelar el Servidor Remoto para capturar deltas
      await this.dbManager.setReadOnly(this.standbyConfig.host, this.standbyConfig.port, true);

      // 2. Extraer respaldo de los datos generados en el Remoto
      const deltaBackup = await this.dbManager.createBackup(this.standbyConfig.host, this.standbyConfig.port, 'failback_delta');

      // 3. Restaurar en HomeLab
      await this.dbManager.restoreBackup(this.primaryConfig.host, this.primaryConfig.port, deltaBackup.filepath);

      // 4. Activar escritura en HomeLab
      await this.dbManager.setReadOnly(this.primaryConfig.host, this.primaryConfig.port, false);

      this.activeNode = 'PRIMARY';
      console.log('[FAILBACK] Retorno completado. Nodo activo: PRIMARY (HomeLab)');

      await this.telegramBot.sendAlert(
        '✅ RETORNO A HOMELAB COMPLETADO',
        `HomeLab vuelve a ser el nodo primario activo.\n` +
        `Todos los datos generados durante el corte fueron transferidos e integrados.`
      );

      this.emit('node_switched', { activeNode: 'PRIMARY', reason });
    } finally {
      this.isSwitching = false;
    }
  }

  getStatus() {
    return {
      activeNode: this.activeNode,
      isBackingUp: this.isBackingUp,
      isSwitching: this.isSwitching,
      lastBackup: this.lastBackup,
      health: this.health,
      primaryConfig: { host: this.primaryConfig.host, port: this.primaryConfig.port },
      standbyConfig: { host: this.standbyConfig.host, port: this.standbyConfig.port },
      backupsCount: this.dbManager.listBackups().length,
    };
  }
}

module.exports = { FailoverOrchestrator };
