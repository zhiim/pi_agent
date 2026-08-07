import assert from "node:assert/strict";
import { test } from "node:test";
import {
  captureToolsActivatedDuringPlanMode,
  getPlanModeTools,
} from "./tool-policy.ts";

const toolsBeforePlanMode = [
  "read",
  "bash",
  "edit",
  "write",
  "mcp",
];

test("plan mode exposes only the read-only tool allowlist", () => {
  assert.deepEqual(getPlanModeTools(toolsBeforePlanMode), [
    "read",
    "bash",
    "grep",
    "find",
    "ls",
  ]);
});

test("plan mode preserves tools activated after its initial snapshot", () => {
  const activePlanningTools = [
    ...getPlanModeTools(toolsBeforePlanMode),
    "ctx_execute",
    "ctx_execute_file",
    "ctx_search",
  ];

  const restorationTools = captureToolsActivatedDuringPlanMode(
    toolsBeforePlanMode,
    activePlanningTools,
  );

  assert.deepEqual(restorationTools, [
    ...toolsBeforePlanMode,
    "ctx_execute",
    "ctx_execute_file",
    "ctx_search",
  ]);
  assert.deepEqual(getPlanModeTools(restorationTools), [
    "read",
    "bash",
    "ctx_search",
    "grep",
    "find",
    "ls",
  ]);
});

test("plan mode does not add its injected required tools to the baseline", () => {
  assert.deepEqual(
    captureToolsActivatedDuringPlanMode(
      toolsBeforePlanMode,
      getPlanModeTools(toolsBeforePlanMode),
    ),
    toolsBeforePlanMode,
  );
});

test("capturing activated tools is stable across repeated policy updates", () => {
  const once = captureToolsActivatedDuringPlanMode(toolsBeforePlanMode, [
    ...getPlanModeTools(toolsBeforePlanMode),
    "ctx_execute",
  ]);
  const twice = captureToolsActivatedDuringPlanMode(
    once,
    getPlanModeTools(once),
  );

  assert.deepEqual(twice, once);
});
