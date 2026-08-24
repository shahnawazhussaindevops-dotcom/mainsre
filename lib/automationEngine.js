// Automation engine — executes runbook steps on servers via SSH.
// Persists execution history to data/automation-history.json.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as store from './store.js';
import * as runbookStore from './runbookStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'automation-history.json');

let history = [];
const schedules = new Map(); // id -> { interval, config }

export async function load() {
  try {
    const raw = await fs.readFile(HISTORY_FILE, 'utf8');
    history = JSON.parse(raw);
    if (!Array.isArray(history)) history = [];
  } catch {
    history = [];
  }
}

async function persist() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  // Keep last 200 executions to prevent unbounded growth
  if (history.length > 200) history = history.slice(-200);
  await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
}

export function getHistory(limit = 50) {
  return history.slice(-limit).reverse();
}

export function getExecution(id) {
  return history.find((h) => h.id === id) || null;
}

/**
 * Execute a runbook on a target server.
 * @param {string} runbookId
 * @param {string} serverId
 * @param {Function} broadcast - WebSocket broadcast function
 * @param {Function} sshRun - Function to run SSH command: (server, cmd) => Promise<{out, err}>
 * @returns {Promise<object>} execution record
 */
export async function execute(runbookId, serverId, broadcast, sshRun) {
  const runbook = runbookStore.getById(runbookId);
  if (!runbook) throw new Error('Runbook not found.');

  const server = store.get(serverId);
  if (!server) throw new Error('Server not found.');

  const execution = {
    id: crypto.randomUUID(),
    runbookId: runbook.id,
    runbookName: runbook.name,
    serverId: server.id,
    serverName: server.name,
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    steps: runbook.steps.map((s) => ({
      order: s.order,
      title: s.title,
      command: s.command,
      status: 'pending',
      output: '',
      error: '',
      duration: 0,
    })),
    totalDuration: 0,
  };

  history.push(execution);
  await persist();

  // Broadcast start
  if (broadcast) {
    broadcast({ type: 'automation', action: 'started', execution: { ...execution, steps: undefined } });
  }

  // Execute steps sequentially
  const overallStart = Date.now();
  let allOk = true;

  for (const step of execution.steps) {
    step.status = 'running';
    if (broadcast) {
      broadcast({
        type: 'automation_step',
        executionId: execution.id,
        step: { order: step.order, title: step.title, status: 'running' },
      });
    }

    const stepStart = Date.now();
    try {
      if (server.kind === 'local') {
        // For local server, use child_process
        const { exec } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execp = promisify(exec);
        try {
          const { stdout, stderr } = await execp(step.command, {
            timeout: 30000,
            windowsHide: true,
            maxBuffer: 2 * 1024 * 1024,
            shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/bash',
          });
          step.output = stdout || '';
          step.error = stderr || '';
          step.status = 'success';
        } catch (e) {
          step.output = e.stdout || '';
          step.error = e.stderr || e.message;
          step.status = 'failed';
          allOk = false;
        }
      } else {
        // SSH execution
        try {
          const result = await sshRun(server, step.command);
          step.output = result.out || '';
          step.error = result.err || '';
          step.status = 'success';
        } catch (e) {
          step.error = e.message;
          step.status = 'failed';
          allOk = false;
        }
      }
    } catch (e) {
      step.error = e.message;
      step.status = 'failed';
      allOk = false;
    }

    step.duration = Date.now() - stepStart;

    if (broadcast) {
      broadcast({
        type: 'automation_step',
        executionId: execution.id,
        step: {
          order: step.order,
          title: step.title,
          status: step.status,
          output: step.output.slice(0, 2000),
          error: step.error.slice(0, 500),
          duration: step.duration,
        },
      });
    }
  }

  execution.totalDuration = Date.now() - overallStart;
  execution.completedAt = new Date().toISOString();
  execution.status = allOk ? 'success' : 'partial';

  await persist();

  if (broadcast) {
    broadcast({
      type: 'automation',
      action: 'completed',
      execution: {
        id: execution.id,
        runbookName: execution.runbookName,
        serverName: execution.serverName,
        status: execution.status,
        totalDuration: execution.totalDuration,
      },
    });
  }

  return execution;
}

// Scheduled automations
export function addSchedule(runbookId, serverId, intervalMs, broadcast, sshRun) {
  const id = 'sched-' + crypto.randomUUID().slice(0, 8);
  const interval = setInterval(() => {
    execute(runbookId, serverId, broadcast, sshRun).catch(() => {});
  }, Math.max(60000, intervalMs)); // Minimum 1 minute

  const rb = runbookStore.getById(runbookId);
  const srv = store.get(serverId);

  schedules.set(id, {
    interval,
    config: {
      id,
      runbookId,
      runbookName: rb?.name || runbookId,
      serverId,
      serverName: srv?.name || serverId,
      intervalMs,
      createdAt: new Date().toISOString(),
    },
  });

  return schedules.get(id).config;
}

export function removeSchedule(id) {
  const s = schedules.get(id);
  if (!s) return false;
  clearInterval(s.interval);
  schedules.delete(id);
  return true;
}

export function listSchedules() {
  return [...schedules.values()].map((s) => s.config);
}
