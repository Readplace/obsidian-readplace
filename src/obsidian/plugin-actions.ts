import type { SignIn } from "../auth/sign-in";
import type { TokenClient } from "../auth/tokens";
import { DEFAULT_NOTES_FOLDER } from "../config";
import type { Notify } from "../ports";
import type { SyncResult, SyncRunner } from "../sync/run-sync";
import { noteRenamed, type PluginData, type PluginSettings } from "../sync/sync-state";
import { signInNotice, signInUnavailableNotice, SIGNED_OUT_NOTICE, SYNC_FAILED_NOTICE, syncNotice } from "./notices";

export interface PluginActions {
	beginSignIn(options: { screenHint: "login" | "signup" }): Promise<void>;
	completeSignIn(params: Record<string, string>): Promise<void>;
	signOut(): Promise<void>;
	sync(options: { refreshAll: boolean }): Promise<void>;
	automaticSync(): Promise<void>;
	syncOnOpen(): Promise<void>;
	setFolder(folder: string): Promise<void>;
	setAutomaticSync(on: boolean): Promise<void>;
	setSyncOnOpen(on: boolean): Promise<void>;
	noteMoved(move: { oldPath: string; newPath: string }): Promise<void>;
}

function changedNothing(result: SyncResult): boolean {
	if (result.kind === "already-running") return true;
	return result.kind === "done" && Object.values(result.counts).every((count) => count === 0);
}

export function initPluginActions(deps: {
	tokens: TokenClient;
	signIn: SignIn;
	runner: SyncRunner;
	data: { get(): PluginData; set(next: PluginData): Promise<void> };
	notify: Notify;
	normalizePath: (path: string) => string;
	accountChanged: () => void;
}): PluginActions {
	const { tokens, signIn, runner, data, notify, accountChanged } = deps;

	const report = async (options: { refreshAll: boolean; quietWhenUnchanged: boolean }): Promise<void> => {
		let result: SyncResult;
		try {
			result = await runner.run({ refreshAll: options.refreshAll });
		} catch {
			notify(SYNC_FAILED_NOTICE);
			return;
		}
		if (result.kind === "stopped") return;
		if (result.kind === "signed-out") accountChanged();
		if (options.quietWhenUnchanged && changedNothing(result)) return;
		notify(syncNotice(result));
	};

	const syncInBackgroundWhen = async (enabled: (settings: PluginSettings) => boolean): Promise<void> => {
		if (!enabled(data.get().settings) || !tokens.isSignedIn()) return;
		await report({ refreshAll: false, quietWhenUnchanged: true });
	};

	const saveSettings = async (change: Partial<PluginSettings>): Promise<void> => {
		const current = data.get();
		await data.set({ ...current, settings: { ...current.settings, ...change } });
	};

	return {
		beginSignIn: async (options) => {
			const begun = await signIn.begin(options);
			if (begun.kind === "unavailable") notify(signInUnavailableNotice(begun.status));
		},
		completeSignIn: async (params) => {
			const outcome = await signIn.complete(params);
			if (outcome.kind === "signed-in") accountChanged();
			notify(signInNotice(outcome));
		},
		signOut: async () => {
			await tokens.signOut();
			accountChanged();
			notify(SIGNED_OUT_NOTICE);
		},
		sync: ({ refreshAll }) => report({ refreshAll, quietWhenUnchanged: false }),
		automaticSync: () => syncInBackgroundWhen((settings) => settings.automaticSync),
		syncOnOpen: () => syncInBackgroundWhen((settings) => settings.syncOnOpen),
		setFolder: (folder) => saveSettings({ folder: folder.trim() === "" ? DEFAULT_NOTES_FOLDER : deps.normalizePath(folder) }),
		setAutomaticSync: (automaticSync) => saveSettings({ automaticSync }),
		setSyncOnOpen: (syncOnOpen) => saveSettings({ syncOnOpen }),
		noteMoved: (move) => data.set(noteRenamed(data.get(), move)),
	};
}
