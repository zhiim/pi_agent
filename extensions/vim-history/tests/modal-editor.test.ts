import assert from "node:assert/strict";
import { test } from "node:test";
import { KeybindingsManager } from "#host-keybindings";
import { getEditorTheme, setTheme, theme } from "#host-theme";
import {
  Container,
  CURSOR_MARKER,
  ScrollView,
  Text,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  VStack,
} from "@earendil-works/pi-tui";
import { VimHistoryEditor } from "../modal-editor.ts";
import { makeTui } from "./helpers.ts";

function setup() {
  const { tui, terminal } = makeTui();
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
  const document = new Container();
  document.addChild(new Text("history line\n".repeat(100), 0, 0));
  const scroll = new ScrollView(document, {
    primary: true,
    follow: "end",
    scrollbar: "hidden",
  });
  tui.addChild(document);
  tui.setLayoutRoot(
    new VStack([
      { component: scroll, grow: 1, basis: 0 },
      { component: editor, basis: "auto" },
    ]),
  );
  tui.setFocus(editor);
  tui.start();
  tui.renderNow();
  return { tui, terminal, editor };
}

test("insert -> normal -> insert preserves draft and cursor, G follows bottom", () => {
  const { tui, editor } = setup();
  editor.handleInput("中文 draft");
  editor.handleInput("\x1b[D");
  const draft = editor.getText();
  editor.handleInput("\x1b");
  assert.equal(editor.vimMode, "normal");
  const bottom = tui.viewportTop;
  editor.handleInput("k");
  assert.equal(tui.viewportTop, bottom - 1);
  editor.handleInput("\x15");
  assert.equal(tui.viewportTop, bottom - 11);
  editor.handleInput("\x04");
  assert.equal(tui.viewportTop, bottom - 1);
  for (const data of ["hello", "\r", "\x7f", "\t", "\x1b[200~i[[jG\x1b[201~"])
    editor.handleInput(data);
  assert.equal(editor.getText(), draft);
  assert.equal(editor.vimMode, "normal");
  editor.handleInput("G");
  assert.equal(tui.isFollowingOutput, true);
  assert.equal(editor.vimMode, "normal");
  editor.handleInput("a");
  assert.equal(editor.vimMode, "insert");
  editor.handleInput("X");
  assert.equal(editor.getText(), "中文 drafXt");
  tui.stop();
  editor.dispose();
});

test("bridge preparation enters INSERT before native paste, preserving draft cursor and following output", () => {
  const { tui, editor } = setup();
  try {
    editor.handleInput("draft");
    editor.handleInput("\x1b[D");
    const cursor = editor.getCursor();
    editor.handleInput("\x1b");
    editor.handleInput("k");
    assert.equal(tui.isFollowingOutput, false);
    // Ordinary terminal paste is still ignored in NORMAL.
    editor.handleInput("\x1b[200~ignored\x1b[201~");
    assert.equal(editor.getText(), "draft");
    assert.equal(editor.vimMode, "normal");

    let submits = 0;
    editor.onSubmit = () => submits++;
    editor.enterInsertMode();
    assert.equal(editor.vimMode, "insert");
    assert.deepEqual(editor.getCursor(), cursor);
    assert.equal(tui.isFollowingOutput, true);
    assert.equal(editor.getText(), "draft");
    const selection = "Path: /tmp/example.ts\nLines: 1-2\n\niG[[中文\nsecond line";
    editor.handleInput(`\x1b[200~${selection}\x1b[201~`);
    assert.equal(editor.getExpandedText(), `draf${selection}t`);
    assert.equal(submits, 0);
    assert.ok(editor.render(60).some((line) => line.includes(CURSOR_MARKER)));
    editor.enterInsertMode();
    editor.handleInput("\x1b[200~again\x1b[201~");
    assert.equal(editor.getExpandedText(), `draf${selection}againt`);
  } finally {
    tui.stop();
    editor.dispose();
  }
});

test("bridge preparation does not revive a disposed editor", () => {
  const { tui, editor } = setup();
  editor.handleInput("\x1b");
  editor.dispose();
  editor.enterInsertMode();
  assert.equal(editor.vimMode, "normal");
  tui.stop();
});

