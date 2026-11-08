import { DEFAULT_SETTINGS, noteRenamed, parsePluginData, type PluginData, type SyncedNote } from "./sync-state";

const EMPTY: PluginData = { version: 1, settings: DEFAULT_SETTINGS, notes: {}, lastSyncAt: null };

function note(path: string): SyncedNote {
	return { path, title: "Title", hash: "hash", contentVersion: "v1", status: "unread", readAt: null, edited: false };
}

describe("parsePluginData", () => {
	it("defaults to the folder and schedule the plan fixes", () => {
		expect(DEFAULT_SETTINGS).toEqual({ folder: "Readplace", automaticSync: true, syncOnOpen: false });
	});

	it("starts empty on first load", () => {
		expect(parsePluginData(null)).toEqual(EMPTY);
	});

	it("starts empty on a version it does not know", () => {
		expect(parsePluginData({ ...EMPTY, version: 2 })).toEqual(EMPTY);
	});

	it("starts empty on garbage", () => {
		expect(parsePluginData("not an object")).toEqual(EMPTY);
	});

	it("round-trips saved data through JSON", () => {
		const saved: PluginData = {
			version: 1,
			settings: { folder: "Reading", automaticSync: false, syncOnOpen: true },
			notes: { a: note("Reading/A.md") },
			lastSyncAt: "2026-11-02T00:00:00.000Z",
		};

		expect(parsePluginData(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
	});
});

describe("noteRenamed", () => {
	const data: PluginData = {
		...EMPTY,
		notes: { a: note("Readplace/A.md"), b: note("Readplace/Deep/B.md"), c: note("Readplace2/C.md") },
	};

	it("moves the renamed file only", () => {
		const moved = noteRenamed(data, { oldPath: "Readplace/A.md", newPath: "Filed/A.md" });

		expect(moved.notes.a?.path).toBe("Filed/A.md");
		expect(moved.notes.b?.path).toBe("Readplace/Deep/B.md");
	});

	it("moves every note under a renamed folder and leaves a sibling sharing the prefix", () => {
		const moved = noteRenamed(data, { oldPath: "Readplace", newPath: "Filed" });

		expect(moved.notes.a?.path).toBe("Filed/A.md");
		expect(moved.notes.b?.path).toBe("Filed/Deep/B.md");
		expect(moved.notes.c?.path).toBe("Readplace2/C.md");
	});
});
