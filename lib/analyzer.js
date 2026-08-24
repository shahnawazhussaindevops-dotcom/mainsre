// AI incident analysis.
// Uses Anthropic or OpenAI if an API key is set; otherwise a real rule-based
// analyzer that recognizes common failure signatures. Always returns the same shape:
//   { severity, summary, rootCause, command, risk, source, note? }
const SEVERITIES = ['info', 'warning', 'critical'];

function clampSeverity(s) {
  const v = String(s || '').toLowerCase();
  return SEVERITIES.includes(v) ? v : 'warning';
}

function extractJson(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function buildPrompt(log, server, errorContext) {
  const ctx = server
    ? `Server: ${server.name || server.host} (${server.host}, OS: ${server.platform || 'unknown'}). ` +
      `CPU ${fmtPct(server.cpuPct)}, memory ${fmtPct(server.memPct)}, disk ${fmtPct(server.diskPct)}.`
    : 'No live metrics available.';
    
  let prompt = `You are a senior Site Reliability Engineer. Analyze the incident below and respond ONLY with a JSON ` +
    `object, no prose, using exactly these keys: severity ("info"|"warning"|"critical"), summary (one sentence), ` +
    `rootCause (one or two sentences), command (a single shell/PowerShell command to investigate or safely remediate), ` +
    `risk ("safe"|"caution"|"destructive").\n\n` +
    `${ctx}\n\nLog excerpt:\n${log}`;
    
  if (errorContext) {
    prompt += `\n\nUPDATE: The previous command you suggested failed with this error:\n${errorContext}\n\nPlease generate a NEW command to fix or investigate this new error.`;
  }
  return prompt;
}

function fmtPct(v) {
  return v == null ? 'n/a' : `${Math.round(v)}%`;
}

async function viaAnthropic(log, server, key, errorContext) {
  const model = process.env.ANTHROPIC_MODEL?.trim() || 'claude-3-5-sonnet-latest';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      messages: [{ role: 'user', content: buildPrompt(log, server, errorContext) }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = data?.content?.map((c) => c.text).join('') || '';
  const parsed = extractJson(text);
  if (!parsed) throw new Error('Could not parse model response.');
  return { ...normalize(parsed), source: `anthropic:${model}` };
}

async function viaOpenAI(log, server, key, errorContext) {
  const model = process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini';
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You are a senior SRE. Reply only with the requested JSON object.' },
        { role: 'user', content: buildPrompt(log, server, errorContext) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || '';
  const parsed = extractJson(text);
  if (!parsed) throw new Error('Could not parse model response.');
  return { ...normalize(parsed), source: `openai:${model}` };
}

function normalize(p) {
  return {
    severity: clampSeverity(p.severity),
    summary: String(p.summary || 'Analysis complete.').trim(),
    rootCause: String(p.rootCause || p.root_cause || '').trim(),
    command: String(p.command || '').trim(),
    risk: ['safe', 'caution', 'destructive'].includes(String(p.risk).toLowerCase())
      ? String(p.risk).toLowerCase()
      : 'caution',
  };
}

// Ordered signatures — first match wins.
const SIGNATURES = [
  {
    test: /out of memory|oom-killer|cannot allocate memory|memoryerror/i,
    severity: 'critical',
    summary: 'A process was killed by the kernel out-of-memory (OOM) killer.',
    rootCause:
      'Memory demand exceeded available RAM, so the kernel terminated the largest offender. Likely a leak, an under-provisioned instance, or a workload spike.',
    command: 'sudo dmesg -T | grep -i "killed process" | tail -n 20',
    risk: 'safe',
  },
  {
    test: /no space left on device|disk (is )?full|enospc/i,
    severity: 'critical',
    summary: 'A filesystem has run out of space.',
    rootCause: 'A volume reached 100% capacity — commonly runaway logs, old container images, or unrotated files.',
    command: 'sudo du -xh / 2>/dev/null | sort -rh | head -n 20',
    risk: 'safe',
  },
  {
    test: /502 bad gateway|503 service unavailable|504 gateway time-?out|upstream/i,
    severity: 'critical',
    summary: 'The web tier cannot reach a healthy upstream/backend.',
    rootCause: 'A backend service is down, overloaded, or failing health checks, so the proxy returns 5xx errors.',
    command: 'systemctl status nginx && sudo ss -ltnp | head -n 20',
    risk: 'safe',
  },
  {
    test: /connection refused|could not connect|econnrefused/i,
    severity: 'warning',
    summary: 'A service refused a network connection.',
    rootCause: 'The target process is not listening on the expected port — crashed, not started, or bound to the wrong interface.',
    command: 'sudo ss -ltnp',
    risk: 'safe',
  },
  {
    test: /segfault|core dumped|panic|kernel bug/i,
    severity: 'critical',
    summary: 'A process crashed (segfault / core dump).',
    rootCause: 'A binary hit an illegal memory access or unrecoverable fault. Check recent deploys and dependency versions.',
    command: 'sudo coredumpctl list 2>/dev/null | tail -n 20',
    risk: 'safe',
  },
  {
    test: /crashloopbackoff|imagepullbackoff|failedscheduling/i,
    severity: 'critical',
    summary: 'A Kubernetes pod is failing to start.',
    rootCause: 'A pod is crash-looping or cannot pull its image / be scheduled — bad config, missing secret, wrong image tag, or no capacity.',
    command: 'kubectl get pods -A | grep -Ev "Running|Completed"',
    risk: 'safe',
  },
  {
    test: /permission denied|eacces|not permitted/i,
    severity: 'warning',
    summary: 'An operation failed due to insufficient permissions.',
    rootCause: 'A process lacks the rights for a file, socket, or capability — often ownership, mode bits, or SELinux/AppArmor.',
    command: 'sudo journalctl -p err -n 40 --no-pager',
    risk: 'safe',
  },
  {
    test: /timed out|timeout/i,
    severity: 'warning',
    summary: 'An operation timed out.',
    rootCause: 'A dependency responded too slowly or not at all — network path, DNS, or a saturated downstream service.',
    command: 'ping -c 4 8.8.8.8 && sudo journalctl -n 40 --no-pager',
    risk: 'safe',
  },
];

function ruleBased(log, server) {
  const text = String(log || '');
  for (const sig of SIGNATURES) {
    if (sig.test.test(text)) {
      return { ...sig, test: undefined, source: 'rule-based' };
    }
  }

  // Fall back to live metrics if the log text is unremarkable.
  if (server) {
    if (server.cpuPct != null && server.cpuPct >= 90) {
      return {
        severity: 'critical',
        summary: `CPU is saturated at ${Math.round(server.cpuPct)}%.`,
        rootCause: 'Sustained high CPU points to a hot process, a runaway loop, or insufficient compute for the current load.',
        command: 'top -bn1 | head -n 15',
        risk: 'safe',
        source: 'rule-based',
      };
    }
    if (server.diskPct != null && server.diskPct >= 90) {
      return {
        severity: 'critical',
        summary: `Disk is ${Math.round(server.diskPct)}% full.`,
        rootCause: 'The root filesystem is nearly full; writes will start failing soon.',
        command: 'sudo du -xh / 2>/dev/null | sort -rh | head -n 20',
        risk: 'safe',
        source: 'rule-based',
      };
    }
    if (server.memPct != null && server.memPct >= 90) {
      return {
        severity: 'warning',
        summary: `Memory usage is high at ${Math.round(server.memPct)}%.`,
        rootCause: 'Free memory is low; the OOM killer may activate if pressure continues.',
        command: 'free -m && ps -eo pid,comm,%mem --sort=-%mem | head',
        risk: 'safe',
        source: 'rule-based',
      };
    }
  }

  const hit = text.match(/.*\b(error|fatal|critical|fail(?:ed|ure)?)\b.*/i);
  return {
    severity: hit ? 'warning' : 'info',
    summary: hit ? 'An error was logged, but it does not match a known signature.' : 'No obvious problem detected in this excerpt.',
    rootCause: hit
      ? `First error line: "${hit[0].trim().slice(0, 160)}". Investigate surrounding log context.`
      : 'Metrics and logs look nominal. Keep monitoring.',
    command: 'sudo journalctl -p warning -n 60 --no-pager',
    risk: 'safe',
    source: 'rule-based',
  };
}

export async function analyze({ log, server, errorContext }) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  const openaiKey = process.env.OPENAI_API_KEY?.trim();
  try {
    if (anthropicKey) return await viaAnthropic(log, server, anthropicKey, errorContext);
    if (openaiKey) return await viaOpenAI(log, server, openaiKey, errorContext);
  } catch (e) {
    return { ...ruleBased(log, server), note: `LLM call failed (${e.message}); used rule-based analysis.` };
  }
  return ruleBased(log, server);
}
