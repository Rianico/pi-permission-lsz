import { describe, expect, it, vi } from "vitest";
import { registerPermissionHooks } from "../extensions/hooks.js";
import type { PermissionHandler } from "../src/api.js";
import { assignPermissionHookIds, isPermissionHookEnabled } from "../src/enablement.js";
import { PendingApprovalNotes } from "../src/pending-approvals.js";
import type { Rtk } from "../src/rtk.js";
import { type PermissionGateResult, showPermissionGate } from "../src/ui/permission-prompt.js";

vi.mock("../src/ui/permission-prompt.js", () => ({ showPermissionGate: vi.fn() }));

describe("don't ask again outcomes", () => {
  it("approves the call and disables the deciding hook for the session branch", async () => {
    const runtime = createRuntime({ kind: "allow", forSession: true });

    const result = await runtime.toolCall();

    expect(result).toBeUndefined();
    expect(isPermissionHookEnabled(runtime.state.enablement, runtime.hook)).toBe(false);
    expect(runtime.appendEntry).toHaveBeenCalledWith("permissions", {
      hooks: [
        {
          id: runtime.hook.id,
          name: "Git mutations",
          source: "user",
          enabled: false,
          changed: true,
        },
      ],
    });
    expect(runtime.notifications).toEqual([
      "Authorization no longer required (Git mutations)... be careful",
    ]);
    expect(runtime.statuses).toEqual(["permissions:0/1"]);
  });

  it("relays the approval note alongside the disable", async () => {
    const runtime = createRuntime({ kind: "allow", forSession: true, note: "it is fine" });

    await runtime.toolCall();

    expect(runtime.notifications).toEqual([
      `Operation authorized (Git mutations)

Authorization log:
it is fine`,
      "Authorization no longer required (Git mutations)... be careful",
    ]);
    expect(runtime.pendingApprovalNotes.consumeForToolResult("call-1")).toEqual({
      kind: "approval",
      hookName: "Git mutations",
      note: "it is fine",
    });
  });

  it("leaves the hook enabled for a plain approval", async () => {
    const runtime = createRuntime({ kind: "allow" });

    await runtime.toolCall();

    expect(isPermissionHookEnabled(runtime.state.enablement, runtime.hook)).toBe(true);
    expect(runtime.appendEntry).not.toHaveBeenCalled();
    expect(runtime.notifications).toEqual([]);
  });
});

