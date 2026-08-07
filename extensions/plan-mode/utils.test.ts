import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractPlan,
  extractTodoItems,
  filterPlanModeContextMessages,
  formatPlan,
} from "./utils.ts";
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

const completePlan = `Plan:
Summary:
Separate review metadata from executable scheduling.
Assumptions:
- Assumption: Existing sessions may contain legacy todos.
- Risk: Review content may contain numbered examples.
Changes:
- Implementation: Parse named sections into a Plan object.
- API/type change: Add Plan and PlanStep interfaces.
- Rollback: Restore the legacy parser and prompt.
Test Plan:
1. This numbered review scenario must not become an execution item.
- Validation: Run the focused Node test suite.
Steps:
1. Add the structured plan parser.
2) Integrate parsed steps with scheduling.`;

test("extractPlan parses the complete review document and executable steps", () => {
  assert.deepEqual(extractPlan(completePlan), {
    summary: "Separate review metadata from executable scheduling.",
    assumptions: [
      "Assumption: Existing sessions may contain legacy todos.",
      "Risk: Review content may contain numbered examples.",
    ],
    changes: [
      "Implementation: Parse named sections into a Plan object.",
      "API/type change: Add Plan and PlanStep interfaces.",
      "Rollback: Restore the legacy parser and prompt.",
    ],
    testPlan: [
      "1. This numbered review scenario must not become an execution item.",
      "Validation: Run the focused Node test suite.",
    ],
    steps: [
      { step: 1, text: "Add the structured plan parser." },
      { step: 2, text: "Integrate parsed steps with scheduling." },
    ],
  });
});

test("formatPlan renders every section in canonical order", () => {
  const plan = extractPlan(completePlan);
  assert.ok(plan);

  assert.equal(
    formatPlan(plan),
    `Plan:
Summary:
Separate review metadata from executable scheduling.
Assumptions:
- Assumption: Existing sessions may contain legacy todos.
- Risk: Review content may contain numbered examples.
Changes:
- Implementation: Parse named sections into a Plan object.
- API/type change: Add Plan and PlanStep interfaces.
- Rollback: Restore the legacy parser and prompt.
Test Plan:
- 1. This numbered review scenario must not become an execution item.
- Validation: Run the focused Node test suite.
Steps:
1. Add the structured plan parser.
2. Integrate parsed steps with scheduling.`,
  );
});

test("formatPlan uses None for empty review lists", () => {
  assert.equal(
    formatPlan({
      summary: "Keep the complete plan reviewable.",
      assumptions: [],
      changes: [],
      testPlan: [],
      steps: [{ step: 1, text: "Show the plan." }],
    }),
    `Plan:
Summary:
Keep the complete plan reviewable.
Assumptions:
- None
Changes:
- None
Test Plan:
- None
Steps:
1. Show the plan.`,
  );
});

test("extractTodoItems schedules only numbered lines from Steps", () => {
  assert.deepEqual(extractTodoItems(completePlan), [
    {
      step: 1,
      text: "Add the structured plan parser.",
      completed: false,
    },
    {
      step: 2,
      text: "Integrate parsed steps with scheduling.",
      completed: false,
    },
  ]);
});

test("structured plans reject a missing Steps section", () => {
  const missingSteps = completePlan.replace(/Steps:\n[\s\S]*$/, "");

  assert.equal(extractPlan(missingSteps), undefined);
  assert.deepEqual(extractTodoItems(missingSteps), []);
});

test("structured plans reject duplicate step numbers", () => {
  const duplicateSteps = completePlan.replace(
    "2) Integrate parsed steps with scheduling.",
    "1. Integrate parsed steps with scheduling.",
  );

  assert.equal(extractPlan(duplicateSteps), undefined);
  assert.deepEqual(extractTodoItems(duplicateSteps), []);
});

test("structured plans require consecutive steps in ascending order", () => {
  const missingStepNumber = completePlan.replace(
    "2) Integrate parsed steps with scheduling.",
    "3. Integrate parsed steps with scheduling.",
  );
  const outOfOrderSteps = completePlan.replace(
    "1. Add the structured plan parser.\n2) Integrate parsed steps with scheduling.",
    "2. Integrate parsed steps with scheduling.\n1. Add the structured plan parser.",
  );

  assert.equal(extractPlan(missingStepNumber), undefined);
  assert.equal(extractPlan(outOfOrderSteps), undefined);
});

test("extractTodoItems remains compatible with legacy one-line plans", () => {
  const legacyPlan = `Plan:
1. Inspect the existing implementation.
2) Apply the focused change.`;

  assert.deepEqual(extractTodoItems(legacyPlan), [
    {
      step: 1,
      text: "Inspect the existing implementation.",
      completed: false,
    },
    {
      step: 2,
      text: "Apply the focused change.",
      completed: false,
    },
  ]);
});
