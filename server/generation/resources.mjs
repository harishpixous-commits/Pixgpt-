import { execFile } from 'node:child_process'
import { existsSync, statfsSync } from 'node:fs'
import { promisify } from 'node:util'
import { cpus, totalmem, freemem, platform, arch } from 'node:os'
import { log } from '../config.mjs'

/* ============================================================
   Generation resource detection
   -----------------------------
   Decides whether this machine can actually run a diffusion model
   locally, before anything tries to.

   The alternative is worse than useless: attempting SDXL on a laptop
   with integrated graphics does not fail fast, it swaps for twenty
   minutes and then dies. So the capability is measured once, cached,
   and reported honestly — including *why* it is unavailable, so the
   answer is actionable rather than a shrug.

   Nothing here downloads anything or installs anything.
   ============================================================ */

const run = promisify(execFile)

/** Rough VRAM needed to run a model class at a usable speed. */
export const VRAM_REQUIREMENTS = Object.freeze({
  'sd15': 4,
  'sdxl': 8,
  'sd3': 10,
  'flux-schnell': 12,
  'flux-dev': 24,
  'ltx-video': 12,
  'wan-1.3b': 8,
  'wan-14b': 24,
  'hunyuan-video': 45,
})

let cached = null

async function detectNvidia() {
  try {
    const { stdout } = await run('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'], {
      timeout: 8000,
      windowsHide: true,
    })
    const rows = stdout
      .trim()
      .split('\n')
      .map((line) => line.split(',').map((s) => s.trim()))
      .filter((parts) => parts.length >= 2)

    return rows.map(([name, memoryMb, driver]) => ({
      name,
      vendor: 'nvidia',
      vramGb: Math.round((Number(memoryMb) / 1024) * 10) / 10,
      driver,
      accelerator: 'cuda',
    }))
  } catch {
    return []
  }
}

/** Windows enumerates every adapter, including the integrated one. */
async function detectWindowsGpus() {
  if (platform() !== 'win32') return []
  try {
    const { stdout } = await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name + "|" + $_.AdapterRAM + "|" + $_.DriverVersion }',
      ],
      { timeout: 15_000, windowsHide: true },
    )

    return stdout
      .trim()
      .split('\n')
      .map((line) => line.split('|').map((s) => s.trim()))
      .filter((parts) => parts[0])
      .map(([name, ram, driver]) => {
        const bytes = Number(ram)
        const lower = name.toLowerCase()
        return {
          name,
          vendor: /nvidia|geforce|quadro|rtx|gtx/.test(lower)
            ? 'nvidia'
            : /amd|radeon/.test(lower)
              ? 'amd'
              : /intel|uhd|iris|arc/.test(lower)
                ? 'intel'
                : 'unknown',
          /*
           * Win32_VideoController reports a 32-bit AdapterRAM, so anything over
           * 4 GB is truncated and integrated graphics report a shared-memory
           * figure rather than dedicated VRAM. Treated as a floor, not a fact.
           */
          vramGb: Number.isFinite(bytes) && bytes > 0 ? Math.round((bytes / 1024 ** 3) * 10) / 10 : null,
          vramReliable: false,
          driver,
          accelerator: /nvidia|geforce|rtx|gtx/.test(lower) ? 'cuda' : /radeon|amd/.test(lower) ? 'rocm' : 'none',
        }
      })
  } catch {
    return []
  }
}

async function detectPython() {
  for (const executable of ['python', 'python3', 'py']) {
    try {
      const { stdout } = await run(executable, ['--version'], { timeout: 8000, windowsHide: true })
      const version = stdout.trim().replace(/^Python\s*/i, '')
      return { available: true, executable, version }
    } catch {
      /* try the next name */
    }
  }
  return { available: false, executable: null, version: null }
}

/** Is torch installed, and can it see an accelerator? */
async function detectTorch(pythonExecutable) {
  if (!pythonExecutable) return { available: false }
  try {
    const { stdout } = await run(
      pythonExecutable,
      [
        '-c',
        'import torch,json;' +
          'print(json.dumps({' +
          '"version":torch.__version__,' +
          '"cuda":torch.cuda.is_available(),' +
          '"mps":bool(getattr(torch.backends,"mps",None) and torch.backends.mps.is_available()),' +
          '"devices":torch.cuda.device_count() if torch.cuda.is_available() else 0,' +
          '"vram":round(torch.cuda.get_device_properties(0).total_memory/1024**3,1) if torch.cuda.is_available() else 0' +
          '}))',
      ],
      { timeout: 30_000, windowsHide: true },
    )
    return { available: true, ...JSON.parse(stdout.trim()) }
  } catch {
    return { available: false }
  }
}

async function detectDiskFreeGb(path) {
  try {
    const stats = statfsSync(path)
    return Math.round(((stats.bavail * stats.bsize) / 1024 ** 3) * 10) / 10
  } catch {
    return null
  }
}

