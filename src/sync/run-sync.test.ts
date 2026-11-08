import { initTokenClient } from "../auth/tokens";
import { sha256Hex } from "../notes/content-hash";
import type { HttpRequest, HttpResponse, SecretId, VaultPort } from "../ports";
import { initSyncRunner } from "./run-sync";
import { DEFAULT_SETTINGS, noteRenamed, type PluginData } from "./sync-state";

const ORIGIN = "https://readplace.com";
const ROOT = `${ORIGIN}/`;
const LIST = `${ORIGIN}/queue`;
const OTHER_LIST = `${ORIGIN}/lists/opaque`;
const NOW = new Date("2026-11-02T10:00:00.000Z");

interface Listed { id: string; title?: string; version?: string; status?: string; readAt?: string; noReadLink?: boolean }

function collection(input: { articles: Listed[]; readlists?: { rel: string; href: string }[] ; tabs?: { rel: string; href: string }[] }): HttpResponse {
	return {
		status: 200,
		headers: { "Content-Type": "application/vnd.siren+json" },
		text: JSON.stringify({
			class: ["collection"],
			properties: {
				readlists: (input.readlists ?? [{ rel: "current", href: "/queue" }]).map((entry) => ({ label: "List", ...entry })),
				tabs: (input.tabs ?? [{ rel: "current", href: "/queue" }]).map((entry) => ({ label: "Tab", ...entry })),
			},
			entities: input.articles.map(({ id, title, version, status, readAt, noReadLink }) => ({
				class: ["article"],
				properties: { id, title: title ?? `Title ${id}`, status: status ?? "unread", readAt, contentVersion: version ?? "v1" },
				links: noReadLink ? [] : [{ rel: ["read"], href: `/opaque/${id}` }],
			})),
			links: [],
		}),
	};
}

function markdown(text: string, status = 200, contentType = "text/markdown; charset=utf-8"): HttpResponse {
	return { status, headers: { "Content-Type": contentType }, text };
}

function readHref(id: string): string {
	return `${ORIGIN}/opaque/${id}`;
}

function inMemoryVault(initial: Record<string, string> = {}) {
	const files = new Map(Object.entries(initial));
	const folders = new Set<string>();
	const vault: VaultPort = {
		normalizePath: (path) => path,
		fileExists: (path) => files.has(path),
		folderExists: (path) => folders.has(path),
		createFolder: async (path) => {
			folders.add(path);
		},
		create: async (path, content) => {
			files.set(path, content);
		},
		read: async (path) => {
			const content = files.get(path);
			if (content === undefined) throw new Error(`No file at ${path}`);
			return content;
		},
		process: async (path, update) => {
			const after = update(files.get(path) ?? "");
			files.set(path, after);
			return after;
		},
		rename: async (path, newPath) => {
			files.set(newPath, files.get(path) ?? "");
			files.delete(path);
		},
	};
	return { vault, files };
}

function syncHarness(input: { routes?: Record<string, HttpResponse>; accessToken?: string; files?: Record<string, string> } = {}) {
	const routes: Record<string, HttpResponse> = { [ROOT]: { status: 303, headers: { Location: "/queue" }, text: "" }, ...input.routes };
	const requests: HttpRequest[] = [];
	const hooks: { beforeAnswer?: (url: string) => void } = {};
	const secrets: Partial<Record<SecretId, string>> = {
		"readplace-access-token": input.accessToken ?? "access-1",
		"readplace-refresh-token": input.accessToken ?? "refresh-1",
	};
	const tokens = initTokenClient({
		sendHttp: async (request) => {
			requests.push(request);
			hooks.beforeAnswer?.(request.url);
			const response = routes[request.url];
			if (response === undefined) throw new Error(`transport failure for ${request.url}`);
			return response;
		},
		secrets: {
			get: (id) => secrets[id] ?? null,
			set: (id, value) => {
				secrets[id] = value;
			},
		},
		server: async () => ({
			kind: "ok",
			server: { authorizationEndpoint: `${ORIGIN}/a`, tokenEndpoint: `${ORIGIN}/token`, revocationEndpoint: `${ORIGIN}/r` },
		}),
	});
	const { vault, files } = inMemoryVault(input.files);
	let data: PluginData = { version: 1, settings: DEFAULT_SETTINGS, notes: {}, lastSyncAt: null };
	const store = {
		get: () => data,
		set: async (next: PluginData) => {
			data = next;
		},
	};
	const runner = initSyncRunner({ tokens, vault, data: store, origin: ORIGIN, clock: () => NOW });
	const markdownFetches = () => requests.filter((request) => request.headers.Accept === "text/markdown").map((request) => request.url);
	return { runner, routes, requests, files, vault, hooks, store, markdownFetches };
}

