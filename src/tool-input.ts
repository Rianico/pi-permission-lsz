import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  type BashToolCallEvent,
  type EditToolCallEvent,
  type FindToolCallEvent,
  type GrepToolCallEvent,
  isToolCallEventType,
  type LsToolCallEvent,
  type ReadToolCallEvent,
  type ToolCallEvent,
  type WriteToolCallEvent,
} from "@earendil-works/pi-coding-agent";

export type BuiltInToolCallEvent =
  | BashToolCallEvent
  | ReadToolCallEvent
  | EditToolCallEvent
  | WriteToolCallEvent
  | GrepToolCallEvent
  | FindToolCallEvent
  | LsToolCallEvent;

export type BuiltInToolName = BuiltInToolCallEvent["toolName"];
export type PermissionToolName = BuiltInToolName | (string & {});

export interface PermissionInput {
  cwd: string;
  permissionRoot: string;
  tool: PermissionToolInput;
}

export type PermissionToolInput =
  | BashPermissionToolInput
  | ReadPermissionToolInput
  | EditPermissionToolInput
  | WritePermissionToolInput
  | GrepPermissionToolInput
  | FindPermissionToolInput
  | LsPermissionToolInput
  | CustomPermissionToolInput;

interface BasePermissionToolInput<TName extends string, TInput> {
  toolName: TName;
  input: TInput;
  detail: string;
}

export interface BashPermissionToolInput
  extends BasePermissionToolInput<"bash", BashToolCallEvent["input"]> {
  command: string;
}

export interface ReadPermissionToolInput
  extends BasePermissionToolInput<"read", ReadToolCallEvent["input"]> {
  path: string;
  absolutePath: string;
  projectPath?: string;
}

export interface EditPermissionToolInput
  extends BasePermissionToolInput<"edit", EditToolCallEvent["input"]> {
  path: string;
  absolutePath: string;
  projectPath?: string;
}

export interface WritePermissionToolInput
  extends BasePermissionToolInput<"write", WriteToolCallEvent["input"]> {
  path: string;
  absolutePath: string;
  projectPath?: string;
}

export interface GrepPermissionToolInput
  extends BasePermissionToolInput<"grep", GrepToolCallEvent["input"]> {
  path?: string;
  absolutePath?: string;
  projectPath?: string;
}

export interface FindPermissionToolInput
  extends BasePermissionToolInput<"find", FindToolCallEvent["input"]> {
  path?: string;
  absolutePath?: string;
  projectPath?: string;
}

export interface LsPermissionToolInput
  extends BasePermissionToolInput<"ls", LsToolCallEvent["input"]> {
  path?: string;
  absolutePath?: string;
  projectPath?: string;
}

export interface CustomPermissionToolInput<TName extends string = string>
  extends BasePermissionToolInput<TName, Record<string, unknown>> {}

export function permissionToolInputFromToolCall(
  event: ToolCallEvent,
  cwd: string,
): PermissionToolInput {
  if (isToolCallEventType("bash", event)) {
    return {
      toolName: "bash",
      input: event.input,
      command: event.input.command,
      detail: event.input.command,
    };
  }

  if (isToolCallEventType("read", event)) {
    // The FIRST target only: `read` may name several files (`files[].file`), and a
    // gate that judged just this one would miss a deny rule on a later file. Use
    // `permissionToolInputsFromToolCall` to see every target.
    const [rawPath] = readTargetPaths(event.input as Record<string, unknown>);
    const pathFields = requiredPathFields(rawPath, cwd, "read");
    return { toolName: "read", input: event.input, ...pathFields };
  }

  if (isToolCallEventType("edit", event)) {
    const rawPath =
      (event.input as Record<string, unknown>).path ??
      (event.input as Record<string, unknown>).file ??
      (event.input as Record<string, unknown>).file_path;
    const pathFields = requiredPathFields(rawPath, cwd, "edit");
    return { toolName: "edit", input: event.input, ...pathFields };
  }

  if (isToolCallEventType("write", event)) {
    const pathFields = requiredPathFields(event.input.path, cwd, "write");
    return { toolName: "write", input: event.input, ...pathFields };
  }

  if (isToolCallEventType("grep", event)) {
    const pathFields = optionalPathFields(event.input.path, cwd, event.input);
    return { toolName: "grep", input: event.input, ...pathFields };
  }

  if (isToolCallEventType("find", event)) {
    const pathFields = optionalPathFields(event.input.path, cwd, event.input);
    return { toolName: "find", input: event.input, ...pathFields };
  }

  if (isToolCallEventType("ls", event)) {
    const pathFields = optionalPathFields(event.input.path, cwd, event.input);
    return { toolName: "ls", input: event.input, ...pathFields };
  }

  return {
    toolName: event.toolName,
    input: event.input,
    detail: formatUnknownInput(event.input),
  };
}

/**
 * Every target a tool call names, in request order.
 *
 * WHY a list rather than one input: `read` is a batch tool. pi-better-edit replaces
 * the builtin `read` and its payload is `files: [{ file }]` — `file`/`path`/`file_path`
 * are then all absent. A gate that resolves a single scalar path therefore feeds
 * `undefined` into `path.isAbsolute`, which throws `ERR_INVALID_ARG_TYPE` from inside
 * the `tool_call` hook; the host reports that as the read tool's own error and nothing
 * names the offending payload. Callers must evaluate every target, or a batched call
 * is judged on `files[0]` alone.
 */
