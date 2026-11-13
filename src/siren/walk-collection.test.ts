import { initTokenClient } from "../auth/tokens";
import { MAX_REDIRECT_HOPS } from "../config";
import type { HttpRequest, HttpResponse, SecretId } from "../ports";
import { fetchCollection, type FetchOutcome, walkPages } from "./walk-collection";

const SIREN_HEADERS = { "Content-Type": "application/vnd.siren+json" };
const TOKEN_ENDPOINT = "https://readplace.com/oauth/token";

function sirenPage(input: { ids: string[]; nextHref?: string }): HttpResponse {
	return {
		status: 200,
		headers: SIREN_HEADERS,
		text: JSON.stringify({
			class: ["collection", "articles"],
			properties: {},
			entities: input.ids.map((id) => ({
				class: ["article"],
				properties: { id, title: id, status: "unread" },
				links: [{ rel: ["read"], href: `/queue/${id}/view` }],
			})),
			links: input.nextHref === undefined ? [] : [{ rel: ["next"], href: input.nextHref }],
		}),
	};
}

function answer(status: number, headers: Record<string, string> = {}): HttpResponse {
	return { status, headers, text: "" };
}

function clientAnswering(input: { answers: Record<string, HttpResponse[]>; accessToken?: string }) {
	const requests: HttpRequest[] = [];
	const secrets: Partial<Record<SecretId, string>> = {
		"readplace-access-token": input.accessToken ?? "access-1",
		"readplace-refresh-token": "refresh-1",
	};
	const tokens = initTokenClient({
		sendHttp: async (request) => {
			requests.push(request);
			const next = input.answers[request.url]?.shift();
			if (next === undefined) throw new Error(`transport failure for ${request.url}`);
			return next;
		},
		secrets: { get: (id) => secrets[id] ?? null, set: (id, value) => { secrets[id] = value; } },
		server: async () => ({
			kind: "ok",
			server: { authorizationEndpoint: "https://readplace.com/oauth/authorize", tokenEndpoint: TOKEN_ENDPOINT, revocationEndpoint: "https://readplace.com/oauth/revoke" },
		}),
	});
	return { tokens, requests };
}

async function drain(input: { tokens: ReturnType<typeof clientAnswering>["tokens"]; firstPageUrl: string }) {
	const pages = walkPages(input);
	const ids: string[][] = [];
	for (;;) {
		const step = await pages.next();
		if (step.done) return { ids, stopped: step.value.stopped };
		ids.push(step.value.articles.map((article) => article.id));
	}
}

