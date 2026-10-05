import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { permissionToolInputFromToolCall } from "../src/tool-input.js";

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
