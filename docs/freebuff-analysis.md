# Freebuff analysis

A reverse-engineering study of `Freebuff-0.0.55-win-x64.exe`, done to find
engineering worth bringing into PixGPT. The original installer was copied to a
scratch directory and never modified.

Four things were ported. Several more were examined and deliberately left alone,
in most cases because PixGPT's existing implementation is stronger.

---

## What Freebuff is

| | |
|---|---|
| Installer | NSIS, 119 MB, PE32 x86 stub with an LZMA payload |
| Application | Electron |
| Runtime | bundled **Bun** (`resources/bun/bun.exe`, 98 MB) |
| Backend | `resources/orchestrator/orchestrator.js` — 8.6 MB, 134,835 lines, Bun-bundled |
| Frontend | `resources/orchestrator/ui/` |
| Native | bundled **ripgrep**, tree-sitter tag queries for 9 languages |
| Publisher | James Grugett · updates from `freebuff.com/api/desktop/updates/` |
| Install path | `%LOCALAPPDATA%\Programs\@codebufffreebuff-desktop` |

The npm scope in the install path and the module tree identify it as a
**Codebuff** derivative. It was already installed on this machine, so the
analysis used the real application files rather than unpacking the installer.

The bundler left its module comments intact, which recovers the original source
tree — **231 modules**:

```
packages/agent-runtime/     the agent loop, tool executor, stream parser, compaction
packages/code-map/          tree-sitter repository indexing
packages/llm-providers/     an OpenAI-compatible client
sdk/                        tools, ripgrep, SSRF, run state
common/src/tools/params/    ~40 tool parameter schemas
```

### Its tool set

`read_files` `write_file` `str_replace` `apply_patch` `run_terminal_command`
`code_search` `find_files` `glob` `list_directory` `read_docs` `read_url`
`web_search` `spawn_agents` `spawn_agent_inline` `think_deeply` `create_plan`
`add_subgoal` `update_subgoal` `write_todos` `browser_logs` `end_turn`
`set_output` `run_file_change_hooks` `lookup_agent_info` plus Composio and MCP
bridges.

### Its models

Freebuff routes to a provider-prefixed catalogue: `anthropic/claude-opus-5`,
`anthropic/claude-fable-5`, `openai/gpt-5.6-luna`, `deepseek/deepseek-v4-pro-max`,
`google/gemini-3.1-pro-preview`, `z-ai/glm-5.2`, `moonshotai/kimi-k2.7-code`,
`minimax/minimax-m3`, `x-ai/grok-4-07-09`, and others.

Its model cards carry metadata PixGPT does not model: `tagline` ("Smartest",
"Balanced"), `reasoningEffort` with an `efforts` ladder
(`minimal|low|medium|high|xhigh|max`), `dataUse` (`training` vs `service`) with a
user-facing warning, `premium`, `multimodal`, `supersededBy` (a pointer to a
replacement model with a notice and an action label), and explicit context
windows — up to 1,048,576 tokens for the DeepSeek V4 line.

**These are OpenRouter model ids.** `sdk/src/impl/model-provider.ts` builds
exactly one adapter — `provider: 'codebuff'`, pointed at
`freebuff.com/api/v1` — and `BYOK_OPENROUTER_HEADER = 'x-openrouter-api-key'`
gives it away: Freebuff is a proxy in front of OpenRouter, and its ids pass
straight through. Verified rather than assumed — `anthropic/claude-opus-4.1`
resolves on OpenRouter with the same 200k window Freebuff records, as do
`openai/gpt-5.1` (400k) and `google/gemini-2.5-pro` (1,048,576).

So the useful integration was the upstream itself. PixGPT gained an
`openrouter` adapter and a `freebuff` adapter, both into the existing gateway
registry, plus multi-gateway discovery so one ranking spans them. See
[models.md](./models.md).

---

## Full source extraction

The installer is NSIS, but `resources/app.asar` proved to contain **readable
TypeScript source**, not just the Bun-bundled `orchestrator.js`. Unpacking it
(ASAR is a trivial header + JSON directory + concatenated payloads) yields 147
files, 26.6 MB, including the complete `@codebuff/sdk` source and its test
suite:

```
node_modules/@codebuff/sdk/src/     run.ts, run-state.ts, impl/llm.ts,
                                    tools/{apply-patch,code-search,ssrf,...}.ts
node_modules/@codebuff/sdk/src/__tests__/   40 test files
electron/                           main.cjs, cdp-bridge.cjs, updater.cjs
```

