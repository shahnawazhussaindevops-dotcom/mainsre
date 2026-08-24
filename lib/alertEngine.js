// Alert engine — threshold-based anomaly detection.
// Called after each telemetry poll. Creates incidents automatically when
// metrics cross configured thresholds.
import * as settingsStore from './settingsStore.js';
import * as incidentStore from './incidentStore.js';

// Track previous states to detect transitions (not just current values).
const prevStatus = new Map(); // serverId -> { cpu, mem, disk }

/**
 * Evaluate a single server's telemetry against configured thresholds.
 * Returns an array of alert objects (may be empty).
 */
export function evaluate(telemetry) {
  if (!telemetry || !telemetry.ok) return [];

  const cfg = settingsStore.get();
  const th = cfg.thresholds || {};
  const alerts = [];

  const checks = [
    { metric: 'cpu', value: telemetry.cpuPct, thresholds: th.cpu },
    { metric: 'mem', value: telemetry.memPct, thresholds: th.mem },
    { metric: 'disk', value: telemetry.diskPct, thresholds: th.disk },
  ];

  for (const { metric, value, thresholds } of checks) {
    if (value == null || !thresholds) continue;
    let severity = null;
    if (value >= thresholds.critical) severity = 'critical';
    else if (value >= thresholds.warning) severity = 'warning';

    if (severity) {
      alerts.push({
        metric,
        value: Math.round(value),
        severity,
        threshold: severity === 'critical' ? thresholds.critical : thresholds.warning,
      });
    }
  }

  return alerts;
}

/**
 * Process alerts and auto-create incidents if enabled.
 * Returns any newly created incidents.
 */
export async function processAlerts(telemetry, broadcast) {
  const cfg = settingsStore.get();
  if (!cfg.autoIncident) return [];

  const alerts = evaluate(telemetry);
  const created = [];

  for (const alert of alerts) {
    // Only create for critical alerts, to avoid noise
    if (alert.severity !== 'critical') continue;

    const tag = `auto-${alert.metric}`;

    // Don't duplicate
    if (incidentStore.hasActiveAutoIncident(telemetry.id, tag)) continue;

    // Check previous status — only create on transition (healthy/warning → critical)
    const prev = prevStatus.get(telemetry.id);
    const prevMetricSev = prev?.[alert.metric];
    if (prevMetricSev === 'critical') continue; // Already was critical, skip

    const metricLabels = { cpu: 'CPU', mem: 'Memory', disk: 'Disk' };
    const incident = await incidentStore.create({
      title: `${metricLabels[alert.metric]} critical on ${telemetry.name || telemetry.hostname}`,
      severity: 'critical',
      serverId: telemetry.id,
      serverName: telemetry.name || telemetry.hostname || '',
      source: 'auto-detected',
      description: `${metricLabels[alert.metric]} usage reached ${alert.value}% (threshold: ${alert.threshold}%).`,
      tags: [tag, alert.metric, 'auto'],
    });

    created.push(incident);

    if (broadcast) {
      broadcast({ type: 'incident', action: 'created', incident });
    }
  }

  // Update previous status map
  const current = {};
  for (const { metric, severity } of evaluate(telemetry)) {
    current[metric] = severity;
  }
  prevStatus.set(telemetry.id, current);

  return created;
}
