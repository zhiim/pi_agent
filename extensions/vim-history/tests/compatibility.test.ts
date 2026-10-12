import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { KeybindingsManager } from "#host-keybindings";
import { getEditorTheme, theme } from "#host-theme";
import {
  CombinedAutocompleteProvider,
  stripTerminalSequences,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import { viewportConflicts } from "../index.ts";
import { VimHistoryEditor } from "../modal-editor.ts";
import { makeTui, MemoryTerminal } from "./helpers.ts";

test("autocomplete Esc cancels without interrupting and enters normal", async () => {
  const { tui } = makeTui();
  const editor = new VimHistoryEditor(
    tui,
    getEditorTheme(),
    new KeybindingsManager(),
    {
      styleModeLabel: (mode, label) =>
        theme.fg(mode === "insert" ? "success" : "accent", label),
      interruptIfRunning: () => false,
    },
  );
  tui.setFocus(editor);
  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider([{ name: "test-command" }], process.cwd()),
  );
  let interrupted = false;
  editor.onEscape = () => {
    interrupted = true;
  };
  editor.handleInput("/te");
  const deadline = Date.now() + 2000;
  while (!editor.isShowingAutocomplete() && Date.now() < deadline)
    await delay(10);
  assert.equal(editor.isShowingAutocomplete(), true);
  const lines = editor.render(60).map(stripTerminalSequences);
  const border = lines.findIndex((line) => line.endsWith(" INSERT "));
  assert.ok(
    border >= 0 && border < lines.length - 1,
    "Mode must stay on the input border, above the completion list",
  );
  assert.ok(lines[border]!.startsWith("─"));
  assert.equal(lines.filter((line) => line.includes(" INSERT ")).length, 1);
  editor.handleInput("\x1b");
  assert.equal(editor.isShowingAutocomplete(), false);
  assert.equal(editor.vimMode, "normal");
  assert.equal(interrupted, false);
  editor.dispose();
});

test("regular mode retains original editing and interrupt behavior", () => {
  const tui = new TuiMainScreen(new MemoryTerminal());
  let aborts = 0;
  const editor = new VimHistoryEditor(
    tui,
    getEditorTheme(),
    new KeybindingsManager(),
    {
      styleModeLabel: (mode, label) =>
        theme.fg(mode === "insert" ? "success" : "accent", label),
      interruptIfRunning: () => {
        aborts++;
        return true;
      },
    },
  );
  let interrupted = false;
  editor.onEscape = () => {
    interrupted = true;
  };
  editor.handleInput("\x1b");
  assert.equal(interrupted, true);
  editor.handleInput("G[[]]jki");
  assert.equal(editor.getText(), "G[[]]jki");
  assert.equal(editor.vimMode, "insert");
  let clears = 0;
  editor.onAction("app.clear", () => clears++);
  editor.handleInput("\x03");
  assert.equal(clears, 1);
  assert.equal(aborts, 0);
  editor.dispose();
});

test("NORMAL preserves allowed app actions but not edit/send actions", () => {
  const { tui } = makeTui();
  const editor = new VimHistoryEditor(
    tui,
    getEditorTheme(),
    new KeybindingsManager(),
    {
      styleModeLabel: (mode, label) =>
        theme.fg(mode === "insert" ? "success" : "accent", label),
      interruptIfRunning: () => false,
    },
  );
  tui.setFocus(editor);
  let models = 0,
    external = 0,
    send = 0;
  editor.onAction("app.model.select", () => models++);
  editor.onAction("app.editor.external", () => external++);
  editor.onAction("app.message.followUp", () => send++);
  editor.handleInput("\x1b");
  editor.handleInput("\x0c");
  editor.handleInput("\x07");
  editor.handleInput("\x1b\r");
  assert.equal(models, 1);
  assert.equal(external, 0);
  assert.equal(send, 0);
  editor.dispose();
});

