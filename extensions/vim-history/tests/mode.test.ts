import assert from "node:assert/strict";
import { test } from "node:test";
import { NormalKeys } from "../mode.ts";

test("normal actions and uppercase G", () => {
  const keys = new NormalKeys();
  for (const [key, action] of [
    ["j", "down"],
    ["k", "up"],
    ["\x15", "halfUp"],
    ["\x04", "halfDown"],
    ["G", "bottom"],
    ["g", "ignore"],
    ["i", "insert"],
    ["a", "insert"],
    ["\x1b", "escape"],
  ])
    assert.equal(keys.next(key!), action);
});

test("removed bracket shortcuts are ignored without affecting subsequent keys", () => {
  const keys = new NormalKeys();
  for (const key of "[[]][[[[]]]]") assert.equal(keys.next(key), "ignore");
  assert.equal(keys.next("j"), "down");
  assert.equal(keys.next("["), "ignore");
  assert.equal(keys.next("i"), "insert");
});

test("Kitty press, release and repeat handling", () => {
  const keys = new NormalKeys();
  assert.equal(keys.next("\x1b[106;1u"), "down");
  assert.equal(keys.next("\x1b[106;1:2u"), "down");
  assert.equal(keys.next("\x1b[106;1:3u"), "ignore");
  assert.equal(keys.next("\x1b[103;2u"), "bottom");
  for (const event of [
    "\x1b[91;1u",
    "\x1b[91;1:2u",
    "\x1b[91;1:3u",
    "\x1b[91;1u",
    "\x1b[93;1u",
    "\x1b[93;1u",
  ])
    assert.equal(keys.next(event), "ignore");
});
