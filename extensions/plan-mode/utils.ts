/**
 * Pure utility functions for plan mode.
 * Extracted for testability.
 */
import fs from "node:fs";

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

export interface TodoItem {
  step: number;
  text: string;
  completed: boolean;
}

export function cleanStepText(text: string): string {
  let cleaned = text
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1") // Remove bold/italic
    .replace(/`([^`]+)`/g, "$1") // Remove code
    .replace(
      /^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }
  if (cleaned.length > 50) {
    cleaned = `${cleaned.slice(0, 47)}...`;
  }
  return cleaned;
}

export function extractTodoItems(message: string): TodoItem[] {
  const items: TodoItem[] = [];
  const headerMatch = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
  if (!headerMatch) return items;

  const planSection = message.slice(
    message.indexOf(headerMatch[0]) + headerMatch[0].length,
  );
  const numberedPattern = /^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm;

  for (const match of planSection.matchAll(numberedPattern)) {
    const text = match[2]
      .trim()
      .replace(/\*{1,2}$/, "")
      .trim();
    if (
      text.length > 5 &&
      !text.startsWith("`") &&
      !text.startsWith("/") &&
      !text.startsWith("-")
    ) {
      const cleaned = cleanStepText(text);
      if (cleaned.length > 3) {
        items.push({ step: items.length + 1, text: cleaned, completed: false });
      }
    }
  }
  return items;
}

export function extractDoneSteps(message: string): number[] {
  const steps: number[] = [];
  for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
    const step = Number(match[1]);
    if (Number.isFinite(step)) steps.push(step);
  }
  return steps;
}

export function markCompletedSteps(text: string, items: TodoItem[]): number {
  const doneSteps = extractDoneSteps(text);
  for (const step of doneSteps) {
    const item = items.find((t) => t.step === step);
    if (item) item.completed = true;
  }
  return doneSteps.length;
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
