import type { TokenClient } from "../auth/tokens";
import type { HttpResponse } from "../ports";
import { walkEverySave } from "./scope";

const ORIGIN = "https://readplace.com";

interface Entry { label: string; rel: string; href: string }

function page(input: { readlists?: Entry[]; tabs?: Entry[]; articles?: { id: string; status?: string }[]; next?: string }): HttpResponse {
	return {
		status: 200,
		headers: { "Content-Type": "application/vnd.siren+json" },
		text: JSON.stringify({
			class: ["collection", "articles"],
			properties: { readlists: input.readlists ?? [], tabs: input.tabs ?? [] },
			entities: (input.articles ?? []).map(({ id, status }) => ({
				class: ["article"],
				properties: { id, title: id, status: status ?? "unread" },
				links: [{ rel: ["read"], href: `/opaque/${id}` }],
			})),
			links: input.next === undefined ? [] : [{ rel: ["next"], href: input.next }],
		}),
	};
}

function answer(status: number): HttpResponse {
	return { status, headers: {}, text: "" };
}

function tokensAnswering(routes: Record<string, HttpResponse>) {
	const fetched: string[] = [];
	const tokens: TokenClient = {
		isSignedIn: () => true,
		authorizedSend: async ({ url }) => {
			fetched.push(url);
			const response = routes[url];
			return response === undefined ? { kind: "unavailable", reason: "network" } : { kind: "response", response };
		},
		storeGrant: () => undefined,
		signOut: async () => undefined,
	};
	return { tokens, fetched };
}

const CURRENT_LIST: Entry = { label: "All", rel: "current", href: "/lists/one" };
const OTHER_LIST: Entry = { label: "Cooking", rel: "readlist", href: "/lists/two" };
const CURRENT_TAB: Entry = { label: "Unread", rel: "current", href: "/lists/one" };
const OTHER_TAB: Entry = { label: "Read", rel: "tab", href: "/lists/one/opaque-read" };

