/* c8 ignore start -- composition root: wires the real Obsidian objects to the ports */
import { App, Notice, normalizePath, Plugin, PluginSettingTab, requestUrl, Setting } from "obsidian";
import { fetchAuthorizationServer } from "./auth/authorization-server";
import { initSignIn } from "./auth/sign-in";
import { initTokenClient } from "./auth/tokens";
import { AUTOMATIC_SYNC_INTERVAL_MINUTES, OAUTH_PROTOCOL_ACTION, SERVER_ORIGIN } from "./config";
import { initPluginActions, type PluginActions } from "./obsidian/plugin-actions";
import { initSecretTokens } from "./obsidian/secret-tokens";
import { renderSettings } from "./obsidian/settings-tab";
import { initVaultNotes, watchRenames } from "./obsidian/vault-notes";
import type { SendHttp } from "./ports";
import { buildSettingsItems, type SettingsActions } from "./settings/settings-items";
import { initSyncRunner } from "./sync/run-sync";
import { parsePluginData } from "./sync/sync-state";

const sendHttp: SendHttp = async ({ url, method, headers, body }) => {
	const response = await requestUrl({ url, method, headers, body, throw: false });
	return { status: response.status, headers: response.headers, text: response.text };
};

function settingsActionsOf(actions: PluginActions): SettingsActions {
	return {
		signIn: () => void actions.beginSignIn({ screenHint: "login" }),
		createAccount: () => void actions.beginSignIn({ screenHint: "signup" }),
		signOut: () => void actions.signOut(),
		syncNow: () => void actions.sync({ refreshAll: false }),
		refreshAllNotes: () => void actions.sync({ refreshAll: true }),
		setFolder: (folder) => void actions.setFolder(folder),
		setAutomaticSync: (on) => void actions.setAutomaticSync(on),
		setSyncOnOpen: (on) => void actions.setSyncOnOpen(on),
	};
}

class ReadplaceSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		plugin: Plugin,
		private readonly render: (containerEl: HTMLElement) => void,
	) {
		super(app, plugin);
	}

	display(): void {
		this.containerEl.empty();
		this.render(this.containerEl);
	}
}

export default class ReadplacePlugin extends Plugin {
	async onload(): Promise<void> {
		let pluginData = parsePluginData(await this.loadData());
		const data = {
			get: () => pluginData,
			set: async (next: typeof pluginData) => {
				pluginData = next;
				await this.saveData(next);
			},
		};

		const server = () => fetchAuthorizationServer({ sendHttp, origin: SERVER_ORIGIN });
		const tokens = initTokenClient({ sendHttp, secrets: initSecretTokens(this.app.secretStorage), server });
		const signIn = initSignIn({
			sendHttp,
			tokens,
			server,
			openInBrowser: (url) => {
				window.open(url);
			},
			randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
		});
		const vault = initVaultNotes({ vault: this.app.vault, fileManager: this.app.fileManager, normalizePath });
		const runner = initSyncRunner({ tokens, vault, data, origin: SERVER_ORIGIN, clock: () => new Date() });
		this.register(() => runner.stop());

		const actions: PluginActions = initPluginActions({
			tokens,
			signIn,
			runner,
			data,
			notify: (message) => {
				new Notice(message);
			},
			normalizePath,
			accountChanged: () => {
				settingTab.display();
			},
		});

		const settingTab = new ReadplaceSettingTab(this.app, this, (containerEl) => {
			renderSettings({
				items: buildSettingsItems({ signedIn: tokens.isSignedIn(), settings: data.get().settings, actions: settingsActionsOf(actions) }),
				addRow: () => new Setting(containerEl),
			});
		});
		this.addSettingTab(settingTab);

		this.registerObsidianProtocolHandler(OAUTH_PROTOCOL_ACTION, ({ action: _action, ...params }) => {
			void actions.completeSignIn(params);
		});

		this.addCommand({ id: "sync", name: "Sync now", callback: () => void actions.sync({ refreshAll: false }) });
		this.addCommand({ id: "refresh-all-notes", name: "Refresh all notes", callback: () => void actions.sync({ refreshAll: true }) });
		this.addCommand({ id: "sign-in", name: "Sign in", callback: () => void actions.beginSignIn({ screenHint: "login" }) });
		this.addCommand({ id: "sign-out", name: "Sign out", callback: () => void actions.signOut() });

		this.registerEvent(watchRenames({ vault: this.app.vault, onMove: (move) => actions.noteMoved(move) }));
		this.registerInterval(window.setInterval(() => void actions.automaticSync(), AUTOMATIC_SYNC_INTERVAL_MINUTES * 60_000));
		this.app.workspace.onLayoutReady(() => void actions.syncOnOpen());
	}
}
/* c8 ignore stop */
