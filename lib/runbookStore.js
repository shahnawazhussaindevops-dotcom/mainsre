// Runbook CRUD store — built-in + custom runbooks.
// Built-in runbooks are read-only; custom ones are persisted to data/runbooks.json.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BUILTIN_RUNBOOKS } from './builtinRunbooks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'runbooks.json');

let customRunbooks = [];

export async function load() {
  try {
    const raw = await fs.readFile(FILE, 'utf8');
    customRunbooks = JSON.parse(raw);
    if (!Array.isArray(customRunbooks)) customRunbooks = [];
  } catch {
    customRunbooks = [];
  }
}

async function persist() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(customRunbooks, null, 2), 'utf8');
}

export function list() {
  return [...BUILTIN_RUNBOOKS, ...customRunbooks];
}

export function getById(id) {
  return BUILTIN_RUNBOOKS.find((r) => r.id === id) || customRunbooks.find((r) => r.id === id) || null;
}

export async function create(input) {
  const name = String(input.name || '').trim();
  if (!name) throw new Error('Runbook name is required.');

  const runbook = {
    id: 'rb-' + crypto.randomUUID().slice(0, 8),
    name,
    description: String(input.description || '').trim(),
    category: ['storage', 'compute', 'network', 'security', 'general'].includes(input.category) ? input.category : 'general',
    severity: ['info', 'warning', 'critical'].includes(input.severity) ? input.severity : 'info',
    builtin: false,
    tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
    estimatedMinutes: Number(input.estimatedMinutes) || 5,
    steps: Array.isArray(input.steps)
      ? input.steps.map((s, i) => ({
          order: i + 1,
          title: String(s.title || `Step ${i + 1}`).trim(),
          command: String(s.command || '').trim(),
          description: String(s.description || '').trim(),
          risk: ['safe', 'caution', 'destructive'].includes(s.risk) ? s.risk : 'safe',
        }))
      : [],
    createdAt: new Date().toISOString(),
  };

  customRunbooks.push(runbook);
  await persist();
  return runbook;
}

export async function update(id, input) {
  const rb = customRunbooks.find((r) => r.id === id);
  if (!rb) return null; // Cannot update built-in

  if (input.name) rb.name = String(input.name).trim();
  if (input.description !== undefined) rb.description = String(input.description).trim();
  if (input.category) rb.category = input.category;
  if (input.severity) rb.severity = input.severity;
  if (input.tags) rb.tags = input.tags;
  if (input.estimatedMinutes) rb.estimatedMinutes = Number(input.estimatedMinutes);
  if (Array.isArray(input.steps)) {
    rb.steps = input.steps.map((s, i) => ({
      order: i + 1,
      title: String(s.title || `Step ${i + 1}`).trim(),
      command: String(s.command || '').trim(),
      description: String(s.description || '').trim(),
      risk: ['safe', 'caution', 'destructive'].includes(s.risk) ? s.risk : 'safe',
    }));
  }

  await persist();
  return rb;
}

export async function remove(id) {
  // Cannot delete built-in
  if (BUILTIN_RUNBOOKS.some((r) => r.id === id)) return false;
  const before = customRunbooks.length;
  customRunbooks = customRunbooks.filter((r) => r.id !== id);
  if (customRunbooks.length === before) return false;
  await persist();
  return true;
}
