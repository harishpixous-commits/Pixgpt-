# Image and video generation

PixGPT can produce image assets, queue them as asynchronous jobs, validate what
comes back, and hand them to the coding agent to use in a project.

What is **verified working** and what is **built but unproven on this machine**
are kept strictly apart on this page, because a generation backend that has
never produced a file is not a working backend.

Companion to [capabilities.md](./capabilities.md),
[build-mode.md](./build-mode.md) and [web-search.md](./web-search.md).

---

## Status

| Backend | Kind | Status | Verified how |
|---|---|---|---|
| **Deterministic renderer** | composes graphics | ✅ **Working** | real PNGs generated and validated; see below |
| **ComfyUI** | diffusion, self-hosted | ⚙️ Built, unproven here | no ComfyUI instance and no GPU on this machine |
| **Remote API** | diffusion, hosted | ⚙️ Built, unproven here | no provider configured |
| Video (any backend) | — | ❌ Unavailable | nothing configured can produce video |

### Why diffusion does not run here

Measured, not assumed:

```
GPU          Intel(R) UHD Graphics (integrated)
Accelerator  none — no CUDA, no ROCm
VRAM         2 GB (shared, and the reported figure is unreliable)
RAM          15.7 GB
PyTorch      not installed
ComfyUI      not configured
```

The smallest usable image model needs about 4 GB of dedicated VRAM; SDXL wants
8 GB, FLUX 12–24 GB, and HunyuanVideo around 45 GB. So `detectResources()`
reports `localGeneration: false` with those reasons, and PixGPT says so rather
than attempting a load that would swap for twenty minutes and then die.

Nothing is downloaded automatically. No model weight is ever fetched without an
explicit decision.

---

## The deterministic renderer

**This is not a diffusion model, and PixGPT never describes it as one.**
`capabilities().generative` is `false`, every artifact it produces carries
`generative: false`, and the agent is told to say so.

It composes real graphics and rasterises them through the headless browser
PixGPT already runs for QA. That matters because most image assets a generated
site actually needs are not photographs:

| Style | What it produces |
|---|---|
| `gradient` | A linear or radial colour field |
| `mesh` | Blurred overlapping blobs — the modern mesh-gradient look |
| `hero` | A gradient with headline typography, for a page hero |
| `card` | An Open Graph / social card with title, subtitle and accent bar |
| `pattern` | A repeating background: dots, grid, waves, diagonals or noise |
| `chart` | A bar, line, area or donut chart plotted from real data |
| `placeholder` | A labelled box showing its own dimensions |
| `swatch` | A palette strip with hex values |

**It refuses what it cannot do.** A prompt asking for a photograph, a portrait,
an illustration or a 3D render comes back with `photographic_subject` and a note
that a diffusion model is needed. It never returns a gradient with the word
"cat" written on it.

### Properties

* **Deterministic.** The same seed produces byte-identical output. Useful for
  regenerating an asset without a diff, and it makes the tests meaningful.
* **Resolution-independent.** Composed as SVG, so it is crisp at any size; ask
  for `format: "svg"` and no rasterisation happens at all.
* **Coherent colour.** Palettes are harmonies, not random values. A named colour
  in the brief anchors the hue and outranks a mood word, so "cool blue
  corporate" is blue. A restrained brief stays analogous rather than running out
  to the complementary hue, because "professional" coming back blue-to-amber
  reads as a mistake.
* **No GPU, no network, no dependency.**

### Verified

Five styles generated and validated end to end on this machine:

| Style | Output | Time |
|---|---|---|
| hero 1200×630 | valid PNG, 178 KB | 1.2 s |
| mesh 800×600 | valid PNG, 155 KB | 0.9 s |
| pattern 600×400 | valid PNG, 2 KB | 0.8 s |
| chart 900×520 | valid PNG, 9 KB | 0.8 s |
| card 1200×630 | valid PNG, 270 KB | 1.0 s |

Determinism confirmed: the same seed gave identical bytes; a different seed gave
different bytes.

---

## ComfyUI

Implemented against the documented HTTP API and ready the moment `COMFYUI_URL`
points at an instance. It is treated as an external worker — heavy execution
never happens inside the PixGPT process.

```
POST /prompt            queue a workflow      -> { prompt_id }
GET  /history/{id}      outputs once finished
GET  /queue             what is running and pending
GET  /view?filename=…   download an output
POST /interrupt         stop the running job
GET  /object_info       installed models, samplers, nodes
GET  /system_stats      device and VRAM
```

Notable behaviour:

* **Capabilities are discovered, not assumed.** The installed checkpoints,
  LoRAs, VAEs and samplers are read from `/object_info`, so PixGPT never offers
  a model that is not on the instance. Video support is inferred from whether
  video nodes are actually installed, because a stock ComfyUI has none.
* **Progress is never invented.** Queue position is real information and is
  reported; progress *within* a running job is not exposed by the HTTP API, so a
  stage name is shown rather than a percentage that creeps upward while the
  backend is wedged.
* **Cancelling propagates.** Aborting a job calls `/interrupt`, so the remote
  work stops too rather than PixGPT merely looking away.
* **A malformed graph fails at submission** with the node errors ComfyUI
  reports, not later as a mysterious empty result.

To use it:

```bash
COMFYUI_URL=http://127.0.0.1:8188
```

Then `GET /api/generate/backends?probe=1` reports what that instance can do.

---

## Remote providers

One generic adapter, configured rather than hardcoded, so PixGPT is not tied to
a vendor. It accepts the shapes services actually return: a binary body, a URL
to fetch, inline base64, or a job id to poll.

