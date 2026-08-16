import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Boxes, ChevronRight, Loader2, RefreshCw, Search, Star, X } from 'lucide-react'
import {
  HEALTH_LABEL,
  TIER_LABEL,
  VERIFICATION_LABEL,
  VERIFICATION_TONE,
  fetchModelDetail,
  fetchRecommended,
  fetchRegistry,
  formatContext,
  formatLatency,
  refreshModels,
  MissingRouteError,
  type CatalogueModel,
  type ModelDetail,
  type RankedModel,
  type Recommendations,
  type RegistrySummary,
} from '../../lib/modelcatalog'
import { Button, IconButton } from '../ui/Button'
import { useToast } from '../ui/Toast'
import { useFocusTrap } from '../../lib/hooks'
import { cn } from '../../lib/utils'

interface ModelsDialogProps {
  open: boolean
  onClose: () => void
  /** The current prompt, so "Recommended" reflects the task actually in hand. */
  contextText?: string
  mode?: string
  onPick?: (id: string) => void
  /** Starred models, so the picker can show and manage them. */
  favourites?: string[]
  onToggleFavourite?: (id: string) => void
  /** The model in use right now, marked so the list shows where you are. */
  selectedModel?: string
}

type Tab = 'recommended' | 'all'
type StatusFilter = 'all' | 'favourites' | 'live' | 'unverified' | 'unavailable'

/*
 * Three states, from the model's point of view rather than the registry's.
 *
 *   live         answered a real request and is answering now
 *   unavailable  tried and failed in a way that will not fix itself
 *   unverified   everything else — never tried, or tried and inconclusive
 *
 * `unverified` is the honest default. It is not a promise and not a verdict,
 * and lumping it in with either would misrepresent most of a catalogue.
 */
const isLive = (m: CatalogueModel) => m.verified && m.health === 'healthy'

/**
 * Failures that will not clear on their own: a missing binary, a rejected
 * credential, an exhausted quota, a model the gateway does not have. A rate
 * limit or a timeout is *not* here — those routes may well work in a minute.
 */
const TERMINAL = new Set(['invalid_key', 'invalid_model', 'quota', 'provider_blocked'])

const isUnavailable = (m: CatalogueModel) =>
  m.verification === 'UNAVAILABLE' ||
  m.health === 'invalid' ||
  m.health === 'unreachable' ||
  (!m.verified && TERMINAL.has(m.failureKind ?? ''))
const isUnverified = (m: CatalogueModel) => !isLive(m) && !isUnavailable(m)

/** The mark shown beside a row. Deliberately the same glyphs as the filters. */
function statusMark(m: CatalogueModel): { glyph: string; tone: string; title: string } {
  if (isLive(m)) return { glyph: '✓', tone: 'ok', title: 'Live — a real request succeeded' }
  if (isUnavailable(m)) {
    return {
      glyph: '✕',
      tone: 'error',
      title: m.failureKind
        ? `Unavailable — ${m.failureKind.replace(/_/g, ' ')}${m.failureRemembered ? ' (from an earlier probe)' : ''}`
        : 'Unavailable — this route failed',
    }
  }
  return { glyph: '⚠', tone: 'muted', title: 'Not verified — no successful request yet' }
}

/**
 * The model browser.
 *
 * Section 26 in one screen: the catalogue is over a hundred entries, and a
 * hundred-row dropdown is not a choice, it is a shrug. The default view is five
 * short groups; the full list is one tab away for anyone who wants it.
 *
 * Every row states its verification. A model the gateway lists but that has
 * never answered reads "Not yet verified", never "available" — that distinction
 * is the entire point of the system behind this panel.
 */
