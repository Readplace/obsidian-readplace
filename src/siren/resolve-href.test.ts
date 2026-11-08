import { resolveHref } from "./resolve-href";

const base = "https://readplace.com/queue?status=unread&page=1";

describe("resolveHref", () => {
	it("keeps an https href verbatim", () => {
		expect(resolveHref({ href: "https://cdn.example.com/a?b=1", base })).toBe("https://cdn.example.com/a?b=1");
	});

	it("keeps an http href verbatim", () => {
		expect(resolveHref({ href: "http://localhost:3000/queue", base })).toBe("http://localhost:3000/queue");
	});

	it("resolves a root-relative href against the base", () => {
		expect(resolveHref({ href: "/queue?x=1", base })).toBe("https://readplace.com/queue?x=1");
	});

	it("resolves a path-relative href against the base", () => {
		expect(resolveHref({ href: "other", base: "https://readplace.com/queue/abc" })).toBe("https://readplace.com/queue/other");
	});

	it.each(["//", "//a b"])("answers no href for a scheme-less href that cannot be parsed: %s", (href) => {
		expect(resolveHref({ href, base: "https://readplace.com/" })).toBeUndefined();
	});

	it.each(["mailto:reader@example.com", "obsidian://open?vault=a", "javascript:alert(1)"])("refuses %s", (href) => {
		expect(resolveHref({ href, base })).toBeUndefined();
	});
});