```bash
GENERATION_REMOTE_URL=https://api.example.com/v1/images
GENERATION_REMOTE_API_KEY=…
GENERATION_REMOTE_AUTH_HEADER=Authorization   # default
GENERATION_REMOTE_AUTH_PREFIX="Bearer "       # default
GENERATION_REMOTE_STATUS_PATH=https://api.example.com/v1/jobs/{id}
GENERATION_REMOTE_VIDEO_URL=https://api.example.com/v1/videos
```

**A URL returned by a provider is screened before anything is fetched from it,**
by the same SSRF policy the search tier uses. A generation service is not more
trusted than a web page because an API key was involved.

---

## Jobs

Generation is asynchronous. The chat server never blocks on it.

```
queued → starting → running → post_processing → qa → completed
                                                  ↘ failed
                                                  ↘ cancelled
```

* **Concurrency is bounded** (`GENERATION_WORKER_CONCURRENCY`, default 1). Two
  large models on one GPU do not run at half speed — they exhaust VRAM and both
  die.
* **Cancellation raises an abort signal** the backend honours, and propagates to
  the remote worker where the backend supports it.
* **Only retryable failures retry.** A transient provider error or a timeout is
  worth another attempt; an invalid prompt, an unsupported capability or a
  rejected key will fail identically and just burn the queue.
* **A job payload never carries the output bytes** — artifacts are referenced by
  id.

Watch one over SSE: `GET /api/generate/jobs/{id}/watch`.

---

## Output validation

Every artifact is parsed before it is stored. A backend returning an HTML error
page with an image content-type has failed, but it looks like success to
anything that only checks the HTTP status.

**Images** — magic bytes, real dimensions from the header, and an end marker.
PNG, JPEG, WebP, GIF and SVG are parsed directly, with no dependency.

**Video** — container structure, and for MP4 the duration and presentation size
read out of `mvhd` and `tkhd`. A file with a header but no media data is
reported as truncated, because it will not play.

Rejected outright: empty files, HTML pages, JSON error bodies, truncated
transfers, unrecognised formats, results under 16 px, and anything over the size
limit. A dimension that differs from the request is a *warning*, not a failure —
backends legitimately snap to a multiple of 8 or 64.

---

## Routing

Capability first, cost second.

1. A backend is only considered for work it declares it can do.
2. Among those, explicit configuration wins, then self-hosted, then free, then
   paid.

**Video never falls back to an image backend.** A still delivered as a video is
a wrong answer wearing a right answer's shape, so the fallback chain is filtered
by capability before it is ordered by preference.

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `IMAGE_GENERATION_PROVIDER` | — | Preferred image backend |
| `IMAGE_GENERATION_FALLBACK` | — | Comma-separated fallbacks |
| `VIDEO_GENERATION_PROVIDER` | — | Preferred video backend |
| `VIDEO_GENERATION_FALLBACK` | — | Comma-separated fallbacks |
| `COMFYUI_URL` | — | ComfyUI instance |
| `COMFYUI_TIMEOUT_MS` | 600000 | Per generation |
| `GENERATION_WORKER_CONCURRENCY` | 1 | Simultaneous jobs |
| `GENERATION_MAX_QUEUE` | 24 | Queue depth before refusing |
| `MAX_GENERATION_JOBS` | 200 | Jobs retained in memory |
| `GENERATION_JOB_TTL_MS` | 7200000 | How long a finished job is kept |
| `MAX_IMAGE_OUTPUT_MB` | 25 | Rejected above this |
| `MAX_VIDEO_OUTPUT_MB` | 200 | Rejected above this |
| `MAX_BATCH_SIZE` | 4 | Images per request |

---

## API

| Route | Purpose |
|---|---|
| `GET /api/generate/status` | What is available, and why not, when not |
| `GET /api/generate/backends?probe=1` | The registry, with live health |
| `POST /api/generate/image` | Queue an image job → `202` with the job |
| `POST /api/generate/video` | Queue a video job |
| `GET /api/generate/jobs` | Recent jobs |
| `GET /api/generate/jobs/{id}` | One job |
| `GET /api/generate/jobs/{id}/watch` | Progress as SSE |
| `DELETE /api/generate/jobs/{id}` | Cancel |
| `POST /api/generate/jobs/{id}/retry` | Retry a retryable failure |
| `GET /api/documents/{artifactId}` | Download the output |

---

## In the coding agent

`generate_image` saves an asset straight into the project, so a generated site
ships with a real hero graphic rather than an empty box or a hotlinked stock
photo.

```
design → generate_image → write the markup → start_preview
      → browser_open → audit_page → screenshot → deliver
```

The tool reports `generative: false` for renderer output, and the agent is
instructed to describe the asset accurately rather than implying a photograph
was produced.

---

## Enabling diffusion

On a machine with a CUDA or ROCm accelerator:

1. Install ComfyUI and start it (default port 8188).
2. Put a checkpoint in `models/checkpoints`. Nothing is downloaded for you —
   model weights are large and their licences vary, so that stays a deliberate
   choice.
3. Set `COMFYUI_URL=http://127.0.0.1:8188`.
4. `GET /api/generate/backends?probe=1` — it will list the models that instance
   actually has.

Rough VRAM requirements, used by the capability check:

| Model | VRAM |
|---|---|
| SD 1.5 | 4 GB |
| SDXL | 8 GB |
| SD3 | 10 GB |
| FLUX schnell | 12 GB |
| FLUX dev | 24 GB |
| LTX-Video | 12 GB |
| Wan 1.3B | 8 GB |
| Wan 14B | 24 GB |
| HunyuanVideo | 45 GB |

**Licensing is not assumed.** "Open source" does not mean unrestricted
commercial use, and model licences differ from the code licence of the tool that
runs them. Check the licence of any weight before shipping work made with it.
