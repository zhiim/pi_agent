/**
 * Pure utility functions for plan mode.
 * Extracted for testability.
 */
import fs from "node:fs";
import { PlanWorkflowState } from "./workflow.ts";

interface PlanModeContextMessage {
  role: string;
  content?: unknown;
  customType?: string;
}

const PLAN_CONTEXT_TYPE = "plan-mode-context";
const EXECUTION_CONTEXT_TYPE = "plan-execution-context";
const INTERNAL_CONTEXT_TYPES = new Set([
  PLAN_CONTEXT_TYPE,
  EXECUTION_CONTEXT_TYPE,
  "plan-mode-execute",
]);
const INTERNAL_TEXT_MARKERS = ["[PLAN MODE ACTIVE]", "[EXECUTING PLAN"];

function containsInternalTextMarker(content: unknown): boolean {
  if (typeof content === "string") {
    return INTERNAL_TEXT_MARKERS.some((marker) => content.includes(marker));
  }
  if (!Array.isArray(content)) return false;

  return content.some((block) => {
    if (typeof block !== "object" || block === null) return false;
    const textBlock = block as { type?: unknown; text?: unknown };
    const text = textBlock.text;
    return (
      textBlock.type === "text" &&
      typeof text === "string" &&
      INTERNAL_TEXT_MARKERS.some((marker) => text.includes(marker))
    );
  });
}

export function filterPlanModeContextMessages<T extends PlanModeContextMessage>(
  messages: readonly T[],
  state: PlanWorkflowState,
): T[] {
  let activeInstructionTypes: ReadonlySet<string> = new Set();
  switch (state) {
    case PlanWorkflowState.Planning:
    case PlanWorkflowState.AwaitingApproval:
      activeInstructionTypes = new Set([PLAN_CONTEXT_TYPE]);
      break;
    case PlanWorkflowState.Executing:
    case PlanWorkflowState.Paused:
      activeInstructionTypes = new Set([
        EXECUTION_CONTEXT_TYPE,
        "plan-mode-execute",
      ]);
      break;
    case PlanWorkflowState.Off:
      break;
  }
  let latestActiveInstructionIndex = -1;

  if (activeInstructionTypes.size > 0) {
    for (let index = messages.length - 1; index >= 0; index--) {
      if (activeInstructionTypes.has(messages[index]?.customType ?? "")) {
        latestActiveInstructionIndex = index;
        break;
      }
    }
  }

  return messages.filter((message, index) => {
    const customType = message.customType ?? "";
    if (INTERNAL_CONTEXT_TYPES.has(customType)) {
      return (
        activeInstructionTypes.has(customType) &&
        index === latestActiveInstructionIndex
      );
    }

    if (
      message.role === "user" &&
      containsInternalTextMarker(message.content)
    ) {
      return false;
    }
    return true;
  });
}

// Destructive commands blocked in plan mode
const DESTRUCTIVE_PATTERNS = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /\bmkdir\b/i,
  /\btouch\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bchgrp\b/i,
  /\bln\b/i,
  /\btee\b/i,
  /\btruncate\b/i,
  /\bdd\b/i,
  /\bshred\b/i,
  /(^|[^<])>(?!>)/,
  />>/,
  /\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
  /\byarn\s+(add|remove|install|publish)/i,
  /\bpnpm\s+(add|remove|install|publish)/i,
  /\bpip\s+(install|uninstall)/i,
  /\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
  /\bbrew\s+(install|uninstall|upgrade)/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
  /\bsudo\b/i,
  /\bsu\b/i,
  /\bkill\b/i,
  /\bpkill\b/i,
  /\bkillall\b/i,
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\bsystemctl\s+(start|stop|restart|enable|disable)/i,
  /\bservice\s+\S+\s+(start|stop|restart)/i,
  /\b(vim?|nano|emacs|code|subl)\b/i,
];

