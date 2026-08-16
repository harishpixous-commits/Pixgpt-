# Build mode — the coding agent

PixGPT's Build and Debug modes drive a real coding agent: it writes files, runs
commands, starts the project, opens it in a browser, looks at what rendered,
fixes what is wrong, and hands back a ZIP that has been proven to work.

Companion to [capabilities.md](./capabilities.md) (what works),
[ai-gateways.md](./ai-gateways.md) (which gateway) and
[production.md](./production.md) (how to run it).

Everything on this page is covered by `tests/agent.test.mjs`,
`tests/agent-runtime.test.mjs`, and the five end-to-end acceptance runs described
at the bottom.

---

## The loop

```
objective
   ↓
report_plan          → a checklist the user watches, struck through as it completes
   ↓
analyze_project      → on an imported codebase: stack, commands, routes, entry points
   ↓
write / edit files   → into real folders, not a flat pile
   ↓
run_command          → install, test, build; exit code and output are read, never assumed
   ↓
start_preview        → the project actually runs
   ↓
browser_open         → a real browser loads it; console + network failures collected
   ↓
audit_page           → measured defects: overflow, contrast, clipping, tap targets
browser_screenshot   → a picture
analyze_screenshot   → a vision model's judgement on how it looks
   ↓
   ↑___ anything failed? fix the cause and repeat from start_preview
   ↓
smoke_test           → install · typecheck · lint · test · build · start · render · visual
   ↓
finish               → with evidence, or with knownIssues stated plainly
```

A build that compiles is not a build that works. The loop exists because the
common failure is a project that passes its build and renders a blank page.

---

## Tools

29 tools, one registry. Files and commands in `server/agent/tools.mjs`;
preview, browser, vision, research, analysis and symbol lookup in
`server/agent/tools-runtime.mjs`.

### Files

| Tool | What it does |
|---|---|
| `list_files` | recursive listing, build noise skipped |
| `read_file` | text only; binary is refused, not mangled |
| `search_code` | literal or regex, with file and line |
| `write_file` | creates or replaces; parent directories made |
| `edit_file` | replace a snippet in one file. Matched in tiers (exact → line endings → trailing space → indentation), but **fails loudly** if the text is missing or ambiguous |
| `apply_patch` | related changes across several files in one call, all-or-nothing |
| `rename_file` / `delete_file` | both confined to the workspace |

`edit_file` refusing an ambiguous match is deliberate: a silent no-op edit is how
an agent convinces itself it fixed something.

### Commands

`run_command` takes a program and an argument list — never a shell string.
`shell: false`, a scrubbed environment, and a risk classification on every call.

| Risk | Behaviour | Examples |
|---|---|---|
| `SAFE` | runs | `npm run build`, `npm test`, `git status`, `node`, `tsc` |
| `LOW_RISK` | runs, logged | `npm install` with no package named, `npm uninstall` |
| `REQUIRES_APPROVAL` | **waits for the user** | `npm install <package>`, `npx`, `npm publish`, anything unrecognised, any path outside the workspace |
| `BLOCKED` | refused | `bash`, `sh`, `cmd`, `powershell`, `sudo`, `mkfs`, `diskpart`, `reg`, `netsh`, `shutdown` |

Restoring what `package.json` already declares is routine. Adding a *named* new
package pulls third-party code the user never asked for, so that stops for a
decision — as does `npx`, which downloads and executes a package outright.

### Preview

`start_preview` works out how to run the project from what is on disk — never a
hardcoded framework guess. It detects Vite, Next.js, an `npm dev` script, an
`npm start` script, a Node entry point, Django, a Python entry point, or a plain
static site, and serves the last of those itself with no dependency.

Ports come from a private range (41000–41400) bound to `127.0.0.1` only.
Readiness is a real HTTP response, not a sleep. `BROWSER=none` is set so a dev
server cannot open a window on the host.

