import type { VaultPort } from "../ports";
import { sha256Hex } from "./content-hash";
import { createNote, renameNote, updateNote } from "./write-note";

function vaultWith(input: { files?: Record<string, string>; folders?: string[]; rejectCreateOf?: (path: string) => boolean }) {
	const files = new Map(Object.entries(input.files ?? {}));
	const folders = new Set(input.folders ?? []);
	const vault: VaultPort = {
		normalizePath: (path) => path.replace(/^\/+|\/+$/g, "") || "/",
		fileExists: (path) => files.has(path),
		folderExists: (path) => folders.has(path),
		createFolder: async (path) => {
			folders.add(path);
		},
		create: async (path, content) => {
			if (input.rejectCreateOf?.(path)) throw new Error("File already exists.");
			files.set(path, content);
		},
		read: async (path) => files.get(path) ?? "",
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
	return { vault, files, folders };
}

describe("createNote", () => {
	it("creates every missing folder segment, parents first", async () => {
		const { vault, files, folders } = vaultWith({ folders: ["Inbox"] });

		const result = await createNote({ vault, folder: "/Inbox/Readplace/", baseName: "Title", content: "body" });

		expect(result).toEqual({ path: "Inbox/Readplace/Title.md" });
		expect([...folders]).toEqual(["Inbox", "Inbox/Readplace"]);
		expect(files.get("Inbox/Readplace/Title.md")).toBe("body");
	});

	it("creates no folder for the vault root", async () => {
		const { vault, files, folders } = vaultWith({});

		await createNote({ vault, folder: "/", baseName: "Title", content: "body" });

		expect(folders.size).toBe(0);
		expect(files.get("Title.md")).toBe("body");
	});

	it("moves to the next suffix when the path is taken and keeps the other file", async () => {
		const { vault, files } = vaultWith({ files: { "Readplace/Title.md": "someone else's" }, folders: ["Readplace"] });

		const result = await createNote({ vault, folder: "Readplace", baseName: "Title", content: "body" });

		expect(result).toEqual({ path: "Readplace/Title (2).md" });
		expect(files.get("Readplace/Title.md")).toBe("someone else's");
	});

	it("moves to the next suffix when create rejects", async () => {
		const { vault } = vaultWith({ folders: ["Readplace"], rejectCreateOf: (path) => path === "Readplace/Title.md" });

		const result = await createNote({ vault, folder: "Readplace", baseName: "Title", content: "body" });

		expect(result).toEqual({ path: "Readplace/Title (2).md" });
	});

	it("gives up when every name is refused", async () => {
		const { vault } = vaultWith({ folders: ["Readplace"], rejectCreateOf: () => true });

		await expect(createNote({ vault, folder: "Readplace", baseName: "Title", content: "body" })).rejects.toThrow('No free note name for "Title"');
	});
});

describe("updateNote", () => {
	it("writes through process when the note still matches the recorded hash", async () => {
		const { vault, files } = vaultWith({ files: { "a.md": "old" } });

		const result = await updateNote({ vault, path: "a.md", expectedHash: await sha256Hex("old"), content: "new" });

		expect(result).toEqual({ kind: "written" });
		expect(files.get("a.md")).toBe("new");
	});

	it("reports edited and leaves the note when the hash differs", async () => {
		const { vault, files } = vaultWith({ files: { "a.md": "reader's words" } });

		const result = await updateNote({ vault, path: "a.md", expectedHash: await sha256Hex("old"), content: "new" });

		expect(result).toEqual({ kind: "edited" });
		expect(files.get("a.md")).toBe("reader's words");
	});

	it("keeps an edit that lands between the read and the process callback", async () => {
		const { vault, files } = vaultWith({ files: { "a.md": "old" } });
		const process = vault.process.bind(vault);
		vault.process = async (path, update) => {
			files.set(path, "typed just now");
			return process(path, update);
		};

		const result = await updateNote({ vault, path: "a.md", expectedHash: await sha256Hex("old"), content: "new" });

		expect(result).toEqual({ kind: "edited" });
		expect(files.get("a.md")).toBe("typed just now");
	});
});

describe("renameNote", () => {
	it("renames to the first free suffix", async () => {
		const { vault, files } = vaultWith({ files: { "Readplace/Old.md": "body", "Readplace/New.md": "other" } });

		const result = await renameNote({ vault, path: "Readplace/Old.md", folder: "Readplace", baseName: "New" });

		expect(result).toEqual({ path: "Readplace/New (2).md" });
		expect(files.get("Readplace/New (2).md")).toBe("body");
		expect(files.get("Readplace/New.md")).toBe("other");
	});
});
