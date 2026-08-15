// Pure parser for the combined telemetry command output.
// No external dependencies, so it can be unit-tested in isolation.

function section(out, name) {
  const re = new RegExp(`__SREAI_${name}__\\n([\\s\\S]*?)(?=\\n__SREAI_|$)`);
  const m = out.match(re);
  return m ? m[1].replace(/\s+$/, '') : '';
}

function num(v) {
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

export function parseTelemetry(out) {
  const hostname = section(out, 'HOST').trim();
  const uptimeSec = num(section(out, 'UPTIME'));

  const loadParts = section(out, 'LOAD').trim().split(/\s+/);
  const load = [num(loadParts[0]) || 0, num(loadParts[1]) || 0, num(loadParts[2]) || 0];

  // CPU: derive from idle%, e.g. "%Cpu(s):  3.4 us, ... 95.0 id, ..."
  let cpuPct = null;
  const idleMatch = section(out, 'CPU').match(/(\d+[.,]\d+)\s*id/i);
  if (idleMatch) cpuPct = Math.max(0, Math.min(100, 100 - num(idleMatch[1])));

  // Memory (bytes): "Mem: total used free shared buff/cache available"
  let memPct = null;
  let memUsedBytes = null;
  let memTotalBytes = null;
  const memFields = section(out, 'MEM').trim().split(/\s+/);
  if (memFields.length >= 4) {
    memTotalBytes = num(memFields[1]);
    const available = memFields.length >= 7 ? num(memFields[6]) : null;
    memUsedBytes = available != null && memTotalBytes != null ? memTotalBytes - available : num(memFields[2]);
    if (memTotalBytes) memPct = Math.max(0, Math.min(100, (memUsedBytes / memTotalBytes) * 100));
  }

  // Disk: "fs 1B-blocks used avail cap% mount"
  let diskPct = null;
  let diskUsedBytes = null;
  let diskTotalBytes = null;
  const diskFields = section(out, 'DISK').trim().split(/\s+/);
  if (diskFields.length >= 5) {
    diskTotalBytes = num(diskFields[1]);
    diskUsedBytes = num(diskFields[2]);
    if (diskTotalBytes) diskPct = Math.max(0, Math.min(100, (diskUsedBytes / diskTotalBytes) * 100));
  }

  const procs = section(out, 'PROC')
    .trim()
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((m) => m.length >= 4)
    .map((m) => ({ pid: Number(m[0]), name: m[1], cpu: num(m[2]), mem: num(m[3]) }));

  const docker = section(out, 'DOCKER')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [name, image, status] = l.split('|');
      return { name, image, status };
    });

  const pods = section(out, 'K8S')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const c = l.trim().split(/\s+/);
      return { ns: c[0], name: c[1], ready: c[2], status: c[3] };
    });

  const logs = section(out, 'LOGS').trim().split('\n').filter(Boolean);

  return {
    ok: true,
    ts: Date.now(),
    hostname,
    platform: 'linux',
    uptimeSec,
    cpuPct,
    memPct,
    memUsedBytes,
    memTotalBytes,
    diskPct,
    diskUsedBytes,
    diskTotalBytes,
    load,
    procs,
    docker,
    pods,
    logs,
  };
}
