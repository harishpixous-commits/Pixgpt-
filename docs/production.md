# PixGPT in production

Companion to [ai-gateways.md](./ai-gateways.md). That document covers *which*
gateway to use; this one covers running PixGPT itself safely.

---

## 1. Node runtime — two runtimes are fine

PixGPT and the gateway are **separate processes**. They do not need to share a
Node version, and PixGPT is deliberately not forced onto a newer one.

| Component | Requirement | Notes |
|---|---|---|
| **PixGPT** (server + build) | **Node 18+** — verified on v18.20.8 | Uses only `node:http`, `fetch`, `node:test`. No native modules. |
| **OmniRoute** | **Node ≥ 22.22.2 <23, or ≥ 24 <27** | Declared in its `package.json` `engines`. Ships native deps (`better-sqlite3`). |
| Other gateways | n/a | Run as containers or their own runtimes; PixGPT never loads their code. |

Running PixGPT on Node 18 and OmniRoute on Node 24 **is supported** — they only
talk HTTP. Do not upgrade PixGPT's runtime just to satisfy the gateway.

### Why the earlier install failed

`npm install -g omniroute` on Node 18 fell through to compiling
`better-sqlite3` from source (no prebuilt binary matches an unsupported Node
ABI), then failed on a missing Visual Studio toolchain. The root cause is the
Node version, not the toolchain.

### Working setup (verified 2026-08-14)

Standalone Node 24 alongside the system Node 18 — this is what was actually used
to bring OmniRoute up:

```powershell
# 1. standalone runtime (system Node 18 untouched)
#    download node-v24.x.x-win-x64.zip, extract to %USERPROFILE%\node24

# 2. isolated global install
$root = "$env:USERPROFILE\node24"
& "$root\node.exe" "$root\node_modules\npm\bin\npm-cli.js" install -g omniroute `
  --prefix "$root\npm-global" `
  --allow-scripts=omniroute,keytar,tls-client-node,onnxruntime-node,sharp,core-js,`
@parcel/watcher,@swc/core,protobufjs,koffi,esbuild,better-sqlite3

# 3. run the server entry directly, from its OWN directory, with an explicit port
cd $env:USERPROFILE\.omniroute-run
$env:PORT = "20128"
& "$root\node.exe" "$root\npm-global\node_modules\omniroute\dist\server.js"
```

Three things that will bite you, all observed:

* **`--allow-scripts` is required.** npm 11 blocks install scripts by default, so
  the first install produced a package with no native bindings.
* **Run `dist/server.js`, not the `omniroute` CLI.** The CLI wrapper crashed with
  `0xC0000005` (access violation) right after Next.js reported ready. The server
  entry runs fine.
* **Run it from its own directory.** It loads the nearest `.env`; started from the
  PixGPT folder it inherited `PORT=8787` and tried to bind PixGPT's port.

And in PixGPT's `.env`, use **`127.0.0.1`, not `localhost`** — Node resolves
`localhost` to an address OmniRoute is not bound to, giving `ECONNREFUSED` even
though the gateway is up.

### Getting a Node 22/24 runtime without touching the system install

Ordered least invasive first. **Nothing here has been run for you.**

**Option A — standalone zip (most isolated, no installer, no PATH change)**

Download `node-v24.x.x-win-x64.zip` from <https://nodejs.org/en/download>,
extract to e.g. `C:\node24`, then use it *only* for the gateway:

```powershell
C:\node24\npm.cmd install -g omniroute
C:\node24\node.exe C:\node24\node_modules\omniroute\bin\omniroute.js
```

System Node stays v18; PixGPT is unaffected. No registry or PATH edits.

**Option B — fnm (per-shell version manager)**

```powershell
winget install Schniz.fnm
fnm install 24
fnm use 24            # affects this shell only
npm install -g omniroute && omniroute
```

Leave PixGPT's shell alone and it keeps using Node 18.

**Option C — Docker (avoids native compilation entirely)**

```powershell
docker run -d --name omniroute --restart unless-stopped `
  -p 127.0.0.1:20128:20128 -v omniroute-data:/app/data `
  diegosouzapw/omniroute:latest
