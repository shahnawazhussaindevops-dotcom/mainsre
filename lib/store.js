import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'servers.json');

// The built-in target: the machine running this backend. Always present, not removable.
const LOCAL_SERVER = {
  id: 'local',
  kind: 'local',
  name: 'This Machine',
  host: '127.0.0.1',
  builtin: true,
};

let servers = [];

// Never send secrets to the browser.
function sanitize(s) {
  const { password, privateKey, passphrase, ...safe } = s;
  return { ...safe, hasSecret: Boolean(password || privateKey) };
}

export async function load() {
  try {
    const raw = await fs.readFile(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    servers = Array.isArray(parsed) ? parsed : [];
  } catch {
    servers = [];
  }
  servers = servers.filter((s) => s.id !== 'local');
  servers.unshift({ ...LOCAL_SERVER });
  return servers;
}

async function persist() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const toSave = servers.filter((s) => !s.builtin);
  await fs.writeFile(DB_FILE, JSON.stringify(toSave, null, 2), 'utf8');
}

export function all() {
  return servers;
}

export function list() {
  return servers.map(sanitize);
}

export function get(id) {
  return servers.find((s) => s.id === id);
}

export async function add(input) {
  const host = String(input.host || '').trim();
  if (!host) throw new Error('Host / IP address is required.');
  if (!String(input.username || '').trim()) throw new Error('Username is required for SSH.');
  if (!input.password && !input.privateKey) throw new Error('Provide either a password or a private key.');

  const server = {
    id: crypto.randomUUID(),
    kind: 'ssh',
    name: String(input.name || host).trim(),
    host,
    port: Number(input.port) || 22,
    username: String(input.username).trim(),
    authType: input.privateKey ? 'key' : 'password',
    password: input.password || undefined,
    privateKey: input.privateKey || undefined,
    passphrase: input.passphrase || undefined,
  };
  servers.push(server);
  await persist();
  return sanitize(server);
}

export async function remove(id) {
  const s = get(id);
  if (!s || s.builtin) return false;
  servers = servers.filter((x) => x.id !== id);
  await persist();
  return true;
}
