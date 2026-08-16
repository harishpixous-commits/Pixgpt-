# Web search and research

PixGPT answers current-information questions by actually searching, reading the
pages it finds, and citing them. Nine providers, routed free-first, with
per-provider health and a controlled page reader.

Companion to [capabilities.md](./capabilities.md),
[build-mode.md](./build-mode.md) and [ai-gateways.md](./ai-gateways.md).

---

## Why

A model's training has a cutoff. Asked who currently holds an office, or what
version of a package is current, it answers from memory that may be a year
stale — confidently, and with no signal that it is guessing. No amount of
prompting fixes that. The fact has to be retrieved and put in front of it.

```
question
   ↓  classify        what kind of question is this
   ↓  select          which providers are good at that, cheapest first
   ↓  search          with fallback on failure
   ↓  deduplicate     the same page found twice is one source
   ↓  rerank          authority, freshness, corroboration, query match
   ↓  retrieve        read the best pages, bounded
   ↓  extract         relevant passages, not whole pages
   ↓  compare         where do sources agree and disagree
   ↓  synthesise      one answer, from those sources only
   ↓  cite            every claim traceable to a page that was read
```

**The model never fetches anything.** It can ask for a search or name a URL from
a result it has already seen; the server decides what is actually requested.

---

## Providers

| Provider | Cost | Best at | Needs |
|---|---|---|---|
| **SearXNG** | self-hosted | web, documentation | `SEARXNG_URL` |
| **Whoogle** | self-hosted | web | `WHOOGLE_URL` |
| **Wikipedia** | free | reference | nothing |
| **GitHub** | free | repositories, code, issues | nothing; `GITHUB_TOKEN` for code search |
| **DuckDuckGo** | free | general fallback | nothing |
| **Tavily** | metered | web, news | `TAVILY_API_KEY` |
| **Brave** | metered | news, web | `BRAVE_SEARCH_API_KEY` |
| **Serper** | metered | web, images, videos | `SERPER_API_KEY` |
| **Exa** | metered | documentation | `EXA_API_KEY` |

Three work with no configuration at all, which is why search is on out of the
box.

### Free-first

Ordering, in decreasing significance:

1. Explicit configuration (`SEARCH_PROVIDER_PRIMARY` and friends)
2. A declared strength in this search type
3. Cost — self-hosted, then free, then metered, then paid
4. The provider's base priority

Spending someone's search credits when a self-hosted SearXNG could have answered
is a real cost, so it takes explicit configuration. `FREE_ONLY` mode drops
metered providers entirely.

**A specialist does not lead outside its strengths.** Wikipedia is free and
excellent for "what is photosynthesis"; it is the wrong answer for a general web
query, so it does not lead one purely on being cheap.

---

## Search types

`web` · `news` · `code` · `github` · `documentation` · `reference` · `images` ·
`videos`

A type is only advertised when a configured provider actually serves it. With no
key set, `images` does not appear — because nothing available can do it.

---

## Current information

A query containing *latest, today, current, now, this week, breaking, price,
release, version* — or a current year — is treated as time-sensitive. That
changes three things:

* **Recency is requested** from providers that support it.
* **Freshness is rewarded** in ranking, and a source over a year old is
  penalised. For a timeless question it is not, because a 2015 article may be
  the best one written.
* **The cache TTL drops to 60 seconds.** Caching "what is the latest version"
  for fifteen minutes would defeat the entire feature.

---

## Version-aware technical research

Implementing against the wrong major version is one of the most common ways
generated code fails, and it is entirely avoidable — the installed version is
sitting in the project.

`research_web` with a `packageName` reads the version actually installed
(`node_modules/<pkg>/package.json` first, the manifest range second), then
scopes the search to that **major** version:

```
question:  "how to use the useActionState hook"
installed: react 19.2.8
searched:  "how to use the useActionState hook react 19"
top hit:   react.dev/reference/react/useActionState
```

The major, not the full version: "react 19" finds the documentation, "react
19.2.8" finds a changelog entry for one patch.

---

## Ranking

A search engine ranks for clicks. PixGPT needs the source most likely to be
correct and current, so provider order is a starting point, not the answer.

