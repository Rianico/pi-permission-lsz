import type { PermissionRequestPrompt } from "./api.js";
import type { RuntimePermissionHook } from "./enablement.js";
import type { PermissionInput, PermissionToolInput } from "./tool-input.js";

export type TerminalPermissionDecision =
  | { decision: "block"; reason: string }
  | { decision: "request"; prompt?: PermissionRequestPrompt };

export interface PermissionEvaluation {
  hook: RuntimePermissionHook;
  input: PermissionInput;
  decision: TerminalPermissionDecision;
}

export interface PermissionHookFailure {
  hook: RuntimePermissionHook;
  input: PermissionInput;
  error: unknown;
}

export interface PermissionEvaluationResult {
  evaluation?: PermissionEvaluation;
  failures: PermissionHookFailure[];
}

export interface PermissionEvaluationInput {
  cwd: string;
  tool: PermissionToolInput;
}

export async function evaluatePermissionHooks(
  hooks: readonly RuntimePermissionHook[],
  input: PermissionEvaluationInput,
): Promise<PermissionEvaluationResult> {
  const failures: PermissionHookFailure[] = [];

  for (const hook of hooks) {
    const hookInput: PermissionInput = {
      ...input,
      permissionRoot: hook.permissionRoot,
    };

    try {
      const decision = await hook.handler(hookInput);
      if (!decision) continue;

      return { evaluation: { hook, input: hookInput, decision }, failures };
    } catch (error) {
      failures.push({ hook, input: hookInput, error });
    }
  }

  return { failures };
}

export interface PermissionTargetsInput {
  cwd: string;
  tools: readonly PermissionToolInput[];
}

/**
 * Judge every target one tool call names, letting a block anywhere outrank a request
 * anywhere.
 *
 * WHY the full scan: a tool call is atomic — the host runs it whole or not at all — and
 * `read` accepts a batch payload (`files: [...]`). Returning the first decision in
 * request order would let an "ask" on `files[0]` mask a deny rule on `files[2]`: the
 * user approves the prompt shown for the first file and the whole batch, denied file
 * included, runs. Scanning every target before deciding makes "blocked if any file
 * matches a deny rule" hold whatever the order. Single-target calls keep the
 * short-circuit path — and its hook-priority meaning — unchanged.
 */
export async function evaluatePermissionTargets(
  hooks: readonly RuntimePermissionHook[],
  input: PermissionTargetsInput,
): Promise<PermissionEvaluationResult> {
  const [first, ...rest] = input.tools;
  if (rest.length === 0) {
    if (!first) return { failures: [] };
    return evaluatePermissionHooks(hooks, { cwd: input.cwd, tool: first });
  }

  const failures: PermissionHookFailure[] = [];
  let blocked: PermissionEvaluation | undefined;
  let requested: PermissionEvaluation | undefined;

  for (const tool of input.tools) {
    const result = await evaluatePermissionHooks(hooks, { cwd: input.cwd, tool });
    failures.push(...result.failures);

    const evaluation = result.evaluation;
    if (!evaluation) continue;
    if (evaluation.decision.decision === "block") blocked ??= evaluation;
    else requested ??= evaluation;
  }

  const evaluation = blocked ?? requested;
  return evaluation ? { evaluation, failures } : { failures };
}