const NO_COUNTS = { created: 0, updated: 0, edited: 0, processing: 0, errors: 0 };

async function syncedOnce(articles: Listed[]) {
	const routes: Record<string, HttpResponse> = { [LIST]: collection({ articles }) };
	for (const { id } of articles) routes[readHref(id)] = markdown(`body ${id}`);
	const harness = syncHarness({ routes });
	await harness.runner.run({ refreshAll: false });
	harness.requests.length = 0;
	return harness;
}

describe("run-sync first and second sync", () => {
	it("creates one note per article and records each", async () => {
		const harness = syncHarness({
			routes: {
				[LIST]: collection({ articles: [{ id: "a", readAt: "2026-11-01T00:00:00.000Z", status: "read" }, { id: "b" }] }),
				[readHref("a")]: markdown("body a"),
				[readHref("b")]: markdown("---\nreadplace_summary_status: pending\n---\nbody b"),
			},
		});

		const result = await harness.runner.run({ refreshAll: false });

		expect(result).toEqual({ kind: "done", counts: { ...NO_COUNTS, created: 2, processing: 1 } });
		expect(harness.files.get("Readplace/Title a.md")).toBe("body a");
		expect(harness.files.get("Readplace/Title b.md")).toBe("---\nreadplace_summary_status: pending\n---\nbody b");
		expect(harness.store.get().notes.a).toEqual({
			path: "Readplace/Title a.md",
			title: "Title a",
			hash: await sha256Hex("body a"),
			contentVersion: "v1",
			status: "read",
			readAt: "2026-11-01T00:00:00.000Z",
			edited: false,
		});
		expect(harness.store.get().lastSyncAt).toBe(NOW.toISOString());
	});

	it("never overwrites a file it did not write", async () => {
		const harness = syncHarness({
			files: { "Readplace/Title a.md": "the reader's own" },
			routes: { [LIST]: collection({ articles: [{ id: "a" }] }), [readHref("a")]: markdown("body a") },
		});

		await harness.runner.run({ refreshAll: false });

		expect(harness.files.get("Readplace/Title a.md")).toBe("the reader's own");
		expect(harness.files.get("Readplace/Title a (2).md")).toBe("body a");
	});

	it("writes nothing and fetches no Markdown on a second sync with no change", async () => {
		const harness = await syncedOnce([{ id: "a" }, { id: "b" }]);
		const notesBefore = harness.store.get().notes;

		const result = await harness.runner.run({ refreshAll: false });

		expect(result).toEqual({ kind: "done", counts: NO_COUNTS });
		expect(harness.markdownFetches()).toEqual([]);
		expect(harness.store.get().notes).toEqual(notesBefore);
	});

	it("leaves a note alone when its article is no longer listed", async () => {
		const harness = await syncedOnce([{ id: "a" }]);
		harness.routes[LIST] = collection({ articles: [] });

		await harness.runner.run({ refreshAll: false });

		expect(harness.files.get("Readplace/Title a.md")).toBe("body a");
	});

	it("does not recreate a note the reader removed", async () => {
		const harness = await syncedOnce([{ id: "a" }]);
		harness.files.delete("Readplace/Title a.md");
		harness.routes[LIST] = collection({ articles: [{ id: "a", version: "v2" }] });

		const result = await harness.runner.run({ refreshAll: false });

		expect(result).toEqual({ kind: "done", counts: NO_COUNTS });
		expect(harness.files.has("Readplace/Title a.md")).toBe(false);
		expect(harness.markdownFetches()).toEqual([]);
	});
});

