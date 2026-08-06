import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isExecutionState,
  isPlanWorkflowActive,
  isReadOnlyPlanningState,
  PlanWorkflowState,
  restorePlanWorkflowState,
  transitionPlanWorkflow,
} from "./workflow.ts";

test("workflow follows the legal planning and execution transitions", () => {
  let state = PlanWorkflowState.Off;
  state = transitionPlanWorkflow(state, PlanWorkflowState.Planning);
  state = transitionPlanWorkflow(state, PlanWorkflowState.AwaitingApproval);
  state = transitionPlanWorkflow(state, PlanWorkflowState.Executing);
  state = transitionPlanWorkflow(state, PlanWorkflowState.Paused);
  state = transitionPlanWorkflow(state, PlanWorkflowState.Executing);
  state = transitionPlanWorkflow(state, PlanWorkflowState.Off);

  assert.equal(state, PlanWorkflowState.Off);
  assert.throws(
    () =>
      transitionPlanWorkflow(
        PlanWorkflowState.Planning,
        PlanWorkflowState.Executing,
      ),
    /Invalid plan workflow transition: planning -> executing/,
  );
});

test("workflow classifies every state", () => {
  const classifications = [
    {
      state: PlanWorkflowState.Off,
      readOnly: false,
      execution: false,
      active: false,
    },
    {
      state: PlanWorkflowState.Planning,
      readOnly: true,
      execution: false,
      active: true,
    },
    {
      state: PlanWorkflowState.AwaitingApproval,
      readOnly: true,
      execution: false,
      active: true,
    },
    {
      state: PlanWorkflowState.Executing,
      readOnly: false,
      execution: true,
      active: true,
    },
    {
      state: PlanWorkflowState.Paused,
      readOnly: false,
      execution: true,
      active: true,
    },
  ];

  for (const classification of classifications) {
    assert.equal(
      isReadOnlyPlanningState(classification.state),
      classification.readOnly,
    );
    assert.equal(
      isExecutionState(classification.state),
      classification.execution,
    );
    assert.equal(
      isPlanWorkflowActive(classification.state),
      classification.active,
    );
  }
});

test("workflow restores every persisted enum state", () => {
  for (const state of Object.values(PlanWorkflowState)) {
    assert.equal(restorePlanWorkflowState({ state }), state);
  }

  assert.equal(
    restorePlanWorkflowState(
      { state: "invalid-state" },
      PlanWorkflowState.Planning,
    ),
    PlanWorkflowState.Off,
  );
  assert.equal(
    restorePlanWorkflowState(undefined, PlanWorkflowState.Planning),
    PlanWorkflowState.Planning,
  );
});

test("workflow migrates legacy boolean session states", () => {
  assert.equal(
    restorePlanWorkflowState({ enabled: false, executing: false }),
    PlanWorkflowState.Off,
  );
  assert.equal(
    restorePlanWorkflowState({ enabled: true, executing: false }),
    PlanWorkflowState.Planning,
  );
  assert.equal(
    restorePlanWorkflowState({ enabled: false, executing: true }),
    PlanWorkflowState.Executing,
  );
  assert.equal(
    restorePlanWorkflowState({ enabled: true, executing: true }),
    PlanWorkflowState.Executing,
  );
});

test("paused workflow can restore and resume execution", () => {
  const restored = restorePlanWorkflowState({
    state: PlanWorkflowState.Paused,
  });
  const resumed = transitionPlanWorkflow(
    restored,
    PlanWorkflowState.Executing,
  );

  assert.equal(resumed, PlanWorkflowState.Executing);
  assert.equal(isExecutionState(resumed), true);
});

test("completed execution returns to off from active execution states", () => {
  assert.equal(
    transitionPlanWorkflow(
      PlanWorkflowState.Executing,
      PlanWorkflowState.Off,
    ),
    PlanWorkflowState.Off,
  );
  assert.equal(
    transitionPlanWorkflow(PlanWorkflowState.Paused, PlanWorkflowState.Off),
    PlanWorkflowState.Off,
  );
});