export function ModelsDialog({
  open,
  onClose,
  contextText,
  mode,
  onPick,
  favourites = [],
  onToggleFavourite,
  selectedModel,
}: ModelsDialogProps) {
  const { push } = useToast()
  const reduceMotion = useReducedMotion()

  const [tab, setTab] = useState<Tab>('recommended')
  const [recommended, setRecommended] = useState<Recommendations | null>(null)
  const [models, setModels] = useState<CatalogueModel[]>([])
  const [summary, setSummary] = useState<RegistrySummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [query, setQuery] = useState('')
  const [provider, setProvider] = useState<string | null>(null)
  const [status, setStatus] = useState<StatusFilter>('all')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [detail, setDetail] = useState<Record<string, ModelDetail>>({})
  const [loadError, setLoadError] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useFocusTrap(open, panelRef)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const [recs, registry] = await Promise.all([
        fetchRecommended({ text: contextText, mode }),
        fetchRegistry(),
      ])
      setRecommended(recs)
      setModels(registry.models)
      setSummary(registry.summary)
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'The request failed.'
      /*
       * Kept in the panel as well as in a toast. A toast is gone in four
       * seconds and this is the state the user is still looking at — the whole
       * reason an empty list was previously indistinguishable from a bad search.
       */
      const stale = error instanceof MissingRouteError
      setLoadError(
        stale
          ? 'The PixGPT server is running an older build than this page, so it has no model registry. Restart the server (npm start) and reopen this panel.'
          : `Could not load the model catalogue: ${detail}`,
      )
      push({
        title: stale ? 'Server needs restarting' : 'Could not load the model catalogue',
        description: stale ? 'It is older than the page it is serving.' : detail,
        tone: 'error',
      })
    } finally {
      setLoading(false)
    }
  }, [contextText, mode, push])

  useEffect(() => {
    if (!open) {
      setQuery('')
      setProvider(null)
      setStatus('all')
      setExpanded(null)
      setTab('recommended')
      return
    }
    void load()
    const timer = setTimeout(() => searchRef.current?.focus(), 120)
    return () => clearTimeout(timer)
  }, [open, load])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  const onRefresh = async () => {
    setRefreshing(true)
    try {
      const result = await refreshModels()
      await load()
      const changed = result.added.length + result.removed.length
      push({
        title: changed > 0 ? 'Catalogue updated' : 'Catalogue unchanged',
        description:
          changed > 0
            ? `${result.added.length} added, ${result.removed.length} removed — ${result.total} models.`
            : `${result.total} models.`,
        tone: 'success',
      })
    } catch (error) {
      push({ title: 'Could not refresh', description: error instanceof Error ? error.message : undefined, tone: 'error' })
    } finally {
      setRefreshing(false)
    }
  }

  const onExpand = async (id: string) => {
    if (expanded === id) {
      setExpanded(null)
      return
    }
    setExpanded(id)
    if (detail[id]) return
    try {
      const { model } = await fetchModelDetail(id)
      setDetail((prev) => ({ ...prev, [id]: model }))
    } catch {
      /* the row still shows what the list already knows */
    }
  }

  /* Filtering is client-side: the list is ~120 rows and it keeps typing instant. */
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return models
      .filter((m) =>
        status === 'favourites'
          ? favourites.includes(m.id)
          : status === 'live'
            ? isLive(m)
            : status === 'unverified'
              ? isUnverified(m)
              : status === 'unavailable'
                ? isUnavailable(m)
                : true,
      )
      .filter((m) => (provider ? m.provider === provider : true))
      .filter((m) =>
        q
          ? m.id.toLowerCase().includes(q) ||
            m.displayName.toLowerCase().includes(q) ||
            m.family.toLowerCase().includes(q) ||
            m.categories.some((c) => c.toLowerCase().includes(q))
          : true,
      )
  }, [models, query, provider, status, favourites])

  const providers = useMemo(() => {
    const counts = new Map<string, { label: string; count: number }>()
    for (const m of models) {
      const entry = counts.get(m.provider) ?? { label: m.providerLabel, count: 0 }
      entry.count++
      counts.set(m.provider, entry)
    }
    return [...counts.entries()].sort((a, b) => b[1].count - a[1].count)
  }, [models])

  const transition = reduceMotion ? { duration: 0 } : { type: 'spring' as const, stiffness: 320, damping: 30 }

  return (
    <AnimatePresence>
      {open && (
        <div className="dialog-root">
          <motion.div
            className="dialog-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.16 }}
            onClick={onClose}
          />
          <motion.div
            ref={panelRef}
            className="dialog models-dialog"
            role="dialog"
            tabIndex={-1}
            aria-modal="true"
            aria-labelledby="models-title"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 8 }}
            animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 8 }}
            transition={transition}
          >
            <header className="dialog-head">
              <div>
                <h2 id="models-title">
                  <Boxes size={17} aria-hidden="true" /> Models
                </h2>
                {/*
                  "116 models" is true and useless. The gap between catalogued
                  and working is the only interesting thing about a model list,
                  so it is stated here rather than left to be discovered.
                */}
                {summary ? (
                  <p className="models-subtitle">
                    {summary.counts
                      ? `${summary.counts.catalogued} catalogued · ${summary.counts.authenticated} reachable · ${summary.counts.liveVerified} verified · ${summary.counts.healthy} healthy`
                      : `${summary.total} in the catalogue · ${summary.verified} verified`}
                  </p>
                ) : null}
              </div>
              <IconButton aria-label="Close" onClick={onClose}>
                <X size={17} />
              </IconButton>
            </header>

            {/* Refresh sits beside the tablist, not inside it: a tablist may
                contain only tabs, and axe rightly flags a button in there. */}
            <div className="models-tabbar">
              <div className="models-tabs" role="tablist" aria-label="Model views">
                {(
                  [
                    ['recommended', 'Recommended'],
                    ['all', `All models${summary ? ` (${summary.total})` : ''}`],
                  ] as [Tab, string][]
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    id={`models-tab-${id}`}
                    aria-selected={tab === id}
                    aria-controls={`models-panel-${id}`}
                    className={cn('models-tab', tab === id && 'models-tab-active')}
                    onClick={() => setTab(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <Button variant="ghost" onClick={onRefresh} disabled={refreshing}>
                {refreshing ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
                Refresh
              </Button>
            </div>

            {tab === 'all' ? (
              <div className="models-controls">
                <div className="models-search">
                  <Search size={15} aria-hidden="true" />
                  <input
                    ref={searchRef}
                    type="search"
                    placeholder="Search models"
                    aria-label="Search models"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
                {/*
                  Status first, provider second. On this deployment 28 of 116
                  models work; "show me the ones that do" is the question people
                  actually arrive with, and scrolling a provider list to find
                  them is the wrong way to answer it.
                */}
                <div className="models-chips">
                  {(
                    [
                      ['all', 'All', models.length],
                      ['favourites', '★ Starred', models.filter((m) => favourites.includes(m.id)).length],
                      ['live', '✓ Live', models.filter(isLive).length],
                      ['unverified', '⚠ Unverified', models.filter(isUnverified).length],
                      ['unavailable', '✕ Unavailable', models.filter(isUnavailable).length],
                    ] as [StatusFilter, string, number][]
                  ).map(([id, label, count]) => (
                    <button
                      key={id}
                      type="button"
                      className={cn('models-chip', 'models-chip-status', status === id && 'models-chip-active')}
                      aria-pressed={status === id}
                      onClick={() => setStatus(id)}
                      disabled={count === 0 && id !== 'all'}
                    >
                      {label} <span className="models-chip-count">{count}</span>
                    </button>
                  ))}
                </div>

                <div className="models-chips">
                  <button
                    type="button"
                    className={cn('models-chip', provider === null && 'models-chip-active')}
                    aria-pressed={provider === null}
                    onClick={() => setProvider(null)}
                  >
                    All providers <span className="models-chip-count">{models.length}</span>
                  </button>
                  {providers.map(([id, { label, count }]) => (
                    <button
                      key={id}
                      type="button"
                      className={cn('models-chip', provider === id && 'models-chip-active')}
                      aria-pressed={provider === id}
                      onClick={() => setProvider(provider === id ? null : id)}
                    >
                      {label} <span className="models-chip-count">{count}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="models-body">
              {loading ? (
                <p className="models-loading">
                  <Loader2 size={16} className="spin" aria-hidden="true" /> Reading the catalogue…
                </p>
              ) : tab === 'recommended' ? (
                <div
                  id="models-panel-recommended"
                  role="tabpanel"
                  aria-labelledby="models-tab-recommended"
                  className="models-panel"
                  /* The panel scrolls, and in this tab its rows hold no
                     focusable elements — without this a keyboard user cannot
                     scroll it at all. */
                  tabIndex={0}
                >
                  {loadError ? (
                    <p className="models-empty">{loadError}</p>
                  ) : recommended ? (
                    <>
                      <p className="models-task">
                        Classified as <strong>{recommended.taskLabel}</strong>{' '}
                        <span className="models-task-reason">({recommended.reason})</span>
                      </p>
                      {recommended.groups.map((group) => (
                        <section key={group.key} className="models-group">
                          <h3 className="models-group-title">{group.label}</h3>
                          {group.note ? <p className="models-group-note">{group.note}</p> : null}
                          {group.models.length === 0 && !group.note ? (
                            <p className="models-group-note">Nothing qualifies right now.</p>
                          ) : null}
                          <ul className="models-list">
                            {group.models.map((m) => (
                              <RankedRow key={`${group.key}:${m.id}`} model={m} onPick={onPick} />
                            ))}
                          </ul>
                        </section>
                      ))}
                    </>
                  ) : null}
                </div>
              ) : (
                <div
                  id="models-panel-all"
                  role="tabpanel"
                  aria-labelledby="models-tab-all"
                  className="models-panel"
                  tabIndex={0}
                >
                  {visible.length === 0 ? (
                    <p className="models-empty">
                      {/*
                        "No match" and "nothing loaded" look identical to a user
                        and mean completely different things. An empty catalogue
                        with no search active is a failed load — usually a server
                        running an older build than the page it is serving — and
                        saying "no match" sends people looking for a typo.
                      */}
                      {models.length === 0
                        ? loadError ?? 'No models could be loaded. Check that the PixGPT server is running the current build.'
                        : 'No model matches that search.'}
                    </p>
                  ) : (
                    <ul className="models-list">
                      {visible.map((m) => (
                        <CatalogueRow
                          key={m.id}
                          model={m}
                          expanded={expanded === m.id}
                          detail={detail[m.id]}
                          onExpand={() => onExpand(m.id)}
                          onPick={onPick}
                          reduceMotion={Boolean(reduceMotion)}
                          favourite={favourites.includes(m.id)}
                          onToggleFavourite={onToggleFavourite}
                          selected={selectedModel === m.id}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>

            <footer className="dialog-foot">
              <p className="models-note">
                A model in the catalogue has not been shown to work. “Verified” means a real request succeeded.
              </p>
              <Button onClick={onClose}>Done</Button>
            </footer>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}

/* ---------- rows ---------- */

function VerificationBadge({ model }: { model: { verification: keyof typeof VERIFICATION_LABEL } }) {
  const tone = VERIFICATION_TONE[model.verification]
  return (
    <span className={cn('model-verify', `model-verify-${tone}`)}>{VERIFICATION_LABEL[model.verification]}</span>
  )
}

function RankedRow({ model, onPick }: { model: RankedModel; onPick?: (id: string) => void }) {
  return (
    <li className={cn('model-row', model.star && 'model-row-star')}>
      <div className="model-main">
        <div className="model-name-row">
          {model.star ? <Star size={13} className="model-star" aria-label="Best for this" /> : null}
          <span className="model-name">{model.displayName}</span>
          <VerificationBadge model={model} />
          {model.free ? <span className="model-tag">Free</span> : null}
          {model.routing ? <span className="model-tag">Auto-routed</span> : null}
        </div>
        <p className="model-id">{model.id}</p>
        {model.why ? <p className="model-why">{model.why}</p> : null}
      </div>
      {onPick ? (
        <Button variant="ghost" onClick={() => onPick(model.id)}>
          Use
        </Button>
      ) : null}
    </li>
  )
}

function CatalogueRow({
  model,
  expanded,
  detail,
  onExpand,
  onPick,
  reduceMotion,
  favourite,
  onToggleFavourite,
  selected,
}: {
  model: CatalogueModel
  expanded: boolean
  detail?: ModelDetail
  onExpand: () => void
  onPick?: (id: string) => void
  reduceMotion: boolean
  favourite?: boolean
  onToggleFavourite?: (id: string) => void
  selected?: boolean
}) {
  return (
    <li className={cn('model-row', selected && 'model-row-selected')}>
      <div className="model-main">
        <div className="model-name-row">
          {/*
            A glyph, not just a badge. Scanning 116 rows for the working ones is
            a glance down one column; reading 116 badges is not.
          */}
          <span className={cn('model-mark', `model-mark-${statusMark(model).tone}`)} title={statusMark(model).title}>
            {statusMark(model).glyph}
          </span>
          <button type="button" className="model-name" aria-expanded={expanded} onClick={onExpand}>
            {model.displayName}
          </button>
          <VerificationBadge model={model} />
          {model.qualityTier ? <span className="model-tier">{TIER_LABEL[model.qualityTier]}</span> : null}
          {model.free ? <span className="model-tag">Free</span> : null}
          {!model.inCatalogue ? <span className="model-tag model-tag-warn">Not listed</span> : null}
          {selected ? <span className="model-tag model-tag-current">In use</span> : null}
        </div>
        <p className="model-id">{model.id}</p>

        <AnimatePresence initial={false}>
          {expanded ? (
            <motion.div
              className="model-detail"
              initial={reduceMotion ? false : { height: 0, opacity: 0 }}
              animate={reduceMotion ? {} : { height: 'auto', opacity: 1 }}
              exit={reduceMotion ? {} : { height: 0, opacity: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.18 }}
            >
              <dl className="model-facts">
                <dt>Provider</dt>
                <dd>{model.providerLabel}</dd>
                <dt>Categories</dt>
                <dd>{detail?.categoryLabels.join(', ') ?? model.categories.join(', ')}</dd>
                <dt>Health</dt>
                <dd>
                  {HEALTH_LABEL[model.health]}
                  {model.latency !== null ? ` · ${formatLatency(model.latency)} average` : ''}
                  {model.errorRate !== null ? ` · ${Math.round(model.errorRate * 100)}% recent errors` : ''}
                </dd>
                <dt>Context</dt>
                <dd>
                  {formatContext(model.context)}
                  {detail?.contextSource ? ` (${detail.contextSource === 'id' ? 'stated in the model id' : 'from published documentation'})` : ''}
                </dd>
                <dt>Cost tier</dt>
                <dd>{model.cost}</dd>
                {detail ? (
                  <>
                    <dt>Capabilities</dt>
                    <dd>
                      <ul className="model-caps">
                        {Object.entries(detail.capabilities).map(([name, cap]) => (
                          <li key={name} className={cap.value === true ? 'yes' : cap.value === false ? 'no' : 'unknown'}>
                            {name}
                            <em>
                              {cap.value === true
                                ? cap.source === 'probe'
                                  ? 'confirmed'
                                  : 'declared'
                                : cap.value === false
                                  ? 'not supported'
                                  : 'unverified'}
                            </em>
                          </li>
                        ))}
                      </ul>
                    </dd>
                    {detail.lastVerified ? (
                      <>
                        <dt>Last verified</dt>
                        <dd>
                          {new Date(detail.lastVerified).toLocaleString()}
                          {detail.verifiedBy ? ` · via ${detail.verifiedBy}` : ''}
                        </dd>
                      </>
                    ) : null}
                    {detail.probe?.reason ? (
                      <>
                        <dt>Last probe</dt>
                        <dd>failed — {detail.probe.reason}</dd>
                      </>
                    ) : null}
                    {Object.keys(detail.fallbackPositions).length > 0 ? (
                      <>
                        <dt>Fallback position</dt>
                        <dd>
                          {Object.entries(detail.fallbackPositions)
                            .map(([task, pos]) => `${task.replace(/^BEST_/, '').replace(/_/g, ' ').toLowerCase()} #${pos}`)
                            .join(', ')}
                        </dd>
                      </>
                    ) : null}
                    {detail.docNote ? (
                      <>
                        <dt>Documentation</dt>
                        <dd className="model-doc">{detail.docNote}</dd>
                      </>
                    ) : null}
                  </>
                ) : null}
              </dl>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      <div className="model-actions">
        {onToggleFavourite ? (
          <IconButton
            aria-label={favourite ? `Unstar ${model.displayName}` : `Star ${model.displayName}`}
            aria-pressed={favourite}
            className={cn('model-fav', favourite && 'model-fav-on')}
            onClick={() => onToggleFavourite(model.id)}
          >
            <Star size={15} fill={favourite ? 'currentColor' : 'none'} />
          </IconButton>
        ) : null}
        {onPick ? (
          <Button variant="ghost" onClick={() => onPick(model.id)} disabled={selected}>
            {selected ? 'In use' : 'Use'}
          </Button>
        ) : null}
        <IconButton aria-label={expanded ? `Hide details for ${model.displayName}` : `Show details for ${model.displayName}`} onClick={onExpand}>
          <ChevronRight size={16} className={expanded ? 'chev-open' : ''} />
        </IconButton>
      </div>
    </li>
  )
}