describe("run-sync updates", () => {
	it("rewrites an unedited note when the server changed", async () => {
		const harness = await syncedOnce([{ id: "a" }]);
		harness.routes[LIST] = collection({ articles: [{ id: "a", version: "v2" }] });
		harness.routes[readHref("a")] = markdown("---\nreadplace_content_status: processing\n---\nnew");

		const result = await harness.runner.run({ refreshAll: false });

		expect(result).toEqual({ kind: "done", counts: { ...NO_COUNTS, updated: 1, processing: 1 } });
		expect(harness.files.get("Readplace/Title a.md")).toBe("---\nreadplace_content_status: processing\n---\nnew");
		expect(harness.store.get().notes.a?.contentVersion).toBe("v2");
		expect(harness.store.get().notes.a?.hash).toBe(await sha256Hex("---\nreadplace_content_status: processing\n---\nnew"));
	});

	it("records a status change without writing when the bytes are the same", async () => {
		const harness = await syncedOnce([{ id: "a" }]);
		harness.routes[LIST] = collection({ articles: [{ id: "a", status: "read", readAt: "2026-11-01T00:00:00.000Z" }] });

		const result = await harness.runner.run({ refreshAll: false });

		expect(result).toEqual({ kind: "done", counts: NO_COUNTS });
		expect(harness.markdownFetches()).toEqual([readHref("a")]);
		expect(harness.store.get().notes.a?.status).toBe("read");
		expect(harness.store.get().notes.a?.readAt).toBe("2026-11-01T00:00:00.000Z");
	});

	it("keeps an edited note through a server change, counts it and fetches nothing", async () => {
		const harness = await syncedOnce([{ id: "a" }]);
		harness.files.set("Readplace/Title a.md", "my margin notes");
		harness.routes[LIST] = collection({ articles: [{ id: "a", title: "New title", version: "v2" }] });

		const result = await harness.runner.run({ refreshAll: false });

		expect(result).toEqual({ kind: "done", counts: { ...NO_COUNTS, edited: 1 } });
		expect(harness.files.get("Readplace/Title a.md")).toBe("my margin notes");
		expect(harness.markdownFetches()).toEqual([]);
		expect(harness.store.get().notes.a?.edited).toBe(true);
		expect(harness.store.get().notes.a?.contentVersion).toBe("v1");
	});

	it("does not count the same edited note again on the next run", async () => {
		const harness = await syncedOnce([{ id: "a" }]);
		harness.files.set("Readplace/Title a.md", "my margin notes");
		harness.routes[LIST] = collection({ articles: [{ id: "a", title: "New title", version: "v2" }] });
		await harness.runner.run({ refreshAll: false });

		const result = await harness.runner.run({ refreshAll: false });

		expect(result).toEqual({ kind: "done", counts: NO_COUNTS });
		expect(harness.store.get().notes.a?.edited).toBe(true);
	});

	it("resumes updates once the reader reverts an edit", async () => {
		const harness = await syncedOnce([{ id: "a" }]);
		harness.files.set("Readplace/Title a.md", "my margin notes");
		harness.routes[LIST] = collection({ articles: [{ id: "a", version: "v2" }] });
		harness.routes[readHref("a")] = markdown("new");
		await harness.runner.run({ refreshAll: false });
		harness.files.set("Readplace/Title a.md", "body a");

		const result = await harness.runner.run({ refreshAll: false });

		expect(result).toEqual({ kind: "done", counts: { ...NO_COUNTS, updated: 1 } });
		expect(harness.files.get("Readplace/Title a.md")).toBe("new");
		expect(harness.store.get().notes.a?.edited).toBe(false);
	});

	it("lets an edit made while the Markdown was downloading win", async () => {
		const harness = await syncedOnce([{ id: "a" }]);
		harness.routes[LIST] = collection({ articles: [{ id: "a", version: "v2" }] });
		harness.routes[readHref("a")] = markdown("new");
		harness.hooks.beforeAnswer = (url) => {
			if (url === readHref("a")) harness.files.set("Readplace/Title a.md", "typed during the fetch");
		};

		const result = await harness.runner.run({ refreshAll: false });

		expect(result).toEqual({ kind: "done", counts: { ...NO_COUNTS, edited: 1 } });
		expect(harness.files.get("Readplace/Title a.md")).toBe("typed during the fetch");
		expect(harness.store.get().notes.a?.edited).toBe(true);
	});

	it("renames an unedited note when the title changes and records the new path", async () => {
		const harness = await syncedOnce([{ id: "a" }]);
		harness.routes[LIST] = collection({ articles: [{ id: "a", title: "Real title", version: "v2" }] });
		harness.routes[readHref("a")] = markdown("new");

		await harness.runner.run({ refreshAll: false });

		expect(harness.files.get("Readplace/Real title.md")).toBe("new");
		expect(harness.files.has("Readplace/Title a.md")).toBe(false);
		expect(harness.store.get().notes.a?.path).toBe("Readplace/Real title.md");
		expect(harness.store.get().notes.a?.title).toBe("Real title");
	});

	it("renames in the folder the reader filed the note in", async () => {
		const harness = await syncedOnce([{ id: "a" }]);
		harness.files.set("Title a.md", harness.files.get("Readplace/Title a.md") ?? "");
		await harness.store.set(noteRenamed(harness.store.get(), { oldPath: "Readplace/Title a.md", newPath: "Title a.md" }));
		harness.routes[LIST] = collection({ articles: [{ id: "a", title: "Real title", version: "v2" }] });
		harness.routes[readHref("a")] = markdown("new");

		await harness.runner.run({ refreshAll: false });

		expect(harness.store.get().notes.a?.path).toBe("Real title.md");
	});

	it("keeps the rename when the fetch that follows ends the run", async () => {
		const harness = await syncedOnce([{ id: "a" }]);
		harness.routes[LIST] = collection({ articles: [{ id: "a", title: "Real title", version: "v2" }] });
		delete harness.routes[readHref("a")];

		await harness.runner.run({ refreshAll: false });

		expect(harness.store.get().notes.a?.path).toBe("Readplace/Real title.md");
		expect(harness.store.get().notes.a?.contentVersion).toBe("v1");
	});

	it("keeps syncing when the vault refuses a rename", async () => {
		const harness = await syncedOnce([{ id: "a" }, { id: "b" }]);
		const renames: string[] = [];
		harness.vault.rename = async (path) => {
			renames.push(path);
			throw new Error("Destination file already exists!");
		};
		await harness.store.set({ ...harness.store.get(), lastSyncAt: null });
		harness.routes[LIST] = collection({ articles: [{ id: "a", title: "Real title", version: "v2" }, { id: "b", version: "v2" }] });
		harness.routes[readHref("a")] = markdown("new a");
		harness.routes[readHref("b")] = markdown("new b");

		const result = await harness.runner.run({ refreshAll: false });

		expect(result).toEqual({ kind: "done", counts: { ...NO_COUNTS, updated: 2, errors: 1 } });
		expect(harness.files.get("Readplace/Title a.md")).toBe("new a");
		expect(harness.files.get("Readplace/Title b.md")).toBe("new b");
		expect(harness.store.get().notes.a?.path).toBe("Readplace/Title a.md");
		expect(harness.store.get().notes.a?.title).toBe("Real title");
		expect(harness.store.get().lastSyncAt).toBe(NOW.toISOString());

		const second = await harness.runner.run({ refreshAll: false });

		expect(second).toEqual({ kind: "done", counts: NO_COUNTS });
		expect(renames).toEqual(["Readplace/Title a.md"]);
	});
});

