import type {
  ExtensionAPI,
  ExtensionContext,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Keybinding, KeyId } from "@earendil-works/pi-tui";
import { VimHistoryEditor } from "./modal-editor.ts";

type EditorFactory = NonNullable<
  ReturnType<ExtensionContext["ui"]["getEditorComponent"]>
>;

// Clear the footer entry left by older versions; mode is now editor-only.
const STATUS = "vim-history";
const OWN_KEYS: readonly KeyId[] = [
  "escape",
  "ctrl+c",
  "j",
  "k",
  "ctrl+u",
  "ctrl+d",
  "shift+g",
  "i",
  "a",
];
const VIEWPORT_ACTIONS: readonly Keybinding[] = [
  "tui.altScreen.pageUp",
  "tui.altScreen.pageDown",
  "tui.altScreen.halfPageUp",
  "tui.altScreen.halfPageDown",
  "tui.altScreen.lineUp",
  "tui.altScreen.lineDown",
  "tui.altScreen.previousPrompt",
  "tui.altScreen.nextPrompt",
  "tui.altScreen.search",
  "tui.altScreen.top",
  "tui.altScreen.bottom",
];

export function viewportConflicts(kb: KeybindingsManager): string[] {
  return VIEWPORT_ACTIONS.flatMap((action) =>
    kb
      .getKeys(action)
      .filter((key) => OWN_KEYS.includes(key))
      .map((key) => `${action}: ${key}`),
  );
}

export default function vimHistory(pi: ExtensionAPI): void {
  let ownedFactory: EditorFactory | undefined;
  let editor: VimHistoryEditor | undefined;
  let owner: ExtensionContext | undefined;

  function install(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    ctx.ui.setStatus(STATUS, undefined);
    if (ctx.ui.getEditorComponent() === ownedFactory && ownedFactory) {
      editor?.reset();
      return;
    }
    if (ctx.ui.getEditorComponent()) {
      ctx.ui.notify(
        "vim-history 未启用：已有其他自定义编辑器，不能自动覆盖",
        "warning",
      );
      return;
    }
    owner = ctx;
    ownedFactory = (tui, theme, kb) => {
      const conflicts = viewportConflicts(kb);
      if (conflicts.length)
        ctx.ui.notify(
          `vim-history 按键可能被全屏动作优先消费：${conflicts.join("；")}。请自行调整 /hotkeys 对应绑定`,
          "warning",
        );
      editor = new VimHistoryEditor(tui, theme, kb, {
        styleModeLabel: (mode, label) =>
          ctx.ui.theme.fg(mode === "insert" ? "success" : "accent", label),
        interruptIfRunning: () => {
          if (ctx.isIdle()) return false;
          ctx.abort();
          return true;
        },
      });
      if (tui.mode !== "fullscreen")
        ctx.ui.notify(
          "vim-history：regular 模式保持普通输入；请使用 /settings 或 --tui-mode fullscreen 启用历史导航",
          "info",
        );
      return editor;
    };
    ctx.ui.setEditorComponent(ownedFactory);
  }

  pi.on("session_start", (_event, ctx) => install(ctx));
  pi.on("session_tree", () => editor?.reset());
  pi.on("session_shutdown", () => {
    editor?.dispose();
    if (owner && ownedFactory && owner.ui.getEditorComponent() === ownedFactory)
      owner.ui.setEditorComponent(undefined);
    owner?.ui.setStatus(STATUS, undefined);
    editor = undefined;
    owner = undefined;
    ownedFactory = undefined;
  });
}
