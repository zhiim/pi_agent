// Built-in read-only tools that are always activated in plan mode.
export const PLAN_MODE_REQUIRED_TOOLS = [
  "read",
  "bash",
  "grep",
  "find",
  "ls",
] as const;

// Optional read/search tools are retained only when they were already active.
// Keep this list explicit: unknown extension and MCP tools may have side effects.
const PLAN_MODE_OPTIONAL_TOOLS = [
  "fffind",
  "ffgrep",
  "web_search",
  "fetch_content",
  "get_search_content",
  "ctx_search",
  "ctx_stats",
  "ask_user_question",
] as const;

export const PLAN_MODE_ALLOWED_TOOLS = new Set<string>([
  ...PLAN_MODE_REQUIRED_TOOLS,
  ...PLAN_MODE_OPTIONAL_TOOLS,
]);

function uniqueToolNames(toolNames: readonly string[]): string[] {
  return [...new Set(toolNames)];
}

export function getPlanModeTools(activeToolNames: readonly string[]): string[] {
  return uniqueToolNames([
    ...activeToolNames.filter((name) => PLAN_MODE_ALLOWED_TOOLS.has(name)),
    ...PLAN_MODE_REQUIRED_TOOLS,
  ]);
}

/**
 * Preserve tools activated after plan mode took its restoration snapshot.
 *
 * Pi extensions may register tools lazily during `before_agent_start`.
 * Required tools injected by plan mode itself are excluded, while genuinely
 * new tools are added to the baseline so execution restores them later.
 */
export function captureToolsActivatedDuringPlanMode(
  toolsBeforePlanMode: readonly string[],
  activeToolNames: readonly string[],
): string[] {
  const toolsEnabledByPolicy = new Set(
    getPlanModeTools(toolsBeforePlanMode),
  );
  const newlyActivatedTools = activeToolNames.filter(
    (name) => !toolsEnabledByPolicy.has(name),
  );

  return uniqueToolNames([...toolsBeforePlanMode, ...newlyActivatedTools]);
}