describe("run-sync Refresh all notes", () => {
	it("re-fetches every note and rewrites one whose readlists changed", async () => {
		const harness = await syncedOnce([{ id: "a" }, { id: "b" }]);
		harness.routes[readHref("a")] = markdown("body a\nreadplace_readlists: [cooking]");

		const result = await harness.runner.run({ refreshAll: true });

		expect(result).toEqual({ kind: "done", counts: { ...NO_COUNTS, updated: 1 } });
		expect(harness.markdownFetches()).toEqual([readHref("a"), readHref("b")]);
		expect(harness.files.get("Readplace/Title a.md")).toBe("body a\nreadplace_readlists: [cooking]");
	});

	it("still leaves an edited note and a removed note alone", async () => {
		const harness = await syncedOnce([{ id: "a" }, { id: "b" }]);
		harness.files.set("Readplace/Title a.md", "my margin notes");
		harness.files.delete("Readplace/Title b.md");

		const result = await harness.runner.run({ refreshAll: true });

		expect(result).toEqual({ kind: "done", counts: { ...NO_COUNTS, edited: 1 } });
		expect(harness.files.get("Readplace/Title a.md")).toBe("my margin notes");
		expect(harness.files.has("Readplace/Title b.md")).toBe(false);
		expect(harness.markdownFetches()).toEqual([]);
	});

	it("keeps a move made while the Markdown was downloading", async () => {
		const harness = await syncedOnce([{ id: "a" }]);
		harness.hooks.beforeAnswer = (url) => {
			if (url !== readHref("a")) return;
			harness.files.set("Projects/x.md", harness.files.get("Readplace/Title a.md") ?? "");
			harness.files.delete("Readplace/Title a.md");
			void harness.store.set(noteRenamed(harness.store.get(), { oldPath: "Readplace/Title a.md", newPath: "Projects/x.md" }));
		};

		await harness.runner.run({ refreshAll: true });

		expect(harness.store.get().notes.a?.path).toBe("Projects/x.md");

		harness.hooks.beforeAnswer = undefined;
		harness.routes[LIST] = collection({ articles: [{ id: "a", version: "v2" }] });
		harness.routes[readHref("a")] = markdown("new");

		await harness.runner.run({ refreshAll: false });

		expect(harness.files.get("Projects/x.md")).toBe("new");
	});
});

