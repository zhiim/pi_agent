import type { TUI } from "@earendil-works/pi-tui";

export interface HistoryTUI extends TUI {
  scrollBy(lines: number): void;
  scrollToBottom(): void;
}

export function hasHistory(tui: TUI): tui is HistoryTUI {
  return (
    tui.mode === "fullscreen" &&
    "scrollBy" in tui &&
    typeof tui.scrollBy === "function" &&
    "scrollToBottom" in tui &&
    typeof tui.scrollToBottom === "function"
  );
}

export class HistoryScrollAdapter {
  constructor(private readonly tui: TUI) {}

  get available(): boolean {
    return hasHistory(this.tui);
  }

  line(direction: -1 | 1): void {
    if (hasHistory(this.tui)) this.tui.scrollBy(direction);
  }

  halfPage(direction: -1 | 1): void {
    if (hasHistory(this.tui))
      this.tui.scrollBy(
        direction * Math.max(1, Math.floor(this.tui.terminal.rows / 2)),
      );
  }

  bottom(): void {
    if (hasHistory(this.tui)) this.tui.scrollToBottom();
  }
}
