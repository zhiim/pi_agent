import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text } from "@earendil-works/pi-tui";

type ExportMetadata = {
	title: string;
	id: string;
	cwd: string;
	created?: Date;
	sourceFile?: string;
	turnNumber: number;
	throughEntryId: string;
};

type ContentBlock = {
	type?: string;
	text?: string;
	mimeType?: string;
	source?: { mediaType?: string };
};

type UserTurn = {
	entryId: string;
	startIndex: number;
	endExclusive: number;
	label: string;
	turnNumber: number;
};

function cleanOneLine(value: string, maxLength = 72): string {
	const cleaned = value.replace(/\s+/g, " ").trim();
	if (cleaned.length <= maxLength) return cleaned;
	return `${cleaned.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function contentParts(content: unknown): string[] {
	if (typeof content === "string") return content.trim() ? [content.trim()] : [];
	if (!Array.isArray(content)) return [];

	const parts: string[] = [];
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const block = item as ContentBlock;
		if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
			parts.push(block.text.trim());
		} else if (block.type === "image") {
			const mimeType = block.mimeType ?? block.source?.mediaType ?? "unknown";
			parts.push(`> [Image omitted: ${mimeType}]`);
		}
	}
	return parts;
}

function firstUserText(entries: readonly SessionEntry[]): string | undefined {
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const text = contentParts(entry.message.content).find((part) => !part.startsWith("> [Image omitted:"));
		if (text) return cleanOneLine(text);
	}
	return undefined;
}

function yamlString(value: string): string {
	return JSON.stringify(value);
}

function displayTimestamp(value: string | number | Date | undefined): string | undefined {
	if (value === undefined) return undefined;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function markdownTitle(value: string): string {
	return value.replace(/[\r\n]+/g, " ").trim() || "Pi Conversation";
}

export function renderConversationMarkdown(
	metadata: ExportMetadata,
	entries: readonly SessionEntry[],
): string {
	const title = markdownTitle(metadata.title);
	const lines = [
		"---",
		`title: ${yamlString(title)}`,
		`session_id: ${yamlString(metadata.id)}`,
		`cwd: ${yamlString(metadata.cwd)}`,
		`exported_at: ${yamlString(new Date().toISOString())}`,
		`through_turn: ${metadata.turnNumber}`,
		`through_entry_id: ${yamlString(metadata.throughEntryId)}`,
	];

	const createdAt = displayTimestamp(metadata.created);
	if (createdAt) lines.push(`created_at: ${yamlString(createdAt)}`);
	if (metadata.sourceFile) lines.push(`source_file: ${yamlString(metadata.sourceFile)}`);

	lines.push("---", "");

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const { message } = entry;
		if (message.role !== "user" && message.role !== "assistant") continue;

		const parts = contentParts(message.content);
		if (parts.length === 0) continue;

		lines.push(`## ${message.role === "user" ? "User" : "Assistant"}`);
		const timestamp = displayTimestamp(message.timestamp ?? entry.timestamp);
		if (timestamp) lines.push("", `*${timestamp}*`);
		lines.push("", parts.join("\n\n"), "");
	}

	return `${lines.join("\n").trimEnd()}\n`;
}

function buildUserTurns(entries: readonly SessionEntry[]): UserTurn[] {
	const userEntries: Array<{
		entryId: string;
		index: number;
		preview: string;
		timestamp?: string;
	}> = [];

	for (const [index, entry] of entries.entries()) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		userEntries.push({
			entryId: entry.id,
			index,
			preview: cleanOneLine(contentParts(entry.message.content).join(" ") || "[Empty user message]", 80),
			timestamp: displayTimestamp(entry.message.timestamp ?? entry.timestamp),
		});
	}

	return userEntries.map((entry, turnIndex) => {
		const nextUserIndex = userEntries[turnIndex + 1]?.index ?? entries.length;
		const date = entry.timestamp ? entry.timestamp.slice(0, 16).replace("T", " ") : "Unknown time";
		const turnNumber = turnIndex + 1;
		return {
			entryId: entry.entryId,
			startIndex: entry.index,
			endExclusive: nextUserIndex,
			label: `${String(turnNumber).padStart(2, "0")} · ${date} · ${entry.preview} · ${entry.entryId}`,
			turnNumber,
		};
	});
}

async function selectUserTurn(ctx: ExtensionCommandContext, turns: UserTurn[]): Promise<string | undefined> {
	const title = "Select a user turn to export";
	if (ctx.mode !== "tui") return ctx.ui.select(title, turns.map((turn) => turn.label));

	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));

		const list = new SelectList(
			turns.map((turn) => ({ value: turn.label, label: turn.label })),
			Math.min(turns.length, 10),
			{
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			},
		);
		list.setSelectedIndex(turns.length - 1);
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(undefined);
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate · enter select · esc cancel"), 1, 0));
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

