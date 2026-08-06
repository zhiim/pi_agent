/** Explicit states and transitions for the plan workflow. */
export enum PlanWorkflowState {
  Off = "off",
  Planning = "planning",
  AwaitingApproval = "awaiting-approval",
  Executing = "executing",
  Paused = "paused",
}

export const PLAN_WORKFLOW_TRANSITIONS: Readonly<
  Record<PlanWorkflowState, readonly PlanWorkflowState[]>
> = {
  [PlanWorkflowState.Off]: [PlanWorkflowState.Planning],
  [PlanWorkflowState.Planning]: [
    PlanWorkflowState.Off,
    PlanWorkflowState.AwaitingApproval,
  ],
  [PlanWorkflowState.AwaitingApproval]: [
    PlanWorkflowState.Off,
    PlanWorkflowState.Planning,
    PlanWorkflowState.Executing,
  ],
  [PlanWorkflowState.Executing]: [
    PlanWorkflowState.Off,
    PlanWorkflowState.Paused,
  ],
  [PlanWorkflowState.Paused]: [
    PlanWorkflowState.Off,
    PlanWorkflowState.Executing,
  ],
};

export function canTransitionPlanWorkflow(
  from: PlanWorkflowState,
  to: PlanWorkflowState,
): boolean {
  return PLAN_WORKFLOW_TRANSITIONS[from].includes(to);
}

export function transitionPlanWorkflow(
  from: PlanWorkflowState,
  to: PlanWorkflowState,
): PlanWorkflowState {
  if (from === to) return from;
  if (!canTransitionPlanWorkflow(from, to)) {
    throw new Error(`Invalid plan workflow transition: ${from} -> ${to}`);
  }
  return to;
}

export function isReadOnlyPlanningState(state: PlanWorkflowState): boolean {
  return (
    state === PlanWorkflowState.Planning ||
    state === PlanWorkflowState.AwaitingApproval
  );
}

export function isExecutionState(state: PlanWorkflowState): boolean {
  return (
    state === PlanWorkflowState.Executing || state === PlanWorkflowState.Paused
  );
}

export function isPlanWorkflowActive(state: PlanWorkflowState): boolean {
  return state !== PlanWorkflowState.Off;
}

export function isPlanWorkflowState(
  value: unknown,
): value is PlanWorkflowState {
  return Object.values(PlanWorkflowState).includes(value as PlanWorkflowState);
}

interface PersistedWorkflowStateLike {
  state?: unknown;
  enabled?: unknown;
  executing?: unknown;
}

export function restorePlanWorkflowState(
  persisted: PersistedWorkflowStateLike | undefined,
  fallback: PlanWorkflowState = PlanWorkflowState.Off,
): PlanWorkflowState {
  if (!persisted) return fallback;

  if (persisted.state !== undefined) {
    return isPlanWorkflowState(persisted.state)
      ? persisted.state
      : PlanWorkflowState.Off;
  }

  const hasLegacyState =
    typeof persisted.enabled === "boolean" ||
    typeof persisted.executing === "boolean";
  if (!hasLegacyState) return fallback;

  if (persisted.executing === true) return PlanWorkflowState.Executing;
  if (persisted.enabled === true) return PlanWorkflowState.Planning;
  return PlanWorkflowState.Off;
}
