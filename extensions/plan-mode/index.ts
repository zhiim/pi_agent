/**
 * Plan Mode Extension
 *
 * Read-only exploration mode for safe code analysis.
 * When enabled, only an explicit allowlist of read/search tools is available.
 *
 * Features:
 * - /plan command to toggle
 * - Bash restricted to allowlisted read-only commands
 * - Extracts numbered plan steps from "Plan:" sections
 * - [DONE:n] markers to complete steps during execution
 * - Progress tracking widget during execution
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  extractPlan,
  filterPlanModeContextMessages,
  formatPlan,
  isSafeCommand,
  markCurrentStepCompleted,
  readPromptFile,
  type Plan,
  type PlanStep,
  type TodoItem,
} from "./utils.ts";
import {
  captureToolsActivatedDuringPlanMode,
  getPlanModeTools,
  PLAN_MODE_ALLOWED_TOOLS,
} from "./tool-policy.ts";
import {
  isExecutionState,
  isPlanWorkflowActive,
  isReadOnlyPlanningState,
  PlanWorkflowState,
  restorePlanWorkflowState,
  transitionPlanWorkflow,
} from "./workflow.ts";

const RESOURCE_PATH = `${process.env.HOME}/.pi/agent/extensions/plan-mode`;

interface PersistedPlanModeState {
  state?: PlanWorkflowState;
  plan?: Plan;
  todos?: TodoItem[];
  toolsBeforePlanMode?: string[];
  // Legacy fields retained only for migrating sessions saved before the state machine.
  enabled?: boolean;
  executing?: boolean;
}

// Type guard for assistant messages
function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
  return m.role === "assistant" && Array.isArray(m.content);
}

// Extract text content from an assistant message
function getTextContent(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function markCompletedStepFromMessage(
  message: AssistantMessage,
  items: TodoItem[],
): boolean {
  if (message.stopReason !== "stop") return false;
  return markCurrentStepCompleted(getTextContent(message), items);
}

function createTodoItems(
  steps: readonly PlanStep[],
  persistedItems?: readonly TodoItem[],
): TodoItem[] {
  return steps.map((step) => ({
    ...step,
    completed:
      persistedItems?.find((item) => item.step === step.step)?.completed ===
      true,
  }));
}

export default function planModeExtension(pi: ExtensionAPI): void {
  let workflowState = PlanWorkflowState.Off;
  // Review-only metadata is persisted for resume but never scheduled directly.
  let currentPlan: Plan | undefined;
  let todoItems: TodoItem[] = [];
  let executionProgressedThisRun = false;
  let toolsBeforePlanMode: string[] | undefined; // available tools before plan mode was enabled

  function transitionWorkflowState(nextState: PlanWorkflowState): void {
    workflowState = transitionPlanWorkflow(workflowState, nextState);
  }

  pi.registerFlag("plan", {
    description: "Start in plan mode (read-only exploration)",
    type: "boolean",
    default: false,
  });

  /** Keep the footer and todo widget aligned with the workflow state. */
  function updateStatus(ctx: ExtensionContext): void {
    const completed = todoItems.filter((item) => item.completed).length;

    switch (workflowState) {
      case PlanWorkflowState.Planning:
        ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", " plan"));
        break;
      case PlanWorkflowState.AwaitingApproval:
        ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", " approval"));
        break;
      case PlanWorkflowState.Executing:
        ctx.ui.setStatus(
          "plan-mode",
          ctx.ui.theme.fg("accent", ` ${completed}/${todoItems.length}`),
        );
        break;
      case PlanWorkflowState.Paused:
        ctx.ui.setStatus(
          "plan-mode",
          ctx.ui.theme.fg("warning", ` ${completed}/${todoItems.length}`),
        );
        break;
      case PlanWorkflowState.Off:
        ctx.ui.setStatus("plan-mode", undefined);
        break;
    }

    const showTodos = todoItems.length > 0 && isExecutionState(workflowState);
    if (!showTodos) {
      ctx.ui.setWidget("plan-todos", undefined);
      return;
    }

    const currentStep = todoItems.find((item) => !item.completed);
    const lines = todoItems.map((item) => {
      if (item.completed) {
        return (
          ctx.ui.theme.fg("success", "󰄵 ") +
          ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
        );
      }
      if (workflowState === PlanWorkflowState.Paused && item === currentStep) {
        return (
          ctx.ui.theme.fg("warning", " ") +
          ctx.ui.theme.fg("warning", item.text)
        );
      }
      return `${ctx.ui.theme.fg("muted", "󰄱 ")}${item.text}`;
    });
    ctx.ui.setWidget("plan-todos", lines);
  }

  function captureNewlyActivatedTools(): void {
    if (toolsBeforePlanMode === undefined) return;

    // Tools such as context-mode's ctx_* surface are registered lazily during
    // before_agent_start. Preserve those additions in the restoration baseline
    // even though unsafe additions remain hidden while planning.
    toolsBeforePlanMode = captureToolsActivatedDuringPlanMode(
      toolsBeforePlanMode,
      pi.getActiveTools(),
    );
  }

  function enablePlanModeTools(): void {
    if (toolsBeforePlanMode === undefined) {
      // Save all active tools for restoration when back to normal mode.
      toolsBeforePlanMode = pi.getActiveTools();
    } else {
      captureNewlyActivatedTools();
    }
    pi.setActiveTools(getPlanModeTools(toolsBeforePlanMode));
  }

  function restoreNormalModeTools(): void {
    if (toolsBeforePlanMode === undefined) {
      // toolsBeforePlanMode being undefined means tools have already been restored
      return;
    }
    captureNewlyActivatedTools();
    pi.setActiveTools(toolsBeforePlanMode);
    toolsBeforePlanMode = undefined;
  }

  function applyToolPolicyForState(): void {
    if (isReadOnlyPlanningState(workflowState)) {
      enablePlanModeTools();
    } else {
      restoreNormalModeTools();
    }
  }

  function persistState(): void {
    pi.appendEntry("plan-mode", {
      state: workflowState,
      plan: currentPlan,
      todos: todoItems,
      toolsBeforePlanMode,
    });
  }

  function buildExecutionStepPrompt(): string | undefined {
    const remaining = todoItems.filter((item) => !item.completed);
    const currentStep = remaining[0];
    if (!currentStep) return undefined;

    return readPromptFile(`${RESOURCE_PATH}/execute_step.md`, {
      TODO_LIST: remaining
        .map((item) => `${item.step}. ${item.text}`)
        .join("\n"),
      STEP_ID: currentStep.step.toString(),
      STEP_TEXT: currentStep.text,
    });
  }

  function queueNextStep(display: boolean): void {
    const execMessage = buildExecutionStepPrompt();
    if (!execMessage) return;

    pi.sendMessage(
      {
        customType: "plan-mode-execute",
        content: execMessage,
        display,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  }

  function togglePlanMode(ctx: ExtensionContext): void {
    // Toggling from any active phase exits the entire workflow.
    if (isPlanWorkflowActive(workflowState)) {
      transitionWorkflowState(PlanWorkflowState.Off);
    } else {
      transitionWorkflowState(PlanWorkflowState.Planning);
    }
    currentPlan = undefined;
    todoItems = [];
    executionProgressedThisRun = false;

    applyToolPolicyForState();
    if (workflowState === PlanWorkflowState.Planning) {
      ctx.ui.notify(
        "Plan mode enabled. Tools restricted to read-only allowlist.",
      );
    } else {
      ctx.ui.notify("Plan mode disabled. Full access restored.");
    }
    updateStatus(ctx);
    persistState();
  }

  pi.registerCommand("plan", {
    description: "Toggle plan mode (read-only exploration)",
    handler: async (_args, ctx) => togglePlanMode(ctx),
  });

  pi.registerCommand("todos", {
    description: "Show current plan todo list",
    handler: async (_args, ctx) => {
      if (todoItems.length === 0) {
        ctx.ui.notify("No todos. Create a plan first with /plan", "info");
        return;
      }
      const list = todoItems
        .map(
          (item, i) => `${i + 1}. ${item.completed ? "" : ""} ${item.text}`,
        )
        .join("\n");
      ctx.ui.notify(`Plan Progress:\n${list}`, "info");
    },
  });

  pi.registerCommand("plan-info", {
    description: "Show the complete plan during execution",
    handler: async (_args, ctx) => {
      if (!isExecutionState(workflowState) || !currentPlan) {
        ctx.ui.notify("No active execution plan to show.", "warning");
        return;
      }
      ctx.ui.notify(formatPlan(currentPlan), "info");
    },
  });

  // Defense in depth: active-tool filtering hides disallowed tools from the
  // model, while this hook blocks stale, injected, or dynamically activated
  // tools that bypass the filtered tool list.
  pi.on("tool_call", async (event) => {
    if (!isReadOnlyPlanningState(workflowState)) return;

    if (!PLAN_MODE_ALLOWED_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason: `Plan mode: tool '${event.toolName}' is not in the read-only allowlist. Use /plan to disable plan mode first.`,
      };
    }

    if (event.toolName !== "bash") return;

    const command = event.input.command as string;
    if (!isSafeCommand(command)) {
      return {
        block: true,
        reason: `Plan mode: command blocked (not allowlisted). Use /plan to disable plan mode first.\nCommand: ${command}`,
      };
    }
  });

  // Keep only the newest instruction for the active phase. Historical
  // execution prompts and display messages remain in the transcript but are
  // excluded from model context so a new plan cannot inherit stale steps.
  pi.on("context", async (event) => ({
    messages: filterPlanModeContextMessages(event.messages, workflowState),
  }));

  // Inject plan/execution context before agent starts
  pi.on("before_agent_start", async () => {
    if (isReadOnlyPlanningState(workflowState)) {
      return {
        message: {
          customType: "plan-mode-context",
          content: readPromptFile(`${RESOURCE_PATH}/plan_mode.md`),
          display: false,
        },
      };
    }

    if (isExecutionState(workflowState) && todoItems.length > 0) {
      const execMessage = buildExecutionStepPrompt();
      if (!execMessage) return;

      return {
        message: {
          customType: "plan-execution-context",
          content: execMessage,
          display: false,
        },
      };
    }
  });

  // Track progress after each turn
  pi.on("turn_end", async (event, ctx) => {
    if (!isExecutionState(workflowState) || todoItems.length === 0) return;
    if (!isAssistantMessage(event.message)) return;

    if (markCompletedStepFromMessage(event.message, todoItems)) {
      executionProgressedThisRun = true;
      updateStatus(ctx);
    }
    persistState();
  });

  // Handle plan completion and plan mode UI
  pi.on("agent_end", async (event, ctx) => {
    // Complete the workflow, continue after verified progress, or pause when
    // the current step did not produce a valid completion marker.
    if (isExecutionState(workflowState) && todoItems.length > 0) {
      if (todoItems.every((item) => item.completed)) {
        if (ctx.hasUI) {
          ctx.ui.notify("Plan complete.", "info");
        }
        transitionWorkflowState(PlanWorkflowState.Off);
        currentPlan = undefined;
        todoItems = [];
        executionProgressedThisRun = false;
        applyToolPolicyForState();
        updateStatus(ctx);
        persistState(); // Save cleared state so resume doesn't restore old execution mode
        return;
      }

      const shouldContinue = executionProgressedThisRun;
      executionProgressedThisRun = false;

      if (shouldContinue) {
        if (workflowState === PlanWorkflowState.Paused) {
          transitionWorkflowState(PlanWorkflowState.Executing);
        }
        applyToolPolicyForState();
        updateStatus(ctx);
        persistState();
        queueNextStep(false);
      } else {
        if (workflowState === PlanWorkflowState.Executing) {
          transitionWorkflowState(PlanWorkflowState.Paused);
        }
        applyToolPolicyForState();
        updateStatus(ctx);
        persistState();
        if (ctx.hasUI) {
          ctx.ui.notify(
            "Plan execution paused: the current step was not confirmed complete.",
            "warning",
          );
        }
      }
      return;
    }

    if (!isReadOnlyPlanningState(workflowState) || !ctx.hasUI) return;

    // Parse the complete review document, then derive execution state only
    // from its explicitly delimited steps.
    const lastAssistant = [...event.messages]
      .reverse()
      .find(isAssistantMessage);
    if (lastAssistant) {
      const extracted = extractPlan(getTextContent(lastAssistant));
      if (extracted) {
        currentPlan = extracted;
        todoItems = createTodoItems(extracted.steps);
      }
    }

    if (todoItems.length === 0) return;
    if (workflowState === PlanWorkflowState.Planning) {
      transitionWorkflowState(PlanWorkflowState.AwaitingApproval);
    }
    applyToolPolicyForState();
    updateStatus(ctx);
    persistState();

    const choice = await ctx.ui.select("Plan mode - what next?", [
      "Execute the plan (track progress)",
      "Stay in plan mode",
      "Refine the plan",
    ]);

    if (choice?.startsWith("Execute")) {
      transitionWorkflowState(PlanWorkflowState.Executing);
      executionProgressedThisRun = false;
      applyToolPolicyForState();
      updateStatus(ctx);
      persistState();

      // agent_end still runs while the agent is streaming. Queue exactly one
      // follow-up so the first continuation receives the selected step rather
      // than a display-only todo message.
      queueNextStep(true);
    } else if (choice === "Stay in plan mode") {
      transitionWorkflowState(PlanWorkflowState.Planning);
      applyToolPolicyForState();
      updateStatus(ctx);
      persistState();
    } else if (choice === "Refine the plan") {
      transitionWorkflowState(PlanWorkflowState.Planning);
      applyToolPolicyForState();
      updateStatus(ctx);
      persistState();
      const refinement = await ctx.ui.editor("Refine the plan:", "");
      if (refinement?.trim()) {
        pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
      }
    }
  });

  // Restore state on session start/resume
  pi.on("session_start", async (_event, ctx) => {
    if (
      pi.getFlag("plan") === true &&
      workflowState === PlanWorkflowState.Off
    ) {
      transitionWorkflowState(PlanWorkflowState.Planning);
    }

    const entries = ctx.sessionManager.getBranch();

    // Restore persisted state
    // only if the resumed session have saved "plan-mode" entry
    const planModeEntry = entries
      .filter(
        (e: { type: string; customType?: string }) =>
          e.type === "custom" && e.customType === "plan-mode",
      )
      .pop() as { data?: PersistedPlanModeState } | undefined;

    if (planModeEntry?.data) {
      workflowState = restorePlanWorkflowState(
        planModeEntry.data,
        workflowState,
      );
      currentPlan = planModeEntry.data.plan ?? currentPlan;
      // The plan's Steps section remains canonical while persisted todos carry
      // completion state. Legacy sessions without a plan still restore todos.
      todoItems = currentPlan
        ? createTodoItems(currentPlan.steps, planModeEntry.data.todos)
        : (planModeEntry.data.todos ?? todoItems);
      toolsBeforePlanMode =
        planModeEntry.data.toolsBeforePlanMode ?? toolsBeforePlanMode;
    }

    // On resume: re-scan messages to rebuild completion state
    // Only scan messages AFTER the last "plan-mode-execute" to avoid picking up [DONE:n] from previous plans
    const isResume = planModeEntry !== undefined;
    if (isResume && isExecutionState(workflowState) && todoItems.length > 0) {
      // Find the index of the last plan-mode-execute entry (marks when current execution started)
      let executeIndex = -1;
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i] as { type: string; customType?: string };
        if (entry.customType === "plan-mode-execute") {
          executeIndex = i;
          break;
        }
      }

      if (executeIndex >= 0) {
        // Only scan messages after the execute marker
        const messages: AssistantMessage[] = [];
        for (let i = executeIndex + 1; i < entries.length; i++) {
          const entry = entries[i];
          if (
            entry.type === "message" &&
            "message" in entry &&
            isAssistantMessage(entry.message as AgentMessage)
          ) {
            messages.push(entry.message as AssistantMessage);
          }
        }
        for (const message of messages) {
          if (markCompletedStepFromMessage(message, todoItems)) break;
        }
      }
    }

    applyToolPolicyForState();
    updateStatus(ctx);
  });
}
