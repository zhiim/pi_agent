import {
  CustomEditor,
  type AppKeybinding,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  isKeyRelease,
  matchesKey,
  StdinBuffer,
  truncateToWidth,
  visibleWidth,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import { HistoryScrollAdapter } from "./history-scroll.ts";
import { NormalKeys, type Mode } from "./mode.ts";

const NORMAL_APP_ACTIONS: readonly AppKeybinding[] = [
  "app.clear",
  "app.suspend",
  "app.model.select",
  "app.model.cycleForward",
  "app.model.cycleBackward",
  "app.thinking.cycle",
  "app.thinking.toggle",
  "app.tools.expand",
  "app.message.copy",
  "app.session.new",
  "app.session.tree",
  "app.session.fork",
  "app.session.resume",
];

export interface EditorCallbacks {
  styleModeLabel(mode: Mode, label: string): string;
  interruptIfRunning(): boolean;
}

export class VimHistoryEditor extends CustomEditor {
  private mode: Mode = "insert";
  private readonly keys = new NormalKeys();
  private readonly scroll: HistoryScrollAdapter;
  private inPaste = false;
  private bufferedPaste = "";
  private active = false;
  private disposed = false;
  private labelWidth: number | undefined;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    private readonly appKeys: KeybindingsManager,
    private readonly callbacks: EditorCallbacks,
  ) {
    super(tui, theme, appKeys);
    this.scroll = new HistoryScrollAdapter(tui);
    this.syncCapability();
  }

  get vimMode(): Mode {
    return this.mode;
  }

  reset(): void {
    this.mode = "insert";
    this.inPaste = false;
    this.bufferedPaste = "";
    this.tui.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
  }

  private syncCapability(): void {
    const active = this.scroll.available;
    if (active === this.active) return;
    this.active = active;
    this.mode = "insert";
  }

  private changeMode(mode: Mode): void {
    this.mode = mode;
    if (mode === "insert") this.scroll.bottom();
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.disposed || isKeyRelease(data)) return;
    this.syncCapability();
    // Track paste before inspecting control keys: a literal Ctrl+C inside
    // pasted input is text, not a request to abort the current agent run.
    if (this.active && (this.inPaste || data.includes("\x1b[200~"))) {
      if (this.mode === "insert") this.bufferedPaste += data;
      this.inPaste = !data.includes("\x1b[201~");
      if (!this.inPaste) {
        // CustomEditor's app actions run before its underlying paste handler,
        // so forward fragments only once the entire bracketed paste is ready.
        if (this.mode === "insert") super.handleInput(this.bufferedPaste);
        this.bufferedPaste = "";
      }
      return;
    }
    if (
      this.active &&
      matchesKey(data, "ctrl+c") &&
      this.callbacks.interruptIfRunning()
    )
      return;
    if (
      !this.active ||
      (this.mode === "insert" && !matchesKey(data, "escape"))
    ) {
      super.handleInput(data);
      return;
    }
    if (this.mode === "insert") {
      if (this.isShowingAutocomplete()) super.handleInput(data);
      this.changeMode("normal");
      return;
    }
    if (
      data.length === 1 ||
      (data.startsWith("\x1b") && !data.slice(1).includes("\x1b"))
    ) {
      this.handleNormalKey(data);
      return;
    }
    // Pi normally supplies complete keys. This also supports coalesced bursts,
    // without splitting Kitty/CSI sequences into printable characters.
    const buffer = new StdinBuffer();
    buffer.on("data", (key) => this.handleInput(key));
    try {
      buffer.process(data);
      buffer.flush();
    } finally {
      buffer.destroy();
    }
  }

  private handleNormalKey(data: string): void {
    if (isKeyRelease(data)) return;
    const action = this.keys.next(data);
    switch (action) {
      case "insert":
        this.changeMode("insert");
        break;
      case "escape":
        super.handleInput(data);
        break;
      case "up":
        this.scroll.line(-1);
        break;
      case "down":
        this.scroll.line(1);
        break;
      case "halfUp":
        this.scroll.halfPage(-1);
        break;
      case "halfDown":
        this.scroll.halfPage(1);
        break;
      case "bottom":
        this.scroll.bottom();
        break;
      case "ignore":
        if (
          NORMAL_APP_ACTIONS.some((action) =>
            this.appKeys.matches(data, action),
          )
        )
          super.handleInput(data);
        break;
    }
  }

  protected renderBottomBorder(width: number, hiddenLineCount: number): string {
    const border = super.renderBottomBorder(width, hiddenLineCount);
    if (!this.active) return border;
    const availableWidth = Math.max(
      0,
      Math.min(width, this.labelWidth ?? width),
    );
    const text = truncateToWidth(
      ` ${this.mode.toUpperCase()} `,
      availableWidth,
      "",
    );
    const label = this.callbacks.styleModeLabel(this.mode, text);
    return (
      truncateToWidth(
        border,
        Math.max(0, availableWidth - visibleWidth(label)),
        "",
      ) + label
    );
  }

  render(width: number): string[] {
    this.syncCapability();
    // Pi 1.1's word wrapper recurses on a wide grapheme in a one-column
    // content area. Render a safe minimum, then clip to the real terminal.
    const safeWidth = Math.max(width, 4 + this.getPaddingX() * 2);
    let lines: string[];
    this.labelWidth = width;
    try {
      lines = super.render(safeWidth);
    } finally {
      this.labelWidth = undefined;
    }
    if (width < safeWidth)
      lines = lines.map((line) =>
        truncateToWidth(line, Math.max(0, width), ""),
      );
    if (this.active && this.mode === "normal")
      lines = lines.map((line) => line.replaceAll(CURSOR_MARKER, ""));
    return lines;
  }
}