The preview is **left running** when a task finishes — the user's whole reason for
building something is to click the link and look at it. It is stopped when the
task is discarded, on explicit stop, and at shutdown.

### Browser

A real Chrome or Edge, headless, driven through `puppeteer-core`.

| Tool | What it does |
|---|---|
| `browser_open` | navigate; reports status, title, console errors, failed requests |
| `browser_interact` | click, type, select, submit, scroll, wait, press, change viewport |
| `browser_inspect` | visible text, headings, links, buttons, inputs, overflow geometry |
| `browser_screenshot` | PNG, kept out of the project directory |
| `audit_page` | measured visual defects (below) |
| `analyze_screenshot` | a vision model's judgement on a screenshot |
| `browser_diagnostics` | console and network failures since the page opened |

**Isolation.** A throwaway `userDataDir` per task, so the agent never touches the
real browser profile, cookies, history or saved passwords. Navigation is
restricted to the task's own preview origin — it cannot browse the web, reach
`localhost` services, or read `file:` URLs.

Viewports: desktop 1440×900, tablet 834×1112, mobile 390×844.

### `audit_page` — the reliable visual check

Measured in the browser from computed styles and real geometry:

| Finding | Severity | How it is measured |
|---|---|---|
| horizontal overflow | high | `scrollWidth` vs `clientWidth`, plus the widest offending element |
| unreadable contrast | high / medium | WCAG 2.1 ratio, translucency composited, backdrop walked up the tree |
| invisible text | high | computed `opacity` below 0.15 on an element with text |
| broken image | high | `complete && naturalWidth === 0` |
| blank page | high | under 10 characters of visible text |
| clipped content | medium | `scrollHeight` past `clientHeight` under `overflow: hidden` |
| tiny tap target | low | interactive element under 24px |

This exists because a vision model is a remote dependency that can be rate
limited, and **"the UI was not checked" must never be reported as "the UI is
fine."** When `analyze_screenshot` cannot reach a model it returns
`verified: false` and says so; `audit_page` still stands, and the agent is told to
state plainly that the appearance was not model-reviewed.

### Research

`research_web` reuses PixGPT's existing search tier but scopes the query to the
version *actually installed* in the project — asking about React Router is
useless if the project is on v6 and the top result is v7. Documentation and
standards bodies are ranked above forum answers. Retrieved pages are wrapped in
the same labelled-as-data fence the chat path uses, so a page saying "ignore your
instructions" cannot issue tool calls.

### Documents

`generate_document` writes a real PDF, Word document, PowerPoint deck, HTML page
or Markdown file into the project. See [documents.md](./documents.md).

---

## Smoke test

`smoke_test` is the delivery gate. It runs the real commands and reports what
happened rather than asserting success.

| Step | Blocking | Checks |
|---|---|---|
| `files` | yes | there is something to run |
| `detect` | yes | the project kind is recognised |
| `install` | yes | dependencies install |
| `typecheck` / `lint` | no | reported, do not block |
| `test` | yes | the project's own tests pass |
| `build` | yes | it builds |
| `start` | yes | it starts and answers HTTP |
| `render` | yes | the page is not blank |
| `console` | no | no console errors |
| `visual:desktop` / `visual:mobile` | no | `audit_page` at both viewports |

Negative-tested against five deliberately broken projects — a blank page, a
1400px mobile overflow, a JavaScript error, a failing build, and nothing runnable
at all. All five are caught, with the offending element named.

---

## Workspace containment

Every task gets `…/workspaces/<taskId>/`:

```
<taskId>/
  project/     ← the agent's world: every path resolves inside this
  artifacts/   ← screenshots and throwaway browser profiles
```

`artifacts/` is a **sibling** of `project/`, not a directory inside it. A Chrome
profile is tens of megabytes: kept under the project it would count against the
workspace size limit, be listed as project files, and end up in the ZIP the user
downloads. None of it is their code.

