import { describe, expect, it } from "vitest";
import { assignPermissionHookIds } from "../src/enablement.js";
import { evaluatePermissionHooks, evaluatePermissionTargets } from "../src/evaluator.js";
import { matchTool } from "../src/match-tool.js";
import {
  isReadToolInput,
  type PermissionInput,
  type PermissionToolInput,
} from "../src/tool-input.js";

const readInput: PermissionInput = {
  cwd: "/repo",
  permissionRoot: "/repo/.pi/permissions",
  tool: {
    toolName: "read",
    input: { path: "data/corpus.json" },
    detail: "data/corpus.json",
    path: "data/corpus.json",
    absolutePath: "/repo/data/corpus.json",
    projectPath: "data/corpus.json",
  },
};

const bashInput: PermissionInput = {
  cwd: "/repo",
  permissionRoot: "/repo/.pi/permissions",
  tool: {
    toolName: "bash",
    input: { command: "npm test" },
    detail: "npm test",
    command: "npm test",
  },
};

describe("evaluatePermissionHooks", () => {
  it("lets handlers filter by returning undefined", async () => {
    const hooks = assignPermissionHookIds([
      {
        name: "read-only",
        description: "only blocks reads",
        source: "user",
        permissionRoot: "/user/permissions",
        modulePath: "/user/permissions/read.ts",
        handler: (input) =>
          matchTool(input.tool, {
            read: () => ({ decision: "block", reason: "blocked" }),
          }),
      },
      {
        name: "fallback",
        description: "requests everything else",
        source: "user",
        permissionRoot: "/user/permissions",
        modulePath: "/user/permissions/fallback.ts",
        handler: () => ({ decision: "request" }),
      },
    ]);

    const result = await evaluatePermissionHooks(hooks, {
      cwd: bashInput.cwd,
      tool: bashInput.tool,
    });

    expect(result.evaluation?.hook.name).toBe("fallback");
    expect(result.evaluation?.decision).toEqual({ decision: "request" });
    expect(result.failures).toEqual([]);
  });

  it("continues after undefined and stops at the first terminal decision", async () => {
    const hooks = assignPermissionHookIds([
      {
        name: "first",
        description: "does not decide",
        source: "user",
        permissionRoot: "/user/permissions",
        modulePath: "/user/permissions/first.ts",
        handler: () => undefined,
      },
      {
        name: "second",
        description: "blocks",
        source: "user",
        permissionRoot: "/user/permissions",
        modulePath: "/user/permissions/second.ts",
        handler: (input) =>
          matchTool(input.tool, {
            read: () => ({ decision: "block", reason: "blocked" }),
          }),
      },
      {
        name: "third",
        description: "should not run",
        source: "user",
        permissionRoot: "/user/permissions",
        modulePath: "/user/permissions/third.ts",
        handler: () => ({ decision: "request" }),
      },
    ]);

    const result = await evaluatePermissionHooks(hooks, {
      cwd: readInput.cwd,
      tool: readInput.tool,
    });

    expect(result.evaluation?.hook.name).toBe("second");
    expect(result.evaluation?.decision).toEqual({ decision: "block", reason: "blocked" });
  });

  it("skips throwing hooks and reports the failures", async () => {
    const hooks = assignPermissionHookIds([
      {
        name: "broken",
        description: "throws",
        source: "user",
        permissionRoot: "/user/permissions",
        modulePath: "/user/permissions/broken.ts",
        handler: () => {
          throw new Error("boom");
        },
      },
      {
        name: "decider",
        description: "continues",
        source: "user",
        permissionRoot: "/user/permissions",
        modulePath: "/user/permissions/decider.ts",
        handler: () => ({ decision: "request" }),
      },
    ]);

    const result = await evaluatePermissionHooks(hooks, {
      cwd: bashInput.cwd,
      tool: bashInput.tool,
    });

    expect(result.evaluation?.hook.name).toBe("decider");
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.hook.name).toBe("broken");
  });
});

describe("evaluatePermissionTargets", () => {
  const readTarget = (path: string): PermissionToolInput => ({
    toolName: "read",
    input: { path },
    detail: path,
    path,
    absolutePath: `/repo/${path}`,
  });

  const denyDenied = assignPermissionHookIds([
    {
      name: "deny-list",
      description: "denies one file, asks for the rest",
      source: "user",
      permissionRoot: "/user/permissions",
      modulePath: "/user/permissions/deny.ts",
      handler: (input) => {
        if (!isReadToolInput(input.tool)) return undefined;
        if (input.tool.path === "denied.md") return { decision: "block", reason: "denied" };
        if (input.tool.path === "asked.md") return { decision: "request" };
        return undefined;
      },
    },
  ]);

  // A batch read is one atomic tool call: had the scan stopped at `asked.md`'s request,
  // approving that prompt would have run the batch — including the denied file.
  it("lets a deny rule on a later file outrank an ask on an earlier one", async () => {
    const result = await evaluatePermissionTargets(denyDenied, {
      cwd: "/repo",
      tools: [readTarget("clean.md"), readTarget("asked.md"), readTarget("denied.md")],
    });

    expect(result.evaluation?.decision).toEqual({ decision: "block", reason: "denied" });
    expect(result.evaluation?.input.tool.detail).toBe("denied.md");
  });

  it("keeps the asking target when no target is denied", async () => {
    const result = await evaluatePermissionTargets(denyDenied, {
      cwd: "/repo",
      tools: [readTarget("clean.md"), readTarget("asked.md")],
    });

    expect(result.evaluation?.decision).toEqual({ decision: "request" });
    expect(result.evaluation?.input.tool.detail).toBe("asked.md");
  });

  it("short-circuits a single target, preserving hook priority", async () => {
    const hooks = assignPermissionHookIds([
      {
        name: "first",
        description: "asks",
        source: "user",
        permissionRoot: "/user/permissions",
        modulePath: "/user/permissions/first.ts",
        handler: () => ({ decision: "request" }),
      },
      {
        name: "second",
        description: "would block",
        source: "user",
        permissionRoot: "/user/permissions",
        modulePath: "/user/permissions/second.ts",
        handler: () => ({ decision: "block", reason: "denied" }),
      },
    ]);

    const result = await evaluatePermissionTargets(hooks, {
      cwd: "/repo",
      tools: [readTarget("asked.md")],
    });

    expect(result.evaluation?.hook.name).toBe("first");
  });
});
