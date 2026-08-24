import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { supabase } from './supabase.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.VERCEL ? path.join('/tmp', 'data') : path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'servers.json');

const LOCAL_SERVER = {
  id: 'local',
  kind: 'local',
  name: 'This Machine',
  host: '127.0.0.1',
  builtin: true,
};

// local storage fallback: { userId: [servers] }
let localDB = {};

function sanitize(s) {
  const { password, privateKey, passphrase, ...safe } = s;
  return { ...safe, hasSecret: Boolean(password || privateKey) };
}

export async function load() {
  if (supabase) return; // Supabase doesn't need pre-loading
  try {
    const raw = await fs.readFile(DB_FILE, 'utf8');
    localDB = JSON.parse(raw);
    if (Array.isArray(localDB)) {
      // Migrate old format to new format under 'local-dev-user'
      localDB = { 'local-dev-user': localDB };
    }
  } catch {
    localDB = {};
  }
}

async function persist() {
  if (supabase) return;
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(DB_FILE, JSON.stringify(localDB, null, 2), 'utf8');
}

export async function all(userId = 'local-dev-user') {
  if (supabase) {
    const { data } = await supabase.from('servers').select('*').eq('user_id', userId);
    return [LOCAL_SERVER, ...(data || [])];
  }
  const userServers = localDB[userId] || [];
  return [LOCAL_SERVER, ...userServers.filter((s) => s.id !== 'local')];
}

export async function list(userId = 'local-dev-user') {
  const servers = await all(userId);
  return servers.map(sanitize);
}

export async function get(userId, id) {
  if (id === 'local') return LOCAL_SERVER;
  if (supabase) {
    const { data } = await supabase.from('servers').select('*').eq('id', id).eq('user_id', userId).single();
    return data;
  }
  const userServers = localDB[userId] || [];
  return userServers.find((s) => s.id === id);
}

export async function add(userId, input) {
  const host = String(input.host || '').trim();
  if (!host) throw new Error('Host / IP address is required.');
  if (!String(input.username || '').trim()) throw new Error('Username is required for SSH.');
  if (!input.password && !input.privateKey) throw new Error('Provide either a password or a private key.');

  const server = {
    id: crypto.randomUUID(),
    user_id: userId,
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

  if (supabase) {
    const { error } = await supabase.from('servers').insert([server]);
    if (error) throw new Error(error.message);
  } else {
    if (!localDB[userId]) localDB[userId] = [];
    localDB[userId].push(server);
    await persist();
  }
  return sanitize(server);
}

export async function remove(userId, id) {
  if (id === 'local') return false;
  
  if (supabase) {
    const { error } = await supabase.from('servers').delete().eq('id', id).eq('user_id', userId);
    return !error;
  } else {
    const userServers = localDB[userId] || [];
    const initialLen = userServers.length;
    localDB[userId] = userServers.filter((x) => x.id !== id);
    if (localDB[userId].length !== initialLen) {
      await persist();
      return true;
    }
    return false;
  }
}
