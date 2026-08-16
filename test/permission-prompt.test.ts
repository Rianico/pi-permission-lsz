import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { PermissionHighlight } from "../src/highlight.js";
import { openExternalEditor } from "../src/ui/external-editor.js";
import { type PermissionGateResult, showPermissionGate } from "../src/ui/permission-prompt.js";

vi.mock("../src/ui/external-editor.js", () => ({ openExternalEditor: vi.fn() }));

const KEY = {
  enter: "\r",
  escape: "\x1b",
  tab: "\t",
  shiftTab: "\x1b[Z",
  up: "\x1b[A",
  down: "\x1b[B",
  shiftUp: "\x1b[a",
  shiftDown: "\x1b[b",
  backspace: "\x7f",
  ctrlR: "\x12",
  ctrlG: "\x07",
  ctrlS: "\x13",
} as const;

const LABELS = { approveLabel: "Authorize", rejectLabel: "Abort", editLabel: "Edit" };

type Overlay = {
  handleInput(data: string): void;
  render(width: number): string[];
  focused: boolean;
};

type Harness = {
  overlay: Overlay;
  result(): PermissionGateResult | undefined;
  type(...keys: string[]): void;
  render(): string[];
};

function mount(
  editable?: { command: string },
  opts?: { highlight?: PermissionHighlight; rows?: number },
): Harness {
  let overlay: Overlay | undefined;
  let result: PermissionGateResult | undefined;

  const theme = {
    // Make the warning color visible so highlighted fragments are observable.
    fg: (color: string, text: string) => (color === "warning" ? `[[${text}]]` : text),
    bold: (text: string) => text,
    inverse: (text: string) => text,
  };
  const tui = {
    requestRender() {},
    terminal: { rows: opts?.rows ?? 40, cols: 80 },
    stop() {},
    start() {},
  };
  const keybindings = {
    matches: (data: string, id: string) => id === "app.editor.external" && data === KEY.ctrlG,
  };

  const ctx = {
    cwd: process.cwd(),
    isProjectTrusted: () => false,
    ui: {
      theme,
      custom<T>(
        factory: (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
          done: (value: T) => void,
        ) => Overlay,
      ): Promise<T> {
        return new Promise<T>((resolve) => {
          overlay = factory(tui, theme, keybindings, resolve as (value: T) => void);
          overlay.focused = true;
        });
      },
    },
  } as unknown as ExtensionContext;

  void showPermissionGate(ctx, {
    name: "! Authorization required: Git",
    header: "message",
    toolName: "bash",
    detail: editable?.command ?? "some detail",
    labels: LABELS,
    ...(opts?.highlight !== undefined ? { highlight: opts.highlight } : {}),
    ...(editable ? { editable } : {}),
  }).then((value) => {
    result = value;
  });

  if (!overlay) throw new Error("overlay not mounted");

  return {
    overlay,
    result: () => result,
    type: (...keys: string[]) => {
      for (const key of keys) overlay?.handleInput(key);
    },
    render: () => overlay?.render(60) ?? [],
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("permission prompt edit mode", () => {
  it("edits a bash command and returns the edited command", async () => {
    const h = mount({ command: "git commit -m hi" });
    h.type("2", "X", KEY.enter);
    await flush();
    expect(h.result()).toEqual({ kind: "edit", command: "git commit -m hiX" });
  });

  it("degrades an unchanged submit to a plain approval", async () => {
    const h = mount({ command: "git commit -m hi" });
    h.type("2", KEY.enter);
    await flush();
    expect(h.result()).toEqual({ kind: "allow" });
  });

  it("keeps an unchanged submit with a note as approve-with-note", async () => {
    const h = mount({ command: "git commit -m hi" });
    h.type("2", KEY.tab, "n", "o", "t", "e", KEY.enter);
    await flush();
    expect(h.result()).toEqual({ kind: "allow", note: "note" });
  });

  it("emits a full edit note when the command changed and a note was given", async () => {
    const h = mount({ command: "git commit -m hi" });
    h.type("2", "X", KEY.tab, "w", "h", "y", KEY.enter);
    await flush();
    expect(h.result()).toEqual({ kind: "edit", command: "git commit -m hiX", note: "why" });
  });

  it("runs the original command when the edit is escaped then authorized", async () => {
    const h = mount({ command: "git commit -m hi" });
    h.type("2", "X", KEY.escape, "1");
    await flush();
    expect(h.result()).toEqual({ kind: "allow" });
  });

  it("retains the note draft across an escape back to select mode", async () => {
    const h = mount({ command: "git commit -m hi" });
    h.type("2", KEY.tab, "k", "e", "e", "p", KEY.escape, "2", KEY.enter);
    await flush();
    expect(h.result()).toEqual({ kind: "allow", note: "keep" });
  });

  it("seeds the note field from the Edit choice's tab draft", async () => {
    const h = mount({ command: "git commit -m hi" });
    h.type(KEY.down, KEY.tab, "s", "e", "e", "d", KEY.enter, KEY.enter);
    await flush();
    expect(h.result()).toEqual({ kind: "allow", note: "seed" });
  });

  it("refuses a blank command and shows a warning without resolving", async () => {
    const h = mount({ command: "x" });
    h.type("2", KEY.backspace, KEY.enter);
    await flush();
    expect(h.result()).toBeUndefined();
    expect(h.render().join("\n")).toContain("An empty command achieves nothing");
  });

  it("runs the expanded paste content, not the collapsed marker, when submitting from the note field", async () => {
    const h = mount({ command: "git commit -m hi" });
    const pasted = `echo ${"a".repeat(1100)}`;
    h.type("2", `\x1b[200~${pasted}\x1b[201~`);
    // submit from the note field, the path that previously used raw getText()
    h.type(KEY.tab, KEY.enter);
    await flush();
    const result = h.result();
    expect(result?.kind).toBe("edit");
    expect(result).toEqual({ kind: "edit", command: `git commit -m hi${pasted}` });
    expect((result as { command: string }).command).not.toContain("[paste #");
  });

  it("ctrl+r toggles between edits and the original, preserving edits on round trip", async () => {
    const h = mount({ command: "git commit -m hi" });
    h.type("2", "X"); // buffer: "git commit -m hiX"
    h.type(KEY.ctrlR); // stash edits, show original
    expect(h.render().join("\n")).toContain("git commit -m hi");
    h.type(KEY.ctrlR); // swap the edits back in
    h.type(KEY.enter);
    await flush();
    expect(h.result()).toEqual({ kind: "edit", command: "git commit -m hiX" });
  });

  it("submits the original as a plain approval when ctrl+r is showing it", async () => {
    const h = mount({ command: "git commit -m hi" });
    h.type("2", "X", KEY.ctrlR, KEY.enter); // edit, toggle to original, submit
    await flush();
    expect(h.result()).toEqual({ kind: "allow" });
  });

  it("discards the stash when the buffer is modified while showing the original", async () => {
    const h = mount({ command: "git commit -m hi" });
    h.type("2", "X"); // buffer: "git commit -m hiX"
    h.type(KEY.ctrlR); // stash X, show original
    h.type("Y"); // modify original -> stash discarded, buffer: "git commit -m hiY"
    h.type(KEY.ctrlR, KEY.ctrlR); // round trip must preserve Y, not resurrect X
    const buffer = h.render().join("\n");
    expect(buffer).toContain("git commit -m hiY");
    expect(buffer).not.toContain("git commit -m hiX");
  });

  it("preserves the stash across esc and re-entering edit mode", async () => {
    const h = mount({ command: "git commit -m hi" });
    h.type("2", "X", KEY.ctrlR); // stash X, show original
    h.type(KEY.escape, "2"); // back to select, re-enter edit
    h.type(KEY.ctrlR); // restore the stashed edits
    h.type(KEY.enter);
    await flush();
    expect(h.result()).toEqual({ kind: "edit", command: "git commit -m hiX" });
  });

  it("treats an external-editor return as a modification that discards the stash", async () => {
    vi.mocked(openExternalEditor).mockResolvedValue("git commit -m external");
    const h = mount({ command: "git commit -m hi" });
    h.type("2", "X"); // buffer: "git commit -m hiX"
    h.type(KEY.ctrlR); // stash X, show original
    h.type(KEY.ctrlG); // external editor returns a modification
    await flush();
    // the return replaced the buffer and discarded the stash: a round trip
    // preserves the external content rather than resurrecting "hiX"
    h.type(KEY.ctrlR, KEY.ctrlR);
    const buffer = h.render().join("\n");
    expect(buffer).toContain("git commit -m external");
    expect(buffer).not.toContain("git commit -m hiX");
  });

  it("keeps j/k navigating onto a choice that carries a note draft", async () => {
    const h = mount({ command: "git commit -m hi" });
    // put a note on the Edit choice, close editing, move back to Authorize
    h.type(KEY.down, KEY.tab, "n", "o", "t", "e", KEY.shiftTab, KEY.up);
    // j moves onto Edit (which carries the note); k must move back off rather
    // than type into the note
    h.type("j", "k", KEY.enter);
    await flush();
    expect(h.result()).toEqual({ kind: "allow" });
  });

  it("toggles fields with shift+tab as well as tab", async () => {
    const h = mount({ command: "git commit -m hi" });
    // enter edit (command focused), shift+tab to the note field, type a note
    h.type("2", KEY.shiftTab, "n", "o", "t", "e", KEY.enter);
    await flush();
    expect(h.result()).toEqual({ kind: "allow", note: "note" });
  });

  it("shows one cursor and a contextual legend as focus moves between fields", async () => {
    const h = mount({ command: "git commit -m hi" });
    h.type("2");
    // command field: editor paints its inverse cursor, shift+enter is offered
    const command = h.render().join("\n");
    expect(command).toContain("\x1b[7m");
    expect(command).toContain("shift+enter");

    h.type(KEY.tab);
    // note field: command editor cursor is stripped, shift+enter is hidden
    const note = h.render().join("\n");
    expect(note).not.toContain("\x1b[7m");
    expect(note).not.toContain("shift+enter");
  });

  it("previews the edited command plain under Edit, the highlighted original otherwise", async () => {
    const h = mount({ command: "git stash lst" }, { highlight: /git stash \w+/ });
    // Accept highlighted: original with its frozen highlight
    expect(h.render().join("\n")).toContain("[[git stash lst]]");

    // edit, esc back with Edit highlighted: the live buffer, no highlight
    h.type("2", "X", KEY.escape);
    const edit = h.render().join("\n");
    expect(edit).toContain("git stash lstX");
    expect(edit).not.toContain("[[");

    // move up to Accept: the original with its highlight again, not the edit
    h.type(KEY.up);
    const accept = h.render().join("\n");
    expect(accept).toContain("[[git stash lst]]");
    expect(accept).not.toContain("git stash lstX");
  });

  it("frames the detail in an inner box labeled with the tool name", () => {
    const h = mount({ command: "git commit -m hi" });
    const lines = h.render();
    const top = lines.findIndex((line) => line.includes("╭─ bash "));
    const bottom = lines.findIndex((line) => line.includes("╰"));

    expect(top).toBeGreaterThan(-1);
    expect(bottom).toBeGreaterThan(top);
    expect(lines.slice(top + 1, bottom).join("\n")).toContain("git commit -m hi");
  });

  it("offers no edit choice for non-bash tool calls", async () => {
    const h = mount();
    expect(h.render().join("\n")).not.toContain("Edit");
    h.type("2");
    await flush();
    expect(h.result()).toEqual({ kind: "reject", abort: true });
  });
});

describe("permission prompt body scrolling", () => {
  const longCommand = `git commit -m "${"word ".repeat(400)}TAIL_MARKER"`;

  it("windows a tall body so the options and legend stay on screen", () => {
    const h = mount({ command: longCommand });
    const lines = h.render();
    const text = lines.join("\n");

    // fits the 40-row terminal from the mount harness
    expect(lines.length).toBeLessThanOrEqual(38);
    expect(text).toContain("Authorize");
    expect(text).toContain("↑↓ select");
    expect(text).toContain("f/b scroll");
    expect(text).toContain("shift+↑↓");
    expect(text).toContain("↓");
    expect(text).toContain("more");
    expect(text).not.toContain("TAIL_MARKER");
  });

  it("pages forward with f and back with b, marking off-screen lines in the borders", () => {
    const h = mount({ command: longCommand });
    h.render(); // establish the window before scrolling

    // The detail window is only a few lines under the 61.8% height cap, so
    // reaching the tail takes many f presses; the scroll clamps at the end.
    h.type(...Array.from({ length: 40 }, () => "f"));
    const scrolled = h.render().join("\n");
    expect(scrolled).toContain("TAIL_MARKER");
    expect(scrolled).toMatch(/↑ \d+/);

    h.type(...Array.from({ length: 40 }, () => "b"));
    const back = h.render().join("\n");
    expect(back).not.toContain("TAIL_MARKER");
    expect(back).toMatch(/↓ \d+ more/);
    expect(back).not.toMatch(/↑ \d+/);
  });

  it("leaves f/b inert and unwindowed when the body fits", async () => {
    const h = mount({ command: "git commit -m hi" });
    h.render();
    h.type("f", "b");
    const text = h.render().join("\n");
    expect(text).not.toContain("f/b scroll");
    expect(text).not.toContain("more");
    expect(h.result()).toBeUndefined();
  });

  it("still types f and b into an open note draft", async () => {
    const h = mount({ command: longCommand });
    h.render();
    h.type(KEY.tab, "f", "b", KEY.enter);
    await flush();
    expect(h.result()).toEqual({ kind: "allow", note: "fb" });
  });

  it("scrolls the detail one line at a time with shift+up/down", () => {
    const h = mount({ command: longCommand });
    h.render();

    h.type(KEY.shiftDown);
    expect(h.render().join("\n")).toMatch(/↑ 1/);

    h.type(KEY.shiftDown);
    expect(h.render().join("\n")).toMatch(/↑ 2/);

    h.type(KEY.shiftUp);
    expect(h.render().join("\n")).toMatch(/↑ 1/);

    // paging still works from a line-scrolled position
    h.type("b");
    expect(h.render().join("\n")).not.toMatch(/↑ \d+/);
  });

  it("keeps shift+up/down inert when the body fits", async () => {
    const h = mount({ command: "git commit -m hi" });
    h.render();
    h.type(KEY.shiftUp, KEY.shiftDown);
    const text = h.render().join("\n");
    expect(text).not.toContain("more");
    expect(text).not.toContain("shift+↑↓");
    expect(h.result()).toBeUndefined();
  });

  it("ends the last visible line with an ellipsis while content hides below", () => {
    const h = mount({ command: longCommand });
    const lines = h.render();
    const bottomEdge = lines.findIndex((line) => line.includes("╰"));
    const lastContent = lines[bottomEdge - 1] ?? "";
    // rows carry both the outer frame and the inner box borders: `│ │ … │ │`
    const stripped = lastContent.replace(/^│ │ /, "").replace(/ │ │$/, "").trimEnd();
    expect(stripped.endsWith("...")).toBe(true);
    // the border tag below still reports the hidden line count
    expect(lines[bottomEdge]).toMatch(/↓ \d+ more/);
  });

  it("drops the ellipsis once the window reaches the end of the detail", () => {
    const h = mount({ command: longCommand });
    h.render();
    h.type(...Array.from({ length: 40 }, () => "f"));
    const lines = h.render();
    const bottomEdge = lines.findIndex((line) => line.includes("╰"));
    const lastContent = lines[bottomEdge - 1] ?? "";
    const stripped = lastContent.replace(/^│ │ /, "").replace(/ │ │$/, "").trimEnd();
    expect(stripped.endsWith("...")).toBe(false);
    expect(lastContent).toContain("TAIL_MARKER");
  });

  it("caps the whole prompt at 61.8% of a tall terminal", () => {
    const h = mount({ command: longCommand }, { rows: 60 });
    const lines = h.render();
    // 1-line header + 3 options: 13 skeleton lines + 22 window + 2 frame = 37,
    // exactly 61.8% of the 60-row terminal.
    expect(lines.length).toBe(Math.floor(60 * 0.618));
    const text = lines.join("\n");
    expect(text).toContain("Authorize");
    expect(text).toContain("↑↓ select");
    expect(text).toContain("f/b scroll");
  });

  it("keeps the natural height when the body fits under the cap", () => {
    const h = mount({ command: "git commit -m hi" }, { rows: 60 });
    const text = h.render().join("\n");
    expect(text).toContain("git commit -m hi");
    expect(text).not.toContain("f/b scroll");
    expect(text).not.toContain("more");
  });

  it("keeps the options and legend usable on terminals too short for the cap", () => {
    const h = mount({ command: longCommand }, { rows: 24 });
    const lines = h.render();
    const text = lines.join("\n");
    // 61.8% of 24 rows can't fit the fixed skeleton, so the prompt falls back to
    // its minimum: 13 skeleton + 3 detail lines + 2 frame, options intact.
    expect(lines.length).toBe(18);
    expect(text).toContain("Authorize");
    expect(text).toContain("↑↓ select");
    expect(text).toContain("f/b scroll");
  });
});

describe("permission prompt don't ask again", () => {
  it("allows for the session from select mode", async () => {
    const h = mount({ command: "git commit -m hi" });
    h.type(KEY.ctrlS);
    await flush();
    expect(h.result()).toEqual({ kind: "allow", forSession: true });
  });

  it("carries the Authorize note drafted before returning to select mode", async () => {
    const h = mount({ command: "git commit -m hi" });
    h.type(KEY.tab, "w", "h", "y", KEY.shiftTab, KEY.ctrlS);
    await flush();
    expect(h.result()).toEqual({ kind: "allow", forSession: true, note: "why" });
  });

  it("commits mid-note without waiting for the note to be closed", async () => {
    const h = mount({ command: "git commit -m hi" });
    h.type(KEY.tab, "w", "h", "y", KEY.ctrlS);
    await flush();
    expect(h.result()).toEqual({ kind: "allow", forSession: true, note: "why" });
  });

  it("uses the Authorize note while a note on another choice is being edited", async () => {
    const h = mount({ command: "git commit -m hi" });
    // note on Authorize, then a competing note on Abort; only the first travels
    h.type(KEY.tab, "y", "e", "s", KEY.shiftTab);
    h.type(KEY.down, KEY.down, KEY.tab, "n", "o", KEY.ctrlS);
    await flush();
    expect(h.result()).toEqual({ kind: "allow", forSession: true, note: "yes" });
  });

  it("ignores ctrl+s once inside edit mode", async () => {
    const h = mount({ command: "git commit -m hi" });
    h.type("2", KEY.ctrlS);
    await flush();
    expect(h.result()).toBeUndefined();
  });

  it("advertises the outcome on a two-line select legend", () => {
    const h = mount({ command: "git commit -m hi" });
    const lines = h.render();
    const legendStart = lines.findIndex((line) => line.includes("↑↓"));

    expect(lines[legendStart]).toContain("ctrl+s don't ask again");
    expect(lines[legendStart]).toContain("enter confirm");
    expect(lines[legendStart + 1]).toContain("tab add note");
    expect(lines[legendStart + 1]).toContain("shift+tab close");
    expect(lines[legendStart + 1]).toContain("esc abort");
  });
});
