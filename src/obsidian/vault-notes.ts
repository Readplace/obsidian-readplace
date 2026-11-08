import { assert } from "../assert";
import type { VaultPort } from "../ports";

export interface NotesVault<File> {
	getFileByPath(path: string): File | null;
	getFolderByPath(path: string): unknown;
	createFolder(path: string): Promise<unknown>;
	create(path: string, data: string): Promise<unknown>;
	read(file: File): Promise<string>;
	process(file: File, update: (data: string) => string): Promise<string>;
}

export interface NotesFileManager<File> {
	renameFile(file: File, newPath: string): Promise<void>;
}

export interface RenameEvents<Subscription> {
	on(name: "rename", listener: (file: { path: string }, oldPath: string) => unknown): Subscription;
}

export function initVaultNotes<File>(deps: {
	vault: NotesVault<File>;
	fileManager: NotesFileManager<File>;
	normalizePath: (path: string) => string;
}): VaultPort {
	const { vault, fileManager } = deps;

	const fileAt = (path: string): File => {
		const file = vault.getFileByPath(path);
		assert(file !== null, `No note at ${path}`);
		return file;
	};

	return {
		normalizePath: deps.normalizePath,
		fileExists: (path) => vault.getFileByPath(path) !== null,
		folderExists: (path) => vault.getFolderByPath(path) !== null,
		createFolder: async (path) => {
			await vault.createFolder(path);
		},
		create: async (path, content) => {
			await vault.create(path, content);
		},
		read: async (path) => vault.read(fileAt(path)),
		process: async (path, update) => vault.process(fileAt(path), update),
		rename: async (path, newPath) => fileManager.renameFile(fileAt(path), newPath),
	};
}

export function watchRenames<Subscription>(deps: {
	vault: RenameEvents<Subscription>;
	onMove: (move: { oldPath: string; newPath: string }) => unknown;
}): Subscription {
	return deps.vault.on("rename", (file, oldPath) => deps.onMove({ oldPath, newPath: file.path }));
}
