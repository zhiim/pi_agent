import assert from "node:assert/strict";
import { test } from "node:test";
import planModeExtension from "./index.ts";

interface TestContext {
  hasUI?: boolean;
  ui: {
    theme: {
      fg: (_color: string, text: string) => string;
      strikethrough: (text: string) => string;
    };
    notify: () => void;
    setStatus: () => void;
    setWidget: (key: string, content?: unknown) => void;
    select?: (
      question: string,
      options: string[],
    ) => Promise<string | undefined>;
  };
}

type CommandHandler = (
  args: string,
  ctx: TestContext,
) => void | Promise<void>;

interface EventHandler {
  (event: never, ctx: TestContext): unknown;
}

test("execution restores tools registered lazily during plan mode", async () => {
  const toolsBeforePlanMode = [
    "read",
    "bash",
    "edit",
    "write",
    "mcp",
  ];
  let activeTools = [...toolsBeforePlanMode];
  const commands = new Map<string, CommandHandler>();

  const pi = {
    registerFlag() {},
    getFlag() {
      return false;
    },
    registerCommand(
      name: string,
      definition: { handler: CommandHandler },
    ) {
      commands.set(name, definition.handler);
    },
    on() {},
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(toolNames: string[]) {
      activeTools = [...toolNames];
    },
    appendEntry() {},
    sendMessage() {},
    sendUserMessage() {},
  };
  const ctx: TestContext = {
    ui: {
      theme: {
        fg: (_color, text) => text,
        strikethrough: (text) => text,
      },
      notify() {},
      setStatus() {},
      setWidget() {},
    },
  };

  planModeExtension(pi as never);
  const togglePlanMode = commands.get("plan");
  assert.ok(togglePlanMode);

  await togglePlanMode("", ctx);
  assert.deepEqual(activeTools, ["read", "bash", "grep", "find", "ls"]);

  activeTools.push("ctx_execute", "ctx_execute_file", "ctx_search");

  await togglePlanMode("", ctx);
  assert.deepEqual(activeTools, [
    ...toolsBeforePlanMode,
    "ctx_execute",
    "ctx_execute_file",
    "ctx_search",
  ]);
});

test("todo widget render never exceeds the 10-line budget", async () => {
  const commands = new Map<string, CommandHandler>();
  const eventHandlers = new Map<string, EventHandler>();
  let widgetFactory:
    | ((tui: unknown, theme: unknown) => { render: () => string[] })
    | undefined;

  const pi = {
    registerFlag() {},
    getFlag() {
      return false;
    },
    registerCommand(
      name: string,
      definition: { handler: CommandHandler },
    ) {
      commands.set(name, definition.handler);
    },
    on(event: string, handler: EventHandler) {
      eventHandlers.set(event, handler);
    },
    getActiveTools() {
      return [];
    },
    setActiveTools() {},
    appendEntry() {},
    sendMessage() {},
    sendUserMessage() {},
  };
  const ctx: TestContext = {
    hasUI: true,
    ui: {
      theme: {
        fg: (_color, text) => text,
        strikethrough: (text) => text,
      },
      notify() {},
      setStatus() {},
      setWidget(_key, content) {
        if (typeof content === "function") {
          widgetFactory = content as never;
        }
      },
      select: async () => "Execute the plan",
    },
  };

  planModeExtension(pi as never);

  // Enter plan mode, then feed a 10-step plan and start executing it.
  const togglePlanMode = commands.get("plan");
  assert.ok(togglePlanMode);
  await togglePlanMode("", ctx);

  const planDocument = [
    "Plan:",
    "Summary:",
    "Fix the widget overflow",
    "Assumptions:",
    "- none",
    "Changes:",
    "- fix slice call",
    "Test Plan:",
    "- run tests",
    "Steps:",
    ...Array.from({ length: 10 }, (_, i) => `${i + 1}. Step ${i + 1}`),
  ].join("\n");

  const agentEnd = eventHandlers.get("agent_end");
  assert.ok(agentEnd);
  await agentEnd(
    {
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: planDocument }],
        },
      ],
    } as never,
    ctx,
  );

  // Complete step 1: exactly 9 steps remain, so the completed-step budget
  // is 0. The old code rendered all completed steps here (slice(-0)).
  const turnEnd = eventHandlers.get("turn_end");
  assert.ok(turnEnd);
  await turnEnd(
    {
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "[DONE:1]" }],
      },
    } as never,
    ctx,
  );

  assert.ok(widgetFactory, "plan-todos widget factory was not registered");
  const widget = widgetFactory(undefined, undefined);
  const lines = widget.render();

  assert.ok(
    lines.length <= 10,
    `todo widget rendered ${lines.length} lines, expected at most 10:\n${lines.join("\n")}`,
  );
  // Completed step 1 must be hidden (summarized in the hint), not rendered.
  // Rendered labels are zero-padded ("01. Step 1"), so "Step 1" alone would
  // also match "Step 10".
  assert.ok(!lines.some((line) => line.includes("01. Step 1")));
  assert.ok(lines.some((line) => line.includes("steps hidden")));
});
