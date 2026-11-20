/**
 * ups-monitor.js
 * 
 * Motor de monitoreo tolerante a fallos para UPS CDP R-SMART.
 */

'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { UpsHid } = require('./ups-hid');

const EVENTS_FILE = path.join(__dirname, 'events-history.json');
const MAX_TELEMETRY_POINTS = 60;
const MAX_SAVED_EVENTS = 100;

class UpsMonitor extends EventEmitter {
  constructor(options = {}) {
    super();

    this.pollIntervalMs = options.pollIntervalMs || 2500;
    this.nominalPowerWatts = options.nominalPowerWatts || 375;
    this.batteryCapacityWh = options.batteryCapacityWh || 172.8;

    this.ups = new UpsHid(options);
    this.timer = null;
    this.isRunning = false;

    this.state = {
      connected: false,
      status: 'DISCONNECTED', // ONLINE, ON_BATTERY, DISCONNECTED, SYNCHRONIZING
      message: 'Iniciando conexión con UPS...',
      telemetry: null,
      runtimeMinutes: null,
      dischargeRatePctPerMin: 0,
      activeOutage: null,
      summary: {
        totalOutages: 0,
        totalOutageDurationSeconds: 0,
        startTime: new Date().toISOString(),
      },
    };

    this.telemetryHistory = [];
    this._batteryReadings = [];
    this.events = this._loadEvents();
  }

  _loadEvents() {
    try {
      if (fs.existsSync(EVENTS_FILE)) {
        return JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8'));
      }
    } catch (_) {}
    return [];
  }

  _saveEvents() {
    try {
      fs.writeFileSync(EVENTS_FILE, JSON.stringify(this.events.slice(0, MAX_SAVED_EVENTS), null, 2), 'utf8');
    } catch (_) {}
  }

  addEvent(type, title, description, details = {}) {
    const event = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      type,
      title,
      description,
      details,
      timestamp: new Date().toISOString(),
    };

    this.events.unshift(event);
    if (this.events.length > MAX_SAVED_EVENTS) this.events.pop();
    this._saveEvents();
    this.emit('event', event);
    return event;
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;

    await this._tick();

