import type { VaultPort } from "../ports";
import { sha256Hex } from "./content-hash";
import { notePath } from "./note-path";

const MAX_NAME_SUFFIX = 100;

export type CreateResult = { path: string };
export type UpdateResult = { kind: "written" } | { kind: "edited" };

async function ensureFolder(input: { vault: VaultPort; folder: string }): Promise<void> {
	let parent = "";
	for (const segment of input.folder.split("/").filter(Boolean)) {
		parent = parent === "" ? segment : `${parent}/${segment}`;
		if (!input.vault.folderExists(parent)) await input.vault.createFolder(parent);
	}
}

export async function createNote(deps: { vault: VaultPort; folder: string; baseName: string; content: string }): Promise<CreateResult> {
	const { vault, baseName, content } = deps;
	const folder = vault.normalizePath(deps.folder);
	await ensureFolder({ vault, folder });
	for (let suffix = 1; suffix <= MAX_NAME_SUFFIX; suffix += 1) {
		const path = notePath({ folder, baseName, suffix });
		if (vault.fileExists(path)) continue;
		try {
			await vault.create(path, content);
			return { path };
		} catch {
			continue;
		}
	}
	throw new Error(`No free note name for "${baseName}"`);
}

export async function updateNote(deps: { vault: VaultPort; path: string; expectedHash: string; content: string }): Promise<UpdateResult> {
	const { vault, path, content } = deps;
	const current = await vault.read(path);
	if ((await sha256Hex(current)) !== deps.expectedHash) return { kind: "edited" };
	const after = await vault.process(path, (data) => (data === current ? content : data));
	return after === content ? { kind: "written" } : { kind: "edited" };
}

export async function renameNote(deps: { vault: VaultPort; path: string; folder: string; baseName: string }): Promise<{ path: string }> {
	const { vault, baseName } = deps;
	const folder = vault.normalizePath(deps.folder);
	let suffix = 1;
	while (vault.fileExists(notePath({ folder, baseName, suffix }))) suffix += 1;
	const path = notePath({ folder, baseName, suffix });
	await vault.rename(deps.path, path);
	return { path };
}
