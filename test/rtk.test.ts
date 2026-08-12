import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RtkExec, RtkExecOptions, RtkExecResult } from "../src/rtk.js";

// The rtk module holds process-level cache state (rewrite memo, in-flight
// dedupe). Isolate it per test so the cache never leaks across tests.
let rtk: typeof import("../src/rtk.js");
beforeEach(async () => {
  vi.resetModules();
  rtk = await import("../src/rtk.js");
});

afterEach(() => {
  delete process.env.RTK_DISABLED;
});

function fakeExec(
  respond: (
    program: string,
    args: string[],
    options?: RtkExecOptions,
  ) => Partial<RtkExecResult> | Promise<Partial<RtkExecResult>>,
): {
  exec: RtkExec;
  calls: Array<{ program: string; args: string[]; options?: RtkExecOptions | undefined }>;
} {
  const calls: Array<{ program: string; args: string[]; options?: RtkExecOptions | undefined }> =
    [];
  const exec: RtkExec = async (program, args, options) => {
    calls.push({ program, args, options });
    const partial = await respond(program, args, options);
    return { stdout: "", stderr: "", code: 0, killed: false, ...partial };
  };
  return { exec, calls };
}

describe("probeRtk", () => {
  it("returns true when rtk --version reports a supported version", async () => {
    const { exec } = fakeExec(() => ({ code: 0, stdout: "rtk 0.23.0\n" }));

    await expect(rtk.probeRtk(exec)).resolves.toBe(true);
  });

  it("returns false when the rtk binary is absent", async () => {
    const { exec } = fakeExec(() => ({ code: 127, stderr: "command not found" }));

    await expect(rtk.probeRtk(exec)).resolves.toBe(false);
  });

  it("returns false when rtk predates 0.23.0", async () => {
    const { exec } = fakeExec(() => ({ code: 0, stdout: "rtk 0.22.1\n" }));

    await expect(rtk.probeRtk(exec)).resolves.toBe(false);
  });

  it("treats an unparseable version as available (fail-open)", async () => {
    const { exec } = fakeExec(() => ({ code: 0, stdout: "rtk development build\n" }));

    await expect(rtk.probeRtk(exec)).resolves.toBe(true);
  });

  it("returns false when exec throws", async () => {
    const { exec } = fakeExec(() => {
      throw new Error("boom");
    });

    await expect(rtk.probeRtk(exec)).resolves.toBe(false);
  });
});

describe("rewriteCommand", () => {
  it("returns the trimmed rewrite on exit code 0", async () => {
    const { exec } = fakeExec(() => ({ code: 0, stdout: "rtk git status\n" }));

    await expect(rtk.rewriteCommand("git status", { exec })).resolves.toBe("rtk git status");
  });

  it("returns the trimmed rewrite on exit code 3 (advisory)", async () => {
    const { exec } = fakeExec(() => ({ code: 3, stdout: "rtk ls -la\n" }));

    await expect(rtk.rewriteCommand("ls -la", { exec })).resolves.toBe("rtk ls -la");
  });

  it("passes the command to rtk rewrite as a single argument", async () => {
    const { exec, calls } = fakeExec(() => ({ code: 0, stdout: "rtk git status\n" }));

    await rtk.rewriteCommand("git status", { exec });

    expect(calls[0]?.program).toBe("rtk");
    expect(calls[0]?.args).toEqual(["rewrite", "git status"]);
  });

  it("returns null when there is no rtk equivalent (exit 1)", async () => {
    const { exec } = fakeExec(() => ({ code: 1 }));

    await expect(rtk.rewriteCommand("git status", { exec })).resolves.toBeNull();
  });

  it("returns null when the process was killed (timeout)", async () => {
    const { exec } = fakeExec(() => ({ killed: true }));

    await expect(rtk.rewriteCommand("git status", { exec })).resolves.toBeNull();
  });

  it("returns null when exec throws", async () => {
    const { exec } = fakeExec(() => {
      throw new Error("boom");
    });

    await expect(rtk.rewriteCommand("git status", { exec })).resolves.toBeNull();
  });
});

