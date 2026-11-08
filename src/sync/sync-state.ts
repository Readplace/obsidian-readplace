import { z } from "zod";
import { DEFAULT_NOTES_FOLDER } from "../config";

export const PLUGIN_DATA_VERSION = 1;

const SyncedNoteSchema = z.object({
	path: z.string(),
	title: z.string(),
	hash: z.string(),
	contentVersion: z.string(),
	status: z.string(),
	readAt: z.string().nullable(),
	edited: z.boolean(),
});
export type SyncedNote = z.infer<typeof SyncedNoteSchema>;

const PluginSettingsSchema = z.object({ folder: z.string(), automaticSync: z.boolean(), syncOnOpen: z.boolean() });
export type PluginSettings = z.infer<typeof PluginSettingsSchema>;

const PluginDataSchema = z.object({
	version: z.literal(PLUGIN_DATA_VERSION),
	settings: PluginSettingsSchema,
	notes: z.record(z.string(), SyncedNoteSchema),
	lastSyncAt: z.string().nullable(),
});
export type PluginData = z.infer<typeof PluginDataSchema>;

export const DEFAULT_SETTINGS: PluginSettings = { folder: DEFAULT_NOTES_FOLDER, automaticSync: true, syncOnOpen: false };

export function parsePluginData(raw: unknown): PluginData {
	const parsed = PluginDataSchema.safeParse(raw);
	return parsed.success ? parsed.data : { version: PLUGIN_DATA_VERSION, settings: DEFAULT_SETTINGS, notes: {}, lastSyncAt: null };
}

function movedPath(input: { path: string; oldPath: string; newPath: string }): string {
	const { path, oldPath, newPath } = input;
	if (path === oldPath) return newPath;
	return path.startsWith(`${oldPath}/`) ? `${newPath}${path.slice(oldPath.length)}` : path;
}

export function noteRenamed(data: PluginData, move: { oldPath: string; newPath: string }): PluginData {
	const notes = Object.entries(data.notes).map(([id, note]): [string, SyncedNote] => [id, { ...note, path: movedPath({ path: note.path, ...move }) }]);
	return { ...data, notes: Object.fromEntries(notes) };
}
