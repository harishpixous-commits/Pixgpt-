# Models

PixGPT's gateway advertises 116 models. This document is about the difference
between that number and the number of models PixGPT will actually send your
request to.

The system has one governing rule, and everything else follows from it:

> **A model in the catalogue has not been shown to work.**

`auto/best-coding` is a name someone chose. It is not evidence about coding, or
about availability, or about anything. So PixGPT tracks catalogue membership and
verification as separate facts, ranks on measured behaviour rather than on names,
and says "not yet verified" where a lesser system would say "available".

Companion to [capabilities.md](./capabilities.md), [skills.md](./skills.md) and
[web-search.md](./web-search.md).

---

## What actually works here

Measured by real probes against this deployment, not inferred:

| Pool | Models | State |
|---|---|---|
| `auto/*` | 38 | **Working.** 11 routes verified; some rate-limit under load |
| `oc/*` | 6 | **Working**, then rate-limits almost immediately |
| `aug/*` | 28 | **Down.** 502 — the gateway's Auggie CLI is not installed |
| `tllm/*` | 26 | **Down.** 401/403 — the gateway has no credentials for this pool |
| `ddgw/*` | 6 | **Blocked.** 418 anti-abuse challenge |
| `felo/*` | 5 | **Unusable.** HTTP 200 with a body of `"."` |
| `veo*` | 4 | **Unverified.** Timed out at 30s; no output ever validated |
| `pepper`, `mcode` | 2 | **Down.** 502 / unknown model |

So of 116 catalogue entries, **two pools answer**. That is the fact the whole
registry exists to surface, and no amount of reading model names would have
revealed it.