describe("rtk rewrite integration", () => {
  const bashEvent = () =>
    ({ toolCallId: "call-2", toolName: "bash", input: { command: "gh issue create" } }) as Record<
      string,
      unknown
    >;

  it("rewrites the approved bash command after the gate", async () => {
    const rewrite = vi.fn(async () => "rtk gh issue create");
    const runtime = createRuntime(
      { kind: "allow" },
      { rtk: rewritingRtk(rewrite), event: bashEvent() },
    );

    await runtime.toolCall();

    expect(rewrite).toHaveBeenCalledWith("gh issue create", expect.any(AbortSignal));
    expect((runtime.event.input as { command: string }).command).toBe("rtk gh issue create");
  });

  it("does not rewrite a rejected bash command", async () => {
    const rewrite = vi.fn();
    const runtime = createRuntime(
      { kind: "reject", abort: false },
      { rtk: rewritingRtk(rewrite), event: bashEvent() },
    );

    const result = await runtime.toolCall();

    expect(result).toMatchObject({ block: true });
    expect(rewrite).not.toHaveBeenCalled();
    expect((runtime.event.input as { command: string }).command).toBe("gh issue create");
  });

  it("rewrites the edited command after an edit outcome", async () => {
    const rewrite = vi.fn(async () => "rtk gh issue create --title edited");
    const runtime = createRuntime(
      { kind: "edit", command: "gh issue create --title edited" },
      { rtk: rewritingRtk(rewrite), event: bashEvent() },
    );

    await runtime.toolCall();

    expect(rewrite).toHaveBeenCalledWith("gh issue create --title edited", expect.any(AbortSignal));
    expect((runtime.event.input as { command: string }).command).toBe(
      "rtk gh issue create --title edited",
    );
  });

  it("rewrites after a don't-ask-again approval", async () => {
    const rewrite = vi.fn(async () => "rtk gh issue create");
    const runtime = createRuntime(
      { kind: "allow", forSession: true },
      { rtk: rewritingRtk(rewrite), event: bashEvent() },
    );

    await runtime.toolCall();

    expect(rewrite).toHaveBeenCalledWith("gh issue create", expect.any(AbortSignal));
    expect(isPermissionHookEnabled(runtime.state.enablement, runtime.hook)).toBe(false);
  });

  it("rewrites ungated bash commands without showing a gate", async () => {
    const rewrite = vi.fn(async () => "rtk git status");
    const runtime = createRuntime(
      { kind: "allow" },
      {
        rtk: rewritingRtk(rewrite),
        handler: () => undefined,
        event: { toolCallId: "call-3", toolName: "bash", input: { command: "git status" } },
      },
    );

    await runtime.toolCall();

    expect(showPermissionGate).not.toHaveBeenCalled();
    expect(rewrite).toHaveBeenCalledWith("git status", expect.any(AbortSignal));
    expect((runtime.event.input as { command: string }).command).toBe("rtk git status");
  });

  it("leaves the command unchanged when rtk is unavailable", async () => {
    const rewrite = vi.fn(async () => null);
    const runtime = createRuntime(
      { kind: "allow" },
      { rtk: rewritingRtk(rewrite), event: bashEvent() },
    );

    await runtime.toolCall();

    expect(rewrite).toHaveBeenCalled();
    expect((runtime.event.input as { command: string }).command).toBe("gh issue create");
  });

  it("never rewrites non-bash tool calls", async () => {
    const rewrite = vi.fn(async () => "rtk whatever");
    const runtime = createRuntime(
      { kind: "allow" },
      {
        rtk: rewritingRtk(rewrite),
        event: { toolCallId: "call-4", toolName: "read", input: { path: "a.ts" } },
      },
    );

    await runtime.toolCall();

    expect(rewrite).not.toHaveBeenCalled();
  });

  it("does not rewrite a command that already starts with rtk", async () => {
    const rewrite = vi.fn(async () => "rtk rtk git status");
    const runtime = createRuntime(
      { kind: "allow" },
      {
        rtk: rewritingRtk(rewrite),
        event: { toolCallId: "call-5", toolName: "bash", input: { command: "rtk git status" } },
      },
    );

    await runtime.toolCall();

    expect(rewrite).not.toHaveBeenCalled();
    expect((runtime.event.input as { command: string }).command).toBe("rtk git status");
  });
});

function rewritingRtk(rewrite: Rtk["rewrite"]): Rtk {
  return { rewrite };
}

function createRuntime(
  result: PermissionGateResult,
  overrides: {
    rtk?: Rtk;
    event?: Record<string, unknown>;
    handler?: PermissionHandler;
  } = {},
) {
  vi.mocked(showPermissionGate).mockReset();
  vi.mocked(showPermissionGate).mockResolvedValue(result);

  const [hook] = assignPermissionHookIds([
    {
      name: "Git mutations",
      description: "Protect reviewed git state",
      source: "user",
      permissionRoot: "/permissions",
      modulePath: "/permissions/git.ts",
      handler: overrides.handler ?? (() => ({ decision: "request" as const })),
    },
  ]);
  if (!hook) throw new Error("expected runtime hook");

  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const notifications: string[] = [];
  const statuses: string[] = [];
  const appendEntry = vi.fn();
  const state = { hooks: [hook], enablement: {} };
  const pendingApprovalNotes = new PendingApprovalNotes();

  const rtk = overrides.rtk ?? {
    rewrite: vi.fn(async () => null),
  };

  registerPermissionHooks(
    {
      on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        handlers.set(event, handler);
      },
      appendEntry,
      events: { emit: () => undefined },
    } as never,
    state,
    pendingApprovalNotes,
    rtk,
  );

  const ctx = {
    cwd: "/repo",
    mode: "tui",
    hasUI: true,
    sessionManager: { getBranch: () => [] },
    signal: new AbortController().signal,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      notify: (message: string) => notifications.push(message),
      setStatus: (_key: string, value: string) => statuses.push(value),
    },
  };

  const event = overrides.event ?? {
    toolCallId: "call-1",
    toolName: "read",
    input: { path: "a.ts" },
  };

  return {
    hook,
    state,
    appendEntry,
    notifications,
    statuses,
    pendingApprovalNotes,
    rtk,
    event,
    toolCall: () => handlers.get("tool_call")?.(event, ctx),
  };
}