`resolveInside()` refuses absolute paths, `..`, symlink escapes, NUL bytes and
paths over 400 characters. Containment is checked with `realpath`, so a symlink
planted inside the workspace cannot point out of it.

**Never reachable:** operating-system files, credentials, SSH keys, the real
browser profile, unrelated projects, PixGPT's own source, gateway keys. Child
processes get an allowlisted environment — no gateway secret reaches them.

---

## Importing an existing project

`POST /api/agent/import` takes a raw `.zip` body and returns a task with the
codebase in it, plus an analysis.

Every archive is assumed hostile:

| Attack | Defence |
|---|---|
| zip-slip (`../../.ssh/authorized_keys`) | path screened, then re-checked against the real target |
| absolute paths, drive letters, UNC | refused |
| symlinks, devices, FIFOs | refused by `st_mode` |
| decompression bombs | `maxOutputLength` on inflate, plus a per-file ratio cap |
| huge archives | 60 MB in, 400 MB expanded, 25 MB per file |
| too many entries | 8000 |
| nested archives | stored, never expanded |
| control characters, reserved device names (`nul`, `con`, `lpt1`) | refused |
| trailing dots and spaces | refused — Windows strips them, causing collisions |
| secrets | `.env*`, `id_rsa`, `.npmrc`, `.pem`, `.p12` and friends never imported |

Nothing is written until the whole archive has validated, so a malicious entry
near the end cannot leave a half-written workspace. A single wrapping directory
(as GitHub exports have) is stripped.

---

## Codebase analysis

`analyze_project` builds a map so the agent starts from facts:

* language, frameworks, build tools, test tools, database, package manager
* the real commands — install, dev, build, test, lint, typecheck
* entry points, from `package.json` and from convention
* HTTP routes from server code, client routes from router config, and
  file-system routes for Next/Nuxt/SvelteKit
* file counts by extension, top-level directories, largest files, test files
* README, `.env.example` and Dockerfile presence

Read-only, bounded to 4000 files, and `node_modules` is never walked.

---

## Multi-file patches

`edit_file` changes one place. A real change is rarely one place: rename a
function and its call sites move with it; add a route and the router, the
handler and the test all change together.

Done as N sequential `edit_file` calls that costs N tool calls and gives N
chances to half-finish — the function renamed, two of its callers not, and the
agent unable to tell that is what happened.

`apply_patch` does the whole change in one call:

```
*** Begin Patch
*** Update File: src/lib/money.js
@@ export function formatMoney(cents) {
-  return '$' + cents
+  return '$' + (cents / 100).toFixed(2)
*** Add File: src/lib/tax.js
+export const RATE = 0.2
*** Delete File: src/old.js
*** End Patch
```

Three guarantees, each tested:

* **All or nothing.** Every hunk is resolved against the current files before a
  single byte is written. A patch whose third hunk does not match leaves the
  project exactly as it was.
* **Contained.** Every path goes through the same workspace guard as any other
  write. `../../../pwned.txt`, `/etc/passwd` and `C:\pwned.txt` are all refused.
* **Tolerant, not sloppy.** Context is matched through `edit_file`'s tiers, so a
  stray CRLF cannot fail a nine-hunk patch — but an ambiguous hunk is still
  refused rather than guessed at, and a loose match is reported.

Format adapted from Freebuff; see [freebuff-analysis.md](./freebuff-analysis.md).

---

## The code map

`analyze_project` describes the project's *shape*. The code map describes its
*contents*: for every file, the symbols it defines, ranked by how important they
look. It is built once per task and injected into the system prompt, so the model
can see where things are instead of opening files until it finds them.

```
server/agent/tools.mjs · toolNames toolDefinitions coerceArgs executeTool agentSystemPrompt
server/agent/terminal.mjs · classify truncate runCommand resolveProgram childEnv
server/gateway/index.mjs · getGateway resolveConfig modelSupportsVision aliasCapabilities
```

