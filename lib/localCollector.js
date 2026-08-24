// Collects REAL telemetry from the machine running this backend.
// Cross-platform: uses Node's os + fs.statfs for metrics (Windows/macOS/Linux),
// and best-effort shell calls for processes, logs, Docker and Kubernetes.
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execp = promisify(exec);
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

let prevCpu = null;

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times.idle;
  }
  return { idle, total };
}

function cpuDelta() {
  const cur = cpuTimes();
  if (!prevCpu) {
    prevCpu = cur;
    return null;
  }
  const idleDelta = cur.idle - prevCpu.idle;
  const totalDelta = cur.total - prevCpu.total;
  prevCpu = cur;
  if (totalDelta <= 0) return null;
  return Math.max(0, Math.min(100, 100 * (1 - idleDelta / totalDelta)));
}

async function sampleCpu() {
  const p = cpuDelta();
  if (p !== null) return p;
  await new Promise((r) => setTimeout(r, 250));
  const p2 = cpuDelta();
  return p2 === null ? 0 : p2;
}

async function disk() {
  try {
    const root = isWin ? `${process.cwd().split(path.sep)[0]}${path.sep}` : '/';
    const s = await fs.statfs(root);
    const total = s.blocks * s.bsize;
    const free = s.bfree * s.bsize;
    const used = total - free;
    return { total, used, pct: total ? (used / total) * 100 : 0 };
  } catch {
    return null;
  }
}

async function tryExec(cmd, opts = {}) {
  try {
    const defaultShell = isWin ? 'powershell.exe' : '/bin/bash';
    const { stdout } = await execp(cmd, { timeout: 7000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, shell: defaultShell, ...opts });
    return stdout || '';
  } catch (err) {
    return '';
  }
}

function fmtTime(d) {
  return d.toTimeString().slice(0, 8);
}

async function procs() {
  if (isWin) {
    const out = await tryExec(
      'powershell -NoProfile -Command "Get-Process | Sort-Object CPU -Descending | Select-Object -First 8 Id,ProcessName,CPU,WS | ConvertTo-Json -Compress"'
    );
    if (!out.trim()) return [];
    try {
      let arr = JSON.parse(out);
      if (!Array.isArray(arr)) arr = [arr];
      const totalMem = os.totalmem();
      return arr.map((p) => ({
        pid: p.Id,
        name: p.ProcessName,
        cpu: null,
        mem: totalMem ? (p.WS / totalMem) * 100 : 0,
      }));
    } catch {
      return [];
    }
  }
  const out = await tryExec('ps -eo pid,comm,pcpu,pmem --sort=-pcpu 2>/dev/null | head -n 9');
  const lines = out.trim().split('\n').slice(1);
  return lines
    .map((l) => l.trim().split(/\s+/))
    .filter((m) => m.length >= 4)
    .map((m) => ({ pid: Number(m[0]), name: m[1], cpu: parseFloat(m[2]), mem: parseFloat(m[3]) }));
}

async function logs() {
  if (isWin) {
    const out = await tryExec(
      'powershell -NoProfile -Command "Get-WinEvent -MaxEvents 40 -LogName System -ErrorAction SilentlyContinue | Select-Object TimeCreated,LevelDisplayName,Id,ProviderName,Message | ConvertTo-Json -Compress"'
    );
    if (!out.trim()) return [];
    try {
      let arr = JSON.parse(out);
      if (!Array.isArray(arr)) arr = [arr];
      return arr.reverse().map((e) => {
        const ms = String(e.TimeCreated || '').match(/\d{12,}/);
        const t = ms ? new Date(Number(ms[0])) : new Date();
        const level = String(e.LevelDisplayName || 'info').toUpperCase();
        const msg = String(e.Message || '').split('\n')[0].slice(0, 240);
        return `${fmtTime(t)} ${level} ${e.ProviderName}[${e.Id}]: ${msg}`;
      });
    } catch {
      return [];
    }
  }
  if (isMac) {
    const out = await tryExec('tail -n 40 /var/log/system.log 2>/dev/null');
    return out.trim() ? out.trim().split('\n') : [];
  }
  const out = await tryExec(
    'journalctl -n 40 --no-pager 2>/dev/null || tail -n 40 /var/log/syslog 2>/dev/null || tail -n 40 /var/log/messages 2>/dev/null'
  );
  return out.trim() ? out.trim().split('\n') : [];
}

async function containers() {
  const out = await tryExec("docker ps --format '{{.Names}}|{{.Image}}|{{.Status}}' 2>/dev/null");
  if (!out.trim()) return [];
  return out
    .trim()
    .split('\n')
    .slice(0, 12)
    .map((l) => {
      const [name, image, status] = l.split('|');
      return { name, image, status };
    });
}

async function pods() {
  const out = await tryExec('kubectl get pods -A --no-headers 2>/dev/null');
  if (!out.trim()) return [];
  return out
    .trim()
    .split('\n')
    .slice(0, 24)
    .map((l) => {
      const c = l.trim().split(/\s+/);
      return { ns: c[0], name: c[1], ready: c[2], status: c[3] };
    });
}

export async function collect() {
  const [cpuPct, dsk, prc, lg, dkr, k8s] = await Promise.all([
    sampleCpu(),
    disk(),
    procs(),
    logs(),
    containers(),
    pods(),
  ]);
  const memTotal = os.totalmem();
  const memFree = os.freemem();
  const memUsed = memTotal - memFree;
  return {
    ok: true,
    ts: Date.now(),
    hostname: os.hostname(),
    platform: process.platform,
    uptimeSec: os.uptime(),
    cpuPct,
    memPct: memTotal ? (memUsed / memTotal) * 100 : 0,
    memUsedBytes: memUsed,
    memTotalBytes: memTotal,
    diskPct: dsk ? dsk.pct : null,
    diskUsedBytes: dsk ? dsk.used : null,
    diskTotalBytes: dsk ? dsk.total : null,
    load: os.loadavg(),
    procs: prc,
    logs: lg,
    docker: dkr,
    pods: k8s,
  };
}