describe("walkEverySave", () => {
	it("reuses the current readlist and tab, and walks every other one with its pages", async () => {
		const { tokens, fetched } = tokensAnswering({
			[`${ORIGIN}/`]: page({ readlists: [CURRENT_LIST, OTHER_LIST], tabs: [CURRENT_TAB, OTHER_TAB], articles: [{ id: "a" }], next: "/p2" }),
			[`${ORIGIN}/p2`]: page({ articles: [{ id: "b" }] }),
			[`${ORIGIN}/lists/one/opaque-read`]: page({ articles: [{ id: "c" }] }),
			[`${ORIGIN}/lists/two`]: page({ tabs: [{ ...CURRENT_TAB, href: "/lists/two" }], articles: [{ id: "d" }] }),
		});

		const walked = await walkEverySave({ tokens, origin: ORIGIN });

		expect(walked.articles.map(({ id }) => id)).toEqual(["a", "b", "c", "d"]);
		expect(walked.collectionsStopped).toEqual([]);
		expect(walked.fatal).toBeUndefined();
		expect(fetched).toEqual([`${ORIGIN}/`, `${ORIGIN}/p2`, `${ORIGIN}/lists/one/opaque-read`, `${ORIGIN}/lists/two`]);
	});

	it("keeps the first copy of an article listed in two readlists", async () => {
		const { tokens } = tokensAnswering({
			[`${ORIGIN}/`]: page({ readlists: [CURRENT_LIST, OTHER_LIST], tabs: [CURRENT_TAB], articles: [{ id: "a", status: "unread" }] }),
			[`${ORIGIN}/lists/two`]: page({ tabs: [{ ...CURRENT_TAB, href: "/lists/two" }], articles: [{ id: "a", status: "read" }] }),
		});

		const walked = await walkEverySave({ tokens, origin: ORIGIN });

		expect(walked.articles.map(({ id, status }) => ({ id, status }))).toEqual([{ id: "a", status: "unread" }]);
	});

	it("records a stopped tab and continues", async () => {
		const { tokens } = tokensAnswering({
			[`${ORIGIN}/`]: page({ readlists: [CURRENT_LIST, OTHER_LIST], tabs: [OTHER_TAB, CURRENT_TAB], articles: [{ id: "a" }] }),
			[`${ORIGIN}/lists/one/opaque-read`]: answer(404),
			[`${ORIGIN}/lists/two`]: answer(403),
		});

		const walked = await walkEverySave({ tokens, origin: ORIGIN });

		expect(walked.articles.map(({ id }) => id)).toEqual(["a"]);
		expect(walked.collectionsStopped).toEqual([
			{ kind: "not-siren", status: 404, mediaType: "" },
			{ kind: "not-siren", status: 403, mediaType: "" },
		]);
		expect(walked.fatal).toBeUndefined();
	});

	it("records a later page that stops and continues with the next tab", async () => {
		const { tokens } = tokensAnswering({
			[`${ORIGIN}/`]: page({ readlists: [CURRENT_LIST], tabs: [CURRENT_TAB, OTHER_TAB], articles: [{ id: "a" }], next: "/p2" }),
			[`${ORIGIN}/p2`]: answer(500),
			[`${ORIGIN}/lists/one/opaque-read`]: page({ articles: [{ id: "b" }] }),
		});

		const walked = await walkEverySave({ tokens, origin: ORIGIN });

		expect(walked.articles.map(({ id }) => id)).toEqual(["a", "b"]);
		expect(walked.collectionsStopped).toEqual([{ kind: "not-siren", status: 500, mediaType: "" }]);
	});

	it("records a root that is not a collection", async () => {
		const { tokens } = tokensAnswering({ [`${ORIGIN}/`]: answer(500) });

		const walked = await walkEverySave({ tokens, origin: ORIGIN });

		expect(walked).toEqual({ articles: [], collectionsStopped: [{ kind: "not-siren", status: 500, mediaType: "" }], fatal: undefined });
	});

	it("ends the walk at once on a fatal outcome and keeps what it found", async () => {
		const { tokens, fetched } = tokensAnswering({
			[`${ORIGIN}/`]: page({ readlists: [CURRENT_LIST, OTHER_LIST], tabs: [CURRENT_TAB], articles: [{ id: "a" }], next: "/p2" }),
			[`${ORIGIN}/p2`]: answer(429),
		});

		const walked = await walkEverySave({ tokens, origin: ORIGIN });

		expect(walked.articles.map(({ id }) => id)).toEqual(["a"]);
		expect(walked.fatal).toEqual({ kind: "unavailable", reason: "rate-limited", status: 429 });
		expect(fetched).toEqual([`${ORIGIN}/`, `${ORIGIN}/p2`]);
	});

	it("ends the walk when a tab or a readlist reports signed out", async () => {
		const signedOut = tokensAnswering({});
		signedOut.tokens.authorizedSend = async () => ({ kind: "signed-out" });

		const walked = await walkEverySave({ tokens: signedOut.tokens, origin: ORIGIN });

		expect(walked.fatal).toEqual({ kind: "signed-out" });
	});

	it("ends the walk when another tab cannot be reached", async () => {
		const { tokens } = tokensAnswering({
			[`${ORIGIN}/`]: page({ readlists: [CURRENT_LIST], tabs: [OTHER_TAB, CURRENT_TAB], articles: [{ id: "a" }] }),
		});

		const walked = await walkEverySave({ tokens, origin: ORIGIN });

		expect(walked.fatal).toEqual({ kind: "unavailable", reason: "network" });
		expect(walked.articles).toEqual([]);
	});

	it("ends the walk when another readlist cannot be reached", async () => {
		const { tokens } = tokensAnswering({
			[`${ORIGIN}/`]: page({ readlists: [OTHER_LIST, CURRENT_LIST], tabs: [CURRENT_TAB], articles: [{ id: "a" }] }),
		});

		const walked = await walkEverySave({ tokens, origin: ORIGIN });

		expect(walked.fatal).toEqual({ kind: "unavailable", reason: "network" });
		expect(walked.articles).toEqual([]);
	});
});
