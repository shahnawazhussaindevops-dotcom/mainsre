// Collects REAL telemetry from a remote Linux server over SSH.
// One combined command per poll keeps it fast and avoids many round-trips.
import ssh2 from 'ssh2';
import { parseTelemetry } from './parseLinux.js';

const { Client } = ssh2;

const REMOTE_CMD = [
  "echo __SREAI_HOST__; hostname 2>/dev/null",
  "echo __SREAI_UPTIME__; cat /proc/uptime 2>/dev/null | awk '{print $1}'",
  "echo __SREAI_LOAD__; cat /proc/loadavg 2>/dev/null",
  "echo __SREAI_CPU__; top -bn2 -d 0.4 2>/dev/null | grep -i 'Cpu(s)' | tail -1",
  "echo __SREAI_MEM__; free -b 2>/dev/null | awk 'tolower($1) ~ /^mem/ {print}'",
  "echo __SREAI_DISK__; df -B1 -P / 2>/dev/null | tail -1",
  "echo __SREAI_PROC__; ps -eo pid,comm,pcpu,pmem --sort=-pcpu 2>/dev/null | head -n 9",
  "echo __SREAI_DOCKER__; (docker ps --format '{{.Names}}|{{.Image}}|{{.Status}}' 2>/dev/null | head -n 12)",
  "echo __SREAI_K8S__; (kubectl get pods -A --no-headers 2>/dev/null | head -n 24)",
  "echo __SREAI_LOGS__; (journalctl -n 40 --no-pager 2>/dev/null || tail -n 40 /var/log/syslog 2>/dev/null || tail -n 40 /var/log/messages 2>/dev/null)",
].join('; ');

function connectConfig(server, timeoutMs) {
  const cfg = {
    host: server.host,
    port: server.port || 22,
    username: server.username,
    readyTimeout: timeoutMs,
    keepaliveInterval: 10000,
  };
  if (server.privateKey) {
    cfg.privateKey = server.privateKey;
    if (server.passphrase) cfg.passphrase = server.passphrase;
  } else {
    cfg.password = server.password;
  }
  return cfg;
}

function runCommand(server, command, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      conn.end();
      reject(new Error('Connection timed out'));
    }, timeoutMs);

    conn
      .on('ready', () => {
        conn.exec(command, (e, stream) => {
          if (e) {
            clearTimeout(timer);
            conn.end();
            return reject(e);
          }
          stream
            .on('close', () => {
              clearTimeout(timer);
              conn.end();
              resolve({ out, err });
            })
            .on('data', (d) => (out += d.toString()))
            .stderr.on('data', (d) => (err += d.toString()));
        });
      })
      .on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      })
      .connect(connectConfig(server, timeoutMs));
  });
}

export async function collect(server) {
  const { out } = await runCommand(server, REMOTE_CMD, 15000);
  return parseTelemetry(out);
}

export async function testConnection(server) {
  const { out } = await runCommand(server, 'echo __SREAI_OK__', 12000);
  if (!out.includes('__SREAI_OK__')) throw new Error('Connected, but command execution failed.');
  return true;
}
