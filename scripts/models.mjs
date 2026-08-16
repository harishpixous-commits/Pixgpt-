#!/usr/bin/env node
import { getGateway } from '../server/gateway/index.mjs'
import {
  persist,
  discover,
  registryState,
  allModels,
  describeModel,
  summary,
  bestModels,
  allHealth,
  probe,
  ranking,
  installModelRouting,
  selectModels,
} from '../server/models/index.mjs'

/* ============================================================
   npm run models:<command>            (section 41)

     list        the normalised catalogue, grouped by provider
     health      per-route health and verification
     probe       spend real requests to verify candidates
     benchmark   run the task benchmarks against top candidates
     refresh     re-read the catalogue and report what changed
     select      show what would be chosen for a prompt, and why

   `probe` and `benchmark` are the only commands that cost anything.
   Both print what they are about to spend before they spend it, and
   both cap how many models they touch.
   ============================================================ */

const [, , command = 'list', ...rest] = process.argv
const flags = Object.fromEntries(
  rest
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, v] = a.slice(2).split('=')
      return [k, v ?? true]
    }),
)
const positional = rest.filter((a) => !a.startsWith('--'))

const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n)
const dim = (s) => `[2m${s}[0m`
const bold = (s) => `[1m${s}[0m`
const green = (s) => `[32m${s}[0m`
const yellow = (s) => `[33m${s}[0m`
const red = (s) => `[31m${s}[0m`

function tint(verification) {
  if (verification === 'LIVE_VERIFIED') return green(verification)
  if (verification === 'CATALOGUED' || verification === 'UNKNOWN') return dim(verification)
  if (verification === 'RATE_LIMITED' || verification === 'UNHEALTHY') return yellow(verification)
  return red(verification)
}

async function load() {
  installModelRouting()
  const result = await discover({ force: true })
  if (result.error) {
    console.error(red(`\nCould not read the catalogue: ${result.error.message}`))
    console.error(dim('Aliases and configured fallbacks are still registered.\n'))
  }
  return result
}

/* ---------- commands ---------- */

async function list() {
  await load()
  const s = summary()
  const tiers = ranking.qualityTiers()

  console.log(`\n${bold('PixGPT model registry')}  ${dim(`gateway=${registryState().gateway}`)}`)
  console.log(
    `${s.total} models · ${green(`${s.verified} verified`)} · ${s.probed} probed · ` +
      `${Object.entries(s.byProvider).length} providers\n`,
  )

  const filter = flags.provider ?? null
  const byProvider = new Map()
  for (const m of allModels()) {
    if (filter && m.provider !== filter) continue
    if (!byProvider.has(m.provider)) byProvider.set(m.provider, [])
    byProvider.get(m.provider).push(m)
  }

  for (const [provider, models] of [...byProvider].sort((a, b) => b[1].length - a[1].length)) {
    console.log(bold(`${models[0].providerLabel}  ${dim(`(${models.length})`)}`))
    for (const m of models.sort((a, b) => a.id.localeCompare(b.id))) {
      const tier = tiers.get(m.id)
      console.log(
        `  ${pad(m.id, 34)} ${pad(tier ?? '', 10)} ${pad(m.categories.slice(0, 3).join(','), 34)} ${tint(m.verification)}`,
      )
    }
    console.log()
  }

  console.log(bold('Best by task'))
  for (const [task, entry] of Object.entries(bestModels())) {
    console.log(`  ${pad(task.replace(/^BEST_/, ''), 16)} ${entry ? `${pad(entry.id, 30)} ${dim(`score ${entry.score}`)}` : dim('none qualifies')}`)
  }
  console.log()
}

async function health() {
  await load()
  const routes = allHealth()
  const entries = Object.entries(routes)

  console.log(`\n${bold('Route health')}`)
  if (entries.length === 0) {
    console.log(dim('\nNo route has been tried yet. Health is measured, not assumed —'))
    console.log(dim('run `npm run models:probe` or send a chat request to populate it.\n'))
    return
  }

  console.log(`${pad('model', 34)} ${pad('state', 13)} ${pad('ok/fail', 9)} ${pad('latency', 9)} last failure`)
  console.log(dim('─'.repeat(96)))
  for (const [id, h] of entries.sort((a, b) => b[1].successCount - a[1].successCount)) {
    const colour = h.state === 'healthy' ? green : h.state === 'degraded' ? yellow : h.state === 'unknown' ? dim : red
    console.log(
      `${pad(id, 34)} ${colour(pad(h.state, 13))} ${pad(`${h.successCount}/${h.failureCount}`, 9)} ` +
        `${pad(h.latencyMs ? `${h.latencyMs}ms` : '—', 9)} ${h.lastFailureKind ?? dim('—')}` +
        `${h.cooldownMs > 0 ? yellow(`  cooling ${Math.round(h.cooldownMs / 1000)}s`) : ''}`,
    )
  }
  console.log()
}

