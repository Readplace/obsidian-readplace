import { DEFAULT_SETTINGS } from "../sync/sync-state";
import { buildSettingsItems, type SettingItem, type SettingsActions } from "./settings-items";

function recordingActions() {
	const calls: unknown[][] = [];
	const actions: SettingsActions = {
		signIn: () => calls.push(["signIn"]),
		createAccount: () => calls.push(["createAccount"]),
		signOut: () => calls.push(["signOut"]),
		syncNow: () => calls.push(["syncNow"]),
		refreshAllNotes: () => calls.push(["refreshAllNotes"]),
		setFolder: (folder) => calls.push(["setFolder", folder]),
		setAutomaticSync: (on) => calls.push(["setAutomaticSync", on]),
		setSyncOnOpen: (on) => calls.push(["setSyncOnOpen", on]),
	};
	return { calls, actions };
}

function titleOf(item: SettingItem): string {
	return item.kind === "heading" ? `# ${item.text}` : item.name;
}

function itemNamed<Kind extends SettingItem["kind"]>(items: SettingItem[], kind: Kind, name: string) {
	const item = items.find((candidate): candidate is Extract<SettingItem, { kind: Kind }> => candidate.kind === kind && titleOf(candidate) === name);
	if (item === undefined) throw new Error(`No ${kind} item named ${name}`);
	return item;
}

describe("buildSettingsItems", () => {
	it("offers sign in and account creation when signed out, in section order", () => {
		const items = buildSettingsItems({ signedIn: false, settings: DEFAULT_SETTINGS, actions: recordingActions().actions });

		expect(items.map(titleOf)).toEqual([
			"# Account",
			"Sign in",
			"Create account",
			"# Notes",
			"Folder",
			"# Sync",
			"Sync every 60 minutes while Obsidian is open",
			"Sync when Obsidian opens",
			"Sync now",
			"Refresh all notes",
		]);
	});

	it("shows the connection and sign out when signed in", () => {
		const items = buildSettingsItems({ signedIn: true, settings: DEFAULT_SETTINGS, actions: recordingActions().actions });

		expect(items.slice(0, 3).map(titleOf)).toEqual(["# Account", "Signed in", "Sign out"]);
	});

	it("shows the stored settings, with automatic sync on and sync on open off by default", () => {
		const items = buildSettingsItems({ signedIn: true, settings: DEFAULT_SETTINGS, actions: recordingActions().actions });

		expect(itemNamed(items, "text", "Folder")).toMatchObject({ value: "Readplace", placeholder: "Readplace" });
		expect(itemNamed(items, "toggle", "Sync every 60 minutes while Obsidian is open").value).toBe(true);
		expect(itemNamed(items, "toggle", "Sync when Obsidian opens").value).toBe(false);
	});

	it("reaches each signed-out action", () => {
		const { calls, actions } = recordingActions();
		const items = buildSettingsItems({ signedIn: false, settings: DEFAULT_SETTINGS, actions });

		itemNamed(items, "button", "Sign in").onClick();
		itemNamed(items, "button", "Create account").onClick();

		expect(calls).toEqual([["signIn"], ["createAccount"]]);
	});

	it("reaches each signed-in action with its value", () => {
		const { calls, actions } = recordingActions();
		const items = buildSettingsItems({ signedIn: true, settings: DEFAULT_SETTINGS, actions });

		itemNamed(items, "button", "Sign out").onClick();
		itemNamed(items, "button", "Sync now").onClick();
		itemNamed(items, "button", "Refresh all notes").onClick();
		itemNamed(items, "text", "Folder").onChange("Articles");
		itemNamed(items, "toggle", "Sync every 60 minutes while Obsidian is open").onChange(false);
		itemNamed(items, "toggle", "Sync when Obsidian opens").onChange(true);

		expect(calls).toEqual([
			["signOut"],
			["syncNow"],
			["refreshAllNotes"],
			["setFolder", "Articles"],
			["setAutomaticSync", false],
			["setSyncOnOpen", true],
		]);
	});
});
