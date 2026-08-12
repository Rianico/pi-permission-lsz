export interface RtkExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export interface RtkExecOptions {
  timeout?: number;
  signal?: AbortSignal;
}

export type RtkExec = (
  program: string,
  args: string[],
  options?: RtkExecOptions,
) => Promise<RtkExecResult>;

export const DEFAULT_RTK_TIMEOUT_MS = 2_000;
export const MIN_SUPPORTED_RTK_MINOR = 23;

function parseSemver(raw: string): [number, number, number] | null {
  const m = raw.trim().match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [parseInt(m[1] ?? "", 10), parseInt(m[2] ?? "", 10), parseInt(m[3] ?? "", 10)];
}

/**
 * Returns true when the rtk binary is present and new enough to support
 * `rtk rewrite` (>= 0.23.0). Fail-open: an unparseable version is treated as
 * available, matching the original rtk extension's behavior.
 */
export async function probeRtk(
  exec: RtkExec,
  timeoutMs = DEFAULT_RTK_TIMEOUT_MS,
): Promise<boolean> {
  let result: RtkExecResult;
  try {
    result = await exec("rtk", ["--version"], { timeout: timeoutMs });
  } catch {
    return false;
  }
  if (result.code !== 0) return false;

  const parsed = parseSemver(result.stdout.replace(/^rtk\s+/, ""));
  if (!parsed) return true;
  const [major, minor] = parsed;
  if (major === 0 && minor < MIN_SUPPORTED_RTK_MINOR) return false;
  return true;
}

// Bounded memo of `rtk rewrite` results, keyed by the raw command string.
// rtk's rewrite registry is static for a given rtk version, so a command that
// rewrote (or passed through) once will behave the same next time. This turns
// the ~10-30ms subprocess spawn per bash call into a map lookup for repeated
// commands (very common in agent loops: `git status`, `cat x`, `npm test`).
const MAX_CACHE_ENTRIES = 500;
const rewriteCache = new Map<string, string | null>();

// In-flight dedupe: parallel bash calls with the same command share one rtk
// spawn instead of spawning once each.
const inFlightRewrites = new Map<string, Promise<string | null>>();

export interface RewriteCommandOptions {
  exec: RtkExec;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Calls `rtk rewrite`; returns the rewritten command or null (pass through).
 * Never throws and never blocks execution: any failure (non-0/3 exit, killed,
 * timeout, thrown error) yields null. null results are cached too, so a
 * timeout once on a command does not re-pay the subprocess latency on every
 * later occurrence.
 */
export async function rewriteCommand(
  cmd: string,
  options: RewriteCommandOptions,
): Promise<string | null> {
  const { exec, signal } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_RTK_TIMEOUT_MS;

  const cached = rewriteCache.get(cmd);
  if (cached !== undefined) return cached;

  const pending = inFlightRewrites.get(cmd);
  if (pending) return pending;

  const task = (async () => {
    try {
      const execOptions: RtkExecOptions = { timeout: timeoutMs, ...(signal ? { signal } : {}) };
      const result = await exec("rtk", ["rewrite", cmd], execOptions);
      const rewritten = (() => {
        if (result.killed) return null;
        if (result.code !== 0 && result.code !== 3) return null;
        return result.stdout.trim() || null;
      })();
      if (rewriteCache.size >= MAX_CACHE_ENTRIES) {
        // Evict the oldest entry (Map preserves insertion order).
        const oldest = rewriteCache.keys().next().value;
        if (oldest !== undefined) rewriteCache.delete(oldest);
      }
      rewriteCache.set(cmd, rewritten);
      return rewritten;
    } catch {
      return null;
    } finally {
      inFlightRewrites.delete(cmd);
    }
  })();
  inFlightRewrites.set(cmd, task);
  return task;
}

export interface RtkSettings {
  enabled?: boolean;
  timeoutMs?: number;
}

export interface Rtk {
  /** Rewrite a command, or null when disabled/unavailable/no rewrite. Never throws. */
  rewrite(cmd: string, signal?: AbortSignal): Promise<string | null>;
}

/**
 * Assembles the rtk integration for a process: honors the `enabled` setting and
 * the `RTK_DISABLED=1` env override, probes the binary once at creation, and
 * delegates rewrites to `rewriteCommand`. All failure modes are fail-open —
 * rewriting stops, the permission gates never do.
 */
export function createRtk(exec: RtkExec, settings: RtkSettings = {}): Rtk {
  const enabled = settings.enabled !== false && process.env.RTK_DISABLED !== "1";
  const timeoutMs = settings.timeoutMs ?? DEFAULT_RTK_TIMEOUT_MS;

  let warned = false;
  const available = enabled
    ? probeRtk(exec, timeoutMs).then((ok) => {
        if (!ok && !warned) {
          warned = true;
          console.warn(
            "[pi-permissions] rtk missing or too old (need >= 0.23.0) — command rewriting disabled; permission gates unaffected",
          );
        }
        return ok;
      })
    : Promise.resolve(false);

  return {
    async rewrite(cmd, signal) {
      if (!enabled) return null;
      if (!(await available)) return null;
      return rewriteCommand(cmd, { exec, timeoutMs, ...(signal ? { signal } : {}) });
    },
  };
}