Vision is a special case, covered [below](#vision).

---

## Verification states

| State | Meaning |
|---|---|
| `CATALOGUED` | The gateway lists it. Nothing more is known. |
| `LIVE_VERIFIED` | A real request returned usable content, and it still works. |
| `MOCK_VERIFIED` | Verified against a stub. Tests only; never production. |
| `UNHEALTHY` | It worked before; it is failing now. |
| `RATE_LIMITED` | Temporarily over quota. |
| `UNAVAILABLE` | Fatally broken, or gone from the catalogue. |
| `UNKNOWN` | No information either way. |

`LIVE_VERIFIED` is **derived, not stored**. A model that answered an hour ago and
has failed five times since is not currently verified, and the ranking sees that
immediately.

---

## Evidence

Every fact carries where it came from, and stronger sources overwrite weaker ones
— never the reverse.

| Source | Example | Weight |
|---|---|---|
| `probe` | a real request proved it | strongest |
| `config` | the operator set it in `.env` | |
| `gateway` | the adapter declares it | |
| `doc` | published vendor documentation | |
| `id` | parsed out of the model id | weakest |

A capability starts as **unknown**, never as false. "We have not checked" and "it
cannot" are different claims, and conflating them permanently excludes working
models.

**Only a probe may set `vision: true`.** This is not a style preference — it is
the one capability whose failure produces a confident wrong answer rather than an
error.

---

## Ranking

Deterministic and explainable. Every point has a sentence attached, because a
score nobody can read is a score nobody can correct.

```
score = capability match
      + live verification
      + task suitability (category hints)
      + published documentation (capped)
      + health
      + reliability (rolling success rate)
      + context fit
      + tool fit
      + latency fit
      - recent failures
      - cost penalty
      - remembered failures
```

The single most important relationship in that table:

```
VERIFY_LIVE (25)  >  CATEGORY_HINT (8) + DOC_MAX (6)
```

A verified model beats an unverified one whose name says `best-coding`. That is
section 32 expressed as arithmetic, and there is a test asserting it.

### Seeing the reasoning

```
npm run models:select -- "Fix the failing test in my React repo"
```

```
Task    Coding  (matched coding wording)
Chain
  1. auto/claude-sonnet    primary
  2. oc/big-pickle         fallback
  3. aug/opus4.6-500k      fallback

Score breakdown
  +30    tools confirmed by probe
  +25    a real request has succeeded on this route
  +14    route is healthy
  +12.7  catalogued as coding, reasoning, general chat
  ...
```

---

## Quality tiers

`TIER_S` · `TIER_A` · `TIER_B` · `TIER_C` · `TIER_FREE`

Recomputed from the current registry on every read — never hardcoded, never
stored. Tiers are *relative*: a tier is a model's standing among what is
available right now.

**The top two tiers require live verification.** Without that rule the tiers were
computed entirely from names and documentation, and every plausible-sounding
route landed in `TIER_A` having never answered a request — section 32's failure
wearing a grade as a disguise. An unverified model tops out at B.

Free routes are tiered separately, because "best thing that costs nothing" is a
different question from "best thing".

---

## There is no best model

There are eleven bests. They differ, and on this deployment they genuinely do:

| Task | Currently |
|---|---|
| `BEST_GENERAL` | `auto/best-reasoning` |
| `BEST_CODING` | `auto/claude-sonnet` |
| `BEST_REASONING` | `auto/best-reasoning` |
| `BEST_VISION` | **none qualifies** |
| `BEST_FAST` | `auto/best-fast` |
| `BEST_FREE` | `auto/best-free` |
| `BEST_LONG_CONTEXT` | `aug/opus4.6-500k` (unverified — nothing else states a 200k+ window) |
| `BEST_TOOL_AGENT` | `auto/claude-sonnet` |
| `BEST_RESEARCH` | `auto/claude-opus` |
| `BEST_COST` | `auto/best-free` |
| `BEST_FALLBACK` | `auto/best-fast` |

Two classes apply a **soft-hard filter**: they restrict the pool when anything
satisfies the constraint, and degrade gracefully when nothing does.

* `BEST_FREE` filters to free routes. Cost is a constraint the user set, not a
  quality dimension to trade away — as a mere penalty it lost, and the one
  verified route won "best free" while not being free.
* `BEST_LONG_CONTEXT` filters to routes stating a 200k+ window. The window is the
  entire question for that class.

---

## Aliases

The three user-facing aliases are unchanged, and are no longer fixed targets.

| Alias | Resolves to |
|---|---|
| `pixgpt-fast` | the best verified low-latency route |
| `pixgpt-pro` | the best route **for the task** — general, reasoning, coding, research or long-context |
| `pixgpt-vision` | the best verified vision route, or nothing |

`pixgpt-pro` deliberately has no fixed model: it follows the classifier.

---

## Task classification

Pattern-based, not a model call — it runs on every request, so it must be instant
and free. Facts beat wording:

| Signal | Wins over |
|---|---|
| an attached image | any wording |
| Build/Debug/Research mode | any wording |
| a supplied tools array | any wording |
| a very large conversation | any wording |

| Request | Class |
|---|---|
| "hello" | `BEST_FAST` |
| "Explain the trade-offs of event sourcing" | `BEST_REASONING` |
| "Fix this bug in my repository" | `BEST_CODING` |
| "Analyse this screenshot" | `BEST_VISION` |
| "Research the current state of WebGPU" | `BEST_RESEARCH` |
| "I need the cheapest possible answer" | `BEST_COST` |
| "Generate an image of a mountain" | *not* vision — the opposite capability |

---

## Fallback chains

Every request gets a chain, not a model.

Chains prefer **provider diversity** after the first pick: four routes from one
pool fail together when that pool has an outage, which is exactly when a chain is
needed. A coding chain may end on a strong general model; a general chain ends on
`BEST_FALLBACK`, which weights reliability double.

### Vision

`BEST_VISION` has **no tail**, and that absence is deliberate.

Vision has no compatible fallback outside vision. A text model asked about an
image does not degrade gracefully — it produces a confident answer about
something it never saw, which is worse than an error because it looks like a
success. When no vision route is verified, PixGPT returns:

> No vision-capable route has been verified on this server, so images cannot be
> analysed right now.

A bug found while building this: `pixgpt-pro` with an image attached resolved to
`BEST_GENERAL` and routed to text-only models. There are now two independent
guards — the alias table passes `BEST_VISION` through, and `selectModels` forces
the vision class whenever an image is attached regardless of alias — plus eleven
tests covering every alias.

**Vision is not verified on this deployment.** Every attempt returns 429 or an
explicit capability rejection. It is reported as unavailable, never as working.

---

## Health and circuit breaking

Per-route rolling statistics over the last 20 outcomes, so one lucky call cannot
pin a model at the top forever.

```
healthy → degraded → cooldown → (timer lapses) → degraded → healthy
```

A route is **never deleted**. A lapsed cooldown reports `degraded`, not
`healthy` — the timer expiring is permission to try again, not proof of recovery.
Only a real success restores `healthy`.

One failure does not open the breaker; two consecutive ones do. A single failure
on a live gateway is usually noise.

### Failure classification

| Kind | Cooldown | Notes |
|---|---|---|
| `rate_limited` | 2 min | transient |
| `timeout` | 45 s | |
| `server_error` | 90 s | |
| `network` | 60 s | |
| `content_free` | 10 min | HTTP 200 with no content — a quality problem, not an outage |
| `provider_blocked` | 15 min | anti-abuse challenge, geo-block |
| `invalid_key` | fatal | a configuration problem; cooling it down hides it |
| `invalid_model` | fatal | including a 5xx naming a missing binary |
| `quota` | fatal | |
| `unsupported_capability` | **none** | disproves one capability, damages no health |

Three of these were written because of failures found while building this:

* **418 anti-abuse challenge** (`ddgw/*`) matched no numeric rule and landed in
  `unknown` with a 60-second cooldown — far too short for a session-level block.
* **A 502 naming a missing binary** (`aug/*`: `'auggie' is not recognized`)
  cannot be fixed by retrying, so it is fatal rather than retried every 90s.
* **`provider_unavailable` short-circuited** on the error code before the body
  was ever examined, so the rule above could never fire.

---

## Memory across restarts

Without persistence every restart forgets which routes work, and the first
request of each session goes to whatever *sounds* best. Observed exactly that: a
fresh server ranked `aug/opus4.6-500k` first for coding, minutes after a probe
proved the gateway cannot reach it.

`.pixgpt-workspaces/model-registry.json` holds route names and counters. No
prompts, no responses, no credentials.

| Remembered | Expires after |
|---|---|
| verification | 24 hours |
| probe-confirmed capabilities | 7 days |
| failures | 6 hours |

Three rules keep a cache from becoming a lie:

* **Everything expires.** "It answered last Tuesday" is not evidence about today.
* **A past failure is a penalty, never an exclusion.** A route that was
  misconfigured yesterday may have been fixed this morning, and it must be able
  to prove that by answering once.
* **Cooldowns are never restored.** A breaker describes right now.

---

## Probing

Probes cost real money, so they are small, targeted, and never automatic.

| Probe | Asks | Proves |
|---|---|---|
| `chat` | ≤16 tokens | the route answers with content |
| `tools` | ≤64 tokens | a tool call comes back, not prose about one |
| `vision` | ≤16 tokens + a 1×1 PNG | the route accepts an image |
| `structured` | ≤48 tokens | parseable JSON with the right values |
| `reasoning` | ≤24 tokens | one checkable answer |
| `coding` | ≤96 tokens | one checkable snippet |

**A 200 is not a pass.** The content-free guard that catches `felo/felo-chat`
returning `"."` applies to probes too.

**A probe never falls back.** `noFallback` pins it to the model named — otherwise
the registry would record the fallback's success against the probed model and
learn something false.

**121 models are never probed at startup.** The candidate set is the routes that
decide real requests: configured aliases plus the top of each ranking. Ordinary
traffic does the rest — every chat request reports its outcome to the registry,
so the system learns for free.

---

## Ensembles

Off by default and staying that way. A second model reviewing the first costs
linearly and only pays where a mistake is expensive.

| Kind | When |
|---|---|
| `code_review` | difficult coding work |
| `security` | security-sensitive changes |
| `research` | claims that will be cited |
| `architecture` | decisions that are hard to reverse |

The reviewer is chosen from a **different family** wherever the catalogue allows
— two routes into the same model agree with each other by construction.

**The reviewer never edits anything.** Its output is a list of claims handed back
to the primary, which decides. The return shape has no field that could be
mistaken for an edit.

The research verifier sees only the sources search actually retrieved, and a
citation outside that range is dropped rather than passed on.

---

## Commands

```
npm run models:list                          the normalised catalogue
npm run models:list -- --provider=auto       one pool
npm run models:health                        per-route health
npm run models:probe                         verify the default candidates
npm run models:probe -- --probe=vision a/b   verify one capability
npm run models:benchmark                     reasoning / coding / structured
npm run models:refresh                       re-read, report what changed
npm run models:select -- "your prompt"       what would be chosen, and why
```

`probe` and `benchmark` are the only commands that spend anything. Both print
what they are about to spend before spending it, and both cap how many models
they touch — and *report* the cap rather than truncating silently.

---

## API

| Route | Purpose |
|---|---|
| `GET /api/models` | the flat catalogue (unchanged shape) plus registry state |
| `GET /api/models/registry` | normalised catalogue with live status |
| `GET /api/models/recommended` | grouped picks for the picker |
| `GET /api/models/best` | the eleven task winners |
| `GET /api/models/health` | per-route health |
| `GET /api/models/{id}` | one model in full |
| `POST /api/models/refresh` | re-read without a restart |
| `POST /api/models/select` | dry run: what would be chosen, and why |
| `POST /api/models/probe` | **admin** — spend real requests to verify |

`POST /api/models/probe` costs money, so it is gated: with `PIXGPT_ADMIN_TOKEN`
set, the token is required; without it the endpoint is loopback-only. The
comparison is constant-time.

No response carries a key, a base URL, or a configuration value.

---

## What the browser is told

The chat response carries the task class, the model family, and whether a
fallback happened. Not the chain, not the scores, not the base URL — a user does
not need the routing table to understand their answer, and publishing it would
leak the shape of the deployment.

The picker shows five short groups, not 116 rows. Every row states its
verification, and `CATALOGUED` reads **"Not yet verified"** — never "available".

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PIXGPT_MODEL_CATALOGUE_TTL_MS` | 300000 | how long a catalogue read is reused |
| `PIXGPT_MODEL_MEMORY_TTL_MS` | 86400000 | how long a verification is remembered |
| `PIXGPT_PROBE_MAX_TOKENS` | 16 | probe ceiling |
| `PIXGPT_PROBE_MAX_MODELS` | 24 | models per probe run |
| `PIXGPT_PROBE_CONCURRENCY` | 3 | parallel probes |
| `PIXGPT_CHAIN_LENGTH` | 4 | models per fallback chain |
| `PIXGPT_ADMIN_TOKEN` | — | required for the probe endpoint |

Configured routes are a **preference, not an override**: a route named in `.env`
gets ranking points and joins every chain, but an unhealthy one is still bypassed.

---

## Tests

`tests/models.test.mjs` — 131 tests, entirely offline against a seeded registry.
A suite whose results change with someone's rate limit tells you nothing about
the code.

The load-bearing ones:

* live verification outweighs every name-derived signal
* an unverified model cannot reach `TIER_S` or `TIER_A`
* a vision chain never contains a model known to lack vision
* a vision chain has no general-model tail
* **every alias keeps an image request on the vision class** (11 tests)
* a capability failure does not damage health
* rolling statistics turn over, so one success cannot pin a model
* a fatally failed route is excluded; a cooling one is only demoted
* chains prefer provider diversity
* no record leaks a credential

---

## All 116 models

### OmniRoute auto-routing (38)

`auto/best-chaos` · `auto/best-chat` · `auto/best-coding` · `auto/best-coding-fast` · `auto/best-fast` · `auto/best-free` · `auto/best-reasoning` · `auto/best-vision` · `auto/chaos` · `auto/chat` · `auto/cheap` · `auto/claude-opus` · `auto/claude-sonnet` · `auto/coding` · `auto/coding:cheap` · `auto/coding:fast` · `auto/coding:free` · `auto/coding:pro` · `auto/coding:reliable` · `auto/fast` · `auto/gemini` · `auto/gemma` · `auto/glm` · `auto/llama` · `auto/mimo` · `auto/minimax` · `auto/multimodal` · `auto/offline` · `auto/pro-chat` · `auto/pro-coding` · `auto/pro-fast` · `auto/pro-reasoning` · `auto/pro-vision` · `auto/reasoning` · `auto/reasoning:pro` · `auto/smart` · `auto/vision` · `auto/zai`

### Augment (28) — down: the gateway's Auggie CLI is not installed

`aug/fable-5` · `aug/gemini-3.1-pro-preview` · `aug/glm-5.2` · `aug/gpt5` · `aug/gpt5.1` · `aug/gpt5.2` · `aug/gpt5.4` · `aug/gpt5.4-mini` · `aug/gpt5.5` · `aug/gpt5.6-luna` · `aug/gpt5.6-sol` · `aug/gpt5.6-terra` · `aug/haiku4.5` · `aug/kimi-k2.6` · `aug/kimi-k2.7` · `aug/opus4.5` · `aug/opus4.6` · `aug/opus4.6-500k` · `aug/opus4.7` · `aug/opus4.7-500k` · `aug/opus4.8` · `aug/prism-a` · `aug/prism-b` · `aug/sonnet4.5` · `aug/sonnet4.6` · `aug/sonnet4.6-500k` · `aug/sonnet5-500k` · `aug/sonnet5-high`

### TypingMind pool (26) — down: no credentials

`tllm/CLAUDE_4_5_HAIKU` · `tllm/CLAUDE_4_6_OPUS` · `tllm/CLAUDE_4_6_SONNET` · `tllm/claude_haiku_3_5` · `tllm/claude_opus_4` · `tllm/claude_sonnet_4` · `tllm/deepseek_v4` · `tllm/gemini_1_5_flash` · `tllm/gemini_2_0_flash` · `tllm/gemini_2_5_pro` · `tllm/gemini_3_flash` · `tllm/gemini_3_pro` · `tllm/GPT_4o` · `tllm/GPT_5` · `tllm/GPT_5_1` · `tllm/GPT_5_2` · `tllm/GPT_5_3` · `tllm/GPT_5_4` · `tllm/GPT_o3_mini` · `tllm/GPT_o4_mini` · `tllm/openrouter_deepseek_r1` · `tllm/openrouter_gpt_4_o` · `tllm/openrouter_gpt_4_o_mini` · `tllm/openrouter_grok_4` · `tllm/sonar-pro` · `tllm/together_deepseek_v3`

### DuckDuckGo gateway (6) — blocked: 418 anti-abuse challenge

`ddgw/claude-haiku-4-5` · `ddgw/gpt-5.4-mini` · `ddgw/gpt-5.4-nano` · `ddgw/mistral-small-2603` · `ddgw/tinfoil/gemma4-31b` · `ddgw/tinfoil/gpt-oss-120b`

### OpenClaude free tier (6) — answers, then rate-limits

`oc/big-pickle` · `oc/deepseek-v4-flash-free` · `oc/hy3-free` · `oc/mimo-v2.5-free` · `oc/nemotron-3-ultra-free` · `oc/north-mini-code-free`

### Felo (5) — returns HTTP 200 with `"."`

`felo/felo-chat` · `felo/felo-document` · `felo/felo-scholar` · `felo/felo-search` · `felo/felo-social`

### Video (4) — advertised, never validated

`veo-free/veo` · `veo-free/seedance` · `veoaifree-web/veo` · `veoaifree-web/seedance`

### Other (3)

`pepper/pepper-1` · `mcode/mimo-auto` · `auto`

---

The catalogue is live and changes. It was 121 entries when this work started and
116 when it finished — which is why `POST /api/models/refresh` exists and why
nothing here is hardcoded.
