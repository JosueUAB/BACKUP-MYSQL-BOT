/**
 * services/database-manager.js
 * 
 * Gestor de bases de datos para respaldos, restauración y prevención de Split-Brain.
 * Soporta PostgreSQL, MySQL y MariaDB a través de VPN.
 */

'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');

class DatabaseManager {
  constructor(config = {}) {
    this.type = (config.type || 'postgres').toLowerCase();
    this.name = config.name || 'sistema';
    this.user = config.user || 'postgres';
    this.password = config.password || '';
    this.backupsDir = config.backupsDir || path.join(__dirname, '..', 'backups');

    if (!fs.existsSync(this.backupsDir)) {
      fs.mkdirSync(this.backupsDir, { recursive: true });
    }

    // Ubicaciones de binarios
    this.pgDumpBin = this._findBinary([
      'C:\\Program Files\\PostgreSQL\\18\\bin\\pg_dump.exe',
      'C:\\Program Files\\PostgreSQL\\17\\bin\\pg_dump.exe',
      'C:\\Program Files\\PostgreSQL\\16\\bin\\pg_dump.exe',
      'pg_dump',
    ]);

    this.psqlBin = this._findBinary([
      'C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe',
      'C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe',
      'C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe',
      'psql',
    ]);

    this.mysqlDumpBin = this._findBinary([
      'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysqldump.exe',
      'mysqldump',
    ]);

    this.mysqlBin = this._findBinary([
      'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysql.exe',
      'mysql',
    ]);
  }

  _findBinary(candidates) {
    for (const bin of candidates) {
      if (fs.existsSync(bin)) return bin;
    }
    return candidates[candidates.length - 1]; // fallback al comando en PATH
  }

  /**
   * Verifica conectividad TCP con el nodo a través de la VPN.
   */
  testConnection(host, port, timeoutMs = 3000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const socket = new net.Socket();

      socket.setTimeout(timeoutMs);

      socket.on('connect', () => {
        const latency = Date.now() - start;
        socket.destroy();
        resolve({ reachable: true, latencyMs: latency });
      });

      socket.on('timeout', () => {
        socket.destroy();
        resolve({ reachable: false, error: 'Tiempo de espera agotado (Timeout)' });
      });

      socket.on('error', (err) => {
        socket.destroy();
        resolve({ reachable: false, error: err.message });
      });

      socket.connect(port, host);
    });
  }

  /**
   * Genera un respaldo completo de la base de datos origen.
   */
  async createBackup(host, port, tag = 'auto') {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `backup_${this.name}_${tag}_${timestamp}.sql`;
    const outputPath = path.join(this.backupsDir, filename);

    return new Promise((resolve, reject) => {
      let cmd = '';
      const env = { ...process.env };

      if (this.type === 'postgres') {
        env.PGPASSWORD = this.password;
        cmd = `"${this.pgDumpBin}" -h ${host} -p ${port} -U ${this.user} -d ${this.name} -F p -f "${outputPath}"`;
      } else {
        const passArg = this.password ? `-p"${this.password}"` : '';
        cmd = `"${this.mysqlDumpBin}" -h ${host} -P ${port} -u ${this.user} ${passArg} ${this.name} > "${outputPath}"`;
      }

      const start = Date.now();
      exec(cmd, { env, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          // Si falló la herramienta nativa, crear un archivo de registro con el detalle del error
          return reject(new Error(`Fallo al respaldar base de datos: ${stderr || err.message}`));
        }

        const stats = fs.existsSync(outputPath) ? fs.statSync(outputPath) : { size: 0 };
        const durationSec = ((Date.now() - start) / 1000).toFixed(1);

        resolve({
          filename,
          filepath: outputPath,
          sizeBytes: stats.size,
          sizeFormatted: (stats.size / 1024 / 1024).toFixed(2) + ' MB',
          durationSec,
          timestamp: new Date().toISOString(),
        });
      });
    });
  }

  /**
   * Restaura un respaldo en el servidor destino (Secundario o Primario).
   */
  async restoreBackup(targetHost, targetPort, backupFilePath) {
    if (!fs.existsSync(backupFilePath)) {
      throw new Error(`Archivo de respaldo no encontrado: ${backupFilePath}`);
    }

    return new Promise((resolve, reject) => {
      let cmd = '';
      const env = { ...process.env };

      if (this.type === 'postgres') {
        env.PGPASSWORD = this.password;
        cmd = `"${this.psqlBin}" -h ${targetHost} -p ${targetPort} -U ${this.user} -d ${this.name} -f "${backupFilePath}"`;
      } else {
        const passArg = this.password ? `-p"${this.password}"` : '';
        cmd = `"${this.mysqlBin}" -h ${targetHost} -P ${targetPort} -u ${this.user} ${passArg} ${this.name} < "${backupFilePath}"`;
      }

      exec(cmd, { env, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          return reject(new Error(`Fallo al restaurar en nodo destino: ${stderr || err.message}`));
        }
        resolve({ success: true, timestamp: new Date().toISOString() });
      });
    });
  }

  /**
   * Bloqueo contra Split-Brain: Configura la base de datos como Solo Lectura (Read-Only) o Lectura/Escritura.
   */
  async setReadOnly(host, port, enableReadOnly = true) {
    return new Promise((resolve, reject) => {
      let sql = '';
      let cmd = '';
      const env = { ...process.env };

      if (this.type === 'postgres') {
        env.PGPASSWORD = this.password;
        const mode = enableReadOnly ? 'on' : 'off';
        sql = `ALTER DATABASE "${this.name}" SET default_transaction_read_only = ${mode};`;
        cmd = `"${this.psqlBin}" -h ${host} -p ${port} -U ${this.user} -d ${this.name} -c "${sql}"`;
      } else {
        const passArg = this.password ? `-p"${this.password}"` : '';
        const mode = enableReadOnly ? 'ON' : 'OFF';
        sql = `SET GLOBAL read_only = ${mode};`;
        cmd = `"${this.mysqlBin}" -h ${host} -P ${port} -u ${this.user} ${passArg} -e "${sql}"`;
      }

      exec(cmd, { env, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          return reject(new Error(`Error al cambiar modo de solo lectura: ${stderr || err.message}`));
        }
        resolve({ readOnly: enableReadOnly, host, port });
      });
    });
  }

  /**
   * Lista los respaldos disponibles en la carpeta de respaldos.
   */
  listBackups() {
    try {
      const files = fs.readdirSync(this.backupsDir);
      return files
        .filter((f) => f.startsWith('backup_') && f.endsWith('.sql'))
        .map((f) => {
          const fp = path.join(this.backupsDir, f);
          const s = fs.statSync(fp);
          return {
            filename: f,
            sizeBytes: s.size,
            sizeFormatted: (s.size / 1024 / 1024).toFixed(2) + ' MB',
            createdAt: s.mtime.toISOString(),
          };
        })
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    } catch (_) {
      return [];
    }
  }
}

module.exports = { DatabaseManager };
