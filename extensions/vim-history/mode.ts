import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";

export type Mode = "insert" | "normal";
export type Action =
  | "insert"
  | "escape"
  | "up"
  | "down"
  | "halfUp"
  | "halfDown"
  | "bottom"
  | "ignore";

export class NormalKeys {
  next(data: string): Action {
    if (isKeyRelease(data)) return "ignore";
    if (matchesKey(data, "escape")) return "escape";
    if (matchesKey(data, "i") || matchesKey(data, "a")) return "insert";
    if (matchesKey(data, "k")) return "up";
    if (matchesKey(data, "j")) return "down";
    if (matchesKey(data, "ctrl+u")) return "halfUp";
    if (matchesKey(data, "ctrl+d")) return "halfDown";
    if (matchesKey(data, "shift+g")) return "bottom";
    return "ignore";
  }
}
