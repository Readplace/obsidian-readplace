import { assert } from "../assert";
import type { TokenClient } from "../auth/tokens";
import { sha256Hex } from "../notes/content-hash";
import { fetchArticleMarkdown, type MarkdownOutcome } from "../notes/fetch-article-markdown";
import { noteBaseName } from "../notes/note-path";
import { createNote, renameNote, updateNote } from "../notes/write-note";
import type { Clock, VaultPort } from "../ports";
import type { ListedArticle } from "../siren/siren";
import { planNoteWrite } from "./plan-note-writes";
import { walkEverySave } from "./scope";
import type { PluginData, SyncedNote } from "./sync-state";

export interface SyncCounts { created: number; updated: number; edited: number; processing: number; errors: number }

export type SyncResult =
	| { kind: "done"; counts: SyncCounts }
	| { kind: "signed-out"; counts: SyncCounts }
	| { kind: "unavailable"; reason: string; counts: SyncCounts }
	| { kind: "stopped"; counts: SyncCounts }
	| { kind: "already-running" };

export interface SyncRunner {
	run(options: { refreshAll: boolean }): Promise<SyncResult>;
	stop(): void;
}

type FetchedDocument = Extract<MarkdownOutcome, { kind: "document" }>;
type RunEnding = { kind: "signed-out" } | { kind: "unavailable"; reason: string };

function listingValues(listed: ListedArticle): Pick<SyncedNote, "title" | "contentVersion" | "status" | "readAt"> {
	const { title, contentVersion, status, readAt } = listed;
	return { title, contentVersion, status, readAt };
}

function folderOf(path: string): string {
	return path.slice(0, Math.max(path.lastIndexOf("/"), 0));
}

function resultOf(ending: RunEnding, counts: SyncCounts): SyncResult {
	return ending.kind === "signed-out" ? { kind: "signed-out", counts } : { kind: "unavailable", reason: ending.reason, counts };
}

export function initSyncRunner(deps: {
	tokens: TokenClient;
	vault: VaultPort;
	data: { get(): PluginData; set(next: PluginData): Promise<void> };
	origin: string;
	clock: Clock;
}): SyncRunner {
	const { tokens, vault, data } = deps;

	const recordNote = async (id: string, note: SyncedNote): Promise<void> => {
		const current = data.get();
		await data.set({ ...current, notes: { ...current.notes, [id]: note } });
	};

	const fetchDocument = async (input: { listed: ListedArticle; counts: SyncCounts }): Promise<FetchedDocument | RunEnding | undefined> => {
		const { listed, counts } = input;
		if (listed.readHref === undefined) {
			counts.errors += 1;
			return undefined;
		}
		const outcome = await fetchArticleMarkdown({ tokens, readHref: listed.readHref });
		if (outcome.kind === "document" || outcome.kind === "signed-out" || outcome.kind === "unavailable") return outcome;
		counts.errors += 1;
		return undefined;
	};

	const createFrom = async (input: { listed: ListedArticle; counts: SyncCounts }): Promise<RunEnding | undefined> => {
		const { listed, counts } = input;
		const fetched = await fetchDocument(input);
		if (fetched?.kind !== "document") return fetched;
		const content = fetched.markdown;
		let path: string;
		try {
			({ path } = await createNote({ vault, folder: data.get().settings.folder, baseName: noteBaseName(listed), content }));
		} catch {
			counts.errors += 1;
			return undefined;
		}
		await recordNote(listed.id, { path, hash: await sha256Hex(content), ...listingValues(listed), edited: false });
		counts.created += 1;
		if (!fetched.complete) counts.processing += 1;
		return undefined;
	};

	const renamedIfAsked = async (input: {
		listed: ListedArticle;
		state: SyncedNote;
		rename: { baseName: string } | undefined;
		counts: SyncCounts;
	}): Promise<void> => {
		const { listed, state, rename, counts } = input;
		if (rename === undefined) return;
		let path: string;
		try {
			({ path } = await renameNote({ vault, path: state.path, folder: folderOf(state.path), baseName: rename.baseName }));
		} catch {
			counts.errors += 1;
			return;
		}
		await recordNote(listed.id, { ...state, path });
	};

	const refreshFrom = async (input: {
		listed: ListedArticle;
		state: SyncedNote;
		rename: { baseName: string } | undefined;
		counts: SyncCounts;
	}): Promise<RunEnding | undefined> => {
		const { listed, state, counts } = input;
		if ((await sha256Hex(await vault.read(state.path))) !== state.hash) {
			await recordNote(listed.id, { ...state, edited: true });
			if (!state.edited) counts.edited += 1;
			return undefined;
		}
		await renamedIfAsked(input);
		const fetched = await fetchDocument(input);
		if (fetched?.kind !== "document") return fetched;
		const current = data.get().notes[listed.id];
		assert(current, "A note being refreshed keeps its recorded state");
		const content = fetched.markdown;
		const hash = await sha256Hex(content);
		const settled = { ...current, ...listingValues(listed), hash, edited: false };
		if (hash === state.hash) {
			await recordNote(listed.id, settled);
		} else {
			const updated = await updateNote({ vault, path: current.path, expectedHash: state.hash, content });
			if (updated.kind === "edited") {
				await recordNote(listed.id, { ...current, edited: true });
				counts.edited += 1;
				return undefined;
			}
			await recordNote(listed.id, settled);
			counts.updated += 1;
		}
		if (!fetched.complete) counts.processing += 1;
		return undefined;
	};

	const syncArticle = async (input: { listed: ListedArticle; refreshAll: boolean; counts: SyncCounts }): Promise<RunEnding | undefined> => {
		const { listed, refreshAll, counts } = input;
		const state = data.get().notes[listed.id];
		const noteExists = state !== undefined && vault.fileExists(state.path);
		const plan = planNoteWrite({ listed, state, noteExists });
		if (plan.kind === "create") return createFrom({ listed, counts });
		if (plan.kind === "leave-missing" || (plan.kind === "unchanged" && !refreshAll)) return undefined;
		assert(state, "A note planned for refresh has a recorded state");
		return refreshFrom({ listed, state, rename: plan.kind === "refresh" ? plan.rename : undefined, counts });
	};

	const runOnce = async (refreshAll: boolean): Promise<SyncResult> => {
		const counts: SyncCounts = { created: 0, updated: 0, edited: 0, processing: 0, errors: 0 };
		if (!tokens.isSignedIn()) return { kind: "signed-out", counts };

		const walked = await walkEverySave({ tokens, origin: deps.origin });
		counts.errors += walked.collectionsStopped.length;
		if (walked.fatal !== undefined) return resultOf(walked.fatal, counts);

		for (const listed of walked.articles) {
			if (stopped) return { kind: "stopped", counts };
			const ending = await syncArticle({ listed, refreshAll, counts });
			if (ending !== undefined) return resultOf(ending, counts);
		}
		await data.set({ ...data.get(), lastSyncAt: deps.clock().toISOString() });
		return { kind: "done", counts };
	};

	let running = false;
	let stopped = false;

	return {
		stop: () => {
			stopped = true;
		},
		run: async ({ refreshAll }) => {
			if (running) return { kind: "already-running" };
			running = true;
			try {
				return await runOnce(refreshAll);
			} finally {
				running = false;
			}
		},
	};
}
