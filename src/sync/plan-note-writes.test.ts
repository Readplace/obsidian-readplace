import type { ListedArticle } from "../siren/siren";
import { planNoteWrite } from "./plan-note-writes";
import type { SyncedNote } from "./sync-state";

const LISTED: ListedArticle = {
	id: "a",
	title: "Title",
	siteName: "site",
	status: "unread",
	readAt: null,
	contentVersion: "v1",
	readHref: "https://readplace.com/opaque/a",
};
const STATE: SyncedNote = {
	path: "Readplace/Title.md",
	title: "Title",
	hash: "hash",
	contentVersion: "v1",
	status: "unread",
	readAt: null,
	edited: false,
};

describe("planNoteWrite", () => {
	it("creates a note for an id with no state", () => {
		expect(planNoteWrite({ listed: LISTED, state: undefined, noteExists: false })).toEqual({ kind: "create" });
	});

	it("leaves a removed note removed, even when the server changed", () => {
		const listed = { ...LISTED, contentVersion: "v2" };

		expect(planNoteWrite({ listed, state: STATE, noteExists: false })).toEqual({ kind: "leave-missing" });
	});

	it("leaves an identical listing alone, so a settled note is not fetched again", () => {
		expect(planNoteWrite({ listed: LISTED, state: STATE, noteExists: true })).toEqual({ kind: "unchanged" });
	});

	it.each<[string, Partial<ListedArticle>]>([
		["contentVersion", { contentVersion: "v2" }],
		["status", { status: "read" }],
		["readAt", { readAt: "2026-11-02T00:00:00.000Z" }],
	])("refreshes without a rename when %s changes", (_field, change) => {
		expect(planNoteWrite({ listed: { ...LISTED, ...change }, state: STATE, noteExists: true })).toEqual({ kind: "refresh", rename: undefined });
	});

	it("refreshes on every run when the listing carries no version", () => {
		const state = { ...STATE, contentVersion: "" };

		expect(planNoteWrite({ listed: { ...LISTED, contentVersion: "" }, state, noteExists: true })).toEqual({ kind: "refresh", rename: undefined });
	});

	it("still refreshes a note marked edited, because the reader may have reverted it", () => {
		const listed = { ...LISTED, contentVersion: "v2" };

		expect(planNoteWrite({ listed, state: { ...STATE, edited: true }, noteExists: true })).toEqual({ kind: "refresh", rename: undefined });
	});

	it("renames when the title changed and the note keeps its plugin name", () => {
		const listed = { ...LISTED, title: "Better: title" };

		expect(planNoteWrite({ listed, state: STATE, noteExists: true })).toEqual({ kind: "refresh", rename: { baseName: "Better title" } });
	});

	it("renames a note that took a collision number", () => {
		const listed = { ...LISTED, title: "Better" };
		const state = { ...STATE, path: "Readplace/Title (2).md" };

		expect(planNoteWrite({ listed, state, noteExists: true })).toEqual({ kind: "refresh", rename: { baseName: "Better" } });
	});

	it("keeps a name the reader chose", () => {
		const listed = { ...LISTED, title: "Better" };
		const state = { ...STATE, path: "Readplace/My own name.md" };

		expect(planNoteWrite({ listed, state, noteExists: true })).toEqual({ kind: "refresh", rename: undefined });
	});

	it("does not rename when the new title cleans to the same name", () => {
		const listed = { ...LISTED, title: "Title#" };

		expect(planNoteWrite({ listed, state: STATE, noteExists: true })).toEqual({ kind: "refresh", rename: undefined });
	});
});