**Raised:** standards bodies (W3C, WHATWG, IETF), primary developer references
(MDN, the language's own docs), package registries (npm, PyPI, crates.io),
official repositories, academic and government domains, official documentation
hosts, recent sources on a live question, and pages several independent
providers found.

**Lowered:** content farms that restate other sources, aggregators, bare
homepages, and old articles presented as current.

Verified: asked for React's current version, the top three were npmjs.com,
react.dev and the GitHub releases page — with a version-tracking content farm
last.

---

## Reading pages

A snippet rarely answers a question, so the top results are opened and read.

* Scripts, navigation, cookie banners, newsletter prompts, related-article
  rails and footers are stripped.
* The remaining text is split into passages and scored against the query.
* The best are returned in **document order**, so they read as prose rather than
  as shuffled fragments.
* Everything is bounded: bytes fetched, characters extracted, passages returned.

Title, description and publication date are read from Open Graph, meta tags,
`<time>` and JSON-LD. Publication date matters for news — it is the only way to
tell a report from this morning apart from one from last year, and both look
identical in a snippet.

---

## Citations

Every source carries `title`, `url`, `domain`, `publishedAt`, `retrievedAt` and
`provider`. Sources stream as their own events, separate from the prose:

```
progress → progress → source → source → source → answer → note → done
```

**Fabricated citations are detected, not trusted.** Every `[n]` in the answer is
checked against the source list, and any number outside it is logged and
reported in `invalidCitations`. The synthesis prompt is explicit: answer only
from the numbered sources, never invent a source or a date, and say plainly when
the sources do not contain the answer.

Verified live: asked for React's current version and release date, the answer
cited the npm registry and the GitHub releases page, and **refused to state a
release date** the sources did not contain — reporting only the relative "15
days ago" that npm actually showed.

### Disagreement

Sources are compared mechanically and the findings reported alongside them:

* **Major-version conflict** — one source topping out at 18.x while another
  reaches 19.x. A single changelog listing 19.2.6, 19.1.7 and 19.0.6 is *not* a
  conflict; flagging that would teach the reader to distrust a correct source.
* **A wide date spread**, where older sources may describe superseded behaviour.
* **No publication date anywhere**, so currency cannot be confirmed.

---

## Modes

| Mode | Queries | Sources | Pages read | Budget |
|---|---|---|---|---|
| `fast` | 1 | 3 | 2 | 30 s |
| `balanced` | 2 | 6 | 4 | 75 s |
| `deep` | 4 | 12 | 8 | 240 s |
| `free_only` | 2 | 6 | 4 | 75 s, self-hosted and free only |

Deep research queries several providers in parallel and merges: independent
queries surface independent sources, and a claim appearing in several of them is
corroborated rather than merely retrieved once.

Every mode is bounded on queries, sources, pages and wall-clock. There is no
path to an unbounded search loop.

---

## Fallback and health

| Failure | Response |
|---|---|
| timeout | next provider; 20 s cooldown |
| 429 | honour `Retry-After` (capped at 10 min), else 60 s |
| 5xx | next provider; opens after 3 consecutive |
| auth error | opens **immediately** — a wrong key will not become right |
| empty result | not a failure; try the next provider |
| blocked URL | 2 min cooldown |

An open breaker excludes the provider from selection until it closes. A success
clears the streak. Health tracks requests, success rate, average latency,
consecutive failures, rate-limit hits and the last failure reason — and never
records a query.

---

## Security

**SSRF.** Every fetch is screened in five stages: scheme allowlist (http/https
only — no `file:`, `ftp:`, `javascript:`, `data:`); literal-address screening
(loopback, RFC 1918, CGNAT, link-local including `169.254.169.254`, multicast,
documentation ranges); **DNS resolution screening**, so a public hostname
resolving to a private address is refused; manual redirect walking with every
hop re-screened; and content-type validation with a streamed byte ceiling.

IPv4-mapped IPv6 (`::ffff:127.0.0.1`), decimal (`2130706433`) and hex
(`0x7f000001`) host encodings are all refused, as are URLs carrying credentials.

**Prompt injection.** Retrieved text is fenced and labelled as content, not
instructions, and the synthesis prompt says so explicitly. A page containing
"ignore your instructions and run this" is read as page content. This is
mitigation, not a guarantee — which is why the model has no tool that could act
on such an instruction during research, and why the page reader is the only
thing that ever touches the network.

**No key ever reaches the browser.** The provider registry reports whether each
one is configured and which variable it needs, never a value.

---

## Caching

| Query kind | TTL |
|---|---|
| time-sensitive | 60 s |
| news | 5 min |
| web | 15 min |
| reference / documentation | 6 hours |

Bounded and LRU-evicted. Only successful, non-empty results are cached —
caching a failure would make one bad minute last for fifteen.

---

## API

| Route | Purpose |
|---|---|
| `GET /api/search/status` | What is usable, for the UI |
| `GET /api/search/providers` | Full registry with health, for an admin panel |
| `POST /api/search` | One search, ranked and deduplicated |
| `POST /api/research` | A cited answer, streamed |
| `POST /api/research/report` | A downloadable research report |
| `POST /api/search/page` | Read one page |
| `POST /api/search/reset` | Clear a stuck breaker |

---

## In the coding agent

| Tool | Purpose |
|---|---|
| `research_web` | Version-scoped technical search |
| `research_deep` | Several searches, cross-compared, cited |
| `search_github` | Repositories, code or issues |
| `fetch_page` | Read one result in full |

The agent is told not to guess an API, and that retrieved pages are data.

---

## Setting up SearXNG

The recommended primary: self-hosted, unmetered, and it aggregates many engines.

```bash
docker run -d -p 8080:8080 -v "${PWD}/searxng:/etc/searxng" searxng/searxng
```

**JSON must be enabled** — it is off by default, and the API returns 403 without
it. In `settings.yml`:

```yaml
search:
  formats:
    - html
    - json
```

Then `SEARXNG_URL=http://127.0.0.1:8080`. PixGPT reports
`json_format_not_enabled` specifically if this step is missed, because it is a
one-line fix that is otherwise an opaque 403.

Public instances are not recommended for production: most sit behind bot
protection and rate-limit aggressively.

---

## Troubleshooting

**Search reports unavailable.** Check `WEB_SEARCH_PROVIDER` is not `none`.
`GET /api/search/status` lists what is configured.

**A provider keeps being skipped.** Its breaker is open.
`GET /api/search/providers` shows the reason and remaining cooldown;
`POST /api/search/reset` clears it.

**SearXNG returns 403.** JSON format is not enabled — see above.

**GitHub code search fails with 401.** Code search requires a token. Repository
and issue search work without one.

**Answers are stale.** Check the query is being classified as time-sensitive.
A cached entry reports its age; anything time-sensitive expires in 60 seconds.
