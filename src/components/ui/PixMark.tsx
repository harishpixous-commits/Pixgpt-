/* ============================================================
   PixMark — the PixGPT app mark
   ------------------------------
   Derived from the Pixous / PixGPT logo motif: a swarm of dots
   sweeping in an open crescent, thick and deep-teal at the left,
   thinning to lime toward the upper right.

   Why an SVG and not the logo PNG: the supplied logo is a wide
   1758×895 lockup. Squeezing it into a square avatar box crops it
   to the middle of the wordmark, and it costs ~943 KB. This mark
   is a few hundred bytes, stays crisp at any size, and reads
   correctly on both the light and dark surfaces.
   ============================================================ */

interface Dot {
  cx: number
  cy: number
  r: number
}

const CENTER = 32

/** Concentric arcs, outer → inner. Each spans an open crescent (gap on the right). */
const ARCS = [
  { radius: 25.5, count: 15, dot: 3.15, from: 28, to: 332 },
  { radius: 19, count: 12, dot: 2.7, from: 41, to: 319 },
  { radius: 13, count: 9, dot: 2.2, from: 54, to: 306 },
  { radius: 7.2, count: 6, dot: 1.7, from: 68, to: 292 },
]

/** Computed once at module load — the mark is static. */
const DOTS: Dot[] = ARCS.flatMap(({ radius, count, dot, from, to }) =>
  Array.from({ length: count }, (_, i) => {
    const t = count === 1 ? 0.5 : i / (count - 1)
    const angle = ((from + (to - from) * t) * Math.PI) / 180
    // Taper toward both tips of the crescent, thickest at the left
    const taper = 0.42 + 0.58 * Math.sin(Math.PI * t)
    return {
      cx: CENTER + radius * Math.cos(angle),
      cy: CENTER - radius * Math.sin(angle),
      r: dot * taper,
    }
  }),
)

interface PixMarkProps {
  size?: number
  className?: string
  /** Decorative by default; pass a title to expose it to assistive tech. */
  title?: string
}

export function PixMark({ size = 32, className, title }: PixMarkProps) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={className}
      role={title ? 'img' : 'presentation'}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <defs>
        <linearGradient id="pixmark-swarm" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor="#14806c" />
          <stop offset="38%" stopColor="#1f9265" />
          <stop offset="66%" stopColor="#4aa851" />
          <stop offset="86%" stopColor="#8fce55" />
          <stop offset="100%" stopColor="#bce76f" />
        </linearGradient>
      </defs>
      <g fill="url(#pixmark-swarm)">
        {DOTS.map((d, i) => (
          <circle key={i} cx={d.cx.toFixed(2)} cy={d.cy.toFixed(2)} r={d.r.toFixed(2)} />
        ))}
      </g>
    </svg>
  )
}