describe("rewrite cache", () => {
  it("caches a rewrite result per command", async () => {
    const { exec, calls } = fakeExec(() => ({ code: 0, stdout: "rtk git status\n" }));

    await rtk.rewriteCommand("git status", { exec });
    await rtk.rewriteCommand("git status", { exec });

    expect(calls).toHaveLength(1);
    await expect(rtk.rewriteCommand("git status", { exec })).resolves.toBe("rtk git status");
  });

  it("caches null (pass-through) results too", async () => {
    const { exec, calls } = fakeExec(() => ({ code: 1 }));

    await rtk.rewriteCommand("git status", { exec });
    await rtk.rewriteCommand("git status", { exec });

    expect(calls).toHaveLength(1);
    await expect(rtk.rewriteCommand("git status", { exec })).resolves.toBeNull();
  });

  it("evicts the oldest entry when the cache exceeds its bound", async () => {
    const { exec, calls } = fakeExec((_program, args) => ({
      code: 0,
      stdout: `rtk ${args[1] ?? ""}\n`,
    }));

    const commands = Array.from({ length: 501 }, (_, i) => `cmd-${i}`);
    for (const cmd of commands) {
      await rtk.rewriteCommand(cmd, { exec });
    }
    expect(calls).toHaveLength(501);

    // The 501st insert evicted the oldest entry (cmd-0): re-rewriting spawns again.
    await expect(rtk.rewriteCommand("cmd-0", { exec })).resolves.toBe("rtk cmd-0");
    expect(calls).toHaveLength(502);

    // Now cached again; the most recent entry is still cached.
    await expect(rtk.rewriteCommand("cmd-0", { exec })).resolves.toBe("rtk cmd-0");
    await expect(rtk.rewriteCommand("cmd-500", { exec })).resolves.toBe("rtk cmd-500");
    expect(calls).toHaveLength(502);
  });

  it("dedupes concurrent rewrites of the same command", async () => {
    let resolveExec: (result: Partial<RtkExecResult>) => void = () => {};
    const { exec, calls } = fakeExec(
      () =>
        new Promise<Partial<RtkExecResult>>((resolve) => {
          resolveExec = resolve;
        }),
    );

    const first = rtk.rewriteCommand("concurrent cmd", { exec });
    const second = rtk.rewriteCommand("concurrent cmd", { exec });
    resolveExec({ code: 0, stdout: "rtk concurrent cmd\n" });

    await expect(first).resolves.toBe("rtk concurrent cmd");
    await expect(second).resolves.toBe("rtk concurrent cmd");
    expect(calls).toHaveLength(1);
  });
});

describe("createRtk", () => {
  it("short-circuits without exec when enabled is false", async () => {
    const { exec, calls } = fakeExec(() => ({ code: 0, stdout: "rtk 0.23.0\n" }));
    const client = rtk.createRtk(exec, { enabled: false });

    await expect(client.rewrite("git status")).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("short-circuits without exec when RTK_DISABLED is set", async () => {
    process.env.RTK_DISABLED = "1";
    const { exec, calls } = fakeExec(() => ({ code: 0, stdout: "rtk 0.23.0\n" }));
    const client = rtk.createRtk(exec);

    await expect(client.rewrite("git status")).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("probes rtk once and rewrites commands when available", async () => {
    const { exec, calls } = fakeExec((_program, args) =>
      args[0] === "--version"
        ? { code: 0, stdout: "rtk 0.23.0\n" }
        : { code: 0, stdout: "rtk git status\n" },
    );
    const client = rtk.createRtk(exec);

    await expect(client.rewrite("git status")).resolves.toBe("rtk git status");
    await expect(client.rewrite("git status")).resolves.toBe("rtk git status");

    expect(calls.map((c) => c.args[0])).toEqual(["--version", "rewrite"]);
  });

  it("warns once when rtk is unavailable and rewrites nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { exec, calls } = fakeExec(() => ({ code: 127, stderr: "command not found" }));
      const client = rtk.createRtk(exec);

      await expect(client.rewrite("git status")).resolves.toBeNull();
      await expect(client.rewrite("git add .")).resolves.toBeNull();

      expect(calls).toHaveLength(1); // only the probe
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
