/**
 * Bili Context — PI-Desktop plugin (host side).
 *
 * Discovers the local billion-context (bili) proxy port and hands the renderer
 * a single call surface: `getSnapshot()`. Nothing here writes anywhere; every
 * query is a GET against the proxy's own management API.
 *
 * Port discovery mirrors the pi-bili-commands extension:
 *   1. BILI_PORT (not available — the host injects no env — kept for parity)
 *   2. OS process scan for a node process running billion-context
 *   3. well-known ports (8787 user zone, 18787+ self-managed lanes)
 * Each candidate is confirmed with GET /__bili/health before it is trusted.
 */

const { execFile } = require("node:child_process");

const PROBE_TIMEOUT_MS = 1200;
const PORT_TTL_MS = 30_000;
const FALLBACK_PORTS = [8787, 18787, 18788, 18789, 18790, 18791, 18792, 18793, 18794, 18795, 18796, 18797, 18798, 18799, 18800];

let cachedPort = null;
let cachedAt = 0;

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? "" : String(stdout ?? ""));
    });
  });
}

/** Scan the process table for billion-context launchers and read their --port. */
async function portsFromProcesses() {
  const out = [];
  try {
    if (process.platform === "win32") {
      const stdout = await run("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
          "Where-Object { $_.CommandLine -like '*billion-context*' } | " +
          "ForEach-Object { $_.CommandLine }",
      ]);
      for (const m of stdout.matchAll(/--port[=\s]+(\d{2,5})/g)) out.push(Number(m[1]));
    } else {
      const stdout = await run("sh", [
        "-c",
        "ps -eo args= 2>/dev/null | grep -i '[b]illion-context' || true",
      ]);
      for (const m of stdout.matchAll(/--port[=\s]+(\d{2,5})/g)) out.push(Number(m[1]));
    }
  } catch {
    /* discovery is best-effort; fall through to the probe list */
  }
  return out;
}