describe("fetchCollection", () => {
	it("asks for Siren alone", async () => {
		const url = "https://readplace.com/queue";
		const { tokens, requests } = clientAnswering({ answers: { [url]: [sirenPage({ ids: [] })] } });

		await fetchCollection({ tokens, url });

		expect(requests[0]).toMatchObject({ url, method: "GET" });
		expect(requests[0]?.headers["Accept"]).toBe("application/vnd.siren+json");
	});

	it("reads the collection the root answers, without a hop", async () => {
		const { tokens, requests } = clientAnswering({ answers: { "https://readplace.com/": [sirenPage({ ids: ["a"] })] } });

		const outcome = await fetchCollection({ tokens, url: "https://readplace.com/" });

		expect(outcome.kind === "collection" && outcome.collection.articles[0]?.readHref).toBe("https://readplace.com/queue/a/view");
		expect(requests.map((request) => [request.url, request.headers["Authorization"]])).toEqual([["https://readplace.com/", "Bearer access-1"]]);
	});

	it("follows a 303 and re-sends the bearer", async () => {
		const { tokens, requests } = clientAnswering({
			answers: {
				"https://readplace.com/moved": [answer(303, { Location: "/queue" })],
				"https://readplace.com/queue": [sirenPage({ ids: ["a"] })],
			},
		});

		const outcome = await fetchCollection({ tokens, url: "https://readplace.com/moved" });

		expect(outcome.kind === "collection" && outcome.collection.articles[0]?.readHref).toBe("https://readplace.com/queue/a/view");
		expect(requests.map((request) => request.headers["Authorization"])).toEqual(["Bearer access-1", "Bearer access-1"]);
	});

	it("reads a lower-case location header", async () => {
		const { tokens } = clientAnswering({
			answers: {
				"https://readplace.com/moved": [answer(303, { location: "/queue" })],
				"https://readplace.com/queue": [sirenPage({ ids: [] })],
			},
		});

		expect((await fetchCollection({ tokens, url: "https://readplace.com/moved" })).kind).toBe("collection");
	});

	it("gives up after the hop limit", async () => {
		const url = "https://readplace.com/loop";
		const loop = Array.from({ length: MAX_REDIRECT_HOPS + 2 }, () => answer(303, { Location: "/loop" }));
		const { tokens, requests } = clientAnswering({ answers: { [url]: loop } });

		const outcome = await fetchCollection({ tokens, url });

		expect(outcome).toEqual({ kind: "unavailable", reason: "too-many-redirects" });
		expect(requests).toHaveLength(MAX_REDIRECT_HOPS + 1);
	});

	it.each<[string, HttpResponse, FetchOutcome]>([
		["a redirect without a location", answer(303), { kind: "not-siren", status: 303, mediaType: "" }],
		["a redirect to a scheme it will not follow", answer(303, { Location: "mailto:a@b.c" }), { kind: "not-siren", status: 303, mediaType: "" }],
		["a 200 of another type", { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" }, text: "<html></html>" }, { kind: "not-siren", status: 200, mediaType: "text/html" }],
		["a Siren 200 that is not a collection", { status: 200, headers: SIREN_HEADERS, text: "{}" }, { kind: "not-siren", status: 200, mediaType: "application/vnd.siren+json" }],
		["a 402", answer(402, SIREN_HEADERS), { kind: "not-siren", status: 402, mediaType: "application/vnd.siren+json" }],
		["a 404", answer(404), { kind: "not-siren", status: 404, mediaType: "" }],
		["a 500", answer(500), { kind: "not-siren", status: 500, mediaType: "" }],
		["a 429", answer(429), { kind: "unavailable", reason: "rate-limited", status: 429 }],
	])("classifies %s", async (_name, response, expected) => {
		const url = "https://readplace.com/queue";
		const { tokens } = clientAnswering({ answers: { [url]: [response] } });

		expect(await fetchCollection({ tokens, url })).toEqual(expected);
	});

	it("takes a 401 that survives the refresh as unavailable, never as a sign-out", async () => {
		const url = "https://readplace.com/queue";
		const { tokens } = clientAnswering({
			answers: {
				[url]: [answer(401), answer(401)],
				[TOKEN_ENDPOINT]: [{ status: 200, headers: {}, text: JSON.stringify({ access_token: "access-2", refresh_token: "refresh-2" }) }],
			},
		});

		expect(await fetchCollection({ tokens, url })).toEqual({ kind: "unavailable", reason: "unauthorized", status: 401 });
	});

	it("passes a signed-out client through", async () => {
		const url = "https://readplace.com/queue";
		const { tokens } = clientAnswering({ answers: { [url]: [answer(401)], [TOKEN_ENDPOINT]: [answer(400)] } });

		expect(await fetchCollection({ tokens, url })).toEqual({ kind: "signed-out" });
	});
});

describe("walkPages", () => {
	it("follows next across three pages whose hrefs are opaque, sending no page size", async () => {
		const first = "https://readplace.com/queue";
		const { tokens, requests } = clientAnswering({
			answers: {
				[first]: [sirenPage({ ids: ["a"], nextHref: "/x7f?cursor=q" })],
				"https://readplace.com/x7f?cursor=q": [sirenPage({ ids: ["b"], nextHref: "https://readplace.com/opaque/three" })],
				"https://readplace.com/opaque/three": [sirenPage({ ids: ["c"] })],
			},
		});

		const walked = await drain({ tokens, firstPageUrl: first });

		expect(walked).toEqual({ ids: [["a"], ["b"], ["c"]], stopped: undefined });
		expect(requests.map((request) => request.url)).toEqual([first, "https://readplace.com/x7f?cursor=q", "https://readplace.com/opaque/three"]);
	});

	it("keeps the pages it read and reports the outcome that stopped it", async () => {
		const first = "https://readplace.com/queue";
		const { tokens } = clientAnswering({
			answers: {
				[first]: [sirenPage({ ids: ["a"], nextHref: "/page-two" })],
				"https://readplace.com/page-two": [answer(404)],
			},
		});

		expect(await drain({ tokens, firstPageUrl: first })).toEqual({
			ids: [["a"]],
			stopped: { kind: "not-siren", status: 404, mediaType: "" },
		});
	});

	it("reports a transport failure as a network outcome", async () => {
		const { tokens } = clientAnswering({ answers: {} });

		expect((await drain({ tokens, firstPageUrl: "https://readplace.com/queue" })).stopped).toMatchObject({ kind: "unavailable", reason: "network" });
	});
});