describe("run-sync readlists", () => {
	const READLISTS = [
		{ rel: "current", href: "/queue" },
		{ rel: "readlist", href: "/lists/opaque" },
	];

	it("gives a note to an article listed only in a custom readlist", async () => {
		const harness = syncHarness({
			routes: {
				[LIST]: collection({ articles: [], readlists: READLISTS }),
				[OTHER_LIST]: collection({ articles: [{ id: "custom" }], tabs: [{ rel: "current", href: "/lists/opaque" }] }),
				[readHref("custom")]: markdown("body custom"),
			},
		});

		const result = await harness.runner.run({ refreshAll: false });

		expect(result).toEqual({ kind: "done", counts: { ...NO_COUNTS, created: 1 } });
		expect(harness.files.get("Readplace/Title custom.md")).toBe("body custom");
	});

	it("gives one note to an article listed in two readlists", async () => {
		const harness = syncHarness({
			routes: {
				[LIST]: collection({ articles: [{ id: "both" }], readlists: READLISTS }),
				[OTHER_LIST]: collection({ articles: [{ id: "both" }], tabs: [{ rel: "current", href: "/lists/opaque" }] }),
				[readHref("both")]: markdown("body both"),
			},
		});

		const result = await harness.runner.run({ refreshAll: false });

		expect(result).toEqual({ kind: "done", counts: { ...NO_COUNTS, created: 1 } });
		expect(harness.markdownFetches()).toEqual([readHref("both")]);
		expect([...harness.files.keys()]).toEqual(["Readplace/Title both.md"]);
	});

	it("counts a collection that stopped and syncs the rest", async () => {
		const harness = syncHarness({
			routes: {
				[LIST]: collection({ articles: [{ id: "a" }], readlists: READLISTS }),
				[OTHER_LIST]: { status: 404, headers: {}, text: "" },
				[readHref("a")]: markdown("body a"),
			},
		});

		const result = await harness.runner.run({ refreshAll: false });

		expect(result).toEqual({ kind: "done", counts: { ...NO_COUNTS, created: 1, errors: 1 } });
	});
});

