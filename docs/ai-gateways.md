# PixGPT AI Gateways

PixGPT does not talk to OpenAI, Anthropic, Google or any other model provider
directly. It talks to **one AI gateway**, and the gateway deals with providers.

```
        Browser (PixGPT UI)
               │  same-origin /api/chat — no credentials
               ▼
        PixGPT server (server/)
               │
               ▼
        AI Gateway Layer  (server/gateway/)
               │  AI_GATEWAY_PROVIDER selects one adapter
   ┌───────┬───────┬───────┬───────┬────────┬─────────┐
   ▼       ▼       ▼       ▼       ▼        ▼         ▼
OmniRoute LiteLLM Bifrost OneAPI NewAPI  Higress  Portkey
   └───────┴───────┴───────┴───────┴────────┴─────────┘
               │
               ▼
        AI providers (OpenAI, Anthropic, Gemini, DeepSeek, …)
```

---

## 1. What is an AI gateway?

An AI gateway is a proxy that sits between your application and many model
providers. It exposes one API — almost always OpenAI's `/v1/chat/completions`
shape — and handles provider credentials, model naming, routing, load
balancing, retries and failover behind that single endpoint.

## 2. Why PixGPT uses a gateway abstraction

* **No provider SDKs in PixGPT.** Adding a provider is a gateway config change,
  not a code change here.
* **Credentials stay in one place.** The gateway holds provider keys; PixGPT
  holds only the gateway key, server-side.
* **Gateways are swappable.** Different teams standardise on different
  gateways. Switching is one environment variable, with no frontend changes.
* **Routing is not our job.** Each gateway already does routing and fallback
  better than we could re-implement. PixGPT uses the native feature rather than
  faking a universal one.

## 3. Supported gateways

