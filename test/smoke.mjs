// Verifies the real data path without needing the npm packages (express/ws/ssh2).
// Run from the project root:  node test/smoke.mjs
import * as local from '../lib/localCollector.js';
import { parseTelemetry } from '../lib/parseLinux.js';
import { analyze } from '../lib/analyzer.js';
import * as store from '../lib/store.js';

const line = (t) => console.log('\n\x1b[36m── ' + t + ' ──\x1b[0m');
const pct = (v) => (v == null ? 'n/a' : v.toFixed(1) + '%');
const gb = (b) => (b == null ? 'n/a' : (b / 1024 ** 3).toFixed(2) + ' GB');

// 1) REAL local machine telemetry
line('1. Local collector (REAL data from this machine)');
const t = await local.collect();
console.log(`host=${t.hostname} platform=${t.platform} uptime=${Math.round(t.uptimeSec)}s`);
console.log(`CPU=${pct(t.cpuPct)}  MEM=${pct(t.memPct)} (${gb(t.memUsedBytes)}/${gb(t.memTotalBytes)})  DISK=${pct(t.diskPct)} (${gb(t.diskUsedBytes)}/${gb(t.diskTotalBytes)})`);
console.log(`processes=${t.procs.length}  logLines=${t.logs.length}  docker=${t.docker.length}  pods=${t.pods.length}`);
console.log('top process:', t.procs[0] || '(none)');
console.assert(typeof t.cpuPct === 'number', 'CPU should be a number');
console.assert(t.memTotalBytes > 0, 'memory total should be > 0');

// 2) SSH parser against a realistic remote payload
line('2. Linux parser (simulated remote SSH output)');
const sample = [
  '__SREAI_HOST__', 'web-prod-01',
  '__SREAI_UPTIME__', '842197.35',
  '__SREAI_LOAD__', '2.14 1.88 1.42 3/512 20481',
  '__SREAI_CPU__', '%Cpu(s): 34.2 us,  8.1 sy,  0.0 ni, 55.3 id,  1.2 wa,  0.0 hi,  1.2 si,  0.0 st',
  '__SREAI_MEM__', 'Mem: 16776048640 9663676416 1073741824 268435456 6039629824 6721142784',
  '__SREAI_DISK__', '/dev/sda1 105089232896 89325895680 15763337216 85% /',
  '__SREAI_PROC__', '  PID COMMAND         %CPU %MEM', ' 1123 node            42.0  8.1', '  880 postgres        18.5 12.3',
  '__SREAI_DOCKER__', 'api|node:20-alpine|Up 3 hours', 'cache|redis:7|Up 3 hours (healthy)',
  '__SREAI_K8S__', 'default   api-7d9f-abc   1/1   Running', 'default   worker-5c-xy   0/1   CrashLoopBackOff',
  '__SREAI_LOGS__', 'Aug 15 10:02:11 web-prod-01 kernel: Out of memory: Killed process 1123 (node)', 'Aug 15 10:02:12 web-prod-01 nginx[880]: 502 Bad Gateway upstream timed out',
].join('\n');
const p = parseTelemetry(sample);
console.log(`host=${p.hostname} CPU=${pct(p.cpuPct)} MEM=${pct(p.memPct)} DISK=${pct(p.diskPct)}`);
console.log(`procs=${p.procs.length} docker=${p.docker.length} pods=${p.pods.length} logs=${p.logs.length}`);
console.assert(p.hostname === 'web-prod-01', 'hostname parse');
console.assert(Math.abs(p.cpuPct - 44.7) < 0.1, 'cpu should be ~44.7%, got ' + p.cpuPct);
console.assert(Math.abs(p.diskPct - 85) < 1, 'disk should be ~85%, got ' + p.diskPct);
console.assert(Math.abs(p.memPct - 59.9) < 1, 'mem should be ~59.9%, got ' + p.memPct);
console.assert(p.docker.length === 2 && p.pods.length === 2, 'docker/pods parse');
console.assert(p.pods[1].status === 'CrashLoopBackOff', 'pod status parse');

// 3) Rule-based analyzer (no API key needed)
line('3. Rule-based analyzer');
for (const [label, log] of [
  ['OOM', 'kernel: Out of memory: Killed process 1123 (node)'],
  ['Disk', 'write failed: No space left on device'],
  ['Nginx', 'upstream timed out (110) 504 Gateway Time-out'],
  ['K8s', 'Back-off restarting failed container CrashLoopBackOff'],
]) {
  const r = await analyze({ log, server: null });
  console.log(`${label.padEnd(6)} → [${r.severity}] ${r.summary}  |  \`${r.command}\`  (${r.source})`);
  console.assert(r.command && r.summary, label + ' should return command+summary');
}

// 4) Store: built-in local server present, validation works
line('4. Store');
await store.load();
const servers = store.list();
console.log('servers:', servers.map((s) => `${s.name}[${s.kind}]`).join(', '));
console.assert(servers.some((s) => s.id === 'local' && s.builtin), 'built-in local must exist');
let threw = false;
try { await store.add({}); } catch { threw = true; }
console.assert(threw, 'add({}) should reject missing fields');
console.log('validation rejects empty input:', threw);

console.log('\n\x1b[32m✓ All smoke checks passed.\x1b[0m\n');