/** Is a ComfyUI instance reachable? */
export async function detectComfyUI(url) {
  const base = String(url ?? process.env.COMFYUI_URL ?? '').replace(/\/+$/, '')
  if (!base) return { configured: false, reachable: false, url: null }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    const response = await fetch(`${base}/system_stats`, { signal: controller.signal })
    clearTimeout(timer)

    if (!response.ok) return { configured: true, reachable: false, url: base, reason: `http_${response.status}` }

    const stats = await response.json().catch(() => ({}))
    const device = stats?.devices?.[0] ?? null

    return {
      configured: true,
      reachable: true,
      url: base,
      version: stats?.system?.comfyui_version ?? null,
      python: stats?.system?.python_version ?? null,
      device: device
        ? {
            name: device.name,
            type: device.type,
            vramGb: device.vram_total ? Math.round((device.vram_total / 1024 ** 3) * 10) / 10 : null,
            vramFreeGb: device.vram_free ? Math.round((device.vram_free / 1024 ** 3) * 10) / 10 : null,
          }
        : null,
    }
  } catch (error) {
    return {
      configured: true,
      reachable: false,
      url: base,
      reason: error?.name === 'AbortError' ? 'timeout' : 'unreachable',
    }
  }
}

/**
 * Measures what this machine can do. Cached — hardware does not change between
 * requests, and shelling out to PowerShell on every call would be absurd.
 *
 * @param {{ refresh?: boolean }} [options]
 */
export async function detectResources({ refresh = false } = {}) {
  if (cached && !refresh) return cached

  const started = Date.now()
  const [nvidia, windowsGpus, python] = await Promise.all([detectNvidia(), detectWindowsGpus(), detectPython()])
  const torch = await detectTorch(python.executable)

  /*
   * nvidia-smi is authoritative when present: it reports real dedicated VRAM.
   * The Windows enumeration is a fallback and its VRAM figure cannot be trusted.
   */
  const gpus = nvidia.length > 0 ? nvidia : windowsGpus
  const best = [...gpus].sort((a, b) => (b.vramGb ?? 0) - (a.vramGb ?? 0))[0] ?? null

  const accelerated = Boolean(
    (torch.available && (torch.cuda || torch.mps)) || nvidia.length > 0 || best?.accelerator === 'cuda',
  )

  // Trust torch's figure over anything the OS reported
  const vramGb = torch.available && torch.vram > 0 ? torch.vram : (nvidia[0]?.vramGb ?? best?.vramGb ?? 0)

  const ramGb = Math.round((totalmem() / 1024 ** 3) * 10) / 10
  const diskFreeGb = await detectDiskFreeGb(process.cwd())

  /* --- the verdict --- */
  const reasons = []
  if (!accelerated) {
    reasons.push(
      best
        ? `no CUDA or ROCm accelerator (found ${best.name}, an integrated adapter)`
        : 'no GPU accelerator detected',
    )
  }
  if (!python.available) reasons.push('Python is not on PATH')
  else if (!torch.available) reasons.push('PyTorch is not installed')
  if (accelerated && vramGb > 0 && vramGb < VRAM_REQUIREMENTS.sd15) {
    reasons.push(`only ${vramGb} GB of VRAM; the smallest usable image model needs about ${VRAM_REQUIREMENTS.sd15} GB`)
  }

  const localGeneration = reasons.length === 0

  /** Which model classes this hardware could actually run. */
  const canRun = Object.fromEntries(
    Object.entries(VRAM_REQUIREMENTS).map(([model, needed]) => [model, localGeneration && vramGb >= needed]),
  )

  cached = {
    detectedAt: new Date().toISOString(),
    detectionMs: Date.now() - started,
    platform: platform(),
    arch: arch(),
    cpu: { model: cpus()[0]?.model ?? 'unknown', cores: cpus().length },
    ramGb,
    ramFreeGb: Math.round((freemem() / 1024 ** 3) * 10) / 10,
    diskFreeGb,
    gpus,
    gpu: best,
    vramGb,
    accelerator: torch.cuda ? 'cuda' : torch.mps ? 'mps' : (best?.accelerator ?? 'none'),
    python,
    torch,
    /** The headline: can a diffusion model run on this machine at all? */
    localGeneration,
    reasons,
    canRun,
    comfyui: await detectComfyUI(),
  }

  log.info('generation resources detected', {
    localGeneration,
    accelerator: cached.accelerator,
    vramGb,
    ramGb,
    gpu: best?.name ?? 'none',
    comfyui: cached.comfyui.reachable ? 'reachable' : cached.comfyui.configured ? 'unreachable' : 'not configured',
    reasons: reasons.join('; ') || 'none',
    ms: cached.detectionMs,
  })

  return cached
}

/**
 * A short, honest sentence about local generation, for the UI.
 * Never claims a capability that has not been measured.
 */
export function describeLocalCapability(resources) {
  if (!resources) return 'Generation capability has not been checked yet.'
  if (resources.localGeneration) {
    return `Local generation is available: ${resources.gpu?.name ?? 'GPU'} with ${resources.vramGb} GB VRAM.`
  }
  return `Local image and video generation is unavailable on this machine — ${resources.reasons.join('; ')}.`
}

/** Test seam. */
export function resetResourceCache() {
  cached = null
}

export { detectPython, detectTorch }
