# 09 — Absorb rtk rewriting into the gate

Status: Proposed (fork `Rianico/pi-permissions`, on top of upstream HEAD `ba978b7 feat(prompt): frame and scroll the tool detail`)
Author: Rianico
Date: 2026-08-12

## Problem

The user's `rtk` extension (`~/.pi/agent/extensions/rtk.ts`, in their dotfiles)
rewrites nearly every bash command to `rtk <command>` **before** the permission
hooks evaluate it. Consequences:

1. The gate sees `rtk gh issue create …`; the program is `rtk`, so no hook
   matches and **every guard silently stops firing** (a policy bypass, not an
   error).
2. Workarounds leak: an `rtk` entry was grafted into the parser's shared
   `defaultWrappers` (`src/shell.ts`) as a node_modules patch — wiped by every
   `pi update`, and it changes library defaults to serve one user's proxy.
3. The prompt's detail and highlights show the rtk-wrapped text instead of the
   command the approver actually cares about.
4. The two extensions (`rtk.ts` and this one) both register `tool_call`
   handlers that read/mutate `event.input.command`, with no ordering contract.

## Design

Absorb rtk rewriting **into this extension**. The gate evaluates the
**original** command; the rewrite is applied to the command that will run,
**after** the approver's verdict. This removes the wrapper workaround, the
ordering seam, and the wipe-prone node_modules patch in one move. The `rtk
rewrite` CLI stays the single source of rewrite rules (no Rust changes).

### Flow (bash tool calls)

```
agent runs: gh issue create …
  → tool_call handler (this extension only):
      1. evaluate permission hooks against the ORIGINAL command
      2. gate matches?
           yes → show prompt (original detail, original highlights)
                 allow / don't-ask-again / edit → continue to rewrite step
                 reject / block                     → return block (no rewrite)
      3. rewrite step (fail-open): final = event.input.command (original or
         user's edit); rewritten = rtkRewrite(final); if rewritten && != final
         → event.input.command = rewritten
      4. no gate matched → same rewrite step, then return undefined
```

Non-bash tools are untouched (no rewrite; gates unchanged).

### New module: `src/rtk.ts`

Port the rtk extension's mechanics (all fail-open):

- `probeRtk(exec)`: `rtk --version`, parse semver, require >= 0.23.0. Cached.
- `rewriteCommand(cmd, { exec, timeoutMs, signal })`: `rtk rewrite <cmd>`
  (command passed as a single argument, as the current extension does); return
  the trimmed stdout rewrite, or `null` when: exit code not 0/3, killed,
  timeout, or any throw. Never block execution.
- Bounded memo (`rewriteCache`, max 500, FIFO eviction) + in-flight dedupe,
  exactly as the current `rtk.ts` (`MAX_CACHE_ENTRIES`, `inFlightRewrites`).

### Config

`extensions/shared/settings.ts` gains an `rtk` section (TypeBox, optional):

```jsonc
"permissions": {
  "rtk": { "enabled": true, "timeoutMs": 2000 }
}
```

- `enabled` (default true): master switch.
- `timeoutMs` (default 2000).
- The existing `RTK_DISABLED=1` env override is honored (back-compat with the
  current rtk.ts). `enabled:false` and `RTK_DISABLED=1` both disable rewriting
  without disabling the permission gates.
- If `probeRtk` fails (binary missing or too old), rewriting is disabled with a
  one-time `console.warn`; gates still work.

### Handler integration (`extensions/hooks.ts`)

- Keep the existing evaluation/prompt logic; the prompt is always built from
  the command as received (now the original).
- After the gate resolves to allow/edit/don't-ask-again (or no gate matched),
  and only for bash events, run the rewrite step on the final command. The
  edit outcome already mutates `bashEvent.input.command`; the rewrite runs
  after that mutation so the **edited** command is what gets rewritten.
- `reject`/`block` paths return before the rewrite step.

## Why this shape

- The seam disappears: one handler owns both the verdict and the rewrite.
- The prompt shows the real command (detail + highlights accurate).
- `shell.ts` needs no wrapper entry; the node_modules patch goes away entirely.
- Existing hook tests already assert on unwrapped commands — those become the
  real inputs, so they stay correct.

## Tests (fork `test/`)

- `rtk.test.ts`: version probe (present/absent/too-old), `rewriteCommand`
  (rewrite, pass-through, timeout, kill, throw → null), cache bounds + in-flight
  dedupe, config `enabled:false` / `RTK_DISABLED=1`.
- `hooks.test.ts` additions (fake `pi` + fake `rtk rewrite` exec):
  - gated + allow → `event.input.command` becomes the rewrite
  - gated + reject → not mutated, blocked
  - gated + edit → the **edited** command is what gets rewritten
  - no gate → mutated immediately
  - rtk disabled/missing → never mutated, gates unaffected
- No changes needed to `shell.test.ts` (no wrapper concept involved).

## Acceptance criteria

1. Gate evaluates and prompts on the original command; no `rtk ` prefix in the
   detail or highlights.
2. On allow/edit/don't-ask-again and on ungated calls, the command that runs is
   the rtk rewrite (when a rewrite exists, rtk enabled, binary present).
3. Reject/block never rewrites.
4. Rewrite failures (timeout/kill/missing binary) are fail-open — the original
   command runs.
5. `mise run check` green (typecheck + full test suite).

## Out of scope

- Changing `rtk rewrite` (the Rust registry) — stays the rule source.
- Prompt scrolling — already upstream at `ba978b7`.
- Non-bash tool gates.
