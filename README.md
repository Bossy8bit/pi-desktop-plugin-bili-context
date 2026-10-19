# Bili Context

A read-only **PI-Desktop** work-panel view for the
[billion-context](https://github.com/ranxianglei/billion-context) (`bili`)
compression proxy.

`billion-context` compresses a long agent conversation into layered summaries so
a single session can run for days. It exposes a small HTTP management API but
ships no UI of its own in the desktop app — this plugin surfaces it.


## What it shows

| Section | Contents |
|---|---|
| Summary cards | tokens saved, average prefix-cache hit rate, compression blocks, session count |
| Sessions | per-session cache hit (with bar), context/window usage, block count, tokens saved, request count, last seen, upstream origin |
| Cache report | the proxy's own `ACP CACHE REPORT` text — grand ledger, miss attribution, model/key/wire switches |
| Proxy | port, version, pid, default upstream, blind-tunnel count, watchdog state, storage mode, staleness, effective compression tuning |

Auto-refresh every 5 s while the panel is visible; polling pauses when the panel
is hidden and can be turned off entirely. A **Refresh** button is always there,
plus **Open web UI** for the proxy's full web dashboard.

## Install

### From source (development)

1. **Plugins → Load dev plugin**, and pick this directory.
2. Reload or restart PI-Desktop if the view does not appear.

### From a package

```bash
# with the PI-Desktop devkit CLI
pnpm pi-plugin check .
pnpm pi-plugin pack .        # -> dist/local.bili-context-0.1.0.piplug
```

Then **Plugins → Install plugin package**.

## Requirements

- `billion-context` installed and its proxy running. PI-Desktop starts one
  automatically when `npm:billion-context` is in your pi settings
  (`~/.pi/agent/settings.json` → `packages`). Otherwise run `bili start`.
- PI-Desktop `>= 0.9.0`.

## How it finds the proxy

The port is not fixed — PI-Desktop spawns the proxy in a self-managed zone,
usually `18787`–`18800`. Discovery order:

1. OS process scan for a node process whose command line contains
   `billion-context`, reading its `--port`
2. a probe list: `8787`, then `18787`–`18800`

Every candidate is confirmed with `GET /__bili/health` before it is trusted, so
an unrelated service on a probed port is never mistaken for the proxy. The
resolved port is cached for 30 s, and a refused connection invalidates the cache
and re-resolves once.

## How the panel talks to the plugin

The panel window has no Node access. It calls

```js
window.pluginBridge.invoke(channel, payload)
```

and any channel the host does not answer itself is forwarded to the plugin
process as `onPanelInvoke(channel, payload)`.

| Channel | Returns |
|---|---|
| `snapshot` | proxy health, stats, status, config, sessions, totals, cache report |
| `open-web-ui` | opens the proxy's web dashboard in your browser |

## Permissions

Declared: **`ui.view`** only.

The plugin's own process uses Node's built-in `fetch` against `127.0.0.1` — the
host permission gateway does not mediate those calls, which is why no
`net.fetch` is declared. What that means in practice:

- **Read-only.** Every request is a `GET` to the proxy's `/__bili/*` routes.
  Nothing on disk is read or written.
- **No credentials.** No API key is read or sent. The proxy's own
  `GET /__bili/config` response is displayed as-is; it contains routing and
  tuning, not secrets.
- **Loopback only.** Nothing is sent to a remote host.
- **No agent tools.** No tool is registered; the agent cannot see or call this.
- The single side effect is the **Open web UI** button launching your browser at
  `http://127.0.0.1:<port>/`.

## License

MIT
