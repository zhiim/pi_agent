import { TuiAltScreen, type Terminal } from "@earendil-works/pi-tui";

export class MemoryTerminal implements Terminal {
  columns = 60;
  rows = 20;
  kittyProtocolActive = false;
  output = "";
  input: ((data: string) => void) | undefined;
  resize: (() => void) | undefined;
  start(onInput: (data: string) => void, onResize: () => void): void {
    this.input = onInput;
    this.resize = onResize;
  }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.output += data;
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(): void {}
}

export function makeTui(): { terminal: MemoryTerminal; tui: TuiAltScreen } {
  const terminal = new MemoryTerminal();
  const tui = new TuiAltScreen(terminal, true, undefined, { mouse: false });
  return { terminal, tui };
}