test("empty normal Ctrl+D does not exit, first Esc does not interrupt", () => {
  const { tui, editor } = setup();
  let interrupts = 0,
    exits = 0,
    submits = 0;
  editor.onEscape = () => interrupts++;
  editor.onCtrlD = () => exits++;
  editor.onSubmit = () => submits++;
  editor.handleInput("\x1b");
  assert.equal(interrupts, 0);
  editor.handleInput("\x04");
  editor.handleInput("\r");
  assert.equal(exits, 0);
  assert.equal(submits, 0);
  editor.handleInput("\x1b");
  assert.equal(interrupts, 1);
  tui.stop();
  editor.dispose();
});

test("colored mode label follows the theme and stays at the bottom right", () => {
  const { tui, editor } = setup();
  try {
    for (const name of ["dark", "light"]) {
      assert.equal(setTheme(name, false).success, true);
      for (const mode of ["insert", "normal"] as const) {
        if (editor.vimMode !== mode)
          editor.handleInput(mode === "normal" ? "\x1b" : "i");
        const text = ` ${mode.toUpperCase()} `;
        const label = theme.fg(mode === "insert" ? "success" : "accent", text);
        assert.notEqual(label, text);
        const border = editor.render(40).at(-1)!;
        assert.ok(border.endsWith(label));
        assert.equal(visibleWidth(border), 40);
        assert.ok(stripTerminalSequences(border).endsWith(text));
      }
    }
  } finally {
    setTheme("dark", false);
    tui.stop();
    editor.dispose();
  }
});

test("normal hides cursor marker and colored border fits narrow widths", () => {
  const { tui, editor } = setup();
  editor.setText("中文🙂long draft");
  assert.equal(
    editor.render(40).some((line) => line.includes(CURSOR_MARKER)),
    true,
  );
  editor.handleInput("\x1b");
  assert.equal(
    editor.render(40).some((line) => line.includes(CURSOR_MARKER)),
    false,
  );
  for (const width of [1, 5, 9, 20]) {
    for (const line of editor.render(width))
      assert.ok(
        visibleWidth(line) <= width,
        `${visibleWidth(line)} > ${width}: ${truncateToWidth(line, 30)}`,
      );
  }
  editor.handleInput("i");
  assert.equal(
    editor.render(40).some((line) => line.includes(CURSOR_MARKER)),
    true,
  );
  tui.stop();
  editor.dispose();
});

test("removed bracket shortcuts do not scroll or change draft in normal", () => {
  const { tui, editor } = setup();
  editor.setText("draft");
  editor.handleInput("\x1b");
  const top = tui.viewportTop;
  for (const data of [
    "[[",
    "]]",
    "[",
    "[",
    "]",
    "]",
    "\x1b[91;1u",
    "\x1b[91;1u",
    "\x1b[93;1u",
    "\x1b[93;1u",
  ])
    editor.handleInput(data);
  assert.equal(tui.viewportTop, top);
  assert.equal(editor.getText(), "draft");
  assert.equal(editor.vimMode, "normal");
  editor.handleInput("[j");
  assert.equal(tui.viewportTop, top); // Already at the bottom.
  editor.handleInput("[k");
  assert.equal(tui.viewportTop, top - 1);
  editor.handleInput("i");
  editor.handleInput("G[[]]");
  assert.equal(editor.getText(), "draftG[[]]");
  tui.stop();
  editor.dispose();
});

test("Kitty release does not switch modes, fragmented paste stays ignored", () => {
  const { tui, editor } = setup();
  editor.handleInput("\x1b[27;1u");
  assert.equal(editor.vimMode, "normal");
  editor.handleInput("\x1b[105;1:3u");
  assert.equal(editor.vimMode, "normal");
  editor.handleInput("\x1b[200~");
  editor.handleInput("iG[[");
  editor.handleInput("\x1b[201~");
  assert.equal(editor.vimMode, "normal");
  assert.equal(editor.getText(), "");
  editor.handleInput("\x1b[105;1u");
  assert.equal(editor.vimMode, "insert");
  tui.stop();
  editor.dispose();
});