The ranking is arithmetic — no model call, no embeddings, no vector store:

```
base  = 0.8^depth · sqrt(lines / (symbols + 1))
score = base · (1 + ln(1 + externalCallers))
```

Entry points outrank buried helpers; a file with three exports has three
significant symbols rather than eighty trivial ones; and a function called from
a dozen files rises above one that is never called. Measured on PixGPT itself:
147 files, 1,172 symbols, ~100 ms.

The map is fitted to a token budget by degrading in a defined order — full →
fewer symbols per file → symbol-bearing files only → top files → minimal —
rather than being cut off mid-list. It is cached per project and invalidated on
every write, edit, rename and delete, because a map that omits the file just
created is worse than no map.

An empty project gets no map section. There is nothing to describe.

### `find_symbol`

The same index, on demand:

```
find_symbol("formatMoney")
→ definedIn: src/lib/money.js
  calledBy:  src/ui/cart.js, src/ui/receipt.js
  hint:      Used by 2 other file(s). Check them before changing its signature.
```

The caller list is the point. It answers "what breaks if I change this" before
the edit rather than after the test run — the question a file tree could never
answer. A partial name returns ranked matches instead.

Extraction is per-language regex over declaration forms, covering JavaScript,
TypeScript, Python, Go, Rust, Java, Kotlin, C#, Ruby, C, C++ and PHP. It is
wrong at the margins — a symbol defined by a macro is missed — and adequate for
ranking. The alternative was a native tree-sitter grammar per language.

The design is adapted from Freebuff; see [freebuff-analysis.md](./freebuff-analysis.md).

---

## Context compaction

A long build overflows the context window. What gets thrown away decides whether
the agent still knows what it has already tried.

Compaction degrades in four stages, in `server/agent/transcript.mjs`:

1. simplify old tool results in place — keep `ok`, `command`, `exitCode`, `error`
2. simplify the recent ones too
3. drop the oldest exchanges
4. hard floor

**Simplifying always precedes dropping.** A result compacted to
`{command, exitCode, ok, outputOmitted: true}` costs about thirty tokens instead
of two thousand and still answers "has this been tried, and did it work". The
previous behaviour — keep the last forty messages — lost that record entirely,
which is how an agent runs the same failing command at iteration 3 and again at
iteration 30.

Dropping an assistant message also drops its tool results. An orphaned `tool`
message whose `tool_call_id` has no matching call is rejected by the provider
outright, turning a context problem into a failed request.

---

## Approval

A `REQUIRES_APPROVAL` command **parks** — the tool call waits for the user's
decision rather than skipping ahead. The UI shows the command, its risk and the
reason, and offers:

* **Allow once** — this invocation only
* **Allow for this task** — the same command may repeat without asking again
* **Deny** — the agent is told no and must work around it

Approval is per task and never persists to another one.

---

## Acceptance runs

Five end-to-end runs against a live server and a live gateway
(`acceptance.mjs A`…`E`):

| | Scenario | Result |
|---|---|---|
| **A** | Build a static app from scratch, verify it, download a ZIP | 3 files in `styles/` and `scripts/`, preview started, desktop + mobile screenshots analysed, smoke test passed, valid ZIP — **172s** |
| **B** | Fix a broken imported project (wrong CSS path, mismatched element ids) | both root causes found by opening it in a browser, 3 button clicks to confirm the fix, smoke test passed — **115s** |
| **C** | Detect and fix a deliberate visual defect (1400px overflow, `#f0f0f0` on white) | both found by `audit_page` at desktop and mobile, CSS fixed, re-audit clean, smoke test passed — **181s** |
| **D** | Approval flow for `npm install ms` | approval requested and reported as `REQUIRES_APPROVAL`, answered, install succeeded, program ran — **67s** |
| **E** | Recover from a genuinely failing build | build failed (exit 1), root cause read from the error, missing file created, build and tests then passed — **55s** |
