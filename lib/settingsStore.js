// Settings persistence — thresholds, groups, polling config.
// Stored in data/settings.json.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULTS = {
  thresholds: {
    cpu:  { warning: 70, critical: 90 },
    mem:  { warning: 80, critical: 92 },
    disk: { warning: 85, critical: 95 },
  },
  autoIncident: true,          // create incidents automatically on threshold breach
  refreshMs: 3000,
  serverGroups: [],            // [{ id, name, serverIds[] }]
};

let settings = null;

export async function load() {
  try {
    const raw = await fs.readFile(FILE, 'utf8');
    settings = { ...DEFAULTS, ...JSON.parse(raw) };
    // Merge nested defaults so missing keys are filled
    settings.thresholds = { ...DEFAULTS.thresholds, ...settings.thresholds };
  } catch {
    settings = { ...DEFAULTS };
  }
  return settings;
}

async function persist() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(settings, null, 2), 'utf8');
}

export function get() {
  return settings || { ...DEFAULTS };
}

export async function update(patch) {
  if (!settings) await load();
  // Deep-merge thresholds
  if (patch.thresholds) {
    settings.thresholds = { ...settings.thresholds, ...patch.thresholds };
    delete patch.thresholds;
  }
  Object.assign(settings, patch);
  await persist();
  return settings;
}

// Server groups helpers
export async function addGroup(name) {
  if (!settings) await load();
  const id = 'grp-' + Date.now().toString(36);
  const group = { id, name: String(name).trim(), serverIds: [] };
  settings.serverGroups.push(group);
  await persist();
  return group;
}

export async function updateGroup(id, patch) {
  if (!settings) await load();
  const g = settings.serverGroups.find((g) => g.id === id);
  if (!g) return null;
  if (patch.name != null) g.name = String(patch.name).trim();
  if (Array.isArray(patch.serverIds)) g.serverIds = patch.serverIds;
  await persist();
  return g;
}

export async function removeGroup(id) {
  if (!settings) await load();
  const before = settings.serverGroups.length;
  settings.serverGroups = settings.serverGroups.filter((g) => g.id !== id);
  if (settings.serverGroups.length === before) return false;
  await persist();
  return true;
}
