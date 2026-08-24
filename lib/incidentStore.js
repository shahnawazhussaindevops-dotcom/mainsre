// Incident lifecycle store — CRUD with timeline and persistence.
// Stored in data/incidents.json.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'incidents.json');

const STATUSES = ['open', 'acknowledged', 'investigating', 'mitigated', 'resolved'];
const SEVERITIES = ['info', 'warning', 'critical'];

let incidents = [];

export async function load() {
  try {
    const raw = await fs.readFile(FILE, 'utf8');
    incidents = JSON.parse(raw);
    if (!Array.isArray(incidents)) incidents = [];
  } catch {
    incidents = [];
  }
  return incidents;
}

async function persist() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(incidents, null, 2), 'utf8');
}

export function list(filters = {}) {
  let result = [...incidents];
  if (filters.status) result = result.filter((i) => i.status === filters.status);
  if (filters.severity) result = result.filter((i) => i.severity === filters.severity);
  if (filters.serverId) result = result.filter((i) => i.serverId === filters.serverId);
  // Sort by createdAt descending (newest first)
  result.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return result;
}

export function getById(id) {
  return incidents.find((i) => i.id === id) || null;
}

export async function create(input) {
  const title = String(input.title || '').trim();
  if (!title) throw new Error('Incident title is required.');
  const severity = SEVERITIES.includes(input.severity) ? input.severity : 'warning';

  const incident = {
    id: crypto.randomUUID(),
    title,
    severity,
    status: 'open',
    serverId: input.serverId || null,
    serverName: input.serverName || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    resolvedAt: null,
    assignee: input.assignee || null,
    source: input.source || 'manual',
    description: input.description || '',
    timeline: [
      {
        ts: new Date().toISOString(),
        action: 'created',
        note: `Incident created (${input.source || 'manual'})`,
        actor: input.source === 'auto-detected' ? 'system' : 'user',
      },
    ],
    analysis: input.analysis || null,
    relatedLogs: input.relatedLogs || [],
    tags: input.tags || [],
  };

  incidents.push(incident);
  await persist();
  return incident;
}

export async function update(id, patch) {
  const inc = getById(id);
  if (!inc) return null;

  const timelineEntry = { ts: new Date().toISOString(), actor: 'user' };

  if (patch.status && STATUSES.includes(patch.status) && patch.status !== inc.status) {
    const oldStatus = inc.status;
    inc.status = patch.status;
    timelineEntry.action = 'status_change';
    timelineEntry.note = `Status changed: ${oldStatus} → ${patch.status}`;
    if (patch.status === 'resolved') {
      inc.resolvedAt = new Date().toISOString();
    }
  }

  if (patch.severity && SEVERITIES.includes(patch.severity) && patch.severity !== inc.severity) {
    const old = inc.severity;
    inc.severity = patch.severity;
    timelineEntry.action = timelineEntry.action || 'severity_change';
    timelineEntry.note = (timelineEntry.note ? timelineEntry.note + '. ' : '') +
      `Severity changed: ${old} → ${patch.severity}`;
  }

  if (patch.assignee !== undefined) {
    inc.assignee = patch.assignee;
    if (!timelineEntry.action) {
      timelineEntry.action = 'assigned';
      timelineEntry.note = patch.assignee ? `Assigned to ${patch.assignee}` : 'Unassigned';
    }
  }

  if (patch.note) {
    timelineEntry.action = timelineEntry.action || 'note';
    timelineEntry.note = patch.note;
  }

  if (patch.analysis) {
    inc.analysis = patch.analysis;
    timelineEntry.action = timelineEntry.action || 'analysis';
    timelineEntry.note = timelineEntry.note || 'AI analysis attached';
  }

  if (timelineEntry.action) {
    inc.timeline.push(timelineEntry);
  }

  inc.updatedAt = new Date().toISOString();
  await persist();
  return inc;
}

export async function remove(id) {
  const before = incidents.length;
  incidents = incidents.filter((i) => i.id !== id);
  if (incidents.length === before) return false;
  await persist();
  return true;
}

// Check if an auto-detected incident already exists for this server+metric
// so we don't create duplicates.
export function hasActiveAutoIncident(serverId, tag) {
  return incidents.some(
    (i) =>
      i.serverId === serverId &&
      i.source === 'auto-detected' &&
      i.tags.includes(tag) &&
      !['resolved', 'mitigated'].includes(i.status)
  );
}

// Stats for GodMode
export function stats() {
  const s = { total: incidents.length, open: 0, acknowledged: 0, investigating: 0, mitigated: 0, resolved: 0, bySeverity: { info: 0, warning: 0, critical: 0 } };
  for (const i of incidents) {
    s[i.status] = (s[i.status] || 0) + 1;
    s.bySeverity[i.severity] = (s.bySeverity[i.severity] || 0) + 1;
  }
  return s;
}