| Gateway | Adapter id | Default base URL | Licence |
|---|---|---|---|
| [OmniRoute](https://github.com/diegosouzapw/OmniRoute) **(default)** | `omniroute` | `http://localhost:20128/v1` | MIT |
| [LiteLLM](https://github.com/BerriAI/litellm) | `litellm` | `http://localhost:4000/v1` | MIT¹ |
| [Bifrost](https://github.com/maximhq/bifrost) | `bifrost` | `http://localhost:8080/v1` | Apache-2.0 |
| [One API](https://github.com/songquanpeng/one-api) | `oneapi` | `http://localhost:3000/v1` | MIT |
| [New API](https://github.com/Calcium-Ion/new-api) | `newapi` | `http://localhost:3000/v1` | AGPL-3.0 |
| [Higress](https://github.com/alibaba/higress) | `higress` | `http://localhost:8080/v1` | Apache-2.0 |
| [Portkey Gateway](https://github.com/Portkey-AI/gateway) | `portkey` | `http://localhost:8787/v1` | MIT |

¹ LiteLLM's `enterprise/` directory is under a separate commercial licence.

**None of these projects' source code is vendored into PixGPT.** Each runs as
its own service and PixGPT speaks to it over HTTP.

## 4. Verification status

**Mock verified** means driven end to end against a protocol-faithful local
server implementing that gateway's documented API surface (streaming SSE,
`/v1/models`, auth headers, failure codes). **Live verified** means tested
against the real service.

| Gateway | Adapter | Mock tested | Live tested | Streaming | Model list | Fallback |
|---|---|:--:|:--:|:--:|:--:|:--:|
| OmniRoute | `omniroute` | ✅ | ✅ **LIVE** | ✅ live | ✅ live (115 models) | ✅ live |
| LiteLLM | `litellm` | ✅ | ❌ not yet | ✅ | ✅ | ✅ |
| Bifrost | `bifrost` | ✅ | ❌ not yet | ✅ | ✅ | ✅ |
| One API | `oneapi` | ✅ | ❌ not yet | ✅ | ✅ | ✅ |
| New API | `newapi` | ✅ | ❌ not yet | ✅ | ✅ | ✅ |
| Higress | `higress` | ✅ | ❌ not yet | ✅ | ❌ unsupported | ✅ |
| Portkey | `portkey` | ✅ | ❌ not yet | ✅ | ❌ unsupported | ✅ |

### OmniRoute live verification record

**Date:** 2026-08-14 · **OmniRoute:** v3.8.49 · **Runtime:** standalone Node
v24.19.0 (PixGPT itself stayed on Node 18) · **Endpoint:**
`http://127.0.0.1:20128/v1` · **Auth:** none (`REQUIRE_API_KEY=false`)

| Check | Result |
|---|---|
| `/api/health/ping` | ✅ `{"status":"ok"}` |
| `GET /v1/models` | ✅ **115 models** discovered |
| `npm run gateway:health` | ✅ `OmniRoute ready`, authenticated |
| PixGPT `GET /api/health` · `/api/ai/health` | ✅ `status: online` |
| **Real non-streaming chat** | ✅ `"PIXGPT LIVE"` from model `big-pickle`, **2.5 s** |
| **Real streaming chat** | ✅ progressive tokens (`one`, ` two`, ` three`) |
| Model aliases → real models | ✅ fast→`big-pickle`, pro→`big-pickle`, vision→`felo-chat` |
| Image reaches a real vision provider | ✅ routed to `opencode / oc/mimo-v2.5-free` |
| **Vision model output** | ⚠️ **not obtained** — see below |
| Capability-aware vision fallback | ✅ walked `auto/best-vision → oc/mimo-v2.5-free → ddgw/claude-haiku-4-5`, all vision models |

**Vision limitation (honest):** the image demonstrably reaches OmniRoute and is
routed to a genuine vision provider, but no vision model produced an answer. The
only keyless vision model (`oc/mimo-v2.5-free`, OpenCode Free) returned
`[429] Rate limit exceeded`, and the other six vision models (`ddgw/*`, `aug/*`)
need provider credentials that are not configured. **Vision plumbing is
live-verified; vision output is not.** Configure a vision provider in the
OmniRoute dashboard to complete it.

**Two real bugs were found only by live testing** — both fixed:

1. **`localhost` fails, `127.0.0.1` works.** Node resolves `localhost` to an
   address OmniRoute (IPv4-bound) is not listening on, so every request died
   with `ECONNREFUSED` while `curl` succeeded. The adapter default is now
   `127.0.0.1`.
2. **Vision requests could fall back to a text-only model.** `auto/best-vision`
   hit a provider 429 and the generic `auto` fallback then rejected the image.
   Fallback is now capability-aware: a request carrying images uses
   `<PROVIDER>_VISION_FALLBACK_MODELS`, which is **empty by default** — better to
   fail than to silently downgrade a vision request.

**Known startup issue:** the `omniroute` CLI wrapper crashes on Windows with
`0xC0000005` (access violation) immediately after Next.js reports ready. Running
the server entry directly works reliably — see [production.md §1](./production.md).
It also loads the *nearest* `.env`, so starting it from the PixGPT directory made
it inherit `PORT=8787`; run it from its own directory.

Mock coverage is not superficial: the suite exercises normal and empty streams,
malformed SSE frames, a stream that ends without `[DONE]`, provider disconnect
mid-stream, mid-stream error events, connect/idle timeouts, client cancellation,
auth failure, and both fallback rules. Run it with `npm test`.

## 4b. What PixGPT itself uses

The capability table below describes **what each gateway supports**, not what
PixGPT sends. Being precise about the difference:

| Feature | Gateway support | Wired through PixGPT? |
|---|---|---|
| Chat completion | all seven | ✅ yes |
| Streaming | all seven | ✅ yes |
| Model selection | all seven | ✅ yes (aliases + passthrough) |
| System messages | all seven | ✅ yes (`role: "system"` is forwarded) |
| Conversation history | all seven | ✅ yes (last 200 messages) |
| `temperature`, `max_tokens` | all seven | ✅ yes |
| **Image / vision input** | several | ✅ **yes** — see below |
| **File / document input** | n/a (server-side) | ✅ **yes** — extracted to text, see [capabilities.md](./capabilities.md) |
| **Tool / function calling** | several | ⚠️ forwarded but unused by the UI |
| Embeddings | some | ❌ no — PixGPT has no use for them |

### Image input

Images **are** sent to the model. The request carries OpenAI content parts:

```json
{ "role": "user", "content": [
    { "type": "text", "text": "describe this image" },
    { "type": "image_url", "image_url": { "url": "data:image/png;base64,…" } }
]}
```

That shape was verified against OmniRoute's own contract rather than assumed —
`src/lib/guardrails/visionBridgeHelpers.ts` in the OmniRoute repository declares
`{ type: "image_url"; image_url: { url, detail? } }` as an accepted top-level
part (it also accepts `input_image` and Anthropic-style `image.source`). It is
equally the documented OpenAI Chat Completions vision format, so every
OpenAI-compatible gateway here understands it. A gateway needing a different
shape would normalise it in its adapter's `buildBody`.

**Verified end to end** (browser → `/api/chat` → validation → adapter → gateway):
the gateway receives a real `image_url` part with the correct MIME and byte
count, and streaming renders normally.

| Setting | Variable | Default |
|---|---|---|
| Which aliases may send images | `PIXGPT_VISION_ALIASES` | `pixgpt-vision` |
| Accepted formats | `ALLOWED_IMAGE_TYPES` | jpeg, png, webp, gif |
| Per-image size cap | `MAX_IMAGE_SIZE_MB` | 4 |
| Images per message | `MAX_IMAGES_PER_MESSAGE` | 3 |
| Total request cap | `MAX_REQUEST_SIZE_MB` | 10 |
| Remote image URLs | `ALLOW_REMOTE_IMAGE_URLS` | `false` |

**Model-level capability.** A gateway declaring `vision: true` only means *some*
model behind it can see. `PIXGPT_VISION_ALIASES` decides which PixGPT aliases may
carry images — by default just `pixgpt-vision`. Attach an image while
`PixGPT Fast` is selected and the composer says so and refuses to send; it is
never silently dropped. A concrete provider model typed by the operator is
trusted, since they chose it deliberately.

**Security.** Only `data:` URLs are accepted by default. Remote URLs would hand
the gateway a request-forgery primitive against its own network, so they are
opt-in and, when enabled, restricted to https, screened against
loopback/private/link-local/metadata hosts, and optionally host-allowlisted.
MIME type is allowlisted and payload size is measured from the base64 length
before any decode.

**Persistence.** Image bytes are **never written to `localStorage`** — that would
blow the browser quota. Attachments live as object URLs for the session and are
converted to base64 only at request time; `blob:` URLs are stripped on reload, so
history keeps the message text and the attachment's name while the image itself
does not survive a refresh. This was the pre-existing design and it is the right
one here.

### Files and documents

Implemented, and gateway-independent: the **server** extracts plain text and
sends that, so documents work on every gateway and every model with no vision or
file-API capability required. Supported: txt, log, md, csv, tsv, json, jsonl,
docx and common source-code files. **PDF is not enabled** — both maintained
pure-JS extractors need Node ≥ 20/22, the same constraint that blocks OmniRoute.

Full format table, limits and security notes: [capabilities.md](./capabilities.md).

### Voice

Unchanged. Speech **output** (read-aloud) uses the browser's Web Speech API and
is real. Speech **input** returns a clearly-labelled placeholder transcript —
there is no speech-to-text backend, and none was added.

### Tool calling

PixGPT's UI has no tool-calling feature, so none was built. A `tools` array on
the request is shape-validated and forwarded when the selected gateway declares
`tools: true`, so the abstraction does not stand in the way of adding it. Tool
*responses* are not parsed out of the stream yet.

## 5. Capability comparison

Only marked ✅ where verified against the project's current repository or
documentation. `—` means *not documented / not verified*, not "broken".

| Gateway | Chat | Streaming | Model list | Routing | Fallback | OpenAI API | Vision | Tools | Embeddings | Self-hosted |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| OmniRoute | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | ✅ |
| LiteLLM | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Bifrost | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| One API | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — | ✅ |
| New API | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| Higress | ✅ | ✅ | — | ✅ | ✅ | ✅² | — | — | — | ✅ |
| Portkey | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ |

² Higress serves OpenAI-format traffic only once its `ai-proxy` plugin is
configured; it is not usable for chat out of the box.

PixGPT itself currently uses **chat, streaming and model listing**. The other
columns are recorded so the abstraction can grow without re-researching, and are
returned by `/api/ai/health` so the UI could disable unsupported features.

## 6. Switching gateways

One variable:

```bash
AI_GATEWAY_PROVIDER=litellm
```

Restart the PixGPT server. Nothing else changes — not the frontend, not the
stored conversations, not the model selector.

An unknown value logs an error and falls back to `omniroute` rather than
failing to boot.

### Configuration precedence

For every setting, highest first:

1. `<PROVIDER>_<SETTING>` — e.g. `OMNIROUTE_BASE_URL`, `LITELLM_API_KEY`
2. `AI_GATEWAY_<SETTING>` — the generic knob (`AI_GATEWAY_URL` for the base URL)
3. The adapter's built-in default

This ordering is deliberate: it means the pre-existing OmniRoute variables are
simply *case 1*, so an `.env` written before multi-gateway support keeps working
byte-for-byte. **No environment variable was renamed.**

| Setting | Generic name | Per-gateway name |
|---|---|---|
| Base URL | `AI_GATEWAY_URL` | `<PROVIDER>_BASE_URL` |
| API key | `AI_GATEWAY_API_KEY` | `<PROVIDER>_API_KEY` |
| Default model | `AI_GATEWAY_DEFAULT_MODEL` | `<PROVIDER>_DEFAULT_MODEL` |
| Idle timeout | `AI_GATEWAY_TIMEOUT_MS` | `<PROVIDER>_TIMEOUT_MS` |
| Health path | `AI_GATEWAY_HEALTH_PATH` | `<PROVIDER>_HEALTH_PATH` |
| Fallback models | `AI_GATEWAY_FALLBACK_MODELS` | `<PROVIDER>_FALLBACK_MODELS` |

## 7. How model selection works

The UI sends its branded model id. The server maps it through aliases:

```
pixgpt-fast  → PIXGPT_MODEL_FAST   (or <PROVIDER>_MODEL_FAST)
pixgpt-pro   → PIXGPT_MODEL_PRO
pixgpt-vision→ PIXGPT_MODEL_VISION
```

Anything else is passed through unchanged, so the UI can request a concrete
model such as `deepseek/deepseek-chat`.

Model names are rarely portable — `auto` means something to OmniRoute and
nothing to LiteLLM — so prefer the per-gateway form when you configure more
than one:

```bash
PIXGPT_MODEL_PRO=auto              # OmniRoute
LITELLM_MODEL_PRO=gpt-4o           # used when AI_GATEWAY_PROVIDER=litellm
HIGRESS_MODEL_PRO=qwen-turbo
```

## 8. How fallback works

Two independent layers, and PixGPT never pretends they are the same:

1. **Native gateway routing** — the real mechanism. OmniRoute's `auto` cascades
   across provider tiers; LiteLLM uses its router config; Bifrost, One API,
   New API, Higress and Portkey each have their own. PixGPT does not configure
   this; you set it up in the gateway.
2. **Model-chain fallback** (optional) — `<PROVIDER>_FALLBACK_MODELS` lists
   models to try in order if the requested one fails. It only engages when the
   failure is retryable *and* no bytes have reached the browser yet, because
   switching models mid-answer would corrupt the response.

Leave the fallback list empty to rely purely on the gateway's own routing.

## 9. Health and status

`GET /api/ai/health`

```json
{
  "gateway": "omniroute",
  "label": "OmniRoute",
  "status": "online",
  "reachable": true,
  "authenticated": true,
  "code": null,
  "capabilities": { "chat": true, "streaming": true, "...": true }
}
```

`status` is `online`, `degraded` (reachable but unverified, or incomplete
config) or `offline`. No keys, credentials or provider secrets are returned.

`GET /api/health` keeps its original shape for the existing frontend, with
`gateway.name`/`label`/`capabilities` added.

From the CLI:

```bash
npm run gateway:health
```

## 10. Running each gateway

Run **only the one you selected**. All commands are from the projects' own docs.

### OmniRoute — recommended, and PixGPT's default
```bash
npm install -g omniroute && omniroute      # requires Node >= 22
```
Dashboard `http://localhost:20128` → Providers → connect one (Kiro AI or
OpenCode Free need no signup) → Endpoints → copy the key.
Docker: `docker run -d -p 127.0.0.1:20128:20128 -v omniroute-data:/app/data diegosouzapw/omniroute:latest`

Recommended because it needs no provider account to start, ships broad free-tier
routing, and is the configuration PixGPT is tested against.

### LiteLLM
```bash
pip install "litellm[proxy]"
litellm --config litellm.config.yaml --port 4000
```
Define `model_list` and `router_settings` in that YAML — that is where LiteLLM's
routing and fallbacks live. Use a virtual key (`sk-…`) as `LITELLM_API_KEY`.

### Bifrost
```bash
npx -y @maximhq/bifrost            # or: docker run -p 8080:8080 maximhq/bifrost
```
Configure providers/keys in its UI. Models are addressed `provider/model`.
If your build serves the OpenAI drop-in prefix, set
`BIFROST_BASE_URL=http://localhost:8080/openai`.

### One API
```bash
docker run -d --name one-api -p 3000:3000 -v ./data:/data justsong/one-api
```
Add channels, create a token, use it as `ONEAPI_API_KEY`. Append `-<channelId>`
to pin a channel.

### New API
```bash
docker run -d --name new-api -p 3000:3000 -v ./data:/data calciumion/new-api:latest
```
Same token model as One API. **Port 3000 clashes with One API — run one.**

### Higress
```bash
docker run -d --name higress -v ${PWD}:/data \
  -p 8001:8001 -p 8080:8080 -p 8443:8443 \
  higress-registry.cn-hangzhou.cr.aliyuncs.com/higress/all-in-one:latest
```
Then enable the **ai-proxy** plugin in the console on `:8001` and add provider
credentials. Until that is done it will not serve chat. It exposes no model
catalogue, so set `HIGRESS_MODEL_*` explicitly.

### Portkey Gateway
```bash
npx @portkey-ai/gateway             # or: docker run -p 8787:8787 portkeyai/gateway
```
⚠️ **Portkey defaults to port 8787, the same as PixGPT's server.** Change one,
e.g. `PORT=8788` for PixGPT.

Portkey needs the provider named per request:
```bash
PORTKEY_PROVIDER=openai
PORTKEY_API_KEY=<the upstream provider key>   # sent as Authorization: Bearer
PORTKEY_PLATFORM_KEY=                         # optional, x-portkey-api-key
PORTKEY_CONFIG={"strategy":{"mode":"fallback"}}  # native routing/fallback
```

## 11. Security

* Gateway URL and key are read **only** by `server/`. They are never sent to the
  browser, never written to `localStorage`, and never appear in the client
  bundle — verified by scanning `dist/` in CI-style checks.
* The browser only ever calls same-origin `/api/*`.
* Logs record metadata (gateway id, model, error code, timing). Never
  `Authorization` headers, keys, or message bodies.
* Error responses are mapped to a fixed vocabulary. Upstream bodies are not
  forwarded, since they can contain provider identifiers or key fragments; the
  detail goes to the server log.
* `.env` is git-ignored; `.env.example` is the committed template.
* Gateway and model configuration is validated server-side. An unknown
  `AI_GATEWAY_PROVIDER` falls back to the default; a misconfigured adapter is
  reported through `/api/ai/health` instead of crashing the server.

## 12. Error vocabulary

Identical regardless of gateway, so the frontend never branches on backend:

`gateway_unavailable` · `invalid_api_key` · `provider_unavailable` ·
`model_unavailable` · `rate_limited` · `quota_exceeded` · `provider_error` ·
`timeout` · `malformed_response` · `stream_failed` · `bad_request` ·
`unsupported`

Non-streaming failures return `{ "error": { "code", "message" } }`. Because a
stream's headers are already sent, mid-stream failures arrive as an SSE event
`{"type":"error","code","message"}` — partial text stays on screen.

## 13. Licence considerations

PixGPT integrates with every gateway **over its HTTP API only**. No gateway
source is copied, vendored, linked or redistributed, so none of their licences
propagate into PixGPT's own code.

* **MIT / Apache-2.0** (OmniRoute, LiteLLM, Bifrost, One API, Higress, Portkey)
  — no obligations for a separate program that merely calls their API.
* **AGPL-3.0** (New API) — the strongest copyleft here. The AGPL's network
  clause covers modified versions of *New API itself*; calling an unmodified
  instance over HTTP from a separate program does not make PixGPT a derivative
  work. If you fork or modify New API and offer it over a network, you must
  publish those changes. If that is a concern for your deployment, prefer One
  API (MIT), which New API is forked from.
* **LiteLLM** — MIT, except its `enterprise/` directory. Using the OSS proxy's
  HTTP API is unaffected.

This is a summary for engineering purposes, not legal advice.

## 14. Adding another gateway

Add one file to `server/gateway/adapters/` exporting a descriptor
(`id`, `label`, `defaultBaseUrl`, `defaultHealthPath`, `defaultModel`,
`capabilities`, plus optional `buildHeaders`, `buildBody`, `extractDelta`,
`classifyStatus`, `validate`), then register it in `server/gateway/index.mjs`.

If the gateway is OpenAI-compatible, that descriptor is the entire integration —
the shared transport in `openai-compatible.mjs` does the rest.
