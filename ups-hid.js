/**
 * ups-hid.js
 * 
 * Controlador USB HID de bajísimo nivel para UPS CDP R-SMART (chip MEC0003, VID 0001 / PID 0000).
 * Utiliza la API nativa de Windows (HidD_GetIndexedString) mediante koffi.
 * 
 * MEDIDAS DE SEGURIDAD CRÍTICAS:
 *  - ÚNICAMENTE consulta el índice 0x03 (Q1: telemetría de solo lectura: voltajes, batería, carga).
 *  - NUNCA consulta índices de control ni de apagado (0x04 a 0x0b).
 *  - Valores nominales (220V, 24V, 50Hz) fijados por defecto para no arriesgar comandos de hardware.
 *  - Re-detección dinámica de la ruta HID en caso de reconexión de cable.
 *  - Tolerancia a fallos: no lanza excepciones fatales si el dispositivo está reiniciando.
 */

'use strict';

const koffi = require('koffi');

const VENDOR_ID = 0x0001;
const PRODUCT_ID = 0x0000;

// ÚNICO índice seguro permitido:
const IDX_TELEMETRY = 0x03; // Q1: Solo lectura de estado

// Puente con la API nativa de Windows
const kernel32 = koffi.load('kernel32.dll');
const hid = koffi.load('hid.dll');
const setupapi = koffi.load('setupapi.dll');

const GUID = koffi.struct('GUID', {
  Data1: 'uint32',
  Data2: 'uint16',
  Data3: 'uint16',
  Data4: 'uint8[8]',
});

const CreateFileW = kernel32.func(
  'void* CreateFileW(const char16_t*, uint32, uint32, void*, uint32, uint32, void*)'
);
const CloseHandle = kernel32.func('bool CloseHandle(void*)');
const HidD_GetIndexedString = hid.func(
  'bool HidD_GetIndexedString(void*, uint32, void*, uint32)'
);
const HidD_GetHidGuid = hid.func('void HidD_GetHidGuid(GUID*)');
const SetupDiGetClassDevsW = setupapi.func(
  'void* SetupDiGetClassDevsW(GUID*, void*, void*, uint32)'
);
const SetupDiEnumDeviceInterfaces = setupapi.func(
  'bool SetupDiEnumDeviceInterfaces(void*, void*, GUID*, uint32, void*)'
);
const SetupDiGetDeviceInterfaceDetailW = setupapi.func(
  'bool SetupDiGetDeviceInterfaceDetailW(void*, void*, void*, uint32, uint32*, void*)'
);
const SetupDiDestroyDeviceInfoList = setupapi.func(
  'bool SetupDiDestroyDeviceInfoList(void*)'
);

const DIGCF_PRESENT = 0x02;
const DIGCF_DEVICEINTERFACE = 0x10;
const FILE_SHARE_READ = 0x01;
const FILE_SHARE_WRITE = 0x02;
const OPEN_EXISTING = 3;

/**
 * Busca dinámicamente la ruta activa del dispositivo HID en Windows SetupAPI.
 */
function findHidPath(vendorId = VENDOR_ID, productId = PRODUCT_ID) {
  const guid = koffi.alloc(GUID, 1);
  HidD_GetHidGuid(guid);

  const set = SetupDiGetClassDevsW(
    guid,
    null,
    null,
    DIGCF_PRESENT | DIGCF_DEVICEINTERFACE
  );
  if (!set) return null;

  try {
    const vidStr = 'vid_' + vendorId.toString(16).padStart(4, '0');
    const pidStr = 'pid_' + productId.toString(16).padStart(4, '0');

    for (let i = 0; i < 256; i++) {
      const ifd = Buffer.alloc(32);
      ifd.writeUInt32LE(32, 0);
      if (!SetupDiEnumDeviceInterfaces(set, null, guid, i, ifd)) break;

      const requiredBuf = Buffer.alloc(4);
      SetupDiGetDeviceInterfaceDetailW(set, ifd, null, 0, requiredBuf, null);
      const required = requiredBuf.readUInt32LE(0);
      if (!required || required > 4096) continue;

      const detail = Buffer.alloc(required);
      detail.writeUInt32LE(process.arch === 'x64' ? 8 : 6, 0);
      if (
        !SetupDiGetDeviceInterfaceDetailW(
          set,
          ifd,
          detail,
          required,
          requiredBuf,
          null
        )
      ) {
        continue;
      }

      const path = detail.toString('utf16le', 4).split('\0')[0];
      const lower = path.toLowerCase();
      if (lower.includes(vidStr) && lower.includes(pidStr)) {
        return path;
      }
    }
    return null;
  } finally {
    SetupDiDestroyDeviceInfoList(set);
  }
}

/**
 * Parseo de la respuesta Q1:
 * Formato: (MMM.M NNN.N PPP.P QQQ RR.R SS.S TT.T b7b6b5b4b3b2b1b0\r
 */
