import assert from "node:assert/strict";
import { test } from "node:test";
import { filterPlanModeContextMessages } from "./utils.ts";
import { PlanWorkflowState } from "./workflow.ts";

interface TestContextMessage {
  id: string;
  role: string;
  content?: unknown;
  customType?: string;
}

const contextMessages: TestContextMessage[] = [
  { id: "normal", role: "user", content: "Keep this user request" },
  {
    id: "old-plan",
    role: "custom",
    customType: "plan-mode-context",
    content: "old planning instruction",
  },
  {
    id: "new-plan",
    role: "custom",
    customType: "plan-mode-context",
    content: "new planning instruction",
  },
  {
    id: "execution-context",
    role: "custom",
    customType: "plan-execution-context",
    content: "execution instruction",
  },
  {
    id: "execute-prompt",
    role: "custom",
    customType: "plan-mode-execute",
    content: "selected execution step",
  },
  {
    id: "internal-marker",
    role: "user",
    content: [{ type: "text", text: "[PLAN MODE ACTIVE] stale" }],
  },
];

function filteredIds(state: PlanWorkflowState): string[] {
  return filterPlanModeContextMessages(contextMessages, state).map(
    (message) => message.id,
  );
}

test("planning states keep only the newest planning instruction", () => {
  assert.deepEqual(filteredIds(PlanWorkflowState.Planning), [
    "normal",
    "new-plan",
  ]);
  assert.deepEqual(filteredIds(PlanWorkflowState.AwaitingApproval), [
    "normal",
    "new-plan",
  ]);
});

test("execution states keep only the newest execution instruction", () => {
  assert.deepEqual(filteredIds(PlanWorkflowState.Executing), [
    "normal",
    "execute-prompt",
  ]);
  assert.deepEqual(filteredIds(PlanWorkflowState.Paused), [
    "normal",
    "execute-prompt",
  ]);
});

test("off state removes all internal workflow instructions", () => {
  assert.deepEqual(filteredIds(PlanWorkflowState.Off), ["normal"]);
});

test("context filtering removes internal text markers in every state", () => {
  for (const state of Object.values(PlanWorkflowState)) {
    assert.equal(filteredIds(state).includes("internal-marker"), false);
  }
});
