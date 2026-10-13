import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  permissionToolInputFromToolCall,
  permissionToolInputsFromToolCall,
} from "../src/tool-input.js";

const CWD = "/repo";

function readEvent(input: Record<string, unknown>): ToolCallEvent {
  return {
    toolCallId: "call-1",
    toolName: "read",
    input,
  } as unknown as ToolCallEvent;
}

describe("permissionToolInputFromToolCall — read", () => {
  // Regression: pi-better-edit's read payload is `file`, so reading only
  // `event.input.path` fed `undefined` into `path.isAbsolute`, which threw
  // `The "path" argument must be of type string. Received undefined` and the
  // thrown tool_call hook surfaced as the read tool's error result.
  it("accepts the unified `file` field", () => {
    const tool = permissionToolInputFromToolCall(readEvent({ file: "data/corpus.json" }), CWD);
    expect(tool).toMatchObject({
      toolName: "read",
      path: "data/corpus.json",
      absolutePath: "/repo/data/corpus.json",
      projectPath: "data/corpus.json",
    });
  });

  it("keeps the builtin `path` field working", () => {
    const tool = permissionToolInputFromToolCall(readEvent({ path: "data/corpus.json" }), CWD);
    expect(tool).toMatchObject({
      toolName: "read",
      path: "data/corpus.json",
      absolutePath: "/repo/data/corpus.json",
    });
  });

  it("keeps the deprecated `file_path` field working", () => {
    const tool = permissionToolInputFromToolCall(readEvent({ file_path: "data/corpus.json" }), CWD);
    expect(tool).toMatchObject({
      toolName: "read",
      path: "data/corpus.json",
      absolutePath: "/repo/data/corpus.json",
    });
  });
});

describe("permissionToolInputsFromToolCall — read batch", () => {
  // Regression: pi-better-edit's read payload is `files: [{ file }]`, which leaves every
  // scalar path key absent. Resolving one scalar path fed `undefined` into
  // `path.isAbsolute`, and the thrown `tool_call` hook surfaced as the read tool's own
  // error — so a batched read could not be permission-evaluated at all.
  it("judges every file a batch read names", () => {
    const tools = permissionToolInputsFromToolCall(
      readEvent({ files: [{ file: "a.md", mode: "verbatim" }, { file: "b.png" }] }),
      CWD,
    );

    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({
      toolName: "read",
      path: "a.md",
      absolutePath: "/repo/a.md",
      projectPath: "a.md",
    });
    expect(tools[1]).toMatchObject({ toolName: "read", path: "b.png" });
  });

  it("falls back to the legacy keys when `files` names nothing", () => {
    const tools = permissionToolInputsFromToolCall(readEvent({ files: [], path: "a.md" }), CWD);

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ toolName: "read", path: "a.md" });
  });

  it("names the tool instead of leaking a Node type error", () => {
    // Fail closed with a legible message: the old code threw `ERR_INVALID_ARG_TYPE`
    // ("The \"path\" argument must be of type string. Received undefined").
    expect(() => permissionToolInputsFromToolCall(readEvent({}), CWD)).toThrowError(
      /No file path in this read payload/,
    );
    expect(() =>
      permissionToolInputsFromToolCall(
        readEvent({ files: [{ file: "a.md" }, { mode: "verbatim" }] }),
        CWD,
      ),
    ).toThrowError(/No file path in this read payload/);
  });

  it("reports the first target from the single-target API", () => {
    const tool = permissionToolInputFromToolCall(
      readEvent({ files: [{ file: "a.md" }, { file: "b.png" }] }),
      CWD,
    );

    expect(tool).toMatchObject({ toolName: "read", path: "a.md" });
  });
});
