import { noteBaseName, notePath } from "./note-path";

const NO_FALLBACKS = { siteName: "site", id: "id-1" };

describe("noteBaseName", () => {
	it.each(["\\", "/", ":", "*", "?", '"', "<", ">", "|", "#", "^", "[", "]", "%%"])("replaces %s with a space", (character) => {
		expect(noteBaseName({ title: `before${character}after`, ...NO_FALLBACKS })).toBe("before after");
	});

	it("keeps a single percent sign", () => {
		expect(noteBaseName({ title: "100% done", ...NO_FALLBACKS })).toBe("100% done");
	});

	it("collapses whitespace and trims", () => {
		expect(noteBaseName({ title: "  one \t two\n\nthree  ", ...NO_FALLBACKS })).toBe("one two three");
	});

	it("cuts a long title to 100 characters and trims the cut", () => {
		expect(noteBaseName({ title: `${"a".repeat(99)} ${"b".repeat(50)}`, ...NO_FALLBACKS })).toBe("a".repeat(99));
	});

	it("does not split an emoji at the cut", () => {
		expect(noteBaseName({ title: "😀".repeat(101), ...NO_FALLBACKS })).toBe("😀".repeat(50));
	});

	it("cuts a multibyte title to 200 UTF-8 bytes without splitting a character", () => {
		expect(noteBaseName({ title: "日".repeat(100), ...NO_FALLBACKS })).toBe("日".repeat(66));
	});

	it("drops a leading dot so the note is not a hidden file", () => {
		expect(noteBaseName({ title: ".NET 9 is out", siteName: "s", id: "i" })).toBe("NET 9 is out");
	});

	it("falls back to the site name when the title is only dots", () => {
		expect(noteBaseName({ title: "...", siteName: "example: blog", id: "i" })).toBe("example blog");
	});

	it("falls back to the cleaned site name when the title cleans to nothing", () => {
		expect(noteBaseName({ title: " ### ", siteName: "example: blog", id: "id-1" })).toBe("example blog");
	});

	it("falls back to the id when the site name cleans to nothing too", () => {
		expect(noteBaseName({ title: "", siteName: "[]", id: "id-1" })).toBe("id-1");
	});
});

describe("notePath", () => {
	it("adds no number for the first suffix", () => {
		expect(notePath({ folder: "Readplace", baseName: "Title", suffix: 1 })).toBe("Readplace/Title.md");
	});

	it("numbers later suffixes", () => {
		expect(notePath({ folder: "Readplace/Inbox", baseName: "Title", suffix: 2 })).toBe("Readplace/Inbox/Title (2).md");
	});

	it.each(["", "/"])("places the note at the vault root for the folder %j", (folder) => {
		expect(notePath({ folder, baseName: "Title", suffix: 1 })).toBe("Title.md");
	});
});
