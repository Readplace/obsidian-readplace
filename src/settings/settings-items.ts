import { DEFAULT_NOTES_FOLDER } from "../config";
import type { PluginSettings } from "../sync/sync-state";

export type SettingItem =
	| { kind: "heading"; text: string }
	| { kind: "info"; name: string; description: string; visible: () => boolean }
	| { kind: "button"; name: string; description: string; visible: () => boolean; label: string; onClick: () => void }
	| {
			kind: "text";
			name: string;
			description: string;
			visible: () => boolean;
			value: string;
			placeholder: string;
			onChange: (value: string) => void;
	  }
	| { kind: "toggle"; name: string; description: string; visible: () => boolean; value: boolean; onChange: (value: boolean) => void };

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

const always = () => true;

function accountItems(input: { signedIn: () => boolean; actions: SettingsActions }): SettingItem[] {
	const { signedIn, actions } = input;
	const signedOut = () => !signedIn();
	return [
		{
			kind: "button",
			name: "Sign in",
			description: "Opens Readplace in your browser.",
			visible: signedOut,
			label: "Sign in",
			onClick: actions.signIn,
		},
		{
			kind: "button",
			name: "Create account",
			description: "Opens Readplace in your browser to create an account.",
			visible: signedOut,
			label: "Create account",
			onClick: actions.createAccount,
		},
		{ kind: "info", name: "Signed in", description: "This vault is connected to your Readplace account.", visible: signedIn },
		{
			kind: "button",
			name: "Sign out",
			description: "Disconnects this vault. Your notes stay where they are.",
			visible: signedIn,
			label: "Sign out",
			onClick: actions.signOut,
		},
	];
}

export function buildSettingsItems(input: { signedIn: () => boolean; settings: PluginSettings; actions: SettingsActions }): SettingItem[] {
	const { settings, actions } = input;
	return [
		{ kind: "heading", text: "Account" },
		...accountItems(input),
		{ kind: "heading", text: "Notes" },
		{
			kind: "text",
			name: "Folder",
			description: "Where new notes go. Notes already synced stay where they are.",
			visible: always,
			value: settings.folder,
			placeholder: DEFAULT_NOTES_FOLDER,
			onChange: actions.setFolder,
		},
		{ kind: "heading", text: "Sync" },
		{
			kind: "toggle",
			name: "Sync every 60 minutes while Obsidian is open",
			description: "Runs in the background and only shows a notice when something changed.",
			visible: always,
			value: settings.automaticSync,
			onChange: actions.setAutomaticSync,
		},
		{
			kind: "toggle",
			name: "Sync when Obsidian opens",
			description: "Off by default, because creating notes at startup can conflict with Obsidian Sync.",
			visible: always,
			value: settings.syncOnOpen,
			onChange: actions.setSyncOnOpen,
		},
		{
			kind: "button",
			name: "Sync now",
			description: "Copies new and changed articles into your vault.",
			visible: always,
			label: "Sync now",
			onClick: actions.syncNow,
		},
		{
			kind: "button",
			name: "Refresh all notes",
			description: "Rewrites every note you have not edited, including the readlists each article sits in.",
			visible: always,
			label: "Refresh all notes",
			onClick: actions.refreshAllNotes,
		},
	];
}