Its `package.json` is also revealing: it depends on
`@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `ai@7`, `zod@4`,
`zustand@5` and `@xterm/xterm` — an Electron shell around several vendor agent
SDKs, not a single bespoke agent.

---

## What was ported

### 1. Code map — a ranked symbol index

**The strongest idea in the application, and PixGPT's clearest gap.**

Freebuff parses every source file with tree-sitter, extracts definitions and
call sites, and ranks them. The agent receives a map of what the repository
*contains*, not just a list of filenames.

The ranking, recovered from `packages/code-map/src/parse.ts`:

```
base  = 0.8^depth · sqrt(lines / (symbols + 1))
score = base · (1 + ln(1 + externalCallers))
```

Each term earns its place:

* `0.8^depth` — entry points outrank helpers buried six directories down.
* `sqrt(lines / (symbols+1))` — a 400-line file with three exports has three
  significant symbols; a barrel file with eighty re-exports has eighty trivial
  ones. It measures density, not count.
* `1 + ln(1 + callers)` — a function called from twelve files is load-bearing.
  Logarithmic, so a popular utility does not drown out everything else.

PixGPT's implementation is [server/agent/codemap.mjs](../server/agent/codemap.mjs).
The **algorithm is Freebuff's; the extraction is not**. Tree-sitter means a
native build per language — nine grammars, a large amount of build surface for a
list that only has to be roughly in the right order. PixGPT uses per-language
regex over declaration forms, covering JavaScript, TypeScript, Python, Go, Rust,
Java, Kotlin, C#, Ruby, C, C++ and PHP. That is wrong at the margins and
adequate for ranking.

Measured on PixGPT's own repository: **147 files, 1,172 symbols, 98 ms**.
`getGateway` is correctly located in `server/gateway/index.mjs` with its 12 real
callers found.

It also brought a rendering idea worth as much as the ranking: **fit the map to
a token budget by degrading in a defined order** rather than truncating
arbitrarily — full → fewer symbols → symbol-bearing files only → top files →
minimal. On this repository the ladder produces 3,466 tokens at a 4,000 budget
and 303 at 600.

Two ways in:

* Automatically, in the agent's system prompt, when the project already has
  files. A new project has nothing to map and gets no section.
* On demand, through a new `find_symbol` tool — *where is this defined, and
  which files call it*. The caller list answers "what breaks if I change this"
  before the edit rather than after the test run.

The map is cached per project and invalidated on every write, edit, rename or
delete. A map that omits the file just created is worse than no map.

### 2. Tolerant edit matching

`tools/apply-patch.ts` locates a patch's context in **tiers** rather than
demanding an exact hit:

```
exact  →  trailing whitespace ignored  →  all whitespace ignored
fuzz 0        fuzz 1                        fuzz 100
```

PixGPT's `edit_file` required an exact, unique substring. That is correct and
brittle: the model reproduces a snippet from a file it read three tool calls
ago, gets one space or one CRLF wrong, and the edit fails — costing a re-read
and a retry, and sometimes ending in it rewriting the whole file instead.

[server/agent/fuzzy-edit.mjs](../server/agent/fuzzy-edit.mjs) now matches in
four tiers: exact → line endings → trailing whitespace → indentation. Two rules
keep looseness from becoming damage:

* **Ambiguity is refused at every tier.** Matching three places loosely is not
  permission to pick one.
* **Indentation is scaled, not shifted.** A model writing 2-space indentation
  into a 4-space file nests by 2 per level; shifting every line by the +2
  difference leaves a method body at 6 spaces where the file wants 8. Scaling by
  level puts it at 8. Mixed tabs and spaces degrade conservatively rather than
  guessing.

A failed match now names the closest lines in the file, because "not found" is
unactionable and the mismatch is nearly always one line of the block.

Verified live: all four tiers matched, indentation survived, and both safety
rules held.

### 3. Transcript compaction that keeps verdicts

Freebuff's `compact-history.ts` and `simplify-tool-results.ts` do something
PixGPT did not: when context runs short they **simplify old tool results in
place** instead of dropping messages, replacing terminal output with
`stdoutOmittedForLength: true` while keeping the command and its exit code.

PixGPT previously kept the system prompt and the last forty messages. That is
cheap and it loses the wrong thing — the record that `npm test` was run at
iteration 3 and failed, which is exactly what stops the agent running it again
at iteration 30 and being equally surprised.

[server/agent/transcript.mjs](../server/agent/transcript.mjs) now degrades in
four stages:

1. simplify old tool results — keep `ok`, `command`, `exitCode`, `error`, `path`
2. simplify recent ones too
3. drop the oldest exchanges
4. hard floor

**Simplifying always precedes dropping.** Losing an old command's output costs
detail; losing the message costs the knowledge that the command was ever run. A
result compacted to `{command, exitCode, ok, outputOmitted: true}` costs about
thirty tokens instead of two thousand and still answers "has this been tried".

Dropping an assistant message also drops its tool results, and
`dropOrphanToolMessages` sweeps up anything missed — an orphaned `tool` message
whose `tool_call_id` has no matching call makes the provider reject the entire
request, turning a context problem into a failed one.

---

## What was deliberately not ported

### Terminal — PixGPT's is safer

Freebuff runs a **real shell**. `sdk/src/tools/windows-bash.ts` hunts for a Git
bash across Program Files, Scoop and the PATH, then executes command strings
through it.

PixGPT runs `shell: false`, passes program and arguments separately, classifies
every command into `SAFE` / `LOW_RISK` / `REQUIRES_APPROVAL` / `BLOCKED`, scrubs
the child environment, and confines the working directory. That is a stronger
model and it stays.

One caveat, found in PixGPT's own audit and unchanged by this work: `node -e`
classifies as `SAFE`, so an agent can still reach arbitrary code execution
through it. PixGPT's design is better; this specific hole is real and open in
both products.

### Model catalogue — not reachable

Freebuff's models sit behind its own authenticated endpoint. Integrating them
would mean borrowing credentials. PixGPT keeps OmniRoute.

The **metadata schema** is worth adopting later — `reasoningEffort`, `dataUse`,
`supersededBy` and explicit context windows are all things PixGPT's registry
would benefit from — but that is a model-registry change, not a port, and it was
out of scope for this pass.

### Multi-agent — PixGPT has no equivalent to improve

`spawn_agents` / `spawn_agent_inline` run genuine sub-agents with their own
templates. PixGPT has one agent loop. Porting sub-agents means a task tree, an
output protocol and a budget model — a subsystem, not a pattern, and section 8
of the brief says not to duplicate whole subsystems blindly.

### Web research — PixGPT's is stronger

Freebuff has `web_search` and `read_url` with an SSRF guard. PixGPT has nine
providers, an orchestrator with intent classification and reranking, a controlled
page reader, circuit breaking, caching, deep research with conflict detection and
citation validation. Nothing to take.

### Composio and MCP

Freebuff bridges to Composio for third-party tools and ships an MCP client.
Adopting either means arbitrary external tools, which PixGPT's skills platform
would have to gate with schema validation, permissions, sandboxing, approval and
timeouts. Worth doing properly one day; not worth doing quickly.

---

## Comparison

| Area | Freebuff | PixGPT | Action |
|---|---|---|---|
| Repository indexing | tree-sitter, ranked | **none** | **ported** (regex extraction, same ranking) |
| Symbol lookup | via code map | **none** | **ported** as `find_symbol` |
| Context compaction | simplify in place | drop oldest 40 | **ported** |
| Prompt budget | budgeted, degrading | unbounded tree | **ported** |
| Terminal | real shell | `shell:false` + classification | keep PixGPT |
| Web research | 2 tools | 9 providers + orchestrator | keep PixGPT |
| Browser QA | console logs only | full automation + WCAG audit | keep PixGPT |
| Model registry | rich static metadata | live verification + health | keep PixGPT |
| Model access | own authenticated pool | OmniRoute | keep PixGPT |
| Multi-agent | real sub-agents | single loop | not ported |
| MCP / Composio | present | absent | not ported |
| Documents | none found | PDF/DOCX/PPTX + Q&A | PixGPT ahead |
| Image/video | none found | full architecture | PixGPT ahead |
| Skills | prompt profiles | 117-skill platform | PixGPT ahead |

---

## Verification

Ported code is covered by 42 new tests:

* `tests/codemap.test.mjs` — 25 tests: extraction across languages, the three
  ranking properties, caller accuracy, budget degradation, cache invalidation
  after a write, empty and malformed projects
* `tests/transcript.test.mjs` — 17 tests: verdict survival, stage ordering,
  orphan prevention, convergence at every budget
* `tests/fuzzy-edit.test.mjs` — 19 tests: each tier, ambiguity refusal at every
  tier, indentation scaling, blank-line preservation, mixed tabs/spaces
* `tests/providers.test.mjs` — 30 tests: adapter shape, auth headers, BYOK,
  gateway opt-in, key-leak assertions, metadata join, probe-beats-provider-claim

Live, against a running server:

* the code map builds for an imported project and reaches the system prompt
* it is omitted for an empty project
* `formatMoney` is located with both of its callers correctly identified
* an agent run used `find_symbol` unprompted and reported the result
* full regression: 698 unit tests, 203 live checks, 0 failures

---

## Sources

`resources/orchestrator/orchestrator.js` (bundled, module comments intact),
`resources/orchestrator/tree-sitter-*.scm`, `resources/app-update.yml`, and the
PE/NSIS structure of the installer. No credentials, tokens or user data were
read, extracted or logged. Freebuff's own files were not modified.
