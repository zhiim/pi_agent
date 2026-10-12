import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Container,
  ScrollView,
  Text,
  TuiMainScreen,
  VStack,
} from "@earendil-works/pi-tui";
import { HistoryScrollAdapter } from "../history-scroll.ts";
import { makeTui, MemoryTerminal } from "./helpers.ts";

test("native history direction, half-page resize and bottom following", () => {
  const { tui, terminal } = makeTui();
  const document = new Container();
  document.addChild(
    new Text(
      Array.from({ length: 100 }, (_, i) => `row ${i}`).join("\n"),
      0,
      0,
    ),
  );
  const viewport = new ScrollView(document, {
    primary: true,
    follow: "end",
    scrollbar: "hidden",
  });
  tui.setLayoutRoot(new VStack([{ component: viewport, grow: 1, basis: 0 }]));
  tui.start();
  tui.renderNow();
  const history = new HistoryScrollAdapter(tui);
  const bottom = tui.viewportTop;
  history.line(-1);
  assert.equal(tui.viewportTop, bottom - 1);
  history.halfPage(-1);
  assert.equal(tui.viewportTop, bottom - 11);
  terminal.rows = 10;
  tui.renderNow();
  const top = tui.viewportTop;
  history.halfPage(1);
  assert.equal(tui.viewportTop, top + 5);
  history.bottom();
  assert.equal(tui.isFollowingOutput, true);
  tui.stop();
});

test("regular renderer has no history capability", () => {
  const history = new HistoryScrollAdapter(
    new TuiMainScreen(new MemoryTerminal()),
  );
  assert.equal(history.available, false);
  history.line(-1);
  history.halfPage(1);
  history.bottom();
});
