import { parseCollection } from "./siren";

const base = "https://readplace.com/queue?status=unread&page=1";

const articleEntity = {
	class: ["article"],
	rel: ["item"],
	properties: {
		id: "abc123",
		url: "https://example.com/post",
		title: "Test Article",
		siteName: "Example",
		excerpt: "First paragraph...",
		imageUrl: "https://example.com/image.jpg",
		readTime: { value: "5", label: "5 min read" },
		status: "read",
		savedAt: "2026-03-04T10:00:00.000Z",
		publishedOn: null,
		readAt: "2026-03-05T10:00:00.000Z",
		isRead: true,
		needsBrowserCapture: false,
		contentVersion: "0123456789abcdef",
	},
	links: [{ rel: ["read"], title: "Read", href: "/queue/abc123/view?readlist=work" }],
	actions: [{ name: "update-status", href: "/queue/abc123/status?status=read", method: "POST" }],
};

const collectionBody = {
	class: ["collection", "articles"],
	properties: {
		pageSize: 20,
		pages: [{ label: "1", rel: "current", href: "/queue?status=unread&page=1" }],
		tabs: [
			{ label: "To Read", rel: "current", href: "/queue?status=unread" },
			{ label: "Read", rel: "tab", href: "/queue?status=read" },
		],
		readlists: [
			{ label: "All", rel: "current", href: "/queue" },
			{ label: "Work", rel: "readlist", href: "/queue?readlist=work" },
		],
		total: { label: "1 article" },
		appearance: "system",
	},
	entities: [articleEntity],
	links: [
		{ rel: ["self"], href: "/queue?status=unread&page=1" },
		{ rel: ["root"], href: "/queue" },
		{ rel: ["next"], href: "/queue?status=unread&page=2" },
	],
	actions: [{ name: "save-article", href: "/queue", method: "POST" }],
};

function parse(body: unknown) {
	return parseCollection({ text: JSON.stringify(body), base });
}

describe("parseCollection", () => {
	it("reads the published collection shape, resolving every href it will follow", () => {
		expect(parse(collectionBody)).toEqual({
			tabs: [
				{ label: "To Read", rel: "current", href: "https://readplace.com/queue?status=unread" },
				{ label: "Read", rel: "tab", href: "https://readplace.com/queue?status=read" },
			],
			readlists: [
				{ label: "All", rel: "current", href: "https://readplace.com/queue" },
				{ label: "Work", rel: "readlist", href: "https://readplace.com/queue?readlist=work" },
			],
			articles: [
				{
					id: "abc123",
					title: "Test Article",
					siteName: "Example",
					status: "read",
					readAt: "2026-03-05T10:00:00.000Z",
					contentVersion: "0123456789abcdef",
					readHref: "https://readplace.com/queue/abc123/view?readlist=work",
				},
			],
			nextHref: "https://readplace.com/queue?status=unread&page=2",
		});
	});

	it("reads a collection that carries only its class and properties as empty", () => {
		expect(parse({ class: ["collection"], properties: {} })).toEqual({ tabs: [], readlists: [], articles: [], nextHref: undefined });
	});

	it("skips a malformed entity and keeps the others", () => {
		const collection = parse({ ...collectionBody, entities: [{ class: ["article"], properties: { id: 7 } }, articleEntity] });

		expect(collection?.articles.map((article) => article.id)).toEqual(["abc123"]);
	});

	it("skips an entity that is not an article", () => {
		const banner = { class: ["banner"], properties: { id: "b", title: "b", status: "unread" } };

		expect(parse({ ...collectionBody, entities: [banner] })?.articles).toEqual([]);
	});

	it("skips a malformed link and still finds the next one", () => {
		const links = [{ rel: "next", href: "/wrong" }, { rel: ["next"], href: "/queue?opaque=2" }];

		expect(parse({ ...collectionBody, links })?.nextHref).toBe("https://readplace.com/queue?opaque=2");
	});

	it("skips a malformed scope entry, and one whose href cannot be followed", () => {
		const tabs = [{ label: "Bad", rel: ["tab"], href: "/x" }, { label: "Mail", rel: "tab", href: "mailto:a@b.c" }, { label: "Read", rel: "tab", href: "/queue?status=read" }];

		expect(parse({ ...collectionBody, properties: { ...collectionBody.properties, tabs } })?.tabs).toEqual([
			{ label: "Read", rel: "tab", href: "https://readplace.com/queue?status=read" },
		]);
	});

	it("has no next href on the last page", () => {
		expect(parse({ ...collectionBody, links: [{ rel: ["self"], href: "/queue?page=3" }] })?.nextHref).toBeUndefined();
	});

	it("defaults a null site name to an empty string", () => {
		const entity = { ...articleEntity, properties: { ...articleEntity.properties, siteName: null } };

		expect(parse({ ...collectionBody, entities: [entity] })?.articles[0]?.siteName).toBe("");
	});

	it("defaults a null read time stamp to null and a missing version to an empty string", () => {
		const { contentVersion: _contentVersion, readAt: _readAt, ...properties } = articleEntity.properties;

		const article = parse({ ...collectionBody, entities: [{ ...articleEntity, properties }] })?.articles[0];

		expect(article).toMatchObject({ readAt: null, contentVersion: "" });
	});

	it("leaves the read href undefined when the article has no read link", () => {
		const { links: _links, ...entity } = articleEntity;

		expect(parse({ ...collectionBody, entities: [entity] })?.articles[0]?.readHref).toBeUndefined();
	});

	it("keeps an article whose read link cannot be parsed beside a well-formed one", () => {
		const unparseable = { ...articleEntity, links: [{ rel: ["read"], href: "//" }] };

		const articles = parse({ ...collectionBody, entities: [unparseable, articleEntity] })?.articles;

		expect(articles).toHaveLength(2);
		expect(articles?.[0]?.readHref).toBeUndefined();
		expect(articles?.[1]?.readHref).toBe("https://readplace.com/queue/abc123/view?readlist=work");
	});

	it("answers undefined for a body that is not JSON", () => {
		expect(parseCollection({ text: "<html></html>", base })).toBeUndefined();
	});

	it("answers undefined for JSON without collection properties", () => {
		expect(parse({ class: ["collection"] })).toBeUndefined();
	});

	it("answers undefined for a Siren entity that is not a collection", () => {
		expect(parse({ class: ["error"], properties: { code: "invalid-token", message: "Token expired or invalid" } })).toBeUndefined();
	});
});