test("Ctrl+C interrupts in INSERT and NORMAL without clearing the draft or moving the cursor", () => {
  for (const mode of ["insert", "normal"] as const) {
    const { tui } = makeTui();
    let aborts = 0,
      clears = 0;
    const editor = new VimHistoryEditor(
      tui,
      getEditorTheme(),
      new KeybindingsManager(),
      {
        styleModeLabel: (_mode, label) => label,
        interruptIfRunning: () => {
          aborts++;
          return true;
        },
      },
    );
    editor.onAction("app.clear", () => clears++);
    editor.handleInput("draft");
    editor.handleInput("\x1b[D");
    if (mode === "normal") editor.handleInput("\x1b");
    const cursor = editor.getCursor();
    for (const key of ["\x03", "\x1b[99;5u", "\x1b[99;5:2u"])
      editor.handleInput(key);
    editor.handleInput("\x1b[99;5:3u");
    assert.equal(aborts, 3);
    assert.equal(clears, 0);
    assert.equal(editor.getText(), "draft");
    assert.deepEqual(editor.getCursor(), cursor);
    assert.equal(editor.vimMode, mode);
    editor.dispose();
  }
});

test("idle Ctrl+C still delegates to native clear/exit in either mode", () => {
  for (const mode of ["insert", "normal"] as const) {
    const { tui } = makeTui();
    let clears = 0;
    const editor = new VimHistoryEditor(
      tui,
      getEditorTheme(),
      new KeybindingsManager(),
      {
        styleModeLabel: (_mode, label) => label,
        interruptIfRunning: () => false,
      },
    );
    editor.onAction("app.clear", () => clears++);
    editor.setText("draft");
    if (mode === "normal") editor.handleInput("\x1b");
    editor.handleInput("\x03");
    editor.handleInput("\x03");
    assert.equal(clears, 2);
    assert.equal(editor.vimMode, mode);
    editor.dispose();
  }
});

test("Ctrl+C aborts even with autocomplete visible", async () => {
  const { tui } = makeTui();
  let aborts = 0,
    clears = 0;
  const editor = new VimHistoryEditor(
    tui,
    getEditorTheme(),
    new KeybindingsManager(),
    {
      styleModeLabel: (_mode, label) => label,
      interruptIfRunning: () => {
        aborts++;
        return true;
      },
    },
  );
  editor.onAction("app.clear", () => clears++);
  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider([{ name: "test-command" }], process.cwd()),
  );
  editor.handleInput("/te");
  const deadline = Date.now() + 2000;
  while (!editor.isShowingAutocomplete() && Date.now() < deadline)
    await delay(10);
  assert.equal(editor.isShowingAutocomplete(), true);
  editor.handleInput("\x03");
  assert.equal(aborts, 1);
  assert.equal(clears, 0);
  assert.equal(editor.getText(), "/te");
  assert.equal(editor.vimMode, "insert");
  editor.dispose();
});

test("pasted Ctrl+C never aborts, but a Ctrl+C after a coalesced mode switch does", () => {
  for (const mode of ["insert", "normal"] as const) {
    const { tui } = makeTui();
    let aborts = 0,
      clears = 0;
    const editor = new VimHistoryEditor(
      tui,
      getEditorTheme(),
      new KeybindingsManager(),
      {
        styleModeLabel: (_mode, label) => label,
        interruptIfRunning: () => {
          aborts++;
          return true;
        },
      },
    );
    editor.onAction("app.clear", () => clears++);
    if (mode === "normal") editor.handleInput("\x1b");
    for (const chunk of [
      "\x1b[200~",
      "\x03",
      "\x1b[201~",
      "\x1b[200~\x03\x1b[201~",
    ])
      editor.handleInput(chunk);
    assert.equal(aborts, 0);
    assert.equal(clears, 0);
    assert.equal(editor.vimMode, mode);
    if (mode === "insert") editor.handleInput("\x1b");
    const draft = editor.getText();
    editor.handleInput("ji\x03");
    assert.equal(aborts, 1);
    assert.equal(clears, 0);
    assert.equal(editor.getText(), draft);
    assert.equal(editor.vimMode, "insert");
    editor.dispose();
  }
});

test("viewport key conflicts reported without changing bindings", () => {
  const kb = new KeybindingsManager({
    "tui.altScreen.lineUp": "k",
    "tui.altScreen.lineDown": "j",
  });
  assert.deepEqual(viewportConflicts(kb), [
    "tui.altScreen.lineUp: k",
    "tui.altScreen.lineDown: j",
  ]);
  assert.deepEqual(kb.getKeys("tui.altScreen.lineUp"), ["k"]);
});
