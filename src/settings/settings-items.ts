import { DEFAULT_NOTES_FOLDER } from "../config";
import type { PluginSettings } from "../sync/sync-state";

export type SettingItem =
	| { kind: "heading"; text: string }
	| { kind: "info"; name: string; description: string }
	| { kind: "button"; name: string; description: string; label: string; onClick: () => void }
	| { kind: "text"; name: string; description: string; value: string; placeholder: string; onChange: (value: string) => void }
	| { kind: "toggle"; name: string; description: string; value: boolean; onChange: (value: boolean) => void };

export interface SettingsActions {
	signIn: () => void;
	createAccount: () => void;
	signOut: () => void;
	syncNow: () => void;
	refreshAllNotes: () => void;
	setFolder: (folder: string) => void;
	setAutomaticSync: (on: boolean) => void;
	setSyncOnOpen: (on: boolean) => void;
}

function accountItems(input: { signedIn: boolean; actions: SettingsActions }): SettingItem[] {
	const { signedIn, actions } = input;
	if (signedIn) {
		return [
			{ kind: "info", name: "Signed in", description: "This vault is connected to your Readplace account." },
			{ kind: "button", name: "Sign out", description: "Disconnects this vault. Your notes stay where they are.", label: "Sign out", onClick: actions.signOut },
		];
	}
	return [
		{ kind: "button", name: "Sign in", description: "Opens Readplace in your browser.", label: "Sign in", onClick: actions.signIn },
		{ kind: "button", name: "Create account", description: "Opens Readplace in your browser to create an account.", label: "Create account", onClick: actions.createAccount },
	];
}

export function buildSettingsItems(input: { signedIn: boolean; settings: PluginSettings; actions: SettingsActions }): SettingItem[] {
	const { settings, actions } = input;
	return [
		{ kind: "heading", text: "Account" },
		...accountItems(input),
		{ kind: "heading", text: "Notes" },
		{
			kind: "text",
			name: "Folder",
			description: "Where new notes go. Notes already synced stay where they are.",
			value: settings.folder,
			placeholder: DEFAULT_NOTES_FOLDER,
			onChange: actions.setFolder,
		},
		{ kind: "heading", text: "Sync" },
		{
			kind: "toggle",
			name: "Sync every 60 minutes while Obsidian is open",
			description: "Runs in the background and only shows a notice when something changed.",
			value: settings.automaticSync,
			onChange: actions.setAutomaticSync,
		},
		{
			kind: "toggle",
			name: "Sync when Obsidian opens",
			description: "Off by default, because creating notes at startup can conflict with Obsidian Sync.",
			value: settings.syncOnOpen,
			onChange: actions.setSyncOnOpen,
		},
		{ kind: "button", name: "Sync now", description: "Copies new and changed articles into your vault.", label: "Sync now", onClick: actions.syncNow },
		{
			kind: "button",
			name: "Refresh all notes",
			description: "Rewrites every note you have not edited, including the readlists each article sits in.",
			label: "Refresh all notes",
			onClick: actions.refreshAllNotes,
		},
	];
}