describe("run-sync skips and stops", () => {
	it.each<[string, HttpResponse]>([
		["a 404", markdown("Not found", 404)],
		["a 500", markdown("", 500, "text/html")],
		["a 200 in HTML", markdown("<html>", 200, "text/html")],
	])("counts %s, writes nothing and tries again next run", async (_case, answer) => {
		const harness = syncHarness({ routes: { [LIST]: collection({ articles: [{ id: "a" }, { id: "b" }] }), [readHref("a")]: answer, [readHref("b")]: markdown("body b") } });

		const result = await harness.runner.run({ refreshAll: false });

		expect(result).toEqual({ kind: "done", counts: { ...NO_COUNTS, created: 1, errors: 1 } });
		expect([...harness.files.keys()]).toEqual(["Readplace/Title b.md"]);
		expect(Object.keys(harness.store.get().notes)).toEqual(["b"]);
	});

	it("counts an article with no read link", async () => {
		const harness = syncHarness({ routes: { [LIST]: collection({ articles: [{ id: "a", noReadLink: true }] }) } });

		const result = await harness.runner.run({ refreshAll: false });

		expect(result).toEqual({ kind: "done", counts: { ...NO_COUNTS, errors: 1 } });
		expect(harness.markdownFetches()).toEqual([]);
	});

	it("counts a skipped refresh and keeps the recorded note", async () => {
		const harness = await syncedOnce([{ id: "a" }]);
		const noteBefore = harness.store.get().notes.a;
		harness.routes[LIST] = collection({ articles: [{ id: "a", version: "v2" }] });
		harness.routes[readHref("a")] = markdown("Not found", 404);

		const result = await harness.runner.run({ refreshAll: false });

		expect(result).toEqual({ kind: "done", counts: { ...NO_COUNTS, errors: 1 } });
		expect(harness.store.get().notes.a).toEqual(noteBefore);
	});

	it("counts an article whose note cannot be created and syncs the rest", async () => {
		const harness = syncHarness({ routes: { [LIST]: collection({ articles: [{ id: "a" }, { id: "b" }] }), [readHref("a")]: markdown("body a"), [readHref("b")]: markdown("body b") } });
		const create = harness.vault.create.bind(harness.vault);
		harness.vault.create = async (path, content) => {
			if (path.includes("Title a")) throw new Error("Invalid file name");
			await create(path, content);
		};

		const result = await harness.runner.run({ refreshAll: false });

		expect(result).toEqual({ kind: "done", counts: { ...NO_COUNTS, created: 1, errors: 1 } });
	});

	it("ends after the current article once stopped", async () => {
		const harness = syncHarness({
			routes: { [LIST]: collection({ articles: [{ id: "a" }, { id: "b" }] }), [readHref("a")]: markdown("body a"), [readHref("b")]: markdown("body b") },
		});
		harness.hooks.beforeAnswer = (url) => {
			if (url === readHref("a")) harness.runner.stop();
		};

		const result = await harness.runner.run({ refreshAll: false });

		expect(result).toEqual({ kind: "stopped", counts: { ...NO_COUNTS, created: 1 } });
		expect([...harness.files.keys()]).toEqual(["Readplace/Title a.md"]);
		expect(harness.store.get().lastSyncAt).toBeNull();
	});

	it("resumes an interrupted run from the saved state", async () => {
		const articles = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
		const harness = syncHarness({
			routes: { [LIST]: collection({ articles }), [readHref("a")]: markdown("body a"), [readHref("b")]: markdown("body b"), [readHref("d")]: markdown("body d") },
		});

		const interrupted = await harness.runner.run({ refreshAll: false });

		expect(interrupted).toEqual({ kind: "unavailable", reason: "network", counts: { ...NO_COUNTS, created: 2 } });
		expect(Object.keys(harness.store.get().notes)).toEqual(["a", "b"]);
		expect(harness.store.get().lastSyncAt).toBeNull();

		harness.routes[readHref("c")] = markdown("body c");
		harness.requests.length = 0;
		const resumed = await harness.runner.run({ refreshAll: false });

		expect(resumed).toEqual({ kind: "done", counts: { ...NO_COUNTS, created: 2 } });
		expect(harness.markdownFetches()).toEqual([readHref("c"), readHref("d")]);
		expect(harness.files.size).toBe(4);
	});

	it("reports signed out without a request when there is no token", async () => {
		const harness = syncHarness({ accessToken: "" });

		const result = await harness.runner.run({ refreshAll: false });

		expect(result).toEqual({ kind: "signed-out", counts: NO_COUNTS });
		expect(harness.requests).toEqual([]);
	});

	it("reports signed out when the walk's refresh is refused", async () => {
		const harness = syncHarness({ routes: { [ROOT]: { status: 401, headers: {}, text: "" }, [`${ORIGIN}/token`]: { status: 400, headers: {}, text: "" } } });

		const result = await harness.runner.run({ refreshAll: false });

		expect(result).toEqual({ kind: "signed-out", counts: NO_COUNTS });
	});

	it("keeps the notes already created when signed out mid-run", async () => {
		const harness = syncHarness({
			routes: {
				[LIST]: collection({ articles: [{ id: "a" }, { id: "b" }] }),
				[readHref("a")]: markdown("body a"),
				[readHref("b")]: markdown("", 401),
				[`${ORIGIN}/token`]: { status: 400, headers: {}, text: "" },
			},
		});

		const result = await harness.runner.run({ refreshAll: false });

		expect(result).toEqual({ kind: "signed-out", counts: { ...NO_COUNTS, created: 1 } });
		expect(Object.keys(harness.store.get().notes)).toEqual(["a"]);
	});

	it("pauses when the listing is rate limited", async () => {
		const harness = syncHarness({ routes: { [ROOT]: { status: 429, headers: {}, text: "" } } });

		const result = await harness.runner.run({ refreshAll: false });

		expect(result).toEqual({ kind: "unavailable", reason: "rate-limited", counts: NO_COUNTS });
	});

	it("answers already-running while a run is in flight", async () => {
		const harness = await syncedOnce([{ id: "a" }]);

		const first = harness.runner.run({ refreshAll: false });
		const second = await harness.runner.run({ refreshAll: false });

		expect(second).toEqual({ kind: "already-running" });
		expect(await first).toEqual({ kind: "done", counts: NO_COUNTS });
	});

	it("can run again after a run failed on the vault", async () => {
		const harness = await syncedOnce([{ id: "a" }]);
		harness.routes[LIST] = collection({ articles: [{ id: "a", version: "v2" }] });
		const read = harness.vault.read.bind(harness.vault);
		harness.vault.read = async () => {
			throw new Error("disk error");
		};

		await expect(harness.runner.run({ refreshAll: false })).rejects.toThrow("disk error");

		harness.vault.read = read;
		const result = await harness.runner.run({ refreshAll: false });

		expect(result).toEqual({ kind: "done", counts: NO_COUNTS });
	});
});
