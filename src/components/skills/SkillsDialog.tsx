import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import * as Icons from 'lucide-react'
import { Blocks, Loader2, Search, Star, X } from 'lucide-react'
import {
  STATUS_LABEL,
  STATUS_TONE,
  fetchSkills,
  favouriteSkill,
  isUsable,
  toggleSkill,
  updateSkillSettings,
  type Skill,
  type SkillSummary,
} from '../../lib/skills'
import { Button, IconButton } from '../ui/Button'
import { useToast } from '../ui/Toast'
import { useFocusTrap } from '../../lib/hooks'
import { cn } from '../../lib/utils'

interface SkillsDialogProps {
  open: boolean
  onClose: () => void
}

/** Resolves a lucide icon name from the server to a component. */
function SkillIcon({ name, size = 16 }: { name: string; size?: number }) {
  const Icon = (Icons as unknown as Record<string, typeof Blocks>)[name] ?? Blocks
  return <Icon size={size} aria-hidden="true" />
}

/**
 * The Skills panel.
 *
 * Its job is to be honest. A skill whose backend is missing shows what is
 * missing and what would fix it, and its toggle is disabled rather than present
 * and broken — a switch that does nothing is worse than no switch.
 */
export function SkillsDialog({ open, onClose }: SkillsDialogProps) {
  const { push } = useToast()
  const reduceMotion = useReducedMotion()

  const [skills, setSkills] = useState<Skill[]>([])
  const [summary, setSummary] = useState<SkillSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useFocusTrap(open, panelRef)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await fetchSkills()
      setSkills(result.skills)
      setSummary(result.summary)
    } catch (error) {
      push({
        title: 'Could not load skills',
        description: error instanceof Error ? error.message : undefined,
        tone: 'error',
      })
    } finally {
      setLoading(false)
    }
  }, [push])

  useEffect(() => {
    if (!open) {
      setQuery('')
      setCategory(null)
      setExpanded(null)
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

  /* Filtering happens client-side: the list is small and it keeps typing instant. */
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return skills
      .filter((skill) => (category ? skill.category === category : true))
      .filter((skill) =>
        q
          ? skill.name.toLowerCase().includes(q) ||
            skill.description.toLowerCase().includes(q) ||
            skill.categoryLabel.toLowerCase().includes(q) ||
            skill.id.toLowerCase().includes(q)
          : true,
      )
      .sort((a, b) => {
        // Favourites first, then usable, then by name
        if (a.favourite !== b.favourite) return a.favourite ? -1 : 1
        if (isUsable(a) !== isUsable(b)) return isUsable(a) ? -1 : 1
        return a.name.localeCompare(b.name)
      })
  }, [skills, query, category])

  const grouped = useMemo(() => {
    const map = new Map<string, Skill[]>()
    for (const skill of visible) {
      const list = map.get(skill.categoryLabel) ?? []
      list.push(skill)
      map.set(skill.categoryLabel, list)
    }
    return [...map.entries()]
  }, [visible])

  const onToggle = async (skill: Skill) => {
    setBusyId(skill.id)
    try {
      const updated = await toggleSkill(skill.id, !skill.enabled)
      setSkills((prev) => prev.map((s) => (s.id === updated.id ? updated : s)))
    } catch (error) {
      push({
        title: `Could not change ${skill.name}`,
        description: error instanceof Error ? error.message : undefined,
        tone: 'error',
      })
    } finally {
      setBusyId(null)
    }
  }

  const onFavourite = async (skill: Skill) => {
    try {
      const updated = await favouriteSkill(skill.id, !skill.favourite)
      setSkills((prev) => prev.map((s) => (s.id === updated.id ? updated : s)))
    } catch {
      /* a failed favourite is not worth interrupting for */
    }
  }

  const onSetting = async (skill: Skill, key: string, value: string | number | boolean) => {
    try {
      const updated = await updateSkillSettings(skill.id, { [key]: value })
      setSkills((prev) => prev.map((s) => (s.id === updated.id ? updated : s)))
    } catch (error) {
      push({ title: 'Could not save that setting', description: error instanceof Error ? error.message : undefined, tone: 'error' })
    }
  }

  const transition = reduceMotion ? { duration: 0 } : { type: 'spring' as const, stiffness: 420, damping: 34 }

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
            className="dialog skills-dialog"
            role="dialog"
            tabIndex={-1}
            aria-modal="true"
            aria-labelledby="skills-title"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 8 }}
            animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 8 }}
            transition={transition}
          >
            <header className="dialog-head">
              <div>
                <h2 id="skills-title">
                  <Blocks size={17} aria-hidden="true" /> Skills
                </h2>
                {summary ? (
                  <p className="skills-subtitle">
                    {summary.usable} of {summary.total} ready
                    {summary.requiresConfig > 0 ? ` · ${summary.requiresConfig} need setup` : ''}
                    {summary.comingSoon > 0 ? ` · ${summary.comingSoon} coming soon` : ''}
                  </p>
                ) : null}
              </div>
              <IconButton aria-label="Close" onClick={onClose}>
                <X size={17} />
              </IconButton>
            </header>

            <div className="skills-controls">
              <div className="skills-search">
                <Search size={15} aria-hidden="true" />
                <input
                  ref={searchRef}
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search skills"
                  aria-label="Search skills"
                />
              </div>
              <div className="skills-categories" role="group" aria-label="Filter by category">
                <button
                  type="button"
                  className={cn('skills-chip', category === null && 'skills-chip-active')}
                  aria-pressed={category === null}
                  onClick={() => setCategory(null)}
                >
                  All
                </button>
                {(summary?.categories ?? [])
                  .filter((c) => c.count > 0)
                  .map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className={cn('skills-chip', category === c.id && 'skills-chip-active')}
                      aria-pressed={category === c.id}
                      onClick={() => setCategory(category === c.id ? null : c.id)}
                    >
                      {c.label} <span className="skills-chip-count">{c.count}</span>
                    </button>
                  ))}
              </div>
            </div>

            <div className="skills-body">
              {loading ? (
                <p className="skills-loading" role="status">
                  <Loader2 size={16} className="spin" aria-hidden="true" /> Checking what is available…
                </p>
              ) : visible.length === 0 ? (
                <p className="skills-empty">No skill matches “{query}”.</p>
              ) : (
                grouped.map(([label, group]) => (
                  <section key={label} className="skills-group">
                    <h3 className="skills-group-title">{label}</h3>
                    <ul className="skills-list">
                      {group.map((skill) => {
                        const usable = isUsable(skill)
                        const isOpen = expanded === skill.id
                        return (
                          <li key={skill.id} className={cn('skill-row', !usable && 'skill-row-blocked')}>
                            <div className="skill-main">
                              <span className="skill-icon">
                                <SkillIcon name={skill.icon} />
                              </span>
                              <div className="skill-text">
                                <div className="skill-name-row">
                                  <button
                                    type="button"
                                    className="skill-name"
                                    aria-expanded={isOpen}
                                    onClick={() => setExpanded(isOpen ? null : skill.id)}
                                  >
                                    {skill.name}
                                  </button>
                                  <span className={cn('skill-status', `skill-status-${STATUS_TONE[skill.status]}`)}>
                                    {STATUS_LABEL[skill.status]}
                                  </span>
                                  {skill.unverified ? (
                                    <span className="skill-status skill-status-warn" title="Configured, but it has not answered yet">
                                      unverified
                                    </span>
                                  ) : null}
                                  {skill.permission === 'approval_required' ? (
                                    <span className="skill-status skill-status-muted">needs approval</span>
                                  ) : null}
                                  {skill.mandatory ? <span className="skill-status skill-status-muted">always on</span> : null}
                                </div>
                                <p className="skill-description">{skill.description}</p>
                                {!usable && skill.blockedBy.length > 0 ? (
                                  <p className="skill-blocked">{skill.blockedBy[0]}</p>
                                ) : null}
                              </div>
                            </div>

                            <div className="skill-actions">
                              <IconButton
                                aria-label={skill.favourite ? `Unfavourite ${skill.name}` : `Favourite ${skill.name}`}
                                aria-pressed={skill.favourite}
                                onClick={() => onFavourite(skill)}
                                className={cn('skill-fav', skill.favourite && 'skill-fav-on')}
                              >
                                <Star size={15} fill={skill.favourite ? 'currentColor' : 'none'} />
                              </IconButton>

                              {/*
                                A skill that cannot run gets no toggle at all. A switch that
                                silently does nothing teaches the user to distrust the panel.
                              */}
                              {skill.mandatory ? (
                                <span className="skill-locked" title="A security control; it cannot be switched off">
                                  Always on
                                </span>
                              ) : usable ? (
                                <button
                                  type="button"
                                  role="switch"
                                  aria-checked={skill.enabled}
                                  aria-label={`${skill.enabled ? 'Disable' : 'Enable'} ${skill.name}`}
                                  className={cn('skill-switch', skill.enabled && 'skill-switch-on')}
                                  disabled={busyId === skill.id}
                                  onClick={() => onToggle(skill)}
                                >
                                  <span className="skill-switch-thumb" />
                                </button>
                              ) : (
                                <span className="skill-unavailable">{STATUS_LABEL[skill.status]}</span>
                              )}
                            </div>

                            <AnimatePresence initial={false}>
                              {isOpen ? (
                                <motion.div
                                  className="skill-detail"
                                  initial={reduceMotion ? false : { height: 0, opacity: 0 }}
                                  animate={reduceMotion ? {} : { height: 'auto', opacity: 1 }}
                                  exit={reduceMotion ? {} : { height: 0, opacity: 0 }}
                                  transition={{ duration: reduceMotion ? 0 : 0.18 }}
                                >
                                  <dl className="skill-facts">
                                    <dt>Version</dt>
                                    <dd>
                                      {skill.version}
                                      {skill.license ? ` · ${skill.license}` : ''}
                                      {skill.source !== 'built-in' ? ` · ${skill.source}` : ''}
                                    </dd>

                                    {skill.requirements.length > 0 ? (
                                      <>
                                        <dt>Requires</dt>
                                        <dd>
                                          <ul className="skill-requirements">
                                            {skill.requirements.map((r) => (
                                              <li key={r.id} className={r.met ? 'met' : 'unmet'}>
                                                {r.detail}
                                                {r.fix ? <em> — {r.fix}</em> : null}
                                              </li>
                                            ))}
                                          </ul>
                                        </dd>
                                      </>
                                    ) : null}

                                    {skill.tools.length > 0 ? (
                                      <>
                                        <dt>Tools</dt>
                                        <dd>
                                          <code>{skill.tools.join(', ')}</code>
                                        </dd>
                                      </>
                                    ) : null}

                                    {skill.resources ? (
                                      <>
                                        <dt>Bundled data</dt>
                                        <dd>
                                          {skill.resources.files} files, {Math.round(skill.resources.totalBytes / 1024)} KB
                                        </dd>
                                      </>
                                    ) : null}

                                    {skill.telemetry ? (
                                      <>
                                        <dt>Used</dt>
                                        <dd>
                                          {skill.telemetry.uses} times
                                          {skill.telemetry.averageMs ? `, ~${skill.telemetry.averageMs}ms` : ''}
                                        </dd>
                                      </>
                                    ) : null}
                                  </dl>

                                  {skill.settings ? (
                                    <div className="skill-settings">
                                      {Object.entries(skill.settings).map(([key, spec]) => (
                                        <label key={key} className="skill-setting">
                                          <span>{spec.label}</span>
                                          {spec.type === 'select' ? (
                                            <select
                                              value={String(spec.value)}
                                              onChange={(e) => onSetting(skill, key, e.target.value)}
                                            >
                                              {(spec.options ?? []).map((option) => (
                                                <option key={option} value={option}>
                                                  {option}
                                                </option>
                                              ))}
                                            </select>
                                          ) : spec.type === 'number' ? (
                                            <input
                                              type="number"
                                              value={Number(spec.value)}
                                              min={spec.min}
                                              max={spec.max}
                                              onChange={(e) => onSetting(skill, key, Number(e.target.value))}
                                            />
                                          ) : (
                                            <input
                                              type="checkbox"
                                              checked={Boolean(spec.value)}
                                              onChange={(e) => onSetting(skill, key, e.target.checked)}
                                            />
                                          )}
                                        </label>
                                      ))}
                                    </div>
                                  ) : null}

                                  {skill.fixes.length > 0 ? (
                                    <p className="skill-fix">
                                      To enable this: {skill.fixes.join('; ')}.
                                    </p>
                                  ) : null}
                                </motion.div>
                              ) : null}
                            </AnimatePresence>
                          </li>
                        )
                      })}
                    </ul>
                  </section>
                ))
              )}
            </div>

            <footer className="dialog-actions doc-dialog-actions">
              <p className="skills-note">
                Skills activate automatically from what you ask. Turning one on here keeps it active.
              </p>
              <Button variant="primary" onClick={onClose}>
                Done
              </Button>
            </footer>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}
