/**
 * Bili Context — panel renderer.
 *
 * The panel has no Node access. Everything goes through the host bridge:
 *   window.pluginBridge.invoke(channel, payload)
 * Channels the host does not answer itself are forwarded to the plugin
 * process' `onPanelInvoke(channel, payload)`.
 */

const POLL_MS = 5000;

const bridge = window.pluginBridge;

const el = {
  dot: document.getElementById("status-dot"),
  port: document.getElementById("port-label"),
  empty: document.getElementById("empty"),
  emptyMsg: document.getElementById("empty-msg"),
  content: document.getElementById("content"),
  cards: document.getElementById("cards"),
  sessionsHint: document.getElementById("sessions-hint"),
  sessionsTable: document.getElementById("sessions-table"),
  cacheHint: document.getElementById("cache-hint"),
  cacheReport: document.getElementById("cache-report"),
  proxyKv: document.getElementById("proxy-kv"),
  btnRefresh: document.getElementById("btn-refresh"),
  btnAuto: document.getElementById("btn-auto"),
  btnWebUi: document.getElementById("btn-webui"),
};

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

const num = (v) =>
  typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("en-US") : "—";

function compact(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

const pctText = (v) =>
  typeof v === "number" && Number.isFinite(v) ? `${v.toFixed(1)}%` : "—";

function hitClass(hit) {
  if (typeof hit !== "number") return "";
  if (hit >= 90) return "good";
  if (hit >= 75) return "warn";
  return "bad";
}

function el2(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

function renderCards(snap) {
  const t = snap.totals ?? {};
  const hit = t.avgHit;
  const hc = hitClass(hit);

  const cards = [
    {
      label: "Tokens saved",
      value: compact(t.saved),
      sub: `${num(t.saved)} exact`,
      cls: (t.saved ?? 0) > 0 ? "good" : "",
    },
    {
      label: "Cache hit",
      value: pctText(hit),
      sub: `${t.hitN ?? 0} active session${t.hitN === 1 ? "" : "s"}`,
      cls: hc,
    },
    {
      label: "Compression blocks",
      value: num(t.blocks),
      sub: `across ${t.compressed ?? 0} session${t.compressed === 1 ? "" : "s"}`,
      cls: (t.blocks ?? 0) > 0 ? "good" : "",
    },
    {
      label: "Sessions",
      value: num(t.sessions),
      sub: `${num(t.requests)} requests total`,
      cls: "",
    },
  ];

  el.cards.replaceChildren(
    ...cards.map((c) => {
      const box = el2("div", `card ${c.cls}`.trim());
      box.append(
        el2("div", "label", c.label),
        el2("div", "value", c.value),
        el2("div", "sub", c.sub),
      );
      return box;
    }),
  );
}

function renderSessions(snap) {
  const rows = [...(snap.sessions ?? [])].sort((a, b) =>
    String(b.lastSeen ?? "").localeCompare(String(a.lastSeen ?? "")),
  );

  el.sessionsHint.textContent = rows.length
    ? `${rows.length} record${rows.length === 1 ? "" : "s"} · newest first`
    : "";

  const table = el.sessionsTable;
  table.replaceChildren();

  if (!rows.length) {
    const tr = el2("tr");
    const td = el2("td", "hint", "No sessions recorded yet.");
    td.colSpan = 7;
    tr.append(td);
    table.append(tr);
    return;
  }

  const head = el2("tr");
  for (const [label, cls] of [
    ["Cache", "num"],
    ["Context / window", "num"],
    ["Blocks", "num"],
    ["Saved", "num"],
    ["Requests", "num"],
    ["Last seen", ""],
    ["Upstream", ""],
  ]) {
    head.append(el2("th", cls, label));
  }
  table.append(head);

  for (const s of rows) {
    const tr = el2("tr", (s.blocks ?? 0) > 0 ? "has-blocks" : "");

    // cache hit with a bar
    const cacheCell = el2("td", "num");
    const hit = typeof s.cacheHitPct === "number" ? s.cacheHitPct : null;
    if (hit !== null) {
      const bar = el2("span", `bar ${hitClass(hit)}`.trim());
      const fill = document.createElement("i");
      fill.style.width = `${Math.max(0, Math.min(100, hit))}%`;
      bar.append(fill);
      cacheCell.append(bar, document.createTextNode(pctText(hit)));
    } else {
      cacheCell.textContent = "—";
    }
    tr.append(cacheCell);

    tr.append(
      el2(
        "td",
        "num mono",
        `${num(s.contextTokens)} / ${num(s.contextWindow)}`,
      ),
      el2("td", "num mono", num(s.blocks)),
      el2("td", "num mono", num(s.tokensSaved)),
      el2("td", "num mono", num(s.requests)),
      el2("td", "mono", String(s.lastSeen ?? "—").slice(0, 19).replace("T", " ")),
      el2("td", "origin", String(s.upstreamOrigin ?? "—").replace(/^https?:\/\//, "")),
    );
    table.append(tr);
  }
}

function renderCache(snap) {
  if (snap.cacheReport?.text) {
    el.cacheHint.textContent = `${snap.cacheReport.id ?? "session"}${
      snap.cacheReportCount > 1 ? ` · ${snap.cacheReportCount} reports, showing the fullest` : ""
    }`;
    el.cacheReport.textContent = snap.cacheReport.text;
  } else {
    el.cacheHint.textContent = "";
    el.cacheReport.textContent = snap.errors?.cache
      ? `Cache report unavailable: ${snap.errors.cache}`
      : "No cache report yet — send a message through the proxy, then refresh.";
  }
}

function renderProxy(snap) {
  const h = snap.health ?? {};
  const st = snap.status ?? {};
  const cfg = snap.config ?? {};
  const c = cfg.compress ?? {};

  const rows = [
    ["Proxy port", String(snap.port ?? "—")],
    ["Status", h.ok ? "ok" : "down"],
    ["Version", `${h.version ?? "—"}${h.commit ? ` (${h.commit})` : ""}`],
    ["PID", String(h.pid ?? "—")],
    ["Upstream default", String(h.upstream ?? "—")],
    [
      "Blind tunnels",
      `${h.blindTunnels?.total ?? 0}${
        (h.blindTunnels?.total ?? 0) > 0 ? " — traffic bypassing compression" : " — none"
      }`,
    ],
    ["Watchdog", h.watchdog?.armed ? `armed (parent ${h.watchdog.parentPid})` : "not armed"],
    ["Storage", `${st.storage?.effective ?? "—"}${st.storage?.degraded ? " (degraded)" : ""}`],
    ["Stale", st.stale ? "YES — restart the host" : "no"],
    ["In flight", String(st.inFlight ?? "—")],
    ["Config file", String(cfg.path ?? "—")],
    ["Nudge growth", String(c.nudgeGrowthTokens ?? "(default 50000)")],
    ["Max context", String(c.maxContextLimit ?? "—")],
    ["Emergency", String(c.emergencyThresholdPercent ?? "—")],
    ["Provider routes", Object.keys(cfg.providers ?? {}).join(", ") || "(none declared)"],
  ];

  const frag = document.createDocumentFragment();
  for (const [k, v] of rows) {
    frag.append(el2("dt", "", k), el2("dd", "mono", v));
  }

  const errs = Object.entries(snap.errors ?? {}).filter(([, v]) => v);
  if (errs.length) {
    frag.append(el2("dt", "", "Errors"));
    const dd = el2("dd");
    dd.append(el2("span", "err", errs.map(([k, v]) => `${k}: ${v}`).join(" · ")));
    frag.append(dd);
  }

  el.proxyKv.replaceChildren(frag);
}

function showEmpty(message) {
  el.content.hidden = true;
  el.empty.hidden = false;
  el.emptyMsg.textContent = message;
  el.dot.dataset.state = "bad";
  el.port.textContent = "—";
}

function render(snap) {
  if (!snap?.ok) {
    showEmpty(
      snap?.reason === "no-proxy"
        ? "bili proxy not found. Start PI-Desktop (it spawns the proxy when billion-context is installed) or run `bili start`."
        : "Could not read the bili proxy.",
    );
    return;
  }

  el.empty.hidden = true;
  el.content.hidden = false;

  const h = snap.health ?? {};
  el.dot.dataset.state = h.ok ? "ok" : "warn";
  el.port.textContent = `:${snap.port}`;

  renderCards(snap);
  renderSessions(snap);
  renderCache(snap);
  renderProxy(snap);
}

// ---------------------------------------------------------------------------
// data flow
// ---------------------------------------------------------------------------

let inFlight = false;

async function refresh() {
  if (inFlight) return;
  inFlight = true;
  try {
    if (!bridge?.invoke) {
      showEmpty("Host bridge unavailable — reinstall or reload the plugin.");
      return;
    }
    const snap = await bridge.invoke("snapshot", {});
    render(snap);
  } catch (err) {
    showEmpty(`Snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    inFlight = false;
  }
}

// --- controls --------------------------------------------------------------

let timer = null;
let auto = true;

function setAuto(next) {
  auto = next;
  el.btnAuto.setAttribute("aria-pressed", String(auto));
  el.btnAuto.textContent = auto ? `Auto ${POLL_MS / 1000}s` : "Auto off";
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (auto) {
    timer = setInterval(refresh, POLL_MS);
  }
}

el.btnRefresh.addEventListener("click", () => refresh());

el.btnAuto.addEventListener("click", () => setAuto(!auto));

el.btnWebUi.addEventListener("click", async () => {
  try {
    const res = await bridge.invoke("open-web-ui", {});
    if (!res?.ok) {
      el.btnWebUi.textContent = "Open web UI";
      showEmpty("bili proxy not found — nothing to open.");
    }
  } catch (err) {
    console.error("open-web-ui failed", err);
  }
});

// Pause polling while the panel is hidden, so a docked view costs nothing.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  } else if (auto && !timer) {
    refresh();
    timer = setInterval(refresh, POLL_MS);
  }
});

refresh();
setAuto(true);