function slugify(value: string): string {
	const slug = value
		.normalize("NFKC")
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^[.\- ]+|[.\- ]+$/g, "")
		.slice(0, 60);
	return slug || "pi-conversation";
}

function defaultFilename(metadata: ExportMetadata): string {
	const turn = String(metadata.turnNumber).padStart(2, "0");
	return `${slugify(metadata.title)}-turn-${turn}.md`;
}

function normalizeFilename(value: string): string | undefined {
	const filename = value.trim();
	if (!filename || filename === "." || filename === ".." || /[. ]$/.test(filename)) return undefined;
	if (/[<>:"/\\|?*\u0000-\u001f]/.test(filename)) return undefined;
	if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(filename)) return undefined;
	return filename.toLowerCase().endsWith(".md") ? filename : `${filename}.md`;
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function requestOutputFile(
	ctx: ExtensionCommandContext,
	suggestedFilename: string,
): Promise<{ outputPath: string; overwrite: boolean } | undefined> {
	const requestedFilename = await ctx.ui.input("Export filename", suggestedFilename);
	if (requestedFilename === undefined) return undefined;

	const filename = normalizeFilename(requestedFilename || suggestedFilename);
	if (!filename) {
		ctx.ui.notify("Enter a valid filename without directory separators", "error");
		return undefined;
	}

	const outputPath = join(ctx.cwd, filename);
	const overwrite = await fileExists(outputPath);
	if (overwrite) {
		const confirmed = await ctx.ui.confirm(
			"Overwrite existing file?",
			`${filename} already exists in the current directory.`,
		);
		if (!confirmed) return undefined;
	}

	return { outputPath, overwrite };
}

function fullHistoryFilename(metadata: ExportMetadata): string {
	return `${slugify(metadata.title)}-all.md`;
}

export default function mdExportExtension(pi: ExtensionAPI) {
	pi.registerCommand("md", {
		description: "Select one user turn and export only its user/assistant exchange as Markdown",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				throw new Error("/md requires an interactive UI to select a conversation turn");
			}

			try {
				const branch = ctx.sessionManager.getBranch();
				const turns = buildUserTurns(branch);
				if (turns.length === 0) {
					ctx.ui.notify("The current session has no user turns to export", "warning");
					return;
				}

				const selectedLabel = await selectUserTurn(ctx, turns);
				if (!selectedLabel) return;

				const selected = turns.find((turn) => turn.label === selectedLabel);
				if (!selected) {
					ctx.ui.notify("The selected conversation turn could not be found", "error");
					return;
				}

				const header = ctx.sessionManager.getHeader();
				const metadata: ExportMetadata = {
					title: cleanOneLine(pi.getSessionName() || firstUserText(branch) || "Pi Conversation"),
					id: ctx.sessionManager.getSessionId(),
					cwd: ctx.sessionManager.getCwd(),
					created: header?.timestamp ? new Date(header.timestamp) : undefined,
					sourceFile: ctx.sessionManager.getSessionFile(),
					turnNumber: selected.turnNumber,
					throughEntryId: selected.entryId,
				};
				const output = await requestOutputFile(ctx, defaultFilename(metadata));
				if (!output) return;

				const entriesToExport = branch.slice(selected.startIndex, selected.endExclusive);
				await writeFile(output.outputPath, renderConversationMarkdown(metadata, entriesToExport), {
					encoding: "utf8",
					flag: output.overwrite ? "w" : "wx",
				});
				ctx.ui.notify(`Exported conversation to ${output.outputPath}`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Export failed: ${message}`, "error");
			}
		},
	});

	pi.registerCommand("md-all", {
		description: "Export the complete conversation history from the current session as Markdown",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				throw new Error("/md-all requires an interactive UI to choose an export filename");
			}

			try {
				const branch = ctx.sessionManager.getBranch();
				const turns = buildUserTurns(branch);
				if (turns.length === 0) {
					ctx.ui.notify("The current session has no conversation history to export", "warning");
					return;
				}

				const header = ctx.sessionManager.getHeader();
				const lastTurn = turns.at(-1)!;
				const metadata: ExportMetadata = {
					title: cleanOneLine(pi.getSessionName() || firstUserText(branch) || "Pi Conversation"),
					id: ctx.sessionManager.getSessionId(),
					cwd: ctx.sessionManager.getCwd(),
					created: header?.timestamp ? new Date(header.timestamp) : undefined,
					sourceFile: ctx.sessionManager.getSessionFile(),
					turnNumber: turns.length,
					throughEntryId: ctx.sessionManager.getLeafId() || lastTurn.entryId,
				};
				const output = await requestOutputFile(ctx, fullHistoryFilename(metadata));
				if (!output) return;

				await writeFile(output.outputPath, renderConversationMarkdown(metadata, branch), {
					encoding: "utf8",
					flag: output.overwrite ? "w" : "wx",
				});
				ctx.ui.notify(`Exported complete conversation history to ${output.outputPath}`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Export failed: ${message}`, "error");
			}
		},
	});
}
