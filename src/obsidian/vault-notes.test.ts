import { initVaultNotes, watchRenames } from "./vault-notes";

interface FakeFile { path: string; content: string }

function fakeObsidianVault(paths: Record<string, string> = {}) {
	const files = new Map<string, FakeFile>(Object.entries(paths).map(([path, content]) => [path, { path, content }]));
	const folders = new Set<string>();
	const vault = {
		getFileByPath: (path: string) => files.get(path) ?? null,
		getFolderByPath: (path: string) => (folders.has(path) ? { path } : null),
		createFolder: async (path: string) => {
			folders.add(path);
			return { path };
		},
		create: async (path: string, data: string) => {
			if (files.has(path)) throw new Error("File already exists.");
			const file = { path, content: data };
			files.set(path, file);
			return file;
		},
		read: async (file: FakeFile) => file.content,
		process: async (file: FakeFile, update: (data: string) => string) => {
			file.content = update(file.content);
			return file.content;
		},
	};
	const fileManager = {
		renameFile: async (file: FakeFile, newPath: string) => {
			files.delete(file.path);
			file.path = newPath;
			files.set(newPath, file);
		},
	};
	return { files, port: initVaultNotes({ vault, fileManager, normalizePath: (path) => path.replace(/\\/g, "/") }) };
}

describe("initVaultNotes", () => {
	it("normalises a path with the injected function", () => {
		expect(fakeObsidianVault().port.normalizePath("a\\b")).toBe("a/b");
	});

	it("reports whether a note exists", () => {
		const { port } = fakeObsidianVault({ "Readplace/a.md": "body" });

		expect(port.fileExists("Readplace/a.md")).toBe(true);
		expect(port.fileExists("Readplace/b.md")).toBe(false);
	});

	it("reports a folder once it has been created", async () => {
		const { port } = fakeObsidianVault();
		expect(port.folderExists("Readplace")).toBe(false);

		await port.createFolder("Readplace");

		expect(port.folderExists("Readplace")).toBe(true);
	});

	it("creates a note and reads it back", async () => {
		const { port } = fakeObsidianVault();

		await port.create("a.md", "body");

		await expect(port.read("a.md")).resolves.toBe("body");
	});

	it("rejects a create on a path that exists, so the caller moves to the next name", async () => {
		const { port } = fakeObsidianVault({ "a.md": "body" });

		await expect(port.create("a.md", "other")).rejects.toThrow("File already exists.");
	});

	it("updates a note through the vault's atomic process and returns the content after the call", async () => {
		const { files, port } = fakeObsidianVault({ "a.md": "before" });

		await expect(port.process("a.md", (data) => `${data} after`)).resolves.toBe("before after");

		expect(files.get("a.md")?.content).toBe("before after");
	});

	it("renames through the file manager, which keeps links to the note intact", async () => {
		const { files, port } = fakeObsidianVault({ "a.md": "body" });

		await port.rename("a.md", "b.md");

		expect([...files.keys()]).toEqual(["b.md"]);
	});

	it.each([
		["read", (port: ReturnType<typeof fakeObsidianVault>["port"]) => port.read("gone.md")],
		["process", (port: ReturnType<typeof fakeObsidianVault>["port"]) => port.process("gone.md", (data) => data)],
		["rename", (port: ReturnType<typeof fakeObsidianVault>["port"]) => port.rename("gone.md", "b.md")],
	])("refuses to %s a note that is gone", async (_name, act) => {
		const { port } = fakeObsidianVault();

		await expect(act(port)).rejects.toThrow("No note at gone.md");
	});
});

describe("watchRenames", () => {
	it("subscribes to rename events and reports each move with its old and new path", () => {
		const moves: unknown[] = [];
		const subscribed: string[] = [];
		const vault = {
			on: (name: "rename", listener: (file: { path: string }, oldPath: string) => unknown) => {
				subscribed.push(name);
				listener({ path: "New/a.md" }, "Old/a.md");
				return "subscription";
			},
		};

		const subscription = watchRenames({ vault, onMove: (move) => moves.push(move) });

		expect(subscription).toBe("subscription");
		expect(subscribed).toEqual(["rename"]);
		expect(moves).toEqual([{ oldPath: "Old/a.md", newPath: "New/a.md" }]);
	});
});