```

Prefer this if the native build fails again — the image is prebuilt.

> **Not recommended:** `nvm-windows`. It manages `C:\Program Files\nodejs` as a
> symlink, so switching versions changes the Node that PixGPT uses too.

---

## 2. Recommended deployment architecture

```
                        Internet
                            │  TLS
                            ▼
                    Reverse proxy (nginx / Caddy / Traefik)
                      · terminates TLS
                      · rate limits per IP
                      · buffering DISABLED for /api/chat  (SSE)
                            │
                            ▼
                    PixGPT  (npm start — one process, serves API + built UI)
                      · holds AI_GATEWAY_API_KEY
                      · the only thing that talks to the gateway
                            │
                     private network / loopback only
                            ▼
                    AI gateway (OmniRoute, …)
                      · holds provider credentials
                      · NOT published to the internet
                            ▼
                    AI providers
```

**The gateway must not be publicly reachable.** Bind it to loopback
(`-p 127.0.0.1:20128:20128`) or keep it on a private network. If it has to be
exposed, require authentication on it (for OmniRoute: `REQUIRE_API_KEY=true`)
and restrict by source address.

### Reverse-proxy notes for streaming

Proxy buffering breaks SSE — the answer arrives as one block at the end.
PixGPT already sends `X-Accel-Buffering: no` and `Cache-Control: no-transform`,
but configure the proxy too:

```nginx
location /api/chat {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 300s;   # ≥ AI_GATEWAY_MAX_STREAM_MS
    chunked_transfer_encoding on;
}
```

---

## 3. Timeouts

Three independent layers, all configurable, so a dead provider can never hold a
connection open forever.

| Layer | Variable | Default | Guards against |
|---|---|---|---|
| Connect / first response | `AI_GATEWAY_CONNECT_TIMEOUT_MS` | 15 s | Dead host, or a gateway that accepts the socket then goes silent |
| Idle (resets per chunk) | `AI_GATEWAY_TIMEOUT_MS` | 60 s | A stream that stalls mid-answer |
| Absolute ceiling | `AI_GATEWAY_MAX_STREAM_MS` | 300 s | A provider trickling forever |
| Browser watchdog | *(client, fixed)* | 90 s silence | Server/network death that never closes the socket |

Per-gateway overrides use the usual pattern, e.g. `OMNIROUTE_TIMEOUT_MS`.

The browser watchdog matters: without it a half-open connection would leave the
UI on "Generating…" indefinitely. It resets on every event, so slow answers are
unaffected.

---

## 4. Rate limiting

`/api/chat` has an in-memory fixed-window limiter.

| Variable | Default | Meaning |
|---|---|---|
| `RATE_LIMIT_MAX` | `60` | Requests per window. **`0` disables it.** |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Window length |

Exceeding it returns `429` with a `Retry-After` header and the standard
`rate_limited` error code, which the UI already renders.

**Scope: one process.** It protects a single instance against a runaway client
or a stuck retry loop. It is *not* distributed — run N instances and each gets
its own budget. For multi-instance production either:

* enforce the limit at the reverse proxy (`limit_req` in nginx), which is
  usually the right place; or
* replace `server/rate-limit.mjs` with a Redis-backed counter. The module is
  deliberately a single small file with a `check(key)` function so this is a
  local change.

No database was introduced for this.

---

## 5. Request validation

`/api/chat` rejects, with a `bad_request`/`413` and no stack trace:

| Guard | Limit |
|---|---|
| Body size | 1 MB (`413`) |
| Messages forwarded | last 200 |
| Total prompt characters | 400,000 |
| Model id | ≤ 200 chars, `^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$` |
| Tool definitions | ≤ 64, each `{type:'function', function:{name}}` |
| `temperature` | number, clamped 0–2 |
| `max_tokens` | number, clamped 1–200,000 |
| `stream` | boolean |

The model pattern is a real defence, not cosmetic: model ids reach upstream
request bodies and log lines, so newlines and quotes are rejected to prevent
log/payload injection. Unknown message roles are normalised to `user` rather
than forwarded.

---

## 5b. Image input limits

| Guard | Variable | Default |
|---|---|---|
| Per-image bytes | `MAX_IMAGE_SIZE_MB` | 4 MB |
| Images per message | `MAX_IMAGES_PER_MESSAGE` | 3 |
| Whole request | `MAX_REQUEST_SIZE_MB` | 10 MB |
| Accepted MIME types | `ALLOWED_IMAGE_TYPES` | jpeg, png, webp, gif |
| Remote URLs | `ALLOW_REMOTE_IMAGE_URLS` | `false` (data: only) |
| Host allowlist | `REMOTE_IMAGE_HOSTS` | empty |

The request body cap follows `MAX_REQUEST_SIZE_MB` because base64 inflates an
image by ~1.37×; a 4 MB image is ~5.5 MB on the wire. Rate limiting bounds the
cost of that larger ceiling. Size is measured from the base64 length *before*
decoding, so an oversized payload is rejected without being materialised.

Remote image URLs are off by default. Enabling them lets the gateway fetch a URL
your users supply, which is a request-forgery primitive against whatever its
network can reach — so when enabled, PixGPT still requires https, rejects
loopback, private (10/8, 172.16/12, 192.168/16), link-local and cloud-metadata
(169.254.169.254) hosts, and honours `REMOTE_IMAGE_HOSTS` as an allowlist.

## 6. Observability

Every `/api/chat` request gets an id (`req_<12 hex>`), returned in the
`X-Request-Id` response header and embedded in error payloads, so a user can
quote it and you can find the exact log lines.

Logged: `requestId`, `gateway`, `model`, resolved model, message count,
character count, duration, `outcome`, `fellBack`, error `code` and internal
`detail`.

**Never logged:** API keys, `Authorization` headers, prompt text, or response
text. Verified by inspection — no log call references a key, header, or body.

`LOG_LEVEL` = `error` | `warn` | `info` (default) | `debug`.

---

## 7. Security posture

| Concern | Status |
|---|---|
| Gateway key in browser | Never — server-side only; `dist/` scanned clean |
| Key in `localStorage` | No — only `pixgpt:v1` (conversations + settings) |
| Frontend env exposure | Only `VITE_PIXGPT_DEMO` (a boolean flag) |
| Source maps | Not emitted in production |
| `.env` | Git-ignored; never served (static handler is confined to `dist/`) |
| CORS | No CORS headers — browser access is same-origin only |
| SSRF | Gateway URL comes from env only; no request field reaches a URL |
| Stack traces | Never returned; mapped to a fixed error vocabulary |
| Upstream error bodies | Not forwarded (may contain provider ids/key fragments) |
| Path traversal | Static paths normalised and confined to `dist/` |
| Request size | 1 MB cap, enforced while streaming the body |

---

## 8. Docker — decision

**Not adopted, and deliberately so.** PixGPT is a single Node process with no
native dependencies, no database and no services to orchestrate: `npm start`
already produces exactly what a container would. Adding a Dockerfile now would
be maintenance with no benefit.

Docker **is** the right answer for the *gateways* — they are third-party
services with native dependencies and their own runtimes. Run those in
containers and keep PixGPT as a plain process, or add a container for PixGPT
later if your platform requires one.

If you do containerise PixGPT, the shape is small: multi-stage build (`npm ci`
→ `npm run build`) then a runtime stage on Node 18-alpine running
`node server/index.mjs`, with `dist/` copied in and the `.env` supplied by the
orchestrator rather than baked into the image. No code changes are needed.

---

## 9. Commands

```bash
npm run dev              # API + Vite dev server together
npm run dev:server       # API only
npm run dev:web          # UI only
npm run build            # typecheck + production bundle
npm start                # production: one process serves API + UI
npm test                 # unit + integration tests (node:test)
npm run verify           # tsc + eslint + tests + build
npm run gateway:health   # check the selected gateway from the CLI
```
