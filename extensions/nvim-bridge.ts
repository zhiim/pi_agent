import { createHash } from "node:crypto";
import { chmod, mkdir, realpath, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net, { type Server, type Socket } from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MAX_MESSAGE_BYTES = 1024 * 1024;

type SelectionMessage = {
  type: "selection";
  path: string;
  startLine: number;
  endLine: number;
  content: string;
};

function runtimeDirectory(): string {
  if (process.env.XDG_RUNTIME_DIR) {
    return path.join(process.env.XDG_RUNTIME_DIR, "pi-nvim");
  }

  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return path.join(tmpdir(), `pi-nvim-${uid}`);
}

async function socketPathFor(cwd: string): Promise<string> {
  const canonicalCwd = await realpath(cwd).catch(() => path.resolve(cwd));
  const projectId = createHash("sha256").update(canonicalCwd).digest("hex").slice(0, 16);
  return path.join(runtimeDirectory(), `${projectId}.sock`);
}

function isSelectionMessage(value: unknown): value is SelectionMessage {
  if (!value || typeof value !== "object") return false;

  const message = value as Partial<SelectionMessage>;
  return (
    message.type === "selection" &&
    typeof message.path === "string" &&
    message.path.length > 0 &&
    !message.path.includes("\n") &&
    Number.isInteger(message.startLine) &&
    Number.isInteger(message.endLine) &&
    (message.startLine ?? 0) > 0 &&
    (message.endLine ?? 0) >= (message.startLine ?? 0) &&
    typeof message.content === "string"
  );
}

function formatSelection(message: SelectionMessage): string {
  return `Path: ${message.path}\nLines: ${message.startLine}-${message.endLine}\n\n${message.content}`;
}

function handleConnection(socket: Socket, ctx: ExtensionContext): void {
  socket.setEncoding("utf8");

  let input = "";
  let inputBytes = 0;
  let handled = false;

  const fail = (message: string) => {
    if (!socket.destroyed) socket.end(`${JSON.stringify({ ok: false, error: message })}\n`);
  };

  socket.on("data", (chunk: string) => {
    if (handled) return;

    inputBytes += Buffer.byteLength(chunk);
    if (inputBytes > MAX_MESSAGE_BYTES) {
      handled = true;
      fail("Selection exceeds the 1 MiB limit");
      return;
    }

    input += chunk;
    const newline = input.indexOf("\n");
    if (newline === -1) return;

    handled = true;
    const line = input.slice(0, newline).replace(/\r$/, "");

    try {
      const message: unknown = JSON.parse(line);
      if (!isSelectionMessage(message)) {
        fail("Invalid selection payload");
        return;
      }

      ctx.ui.pasteToEditor(formatSelection(message));
      ctx.ui.notify(
        `Loaded ${path.basename(message.path)}:${message.startLine}-${message.endLine} from Neovim`,
        "info",
      );
      socket.end(`${JSON.stringify({ ok: true })}\n`);
    } catch (error) {
      fail(error instanceof Error ? error.message : "Invalid JSON payload");
    }
  });

  socket.on("error", () => {
    // Client disconnects are non-fatal for the bridge.
  });
}

async function socketIsActive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = net.createConnection(socketPath);
    let settled = false;

    const finish = (active: boolean) => {
      if (settled) return;
      settled = true;
      client.destroy();
      resolve(active);
    };

    client.once("connect", () => finish(true));
    client.once("error", () => finish(false));
  });
}

export default function (pi: ExtensionAPI) {
  let server: Server | undefined;
  let ownedSocketPath: string | undefined;
  const clients = new Set<Socket>();

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    const socketDirectory = runtimeDirectory();
    const socketPath = await socketPathFor(ctx.cwd);

    await mkdir(socketDirectory, { recursive: true, mode: 0o700 });
    await chmod(socketDirectory, 0o700);

    if (await socketIsActive(socketPath)) {
      ctx.ui.notify(
        `Neovim bridge is already owned by another Pi session for ${ctx.cwd}`,
        "warning",
      );
      return;
    }

    await unlink(socketPath).catch(() => undefined);

    const nextServer = net.createServer((socket) => {
      clients.add(socket);
      socket.once("close", () => clients.delete(socket));
      handleConnection(socket, ctx);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        nextServer.once("error", reject);
        nextServer.listen(socketPath, resolve);
      });
      nextServer.removeAllListeners("error");
      nextServer.on("error", (error) => {
        ctx.ui.notify(`Neovim bridge error: ${error.message}`, "error");
      });
      await chmod(socketPath, 0o600);
      nextServer.unref();
      server = nextServer;
      ownedSocketPath = socketPath;
      ctx.ui.notify(`Neovim bridge ready: ${socketPath}`, "info");
    } catch (error) {
      nextServer.close();
      ctx.ui.notify(
        `Failed to start Neovim bridge: ${error instanceof Error ? error.message : error}`,
        "error",
      );
    }
  });

  pi.on("session_shutdown", async () => {
    const activeServer = server;
    const activeSocketPath = ownedSocketPath;
    server = undefined;
    ownedSocketPath = undefined;

    for (const client of clients) client.destroy();
    clients.clear();

    if (activeServer) {
      await new Promise<void>((resolve) => activeServer.close(() => resolve()));
    }
    if (activeSocketPath) {
      await unlink(activeSocketPath).catch(() => undefined);
    }
  });
}
