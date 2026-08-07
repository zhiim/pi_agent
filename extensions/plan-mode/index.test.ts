import assert from "node:assert/strict";
import { test } from "node:test";
import planModeExtension from "./index.ts";

interface TestContext {
  ui: {
    theme: {
      fg: (_color: string, text: string) => string;
      strikethrough: (text: string) => string;
    };
    notify: () => void;
    setStatus: () => void;
    setWidget: () => void;
  };
}

type CommandHandler = (
  args: string,
  ctx: TestContext,
) => void | Promise<void>;

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