    this.timer = setInterval(() => {
      this._tick().catch(() => {});
    }, this.pollIntervalMs);
  }

  stop() {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.ups.close();
  }

  async _tick() {
    try {
      const telemetry = this.ups.readTelemetry();

      if (telemetry.waitingAck) {
        this.state.connected = true;
        this.state.status = 'SYNCHRONIZING';
        this.state.message = 'Sincronizando con el microcontrolador del UPS...';
        this.emit('update', this.getFullState());
        return;
      }

      this._processTelemetry(telemetry);
    } catch (err) {
      this._handleError(err);
    }
  }

  _processTelemetry(telemetry) {
    const now = Date.now();
    const prevTelemetry = this.state.telemetry;
    const wasOnBattery = prevTelemetry?.status?.onBattery || false;
    const isOnBattery = telemetry.status?.onBattery || false;

    const loadWatts = Math.round(((telemetry.loadPercent || 0) / 100) * this.nominalPowerWatts);
    telemetry.loadWatts = loadWatts;

    // Corte de luz detectado
    if (isOnBattery && !wasOnBattery) {
      this.state.activeOutage = {
        startTime: now,
        startCharge: telemetry.batteryCharge,
        startVoltage: telemetry.batteryVoltage,
      };

      this.state.summary.totalOutages += 1;
      this.addEvent(
        'OUTAGE_START',
        'Corte de Energía Detectado',
        `Se interrumpió la red eléctrica. El UPS está operando con batería (${telemetry.batteryVoltage}V, carga ${telemetry.loadPercent}%).`,
        {
          inputVoltage: telemetry.inputVoltage,
          batteryVoltage: telemetry.batteryVoltage,
          batteryCharge: telemetry.batteryCharge,
        }
      );
    }

    // Retorno de red eléctrica
    if (!isOnBattery && wasOnBattery && this.state.activeOutage) {
      const outageDurationMs = now - this.state.activeOutage.startTime;
      const durationSeconds = Math.round(outageDurationMs / 1000);
      this.state.summary.totalOutageDurationSeconds += durationSeconds;

      const mins = Math.floor(durationSeconds / 60);
      const secs = durationSeconds % 60;
      const durationStr = mins > 0 ? `${mins} min ${secs} s` : `${secs} segundos`;

      this.addEvent(
        'OUTAGE_END',
        'Energía Eléctrica Restablecida',
        `Volvió la red eléctrica después de ${durationStr}. Batería restante: ${telemetry.batteryCharge}%.`,
        { durationSeconds, batteryCharge: telemetry.batteryCharge }
      );

      this.state.activeOutage = null;
    }

    // Alerta de batería baja
    if (telemetry.status?.batteryLow && (!prevTelemetry || !prevTelemetry.status?.batteryLow)) {
      this.addEvent(
        'BATTERY_LOW',
        'Batería Baja (Alerta Crítica)',
        `La batería ha alcanzado nivel bajo (${telemetry.batteryCharge}%). Guarde sus archivos.`,
        { batteryCharge: telemetry.batteryCharge, batteryVoltage: telemetry.batteryVoltage }
      );
    }

    // Cálculo de descarga y autonomía
    this._batteryReadings.push({
      time: now,
      charge: telemetry.batteryCharge,
      voltage: telemetry.batteryVoltage,
      onBattery: isOnBattery,
    });

    const threeMinutesAgo = now - 180000;
    this._batteryReadings = this._batteryReadings.filter((r) => r.time >= threeMinutesAgo);

    let dischargeRate = 0;
    if (isOnBattery && this._batteryReadings.length >= 2) {
      const oldest = this._batteryReadings[0];
      const deltaCharge = oldest.charge - telemetry.batteryCharge;
      const deltaMin = (now - oldest.time) / 60000;
      if (deltaMin > 0.3 && deltaCharge > 0) {
        dischargeRate = +(deltaCharge / deltaMin).toFixed(2);
      }
    }
    this.state.dischargeRatePctPerMin = dischargeRate;

    let estimatedMinutes = null;
    if (telemetry.batteryCharge != null) {
      const currentWatts = Math.max(telemetry.loadWatts, 25);
      const currentWh = (telemetry.batteryCharge / 100) * this.batteryCapacityWh * 0.85;

      if (dischargeRate > 0) {
        estimatedMinutes = Math.round(telemetry.batteryCharge / dischargeRate);
      } else {
        estimatedMinutes = Math.round((currentWh / currentWatts) * 60);
      }
      estimatedMinutes = Math.min(Math.max(estimatedMinutes, 1), 180);
    }
    this.state.runtimeMinutes = estimatedMinutes;

    this.state.connected = true;
    this.state.status = isOnBattery ? 'ON_BATTERY' : 'ONLINE';
    this.state.message = isOnBattery
      ? '¡CORTE DE ENERGÍA! Operando con batería'
      : 'Red eléctrica estable (En Línea)';
    this.state.telemetry = telemetry;

    if (this.state.activeOutage) {
      this.state.activeOutage.elapsedSeconds = Math.round((now - this.state.activeOutage.startTime) / 1000);
    }

    this.telemetryHistory.push({
      timestamp: new Date().toLocaleTimeString(),
      inputVoltage: telemetry.inputVoltage,
      outputVoltage: telemetry.outputVoltage,
      batteryCharge: telemetry.batteryCharge,
      batteryVoltage: telemetry.batteryVoltage,
      loadPercent: telemetry.loadPercent,
      onBattery: isOnBattery,
    });

    if (this.telemetryHistory.length > MAX_TELEMETRY_POINTS) {
      this.telemetryHistory.shift();
    }

    this.emit('update', this.getFullState());
  }

  _handleError(err) {
    const msg = err.message || String(err);
    this.state.connected = false;
    this.state.status = /UPS_DISCONNECTED/i.test(msg) ? 'DISCONNECTED' : 'RETRYING';
    this.state.message = 'Esperando conexión con el UPS...';
    this.ups.close();
    this.emit('error_state', this.getFullState());
  }

  getFullState() {
    return {
      connected: this.state.connected,
      status: this.state.status,
      message: this.state.message,
      telemetry: this.state.telemetry,
      runtimeMinutes: this.state.runtimeMinutes,
      dischargeRatePctPerMin: this.state.dischargeRatePctPerMin,
      activeOutage: this.state.activeOutage,
      summary: this.state.summary,
      recentEvents: this.events.slice(0, 10),
    };
  }

  getHistory() {
    return this.telemetryHistory;
  }

  getEvents() {
    return this.events;
  }
}

module.exports = { UpsMonitor };