// Shell composition makes a prefix allowlist unsafe (`ls; mutate`, command
// substitution, pipelines, or redirection). Plan mode intentionally accepts
// only one conservative command at a time.
const SHELL_COMPOSITION_PATTERN = /[\r\n;&|`$<>]/;

// Some otherwise read-only Git commands can write through an output option.
const WRITE_CAPABLE_OPTION_PATTERNS = [
  /\bgit\s+(?:diff|log|show)\b[^\r\n]*\s--output(?:=|\s)/i,
  /\bgit\s+(?:diff|show)\b[^\r\n]*\s--(?:ext-diff|textconv)\b/i,
];

// Safe single read-only commands allowed in plan mode. Commands that can run
// subprocesses, access the network, modify package state, or write via flags
// are deliberately omitted; equivalent dedicated read/search tools exist.
const SAFE_PATTERNS = [
  /^\s*cat\b/,
  /^\s*head\b/,
  /^\s*tail\b/,
  /^\s*grep\b/,
  /^\s*ls\b/,
  /^\s*pwd\s*$/,
  /^\s*wc\b/,
  /^\s*diff\b/,
  /^\s*file\b/,
  /^\s*stat\b/,
  /^\s*du\b/,
  /^\s*df\b/,
  /^\s*which\b/,
  /^\s*whereis\b/,
  /^\s*type\b/,
  /^\s*uname\b/,
  /^\s*whoami\s*$/,
  /^\s*id\b/,
  /^\s*uptime\s*$/,
  /^\s*ps\b/,
  /^\s*free\b/,
  /^\s*git\s+(?:status|log|diff|show)\b/i,
  /^\s*git\s+branch\s*$/i,
  /^\s*git\s+remote(?:\s+-v)?\s*$/i,
  /^\s*git\s+config\s+--get(?:-all|-regexp)?\b/i,
  /^\s*git\s+ls-(?:files|tree)\b/i,
  /^\s*node\s+(?:--version|-v)\s*$/i,
  /^\s*python(?:3)?\s+(?:--version|-V)\s*$/,
  /^\s*jq\b/,
  /^\s*bat\b/,
  /^\s*eza\b/,
];

export function isSafeCommand(command: string): boolean {
  if (SHELL_COMPOSITION_PATTERN.test(command)) return false;
  if (DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command)))
    return false;
  if (WRITE_CAPABLE_OPTION_PATTERNS.some((pattern) => pattern.test(command))) {
    return false;
  }
  return SAFE_PATTERNS.some((pattern) => pattern.test(command));
}

export interface PlanStep {
  step: number;
  text: string;
}

export interface Plan {
  summary: string;
  assumptions: string[];
  changes: string[];
  testPlan: string[];
  steps: PlanStep[];
}

export interface TodoItem extends PlanStep {
  completed: boolean;
}

function formatPlanList(items: readonly string[]): string[] {
  return items.length > 0
    ? items.map((item) => `- ${item}`)
    : ["- None"];
}

/** Rebuild the complete structured plan in its canonical review format. */
export function formatPlan(plan: Plan): string {
  return [
    "Plan:",
    "Summary:",
    plan.summary,
    "Assumptions:",
    ...formatPlanList(plan.assumptions),
    "Changes:",
    ...formatPlanList(plan.changes),
    "Test Plan:",
    ...formatPlanList(plan.testPlan),
    "Steps:",
    ...plan.steps.map((step) => `${step.step}. ${step.text}`),
  ].join("\n");
}

const PLAN_HEADER_PATTERN =
  /^[^\S\r\n]*(?:#{1,6}[^\S\r\n]+)?\*{0,2}Plan:\*{0,2}[^\S\r\n]*$/im;
const PLAN_SECTION_NAMES = [
  "summary",
  "assumptions",
  "changes",
  "testPlan",
  "steps",
] as const;
type PlanSectionName = (typeof PLAN_SECTION_NAMES)[number];

const PLAN_SECTION_HEADER_SOURCE =
  "^[^\\S\\r\\n]*(?:#{1,6}[^\\S\\r\\n]+)?\\*{0,2}(Summary|Assumptions|Changes|Test Plan|Steps):\\*{0,2}[^\\S\\r\\n]*$";

function normalizePlanSectionName(header: string): PlanSectionName {
  switch (header.toLowerCase()) {
    case "summary":
      return "summary";
    case "assumptions":
      return "assumptions";
    case "changes":
      return "changes";
    case "test plan":
      return "testPlan";
    case "steps":
      return "steps";
    default:
      throw new Error(`Unknown plan section: ${header}`);
  }
}

function parsePlanList(section: string): string[] {
  return section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^[-*+]\s+/, "").trim())
    .filter((line) => line.length > 0);
}

function parsePlanSteps(section: string): PlanStep[] | undefined {
  const lines = section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return undefined;

  const steps: PlanStep[] = [];
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^(\d+)[.)]\s+(.+?)\s*$/);
    if (!match) return undefined;

    const step = Number(match[1]);
    const text = match[2].trim();
    if (!Number.isSafeInteger(step) || step !== index + 1 || text.length === 0) {
      return undefined;
    }
    steps.push({ step, text });
  }
  return steps;
}

/** Parse the reviewable plan document while keeping executable steps isolated. */
export function extractPlan(message: string): Plan | undefined {
  const headerMatch = PLAN_HEADER_PATTERN.exec(message);
  if (!headerMatch || headerMatch.index === undefined) return undefined;

  const planDocument = message.slice(headerMatch.index + headerMatch[0].length);
  const sectionPattern = new RegExp(PLAN_SECTION_HEADER_SOURCE, "gim");
  const matches = [...planDocument.matchAll(sectionPattern)];
  if (matches.length !== PLAN_SECTION_NAMES.length) return undefined;

  const sections = new Map<PlanSectionName, string>();
  for (const [index, match] of matches.entries()) {
    const name = normalizePlanSectionName(match[1]);
    if (name !== PLAN_SECTION_NAMES[index] || sections.has(name)) {
      return undefined;
    }

    const contentStart = (match.index ?? 0) + match[0].length;
    const contentEnd = matches[index + 1]?.index ?? planDocument.length;
    sections.set(name, planDocument.slice(contentStart, contentEnd).trim());
  }

  const summary = sections.get("summary") ?? "";
  const steps = parsePlanSteps(sections.get("steps") ?? "");
  if (summary.length === 0 || !steps) return undefined;

  return {
    summary,
    assumptions: parsePlanList(sections.get("assumptions") ?? ""),
    changes: parsePlanList(sections.get("changes") ?? ""),
    testPlan: parsePlanList(sections.get("testPlan") ?? ""),
    steps,
  };
}

export function extractTodoItems(message: string): TodoItem[] {
  const plan = extractPlan(message);
  if (plan) {
    return plan.steps.map((step) => ({ ...step, completed: false }));
  }

  // A structured plan that fails validation must not fall back to scraping
  // numbered review content outside the Steps section.
  const structuredSectionPattern = new RegExp(
    PLAN_SECTION_HEADER_SOURCE,
    "im",
  );
  if (structuredSectionPattern.test(message)) return [];

  const items: TodoItem[] = [];
  const headerMatch = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
  if (!headerMatch) return items;

  const planSection = message.slice(
    message.indexOf(headerMatch[0]) + headerMatch[0].length,
  );
  const numberedPattern = /^\s*(\d+)[.)]\s+(.+?)\s*$/gm;

  for (const match of planSection.matchAll(numberedPattern)) {
    const step = Number(match[1]);
    const text = match[2].trim();
    if (Number.isSafeInteger(step) && step > 0 && text.length > 0) {
      items.push({ step, text, completed: false });
    }
  }
  return items;
}

export function markCurrentStepCompleted(
  text: string,
  items: TodoItem[],
): boolean {
  const currentStep = items.find((item) => !item.completed);
  if (!currentStep) return false;

  const completionMatch = text.match(/^[^\S\r\n]*\[DONE:(\d+)\][^\S\r\n]*$/m);
  if (!completionMatch || completionMatch[1] !== String(currentStep.step)) {
    return false;
  }

  currentStep.completed = true;
  return true;
}

function renderPrompt(
  template: string,
  variables: Record<string, unknown>,
): string {
  const rendered = template.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (_, key) => {
    if (!Object.hasOwn(variables, key)) {
      throw new Error(`Prompt variable not provided: ${key}`);
    }
    const value = variables[key];
    if (value === undefined || value === null) {
      throw new Error(`Prompt variable is null or undefined: ${key}`);
    }

    return String(value);
  });

  return rendered;
}

export function readPromptFile(
  filePath: string,
  variables?: Record<string, unknown>,
): string {
  const template = fs.readFileSync(filePath, "utf-8");
  if (!variables) return template;
  return renderPrompt(template, variables);
}
