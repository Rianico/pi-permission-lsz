import { describe, expect, it, vi } from "vitest";
import { registerPermissionHooks } from "../extensions/hooks.js";
import { assignPermissionHookIds, isPermissionHookEnabled } from "../src/enablement.js";
import { PendingApprovalNotes } from "../src/pending-approvals.js";
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

function createRuntime(result: PermissionGateResult) {
  vi.mocked(showPermissionGate).mockResolvedValue(result);

  const [hook] = assignPermissionHookIds([
    {
      name: "Git mutations",
      description: "Protect reviewed git state",
      source: "user",
      permissionRoot: "/permissions",
      modulePath: "/permissions/git.ts",
      handler: () => ({ decision: "request" as const }),
    },
  ]);
  if (!hook) throw new Error("expected runtime hook");

  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const notifications: string[] = [];
  const statuses: string[] = [];
  const appendEntry = vi.fn();
  const state = { hooks: [hook], enablement: {} };
  const pendingApprovalNotes = new PendingApprovalNotes();

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
  );

  const ctx = {
    cwd: "/repo",
    mode: "tui",
    hasUI: true,
    sessionManager: { getBranch: () => [] },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      notify: (message: string) => notifications.push(message),
      setStatus: (_key: string, value: string) => statuses.push(value),
    },
  };

  return {
    hook,
    state,
    appendEntry,
    notifications,
    statuses,
    pendingApprovalNotes,
    toolCall: () =>
      handlers.get("tool_call")?.(
        { toolCallId: "call-1", toolName: "read", input: { path: "a.ts" } },
        ctx,
      ),
  };
}
