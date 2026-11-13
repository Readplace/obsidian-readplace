import type { SignIn, SignInOutcome } from "../auth/sign-in";
import type { TokenClient } from "../auth/tokens";
import type { SyncResult } from "../sync/run-sync";
import { DEFAULT_SETTINGS, parsePluginData, type PluginData, type PluginSettings } from "../sync/sync-state";
import { initPluginActions } from "./plugin-actions";

const noCounts = { created: 0, updated: 0, edited: 0, processing: 0, errors: 0 };

function harness(options: {
	signedIn?: boolean;
	settings?: Partial<PluginSettings>;
	notes?: PluginData["notes"];
	syncResult?: () => Promise<SyncResult>;
	begun?: Awaited<ReturnType<SignIn["begin"]>>;
	completed?: SignInOutcome;
} = {}) {
	let current: PluginData = { ...parsePluginData(null), notes: options.notes ?? {}, settings: { ...DEFAULT_SETTINGS, ...options.settings } };
	const notices: string[] = [];
	const runs: { refreshAll: boolean }[] = [];
	const begins: unknown[] = [];
	const completes: unknown[] = [];
	const events: string[] = [];
	const tokens: TokenClient = {
		isSignedIn: () => options.signedIn ?? true,
		authorizedSend: async () => ({ kind: "signed-out" }),
		storeGrant: () => undefined,
		signOut: async () => {
			events.push("revoked");
		},
	};
	const signIn: SignIn = {
		prepare: async () => undefined,
		begin: async (hint) => {
			begins.push(hint);
			return options.begun ?? { kind: "opened" };
		},
		complete: async (params) => {
			completes.push(params);
			return options.completed ?? { kind: "signed-in" };
		},
	};
	const actions = initPluginActions({
		tokens,
		signIn,
		runner: {
			run: async (run) => {
				runs.push(run);
				return options.syncResult ? options.syncResult() : { kind: "done", counts: noCounts };
			},
			stop: () => undefined,
		},
		data: {
			get: () => current,
			set: async (next) => {
				current = next;
			},
		},
		notify: (message) => notices.push(message),
		normalizePath: (path) => path.replace(/^\/+|\/+$/g, ""),
		accountChanged: () => events.push("account changed"),
	});
	return { actions, notices, runs, begins, completes, events, data: () => current };
}