function parseQ1(raw) {
  const text = String(raw).replace(/\r/g, '').trim();
  const body = text.startsWith('(') ? text.slice(1) : text;
  const parts = body.split(/\s+/).filter(Boolean);
  if (parts.length < 8) {
    throw new Error('Respuesta Q1 incompleta: ' + JSON.stringify(text));
  }

  const num = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };

  const bits = parts[7];
  const b = String(bits).padEnd(8, '0').split('');
  const flag = (i) => b[i] === '1';

  const status = {
    onBattery: flag(0),
    batteryLow: flag(1),
    bypassOrBoost: flag(2),
    upsFailed: flag(3),
    lineInteractive: flag(4),
    testInProgress: flag(5),
    shutdownActive: flag(6),
    beeperEnabled: flag(7),
  };

  return {
    inputVoltage: num(parts[0]),
    inputVoltageFault: num(parts[1]),
    outputVoltage: num(parts[2]),
    loadPercent: num(parts[3]),
    inputFrequency: num(parts[4]),
    batteryVoltage: num(parts[5]),
    temperature: num(parts[6]),
    statusBits: bits,
    status,
  };
}

function statusText(status) {
  const parts = [];
  if (status.onBattery) parts.push('OB');
  else parts.push('OL');
  if (status.batteryLow) parts.push('LB');
  if (status.bypassOrBoost) parts.push('BOOST');
  if (status.upsFailed) parts.push('FSD');
  if (status.testInProgress) parts.push('CAL');
  return parts.join(' ');
}

function estimateBatteryCharge(batteryVoltage, low = 20.8, high = 27.4) {
  if (batteryVoltage == null || !Number.isFinite(batteryVoltage)) return null;
  if (batteryVoltage > 18.0) {
    low = low || 20.8;
    high = high || 27.4;
  } else {
    low = 10.4;
    high = 13.7;
  }
  const pct = (100 * (batteryVoltage - low)) / (high - low);
  return Math.max(0, Math.min(100, Math.round(pct)));
}

class UpsHid {
  constructor(options = {}) {
    this.vendorId = options.vendorId ?? VENDOR_ID;
    this.productId = options.productId ?? PRODUCT_ID;
    this.batteryVoltageLow = options.batteryVoltageLow ?? 20.8;
    this.batteryVoltageHigh = options.batteryVoltageHigh ?? 27.4;

    this._path = null;
    this._handle = null;
    this._isOpen = false;

    // Valores nominales seguros conocidos del CDP R-SMART751:
    this.staticInfo = {
      manufacturer: 'CDP',
      model: 'R-SMART751',
      firmware: 'IPS-2.08C+',
      inputVoltageNominal: 220.0,
      batteryVoltageNominal: 24.0,
      inputFrequencyNominal: 50.0,
    };
  }

  isOpen() {
    return Boolean(this._handle && this._isOpen);
  }

  _ensureOpen() {
    if (this._handle) return;
    this._path = findHidPath(this.vendorId, this.productId);
    if (!this._path) {
      throw new Error('UPS_DISCONNECTED: Cable USB del UPS no detectado.');
    }

    const handle = CreateFileW(
      this._path,
      0,
      FILE_SHARE_READ | FILE_SHARE_WRITE,
      null,
      OPEN_EXISTING,
      0,
      null
    );

    if (!handle) {
      throw new Error('UPS_OPEN_FAILED: No se pudo abrir la conexión con el UPS.');
    }

    this._handle = handle;
    this._isOpen = true;
  }

  /**
   * Lee la telemetría en tiempo real (ÚNICAMENTE índice 0x03).
   * Si el chip está respondiendo "UPS No Ack", no rompe el programa.
   */
  readTelemetry() {
    this._ensureOpen();
    const buffer = Buffer.alloc(2048, 0);

    const ok = HidD_GetIndexedString(this._handle, IDX_TELEMETRY, buffer, 1024);
    if (!ok) {
      this.close();
      throw new Error('UPS_IO_ERROR: No se pudo comunicar con el puerto USB del UPS.');
    }

    const raw = buffer.toString('utf16le').split('\0')[0];
    if (raw === 'UPS No Ack') {
      return {
        ...this.staticInfo,
        waitingAck: true,
        message: 'Esperando respuesta del microcontrolador (No Ack)...',
        timestamp: new Date().toISOString(),
      };
    }

    const status = parseQ1(raw);
    const batteryCharge = estimateBatteryCharge(
      status.batteryVoltage,
      this.batteryVoltageLow,
      this.batteryVoltageHigh
    );

    return {
      ...this.staticInfo,
      ...status,
      waitingAck: false,
      statusText: statusText(status.status),
      batteryCharge,
      timestamp: new Date().toISOString(),
    };
  }

  close() {
    if (this._handle) {
      try {
        CloseHandle(this._handle);
      } catch (_) {}
      this._handle = null;
    }
    this._isOpen = false;
    this._path = null;
  }
}

module.exports = {
  UpsHid,
  parseQ1,
  statusText,
  estimateBatteryCharge,
  findHidPath,
};