export function permissionToolInputsFromToolCall(
  event: ToolCallEvent,
  cwd: string,
): PermissionToolInput[] {
  if (!isToolCallEventType("read", event)) {
    return [permissionToolInputFromToolCall(event, cwd)];
  }

  const input = event.input as Record<string, unknown>;
  return readTargetPaths(input).map((rawPath) => ({
    toolName: "read" as const,
    input: event.input,
    ...requiredPathFields(rawPath, cwd, "read"),
  }));
}

/**
 * The file paths a `read` payload names: the batch `files[].file` form first, then the
 * legacy single-file keys (`file`, then `path`, then the deprecated `file_path`).
 */
function readTargetPaths(input: Record<string, unknown>): unknown[] {
  const files = input.files;
  if (Array.isArray(files)) {
    const paths = files.map((entry) =>
      typeof entry === "object" && entry !== null
        ? (entry as Record<string, unknown>).file
        : undefined,
    );
    // An empty `files` array names nothing; fall back to the legacy keys rather than
    // judging a request with zero targets, which would let it through ungated.
    if (paths.length > 0) return paths;
  }

  return [input.file ?? input.path ?? input.file_path];
}

export function isBashToolInput(tool: PermissionToolInput): tool is BashPermissionToolInput {
  return tool.toolName === "bash" && "command" in tool;
}

export function isReadToolInput(tool: PermissionToolInput): tool is ReadPermissionToolInput {
  return tool.toolName === "read" && "path" in tool && "absolutePath" in tool;
}

export function isEditToolInput(tool: PermissionToolInput): tool is EditPermissionToolInput {
  return tool.toolName === "edit" && "path" in tool && "absolutePath" in tool;
}

export function isWriteToolInput(tool: PermissionToolInput): tool is WritePermissionToolInput {
  return tool.toolName === "write" && "path" in tool && "absolutePath" in tool;
}

export function isGrepToolInput(tool: PermissionToolInput): tool is GrepPermissionToolInput {
  return tool.toolName === "grep";
}

export function isFindToolInput(tool: PermissionToolInput): tool is FindPermissionToolInput {
  return tool.toolName === "find";
}

export function isLsToolInput(tool: PermissionToolInput): tool is LsPermissionToolInput {
  return tool.toolName === "ls";
}

export function isCustomToolInput(
  tool: PermissionToolInput,
  toolName: BuiltInToolName,
): tool is never;
export function isCustomToolInput<TName extends string>(
  tool: PermissionToolInput,
  toolName: TName,
): tool is CustomPermissionToolInput<TName>;
export function isCustomToolInput(tool: PermissionToolInput, toolName: string): boolean {
  return tool.toolName === toolName;
}

function requiredPathFields(
  path: unknown,
  cwd: string,
  toolName: string,
): {
  detail: string;
  path: string;
  absolutePath: string;
  projectPath?: string;
} {
  const readable = assertReadablePath(path, toolName);
  const resolved = resolveToolPath(readable, cwd);
  return {
    detail: readable,
    path: readable,
    absolutePath: resolved.absolutePath,
    ...(resolved.projectPath ? { projectPath: resolved.projectPath } : {}),
  };
}

function optionalPathFields(
  path: string | undefined,
  cwd: string,
  input: unknown,
): {
  detail: string;
  path?: string;
  absolutePath?: string;
  projectPath?: string;
} {
  if (!path) return { detail: formatUnknownInput(input) };

  const resolved = resolveToolPath(path, cwd);
  return {
    detail: path,
    path,
    absolutePath: resolved.absolutePath,
    ...(resolved.projectPath ? { projectPath: resolved.projectPath } : {}),
  };
}

/**
 * WHY a guard rather than a cast: payloads arrive as `unknown` because an extension may
 * replace a builtin tool (pi-better-edit replaces `read`) with a shape this package has
 * never seen. Feeding that shape's `undefined` to `path.isAbsolute` throws
 * `ERR_INVALID_ARG_TYPE` *inside* the `tool_call` hook, so the host reports a tool
 * failure that names no payload and no key. Naming the tool and the received value makes
 * the gate's refusal legible — and because this throws before any hook runs, it fails
 * closed.
 */
function assertReadablePath(path: unknown, toolName: string): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error(
      `No file path in this ${toolName} payload (received ${formatUnknownInput(path)}); ` +
        "expected a non-empty string. The permission gate cannot judge this call, so it was denied.",
    );
  }
  return path;
}

function resolveToolPath(
  path: string,
  cwd: string,
): { absolutePath: string; projectPath?: string } {
  const absolutePath = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const relativePath = relative(cwd, absolutePath);
  const isInsideCwd =
    relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
  return {
    absolutePath,
    ...(isInsideCwd ? { projectPath: relativePath.split(sep).join("/") } : {}),
  };
}

function formatUnknownInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}
