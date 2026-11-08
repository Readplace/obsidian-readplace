import type { AuthorizedResult, TokenClient } from "../auth/tokens";
import type { HttpResponse } from "../ports";
import { fetchArticleMarkdown, isCompleteDocument, type MarkdownOutcome } from "./fetch-article-markdown";

const MARKDOWN_HEADERS = { "Content-Type": "text/markdown; charset=utf-8" };
const readHref = "https://readplace.com/queue/abc/view?readlist=work";

function documentWith(frontmatterLines: string[]): string {
	return ["---", "title: Hello World", ...frontmatterLines, "---", "", "Body text.", ""].join("\n");
}

function tokensAnswering(result: AuthorizedResult) {
	const requests: Parameters<TokenClient["authorizedSend"]>[0][] = [];
	const tokens: TokenClient = {
		isSignedIn: () => true,
		authorizedSend: async (request) => {
			requests.push(request);
			return result;
		},
		storeGrant: () => undefined,
		signOut: async () => undefined,
	};
	return { tokens, requests };
}

function answer(input: Partial<HttpResponse> & { status: number }): AuthorizedResult {
	return { kind: "response", response: { headers: {}, text: "", ...input } };
}

describe("isCompleteDocument", () => {
	it.each([
		["content processing", ["readplace_content_status: processing", "readplace_summary_status: ready"], false],
		["summary pending", ["readplace_content_status: ready", "readplace_summary_status: pending"], false],
		["both ready", ["readplace_content_status: ready", "readplace_summary_status: ready"], true],
		["a failed crawl, whose summary key is absent", ["readplace_content_status: failed"], true],
		["not an article, whose summary key is absent", ["readplace_content_status: not-an-article"], true],
	])("reads %s", (_name, lines, complete) => {
		expect(isCompleteDocument(documentWith(lines))).toBe(complete);
	});

	it("ignores the same line in the body", () => {
		const markdown = `${documentWith(["readplace_content_status: ready"])}readplace_content_status: processing\n`;

		expect(isCompleteDocument(markdown)).toBe(true);
	});

	it("takes a frontmatter-only document that ends at the closing fence", () => {
		expect(isCompleteDocument("---\nreadplace_content_status: processing\n---")).toBe(false);
	});

	it("takes a document with no frontmatter as settled", () => {
		expect(isCompleteDocument("Body only.\n")).toBe(true);
	});
});

describe("fetchArticleMarkdown", () => {
	it("asks for Markdown at the read href", async () => {
		const { tokens, requests } = tokensAnswering(answer({ status: 404 }));

		await fetchArticleMarkdown({ tokens, readHref });

		expect(requests).toEqual([{ url: readHref, method: "GET", headers: { Accept: "text/markdown" } }]);
	});

	it("returns the bytes unchanged with their completeness", async () => {
		const markdown = documentWith(["readplace_content_status: ready", "readplace_summary_status: pending"]);
		const { tokens } = tokensAnswering(answer({ status: 200, headers: MARKDOWN_HEADERS, text: markdown }));

		expect(await fetchArticleMarkdown({ tokens, readHref })).toEqual({ kind: "document", markdown, complete: false });
	});

	it("reads the media type from a lower-case header", async () => {
		const { tokens } = tokensAnswering(answer({ status: 200, headers: { "content-type": "TEXT/MARKDOWN" }, text: "Body.\n" }));

		expect(await fetchArticleMarkdown({ tokens, readHref })).toEqual({ kind: "document", markdown: "Body.\n", complete: true });
	});

	it.each<[string, AuthorizedResult, MarkdownOutcome]>([
		["a 200 of another type", answer({ status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }), { kind: "unsupported-type", mediaType: "text/html" }],
		["a 404, whose body is Markdown too", answer({ status: 404, headers: MARKDOWN_HEADERS, text: "# Not found\n" }), { kind: "not-found" }],
		["a 500", answer({ status: 500 }), { kind: "skipped", status: 500 }],
		["a 403", answer({ status: 403 }), { kind: "skipped", status: 403 }],
		["a 429", answer({ status: 429 }), { kind: "unavailable", reason: "rate-limited", status: 429 }],
		["a 401 that survived the refresh", answer({ status: 401, headers: MARKDOWN_HEADERS, text: "# Unauthorized\n" }), { kind: "unavailable", reason: "unauthorized", status: 401 }],
		["a signed-out client", { kind: "signed-out" }, { kind: "signed-out" }],
		["a network failure", { kind: "unavailable", reason: "network" }, { kind: "unavailable", reason: "network" }],
	])("classifies %s", async (_name, result, expected) => {
		const { tokens } = tokensAnswering(result);

		expect(await fetchArticleMarkdown({ tokens, readHref })).toEqual(expected);
	});
});
