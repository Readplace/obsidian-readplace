import { noteBaseName } from "../notes/note-path";
import type { ListedArticle } from "../siren/siren";
import type { SyncedNote } from "./sync-state";

export type NotePlan =
	| { kind: "create" }
	| { kind: "leave-missing" }
	| { kind: "unchanged" }
	| { kind: "refresh"; rename: { baseName: string } | undefined };

const COLLISION_NUMBER = / \(\d+\)$/;

function baseNameOf(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
}

function renameFor(input: { listed: ListedArticle; state: SyncedNote }): { baseName: string } | undefined {
	const { listed, state } = input;
	if (listed.title === state.title) return undefined;
	const storedName = noteBaseName({ title: state.title, siteName: listed.siteName, id: listed.id });
	const baseName = noteBaseName(listed);
	const currentName = baseNameOf(state.path);
	const keptPluginName = currentName === storedName || currentName.replace(COLLISION_NUMBER, "") === storedName;
	return keptPluginName && baseName !== storedName ? { baseName } : undefined;
}

function matchesListing(input: { listed: ListedArticle; state: SyncedNote }): boolean {
	const { listed, state } = input;
	return (
		listed.contentVersion !== "" &&
		listed.contentVersion === state.contentVersion &&
		listed.status === state.status &&
		listed.readAt === state.readAt &&
		listed.title === state.title
	);
}

export function planNoteWrite(input: { listed: ListedArticle; state: SyncedNote | undefined; noteExists: boolean }): NotePlan {
	const { listed, state, noteExists } = input;
	if (state === undefined) return { kind: "create" };
	if (!noteExists) return { kind: "leave-missing" };
	if (matchesListing({ listed, state })) return { kind: "unchanged" };
	return { kind: "refresh", rename: renameFor({ listed, state }) };
}