/** Probe a candidate port; returns the health payload when it is a live bili proxy. */
async function probe(port) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/__bili/health`, { signal: ctl.signal });
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.ok ? { port, health: data } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolvePort(force = false) {
  if (!force && cachedPort && Date.now() - cachedAt < PORT_TTL_MS) {
    return { port: cachedPort, cached: true };
  }

  const candidates = [...(await portsFromProcesses()), ...FALLBACK_PORTS];
  const seen = new Set();
  for (const port of candidates) {
    if (!Number.isInteger(port) || port <= 0 || seen.has(port)) continue;
    seen.add(port);
    const hit = await probe(port);
    if (hit) {
      cachedPort = hit.port;
      cachedAt = Date.now();
      return { port: hit.port, cached: false, health: hit.health };
    }
  }

  cachedPort = null;
  cachedAt = 0;
  return { port: null, cached: false };
}

async function fetchRoute(port, route) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${route}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * GET a proxy management route, healing a stale cached port once.
 * Returns the value; throws when the route cannot be reached even after a
 * re-resolve. The healed port is cached by resolvePort itself.
 */
async function api(port, route) {
  try {
    return await fetchRoute(port, route);
  } catch (err) {
    const code = err?.cause?.code ?? err?.code;
    if (code !== "ECONNREFUSED" && code !== "ECONNRESET" && code !== "UND_ERR_SOCKET") throw err;
    cachedPort = null;
    cachedAt = 0;
    const next = await resolvePort(true);
    if (!next.port || next.port === port) throw err;
    return await fetchRoute(next.port, route);
  }
}

/** Normalize the several shapes /__bili/sessions can take into an array. */
function sessionList(res) {
  if (Array.isArray(res)) return res;
  if (Array.isArray(res?.sessions)) return res.sessions;
  return [];
}

async function getSnapshot() {
  const { port, cached, health } = await resolvePort();
  if (!port) {
    return { ok: false, reason: "no-proxy", at: Date.now() };
  }

  const grab = async (route) => {
    try {
      return { value: await api(port, route) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };

  const [h, st, cfg, sess, cache] = await Promise.all([
    health ? Promise.resolve({ value: health }) : grab("/__bili/health"),
    grab("/__bili/stats"),
    grab("/__bili/status"),
    grab("/__bili/sessions"),
    grab("/__bili/cache-report"),
  ]);

  const sessions = sessionList(sess.value);
  const totals = sessions.reduce(
    (acc, s) => {
      acc.blocks += Number(s.blocks) || 0;
      acc.saved += Number(s.tokensSaved) || 0;
      acc.requests += Number(s.requests) || 0;
      if ((Number(s.blocks) || 0) > 0) acc.compressed += 1;
      if ((Number(s.requests) || 0) > 1 && typeof s.cacheHitPct === "number") {
        acc.hitSum += s.cacheHitPct;
        acc.hitN += 1;
      }
      return acc;
    },
    { blocks: 0, saved: 0, requests: 0, compressed: 0, hitSum: 0, hitN: 0 },
  );

  const reports = (cache.value?.reports ?? []).filter((r) => typeof r?.report === "string");
  const fullest = reports.length
    ? reports.reduce((a, b) => (b.report.length > a.report.length ? b : a))
    : null;

  return {
    ok: true,
    at: Date.now(),
    port,
    portWasCached: Boolean(cached),
    health: h.value ?? null,
    stats: st.value ?? null,
    status: st.error ? null : st.value,
    errors: {
      health: h.error ?? null,
      stats: st.error ?? null,
      status: st === undefined ? null : (st.error ?? null),
      sessions: sess.error ?? null,
      cache: cache.error ?? null,
    },
    config: cfg.value ?? null,
    sessions,
    totals: {
      sessions: sessions.length,
      compressed: totals.compressed,
      blocks: totals.blocks,
      saved: totals.saved,
      requests: totals.requests,
      avgHit: totals.hitN ? totals.hitSum / totals.hitN : null,
      hitN: totals.hitN,
    },
    cacheReport: fullest ? { id: fullest.id, text: fullest.report } : null,
    cacheReportCount: reports.length,
  };
}

async function onLoad() {
  // Nothing to register: the panel is declared in the manifest and the host
  // opens it from the plugin list. Kept as the documented lifecycle anchor.
}

async function onUnload() {
  cachedPort = null;
  cachedAt = 0;
}

/**
 * Panel bridge entry point.
 *
 * The panel calls `window.pluginBridge.invoke(channel, payload)`. Any channel
 * the host does not answer itself (see its panel-bridge dispatcher: the
 * `default` branch) is forwarded to this function as `onPanelInvoke(channel,
 * payload)` on the plugin's own process.
 *
 * Channels answered here:
 *   snapshot     -> getSnapshot()
 *   open-web-ui  -> open the proxy's web UI in the OS browser
 */
async function onPanelInvoke(rawChannel, rawPayload) {
  const channel = String(rawChannel ?? "");
  const payload = rawPayload && typeof rawPayload === "object" ? rawPayload : {};

  switch (channel) {
    case "snapshot":
      return getSnapshot();

    case "open-web-ui": {
      const { port } = await resolvePort();
      if (!port) return { ok: false, reason: "no-proxy" };
      const suffix = String(payload.path ?? "").replace(/^\/+/, "");
      const url = `http://127.0.0.1:${port}/${suffix}`;
      const opener =
        process.platform === "win32"
          ? ["cmd", ["/c", "start", "", url]]
          : process.platform === "darwin"
            ? ["open", [url]]
            : ["xdg-open", [url]];
      await new Promise((resolve) => {
        execFile(opener[0], opener[1], { timeout: 8000, windowsHide: true }, () => resolve());
      });
      return { ok: true, url };
    }

    default:
      throw new Error(`unknown panel channel: ${channel}`);
  }
}

async function onLoad() {
  // The panel is declared in the manifest and opened by the host; the only
  // thing this process exposes is onPanelInvoke() above.
}

async function onUnload() {
  cachedPort = null;
  cachedAt = 0;
}

module.exports = { onLoad, onUnload, onPanelInvoke, getSnapshot, resolvePort };