async function runProbe() {
  await load()

  const probes = flags.probe ? String(flags.probe).split(',') : ['chat']

  /*
   * Three ways to choose what gets probed:
   *
   *   (nothing)            the routes that decide real requests — configured
   *                        aliases plus the top of each ranking
   *   --provider=<pool>    every model in one pool, for diagnosing that pool
   *   --all                the entire catalogue
   *
   * The default stays small on purpose: probing 116 models costs 116 real
   * requests against someone's quota, and most of them will never be chosen.
   */
  let candidates
  let why = 'default candidates'

  if (positional.length > 0) {
    candidates = positional
    why = 'named on the command line'
  } else if (flags.provider) {
    const pool = String(flags.provider)
    candidates = allModels()
      .filter((m) => m.provider === pool || m.providerLabel.toLowerCase().includes(pool.toLowerCase()))
      .map((m) => m.id)
    why = `every model in the "${pool}" pool`
    if (candidates.length === 0) {
      const pools = [...new Set(allModels().map((m) => m.provider))].sort()
      console.error(red(`No models in pool "${pool}". Available: ${pools.join(', ')}`))
      process.exit(1)
    }
  } else if (flags.all) {
    candidates = allModels().map((m) => m.id)
    why = 'the entire catalogue'
  } else {
    candidates = probe.probeCandidates({ perTask: Number(flags.per ?? 2) }).map((c) => c.id)
  }

  for (const p of probes) {
    if (!probe.PROBE_IDS.includes(p)) {
      console.error(red(`Unknown probe "${p}". Available: ${probe.PROBE_IDS.join(', ')}`))
      process.exit(1)
    }
  }

  /*
   * A deliberate `--all` or `--provider=` run may exceed the default cap. The
   * cap exists to stop an accidental 400-request probe, not to stop a
   * diagnostic that was asked for explicitly.
   */
  const cap = flags.all || flags.provider ? candidates.length : probe.PROBE_LIMITS.maxModels
  const capped = Math.min(candidates.length, cap)
  console.log(`\n${bold('Probing')} ${capped} model(s) × ${probes.length} probe(s) = ${capped * probes.length} request(s)`)
  console.log(dim(`${why} · max ${probe.PROBE_LIMITS.maxTokens} tokens each, ${probe.PROBE_LIMITS.concurrency} at a time\n`))

  if (positional.length === 0 && !flags.provider && !flags.all) {
    for (const c of probe.probeCandidates({ perTask: Number(flags.per ?? 2) }).slice(0, capped)) {
      console.log(dim(`  ${pad(c.id, 34)} ${c.why}`))
    }
    console.log()
  }

  const started = Date.now()
  const outcome = await probe.probeModels(candidates, {
    limit: cap,
    probes,
    onResult: (r) => {
      const mark = r.skipped ? dim('skip') : r.ok ? green(' ok ') : red('fail')
      console.log(`  [${mark}] ${pad(r.model, 34)} ${pad(r.probe, 12)} ${pad(`${r.ms}ms`, 8)} ${r.reason ?? r.detail ?? ''}`)
    },
  })

  console.log(
    `\n${bold('Result')}  ${green(`${outcome.results.filter((r) => r.ok).length} passed`)}, ` +
      `${red(`${outcome.results.filter((r) => !r.ok && !r.skipped).length} failed`)}, ` +
      `${outcome.results.filter((r) => r.skipped).length} skipped in ${Math.round((Date.now() - started) / 1000)}s`,
  )
  if (outcome.note) console.log(yellow(outcome.note))
  console.log()

  await health()
}

