/**
 * services/database-manager.js
 * 
 * Gestor de bases de datos para respaldos, restauración y prevención de Split-Brain.
 * Soporta MySQL, MariaDB (mediante driver nativo mysql2 y CLI) y PostgreSQL.
 */

'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

let mysql;
try {
  mysql = require('mysql2/promise');
} catch (_) {}

class DatabaseManager {
  constructor(config = {}) {
    this.type = (config.type || 'mysql').toLowerCase();
    this.name = config.name || 'sistema';
    this.user = config.user || 'root';
    this.password = config.password || '';
    this.backupsDir = config.backupsDir || path.join(__dirname, '..', 'backups');

    if (!fs.existsSync(this.backupsDir)) {
      fs.mkdirSync(this.backupsDir, { recursive: true });
    }

    // Ubicaciones de binarios PostgreSQL en Windows
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

    // Ubicaciones de binarios MySQL
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
    return candidates[candidates.length - 1];
  }

  /**
   * Verifica conectividad TCP con el nodo a través de la red / VPN.
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

    if (this.type === 'mysql' || this.type === 'mariadb') {
      return this._createBackupMySQL(host, port, outputPath, filename);
    } else {
      return this._createBackupPostgres(host, port, outputPath, filename);
    }
  }

  /**
   * Respaldo para MySQL: Si no existe mysqldump.exe en el host Windows,
   * utiliza el driver nativo mysql2 para extraer esquema y datos tabla por tabla.
   */
  async _createBackupMySQL(host, port, outputPath, filename) {
    const start = Date.now();

    // Intentar primero con mysql2 nativo si está disponible
    if (mysql) {
      try {
        const conn = await mysql.createConnection({
          host,
          port,
          user: this.user,
          password: this.password,
          database: this.name,
          connectTimeout: 8000,
        });

        let sqlDump = `-- ========================================================\n`;
        sqlDump += `-- Respaldo Automático UPS Disaster Recovery\n`;
        sqlDump += `-- Base de Datos: ${this.name}\n`;
        sqlDump += `-- Servidor     : ${host}:${port}\n`;
        sqlDump += `-- Fecha        : ${new Date().toISOString()}\n`;
        sqlDump += `-- ========================================================\n\n`;
        sqlDump += `SET FOREIGN_KEY_CHECKS=0;\n\n`;

        const [tables] = await conn.query('SHOW TABLES');
        const tableKey = `Tables_in_${this.name}`;

        for (const row of tables) {
          const tableName = row[tableKey] || Object.values(row)[0];
          if (!tableName) continue;

          // Extraer DDL (Estructura)
          const [createRows] = await conn.query(`SHOW CREATE TABLE \`${tableName}\``);
          if (createRows.length > 0) {
            const createSql = createRows[0]['Create Table'];
            sqlDump += `DROP TABLE IF EXISTS \`${tableName}\`;\n`;
            sqlDump += `${createSql};\n\n`;
          }

          // Extraer Datos
          const [dataRows] = await conn.query(`SELECT * FROM \`${tableName}\``);
          if (dataRows.length > 0) {
            for (const dataRow of dataRows) {
              const keys = Object.keys(dataRow).map((k) => `\`${k}\``).join(', ');
              const values = Object.values(dataRow)
                .map((v) => (v === null ? 'NULL' : conn.escape(v)))
                .join(', ');
              sqlDump += `INSERT INTO \`${tableName}\` (${keys}) VALUES (${values});\n`;
            }
            sqlDump += '\n';
          }
        }

        sqlDump += `SET FOREIGN_KEY_CHECKS=1;\n`;
        fs.writeFileSync(outputPath, sqlDump, 'utf8');
        await conn.end();

        const stats = fs.statSync(outputPath);
        return {
          filename,
          filepath: outputPath,
          sizeBytes: stats.size,
          sizeFormatted: (stats.size / 1024 / 1024).toFixed(2) + ' MB',
          durationSec: ((Date.now() - start) / 1000).toFixed(1),
          timestamp: new Date().toISOString(),
          method: 'mysql2_native',
        };
      } catch (err) {
        // Si falló por credenciales u otro motivo, documentar y reintentar con CLI si está disponible
        if (!fs.existsSync(this.mysqlDumpBin) && this.mysqlDumpBin === 'mysqldump') {
          throw new Error(`Error en respaldo MySQL (${host}:${port}): ${err.message}`);
        }
      }
    }

    // Fallback con mysqldump.exe si está instalado
    return new Promise((resolve, reject) => {
      const passArg = this.password ? `-p"${this.password}"` : '';
      const cmd = `"${this.mysqlDumpBin}" -h ${host} -P ${port} -u ${this.user} ${passArg} ${this.name} > "${outputPath}"`;

      exec(cmd, { windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          return reject(new Error(`Fallo mysqldump: ${stderr || err.message}`));
        }
        const stats = fs.existsSync(outputPath) ? fs.statSync(outputPath) : { size: 0 };
        resolve({
          filename,
          filepath: outputPath,
          sizeBytes: stats.size,
          sizeFormatted: (stats.size / 1024 / 1024).toFixed(2) + ' MB',
          durationSec: ((Date.now() - start) / 1000).toFixed(1),
          timestamp: new Date().toISOString(),
          method: 'mysqldump_cli',
        });
      });
    });
  }

  /**
   * Respaldo para PostgreSQL con pg_dump
   */
  _createBackupPostgres(host, port, outputPath, filename) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const env = { ...process.env, PGPASSWORD: this.password };
      const cmd = `"${this.pgDumpBin}" -h ${host} -p ${port} -U ${this.user} -d ${this.name} -F p -f "${outputPath}"`;

      exec(cmd, { env, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          return reject(new Error(`Fallo pg_dump: ${stderr || err.message}`));
        }
        const stats = fs.existsSync(outputPath) ? fs.statSync(outputPath) : { size: 0 };
        resolve({
          filename,
          filepath: outputPath,
          sizeBytes: stats.size,
          sizeFormatted: (stats.size / 1024 / 1024).toFixed(2) + ' MB',
          durationSec: ((Date.now() - start) / 1000).toFixed(1),
          timestamp: new Date().toISOString(),
          method: 'pg_dump',
        });
      });
    });
  }

  /**
   * Restaura un respaldo en el servidor destino.
   */
  async restoreBackup(targetHost, targetPort, backupFilePath) {
    if (!fs.existsSync(backupFilePath)) {
      throw new Error(`Archivo de respaldo no encontrado: ${backupFilePath}`);
    }

    if (this.type === 'mysql' || this.type === 'mariadb') {
      if (mysql) {
        const sql = fs.readFileSync(backupFilePath, 'utf8');
        const conn = await mysql.createConnection({
          host: targetHost,
          port: targetPort,
          user: this.user,
          password: this.password,
          database: this.name,
          multipleStatements: true,
          connectTimeout: 8000,
        });
        await conn.query(sql);
        await conn.end();
        return { success: true, timestamp: new Date().toISOString() };
      }
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
        if (err) return reject(new Error(`Fallo al restaurar: ${stderr || err.message}`));
        resolve({ success: true, timestamp: new Date().toISOString() });
      });
    });
  }

  /**
   * Bloqueo contra Split-Brain: Configura la base de datos en solo lectura (Read-Only) o R/W.
   */
  async setReadOnly(host, port, enableReadOnly = true) {
    if (this.type === 'mysql' || this.type === 'mariadb') {
      if (mysql) {
        try {
          const conn = await mysql.createConnection({
            host,
            port,
            user: this.user,
            password: this.password,
            connectTimeout: 5000,
          });
          const mode = enableReadOnly ? 'ON' : 'OFF';
          await conn.query(`SET GLOBAL read_only = ${mode};`);
          await conn.end();
          return { readOnly: enableReadOnly, host, port };
        } catch (err) {
          // Si no tiene permisos globales o falla
          console.warn(`[DB] Aviso al cambiar read_only en ${host}:${port}:`, err.message);
        }
      }
    }

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
        if (err) return reject(new Error(`Error al cambiar modo de solo lectura: ${stderr || err.message}`));
        resolve({ readOnly: enableReadOnly, host, port });
      });
    });
  }

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