describe("initPluginActions", () => {
	describe("sign-in", () => {
		it("passes the screen hint on and says nothing once the browser opened", async () => {
			const { actions, begins, notices } = harness();

			await actions.beginSignIn({ screenHint: "signup" });

			expect(begins).toEqual([{ screenHint: "signup" }]);
			expect(notices).toEqual([]);
		});

		it("starts the sign-in before any await, so the click still counts as the reader's gesture", async () => {
			const { actions, begins } = harness();

			const begun = actions.beginSignIn({ screenHint: "login" });

			expect(begins).toEqual([{ screenHint: "login" }]);
			await begun;
		});

		it("tells the reader when sign-in cannot start", async () => {
			const { actions, notices } = harness({ begun: { kind: "unavailable", status: 503 } });

			await actions.beginSignIn({ screenHint: "login" });

			expect(notices).toEqual(["Readplace: sign-in is unavailable right now (503), try again later"]);
		});

		it("completes with the handoff params, refreshes the account section and offers Sync now", async () => {
			const { actions, completes, events, notices } = harness();

			await actions.completeSignIn({ code: "c", state: "s" });

			expect(completes).toEqual([{ code: "c", state: "s" }]);
			expect(events).toEqual(["account changed"]);
			expect(notices).toEqual(["Readplace: signed in. Choose Sync now in Settings → Readplace to copy your articles"]);
		});

		it("leaves the account section alone when the sign-in did not complete", async () => {
			const { actions, events, notices } = harness({ completed: { kind: "state-mismatch" } });

			await actions.completeSignIn({ code: "c", state: "other" });

			expect(events).toEqual([]);
			expect(notices).toEqual(["Readplace: this sign-in link does not match the one you started. Start again from Settings → Readplace"]);
		});

		it("revokes on sign-out, then refreshes the account section and confirms", async () => {
			const { actions, events, notices } = harness();

			await actions.signOut();

			expect(events).toEqual(["revoked", "account changed"]);
			expect(notices).toEqual(["Readplace: signed out"]);
		});
	});

	describe("a sync the reader asked for", () => {
		it("always reports, even when nothing changed", async () => {
			const { actions, notices, runs } = harness();

			await actions.sync({ refreshAll: false });

			expect(runs).toEqual([{ refreshAll: false }]);
			expect(notices).toEqual(["Readplace: 0 created, 0 updated, 0 left as edited, 0 still processing, 0 skipped"]);
		});

		it("passes refreshAll through", async () => {
			const { actions, runs } = harness();

			await actions.sync({ refreshAll: true });

			expect(runs).toEqual([{ refreshAll: true }]);
		});

		it("says when a run is already going", async () => {
			const { actions, notices } = harness({ syncResult: async () => ({ kind: "already-running" }) });

			await actions.sync({ refreshAll: false });

			expect(notices).toEqual(["Readplace: a sync is already running"]);
		});

		it("refreshes the account section when the run found the session is over", async () => {
			const { actions, events, notices } = harness({ syncResult: async () => ({ kind: "signed-out", counts: noCounts }) });

			await actions.sync({ refreshAll: false });

			expect(events).toEqual(["account changed"]);
			expect(notices).toEqual(["Readplace: sign in again from Settings → Readplace"]);
		});

		it("says nothing when the plugin was unloaded during the run", async () => {
			const { actions, notices } = harness({ syncResult: async () => ({ kind: "stopped", counts: { ...noCounts, created: 1 } }) });

			await actions.sync({ refreshAll: false });

			expect(notices).toHaveLength(0);
		});

		it("turns a rejected run into a notice, so a vault failure never becomes an unhandled rejection", async () => {
			const { actions, notices } = harness({
				syncResult: async () => {
					throw new Error("No note at gone.md");
				},
			});

			await actions.sync({ refreshAll: false });

			expect(notices).toEqual(["Readplace: sync stopped by an error, it will try again on the next run"]);
		});
	});

	describe.each([
		["automaticSync", "automaticSync", "syncOnOpen"],
		["syncOnOpen", "syncOnOpen", "automaticSync"],
	] as const)("%s", (action, setting, otherSetting) => {
		it("does nothing while its setting is off, whatever the other setting says", async () => {
			const { actions, runs } = harness({ settings: { [setting]: false, [otherSetting]: true } });

			await actions[action]();

			expect(runs).toEqual([]);
		});

		it("does not nag a reader who is not signed in", async () => {
			const { actions, runs, notices } = harness({ signedIn: false, settings: { [setting]: true } });

			await actions[action]();

			expect(runs).toEqual([]);
			expect(notices).toEqual([]);
		});

		it("stays quiet when the run changed nothing", async () => {
			const { actions, runs, notices } = harness({ settings: { [setting]: true } });

			await actions[action]();

			expect(runs).toEqual([{ refreshAll: false }]);
			expect(notices).toEqual([]);
		});

		it("stays quiet when a run is already going", async () => {
			const { actions, notices } = harness({ settings: { [setting]: true }, syncResult: async () => ({ kind: "already-running" }) });

			await actions[action]();

			expect(notices).toEqual([]);
		});

		it("reports a run that changed something", async () => {
			const { actions, notices } = harness({
				settings: { [setting]: true },
				syncResult: async () => ({ kind: "done", counts: { ...noCounts, created: 2 } }),
			});

			await actions[action]();

			expect(notices).toEqual(["Readplace: 2 created, 0 updated, 0 left as edited, 0 still processing, 0 skipped"]);
		});

		it("reports a run that paused", async () => {
			const { actions, notices } = harness({
				settings: { [setting]: true },
				syncResult: async () => ({ kind: "unavailable", reason: "network", counts: noCounts }),
			});

			await actions[action]();

			expect(notices).toEqual(["Readplace: sync paused (network), it will try again on the next run"]);
		});
	});

	describe("settings", () => {
		it("normalises the folder before storing it", async () => {
			const { actions, data } = harness();

			await actions.setFolder("/Articles/");

			expect(data().settings.folder).toBe("Articles");
		});

		it.each([[""], ["   "]])("falls back to the default folder for %j, since an empty path would mean the vault root", async (folder) => {
			const { actions, data } = harness({ settings: { folder: "Articles" } });

			await actions.setFolder(folder);

			expect(data().settings.folder).toBe("Readplace");
		});

		it("stores the toggles", async () => {
			const { actions, data } = harness();

			await actions.setAutomaticSync(false);
			await actions.setSyncOnOpen(true);

			expect(data().settings).toEqual({ folder: "Readplace", automaticSync: false, syncOnOpen: true });
		});
	});

	it("records a move of a synced note", async () => {
		const note = { path: "Readplace/a.md", title: "A", hash: "h", contentVersion: "v", status: "unread", readAt: null, edited: false };
		const { actions, data } = harness({ notes: { "article-1": note } });

		await actions.noteMoved({ oldPath: "Readplace/a.md", newPath: "Elsewhere/a.md" });

		expect(data().notes["article-1"]?.path).toBe("Elsewhere/a.md");
	});
});