async function benchmark() {
  await load()
  const probes = ['reasoning', 'coding', 'structured']
  const candidates = positional.length > 0 ? positional : probe.probeCandidates({ perTask: 1 }).map((c) => c.id).slice(0, 8)

  console.log(`\n${bold('Benchmarking')} ${candidates.length} model(s) on ${probes.join(', ')}\n`)

  const grid = new Map()
  await probe.probeModels(candidates, {
    probes,
    onResult: (r) => {
      if (!grid.has(r.model)) grid.set(r.model, {})
      grid.get(r.model)[r.probe] = r
      console.log(`  [${r.ok ? green(' ok ') : r.skipped ? dim('skip') : red('fail')}] ${pad(r.model, 34)} ${pad(r.probe, 12)} ${r.detail ?? r.reason ?? ''}`)
    },
  })

  console.log(`\n${pad('model', 34)} ${probes.map((p) => pad(p, 12)).join('')}`)
  console.log(dim('─'.repeat(74)))
  for (const [model, results] of grid) {
    console.log(
      `${pad(model, 34)} ${probes.map((p) => pad(results[p]?.ok ? green('pass') : results[p]?.skipped ? dim('skip') : red('fail'), 21)).join('')}`,
    )
  }
  console.log(dim('\nThese are cheap sanity checks, not a capability benchmark suite.\n'))
}

async function refresh() {
  const before = registryState().total
  const result = await load()
  console.log(`\n${bold('Catalogue refreshed')}`)
  console.log(`  total     ${result.total}${before ? dim(` (was ${before})`) : ''}`)
  if (result.added?.length) console.log(green(`  added     ${result.added.join(', ')}`))
  if (result.removed?.length) console.log(yellow(`  removed   ${result.removed.join(', ')}`))
  if (result.duplicates?.length) console.log(yellow(`  duplicate ${result.duplicates.join(', ')}`))
  if (!result.added?.length && !result.removed?.length) console.log(dim('  no changes'))
  console.log()
}

async function select() {
  await load()
  const text = positional.join(' ')
  if (!text) {
    console.error('Usage: npm run models:select -- "your prompt here" [--mode=build] [--images]')
    process.exit(1)
  }

  const context = { text, mode: flags.mode, hasImages: Boolean(flags.images), requiresVision: Boolean(flags.images) }
  const result = selectModels(flags.model ?? undefined, context)

  console.log(`\n${bold('Prompt')}  ${dim(text.slice(0, 100))}`)
  console.log(`${bold('Task')}    ${result.taskLabel}  ${dim(`(${result.reason})`)}`)
  console.log(`${bold('Chain')}`)
  result.chain.forEach((id, i) => console.log(`  ${i + 1}. ${pad(id, 34)} ${i === 0 ? bold('primary') : dim('fallback')}`))
  console.log(`\n${bold('Why')}     ${result.why}`)

  const reasons = result.entries?.[0]?.reasons ?? []
  if (reasons.length > 0) {
    console.log(`\n${bold('Score breakdown')}`)
    for (const r of reasons) {
      const sign = r.points > 0 ? green(`+${r.points}`) : red(String(r.points))
      console.log(`  ${pad(sign, 16)} ${r.label}`)
    }
  }
  console.log()
}

async function detail() {
  await load()
  const id = positional[0]
  if (!id) {
    console.error('Usage: npm run models:list -- --detail <model-id>')
    process.exit(1)
  }
  const model = describeModel(id)
  if (!model) {
    console.error(red(`No such model: ${id}`))
    process.exit(1)
  }
  console.log(`\n${bold(model.displayName)}  ${dim(model.id)}`)
  console.log(JSON.stringify(model, null, 2))
  console.log()
}

/* ---------- dispatch ---------- */

const COMMANDS = { list, health, probe: runProbe, benchmark, refresh, select, detail }

const run = COMMANDS[command]
if (!run) {
  console.error(`Unknown command "${command}". Available: ${Object.keys(COMMANDS).join(', ')}`)
  process.exit(1)
}

try {
  await run()
  /*
   * Flush before exiting. Saves are debounced by 30s so a chat request never
   * waits on disk, but `process.exit` kills the pending timer — a probe run
   * that did not flush would throw away everything it just learned, which is
   * precisely what happened the first time this ran.
   */
  persist({ immediate: true })
  // The gateway keeps no persistent sockets, but a pending health timer can
  // hold the loop open for a few seconds; nothing here needs to linger.
  process.exit(0)
} catch (error) {
  console.error(red(`\n${error?.message ?? error}\n`))
  process.exit(1)
}

// Referenced so the gateway is constructed eagerly and configuration problems
// surface before a command starts printing results.
void getGateway
