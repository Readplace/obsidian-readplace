import { SECRET_IDS } from "../config";
import type { HttpRequest, HttpResponse, SecretId, SecretStore, SendHttp } from "../ports";
import type { AuthorizationServerResult } from "./authorization-server";
import { initTokenClient, parseGrant } from "./tokens";

const API_URL = "https://readplace.com/queue";
const TOKEN_URL = "https://readplace.com/oauth/token";
const REVOKE_URL = "https://readplace.com/oauth/revoke";

const okServer = async (): Promise<AuthorizationServerResult> => ({
	kind: "ok",
	server: {
		authorizationEndpoint: "https://readplace.com/oauth/authorize",
		tokenEndpoint: TOKEN_URL,
		revocationEndpoint: REVOKE_URL,
	},
});

const answer = (status: number, text = ""): HttpResponse => ({ status, headers: {}, text });

const GRANT = answer(200, JSON.stringify({ access_token: "access-2", refresh_token: "refresh-2" }));

function fakeSecrets(tokens: { access?: string; refresh?: string } = { access: "access-1", refresh: "refresh-1" }) {
	const secrets = new Map<SecretId, string>();
	if (tokens.access !== undefined) secrets.set(SECRET_IDS.accessToken, tokens.access);
	if (tokens.refresh !== undefined) secrets.set(SECRET_IDS.refreshToken, tokens.refresh);
	const store: SecretStore = {
		get: (id) => secrets.get(id) ?? null,
		set: (id, value) => {
			secrets.set(id, value);
		},
	};
	return { store, access: () => secrets.get(SECRET_IDS.accessToken), refresh: () => secrets.get(SECRET_IDS.refreshToken) };
}

function fakeHttp(routes: { api: (request: HttpRequest) => HttpResponse; token?: () => HttpResponse | Promise<HttpResponse>; revoke?: () => HttpResponse }) {
	const requests: HttpRequest[] = [];
	const sendHttp: SendHttp = async (request) => {
		requests.push(request);
		if (request.url === TOKEN_URL && routes.token) return routes.token();
		if (request.url === REVOKE_URL && routes.revoke) return routes.revoke();
		return routes.api(request);
	};
	return { sendHttp, requests, to: (url: string) => requests.filter((request) => request.url === url) };
}

const staleUntilRefreshed = (request: HttpRequest) =>
	request.headers["Authorization"] === "Bearer access-2" ? answer(200, "fresh") : answer(401);

const offline = (): HttpResponse => {
	throw new Error("offline");
};

describe("authorizedSend", () => {
	it("adds the bearer token, keeps the caller's headers and passes a 200 through", async () => {
		const http = fakeHttp({ api: () => answer(200, "page") });
		const tokens = initTokenClient({ sendHttp: http.sendHttp, secrets: fakeSecrets().store, server: okServer });

		const result = await tokens.authorizedSend({ url: API_URL, method: "GET", headers: { Accept: "text/markdown" } });

		expect(result).toEqual({ kind: "response", response: answer(200, "page") });
		expect(http.requests[0]?.headers).toEqual({ Accept: "text/markdown", Authorization: "Bearer access-1" });
	});

	it("passes any other failure status through without refreshing", async () => {
		const http = fakeHttp({ api: () => answer(404) });
		const tokens = initTokenClient({ sendHttp: http.sendHttp, secrets: fakeSecrets().store, server: okServer });

		const result = await tokens.authorizedSend({ url: API_URL, method: "GET" });

		expect(result).toEqual({ kind: "response", response: answer(404) });
		expect(http.requests).toHaveLength(1);
	});

	it("refreshes once on a 401, stores the rotated grant and retries once with the new token", async () => {
		const secrets = fakeSecrets();
		const http = fakeHttp({ api: staleUntilRefreshed, token: () => GRANT });
		const tokens = initTokenClient({ sendHttp: http.sendHttp, secrets: secrets.store, server: okServer });

		const result = await tokens.authorizedSend({ url: API_URL, method: "GET" });

		expect(result).toEqual({ kind: "response", response: answer(200, "fresh") });
		expect(http.to(API_URL)).toHaveLength(2);
		expect(http.to(TOKEN_URL)).toHaveLength(1);
		expect(secrets.access()).toBe("access-2");
		expect(secrets.refresh()).toBe("refresh-2");
	});

	it("form-encodes the refresh with the client id", async () => {
		const http = fakeHttp({ api: staleUntilRefreshed, token: () => GRANT });
		const tokens = initTokenClient({ sendHttp: http.sendHttp, secrets: fakeSecrets().store, server: okServer });

		await tokens.authorizedSend({ url: API_URL, method: "GET" });

		const [refresh] = http.to(TOKEN_URL);
		expect(refresh?.method).toBe("POST");
		expect(refresh?.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded" });
		expect(refresh?.body).toBe("grant_type=refresh_token&refresh_token=refresh-1&client_id=obsidian-plugin");
	});

	it("shares one refresh between concurrent 401s", async () => {
		let releaseRefresh: (response: HttpResponse) => void = () => undefined;
		const refreshAnswer = new Promise<HttpResponse>((resolve) => {
			releaseRefresh = resolve;
		});
		const http = fakeHttp({ api: staleUntilRefreshed, token: () => refreshAnswer });
		const tokens = initTokenClient({ sendHttp: http.sendHttp, secrets: fakeSecrets().store, server: okServer });

		const sends = [tokens.authorizedSend({ url: API_URL, method: "GET" }), tokens.authorizedSend({ url: API_URL, method: "GET" })];
		for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
		releaseRefresh(GRANT);
		const results = await Promise.all(sends);

		expect(http.to(TOKEN_URL)).toHaveLength(1);
		expect(results).toEqual([
			{ kind: "response", response: answer(200, "fresh") },
			{ kind: "response", response: answer(200, "fresh") },
		]);
	});

	it("starts a new refresh for a 401 that follows a finished one", async () => {
		const http = fakeHttp({ api: () => answer(401), token: () => GRANT });
		const tokens = initTokenClient({ sendHttp: http.sendHttp, secrets: fakeSecrets().store, server: okServer });

		await tokens.authorizedSend({ url: API_URL, method: "GET" });
		await tokens.authorizedSend({ url: API_URL, method: "GET" });

		expect(http.to(TOKEN_URL)).toHaveLength(2);
	});

	it("returns a retry that still answers 401 as a response and keeps the tokens", async () => {
		const secrets = fakeSecrets();
		const http = fakeHttp({ api: () => answer(401), token: () => GRANT });
		const tokens = initTokenClient({ sendHttp: http.sendHttp, secrets: secrets.store, server: okServer });

		const result = await tokens.authorizedSend({ url: API_URL, method: "GET" });

		expect(result).toEqual({ kind: "response", response: answer(401) });
		expect(http.to(API_URL)).toHaveLength(2);
		expect(secrets.access()).toBe("access-2");
	});

	it("signs out and clears both secrets when the refresh answers 400", async () => {
		const secrets = fakeSecrets();
		const http = fakeHttp({ api: () => answer(401), token: () => answer(400, '{"error":"invalid_grant"}') });
		const tokens = initTokenClient({ sendHttp: http.sendHttp, secrets: secrets.store, server: okServer });

		const result = await tokens.authorizedSend({ url: API_URL, method: "GET" });

		expect(result).toEqual({ kind: "signed-out" });
		expect(secrets.access()).toBe("");
		expect(secrets.refresh()).toBe("");
	});

	it("signs out without calling the token endpoint when no refresh token is held", async () => {
		const secrets = fakeSecrets({ access: "access-1", refresh: "" });
		const http = fakeHttp({ api: () => answer(401), token: () => GRANT });
		const tokens = initTokenClient({ sendHttp: http.sendHttp, secrets: secrets.store, server: okServer });

		const result = await tokens.authorizedSend({ url: API_URL, method: "GET" });

		expect(result).toEqual({ kind: "signed-out" });
		expect(http.to(TOKEN_URL)).toHaveLength(0);
		expect(secrets.access()).toBe("");
	});

	it.each([
		["429", () => answer(429, "Too many requests"), { kind: "unavailable", reason: "rate-limited" }],
		["503", () => answer(503), { kind: "unavailable", reason: "server", status: 503 }],
		["a transport failure", offline, { kind: "unavailable", reason: "network" }],
		["a 200 without tokens", () => answer(200, "{}"), { kind: "unavailable", reason: "server", status: 200 }],
		["a 200 that is not JSON", () => answer(200, "<html>"), { kind: "unavailable", reason: "server", status: 200 }],
	])("ends unavailable and keeps the tokens when the refresh answers %s", async (_case, token, expected) => {
		const secrets = fakeSecrets();
		const http = fakeHttp({ api: () => answer(401), token });
		const tokens = initTokenClient({ sendHttp: http.sendHttp, secrets: secrets.store, server: okServer });

		const result = await tokens.authorizedSend({ url: API_URL, method: "GET" });

		expect(result).toEqual(expected);
		expect(secrets.access()).toBe("access-1");
		expect(secrets.refresh()).toBe("refresh-1");
	});

	it.each([
		[503, { kind: "unavailable", reason: "server", status: 503 }],
		[429, { kind: "unavailable", reason: "rate-limited" }],
		["network", { kind: "unavailable", reason: "network" }],
		["malformed", { kind: "unavailable", reason: "server" }],
	] as const)("ends unavailable when the metadata fetch reports %s", async (status, expected) => {
		const secrets = fakeSecrets();
		const http = fakeHttp({ api: () => answer(401) });
		const tokens = initTokenClient({
			sendHttp: http.sendHttp,
			secrets: secrets.store,
			server: async () => ({ kind: "unavailable", status }),
		});

		const result = await tokens.authorizedSend({ url: API_URL, method: "GET" });

		expect(result).toEqual(expected);
		expect(secrets.refresh()).toBe("refresh-1");
	});

	it("reports a transport failure of the request as network", async () => {
		const http = fakeHttp({ api: offline });
		const tokens = initTokenClient({ sendHttp: http.sendHttp, secrets: fakeSecrets().store, server: okServer });

		const result = await tokens.authorizedSend({ url: API_URL, method: "GET" });

		expect(result).toEqual({ kind: "unavailable", reason: "network" });
	});

	it("answers signed-out without sending anything when there is no access token", async () => {
		const http = fakeHttp({ api: () => answer(200) });
		const tokens = initTokenClient({ sendHttp: http.sendHttp, secrets: fakeSecrets({}).store, server: okServer });

		const result = await tokens.authorizedSend({ url: API_URL, method: "GET" });

		expect(result).toEqual({ kind: "signed-out" });
		expect(http.requests).toHaveLength(0);
	});

	it("treats an empty access secret as no access token", async () => {
		const http = fakeHttp({ api: () => answer(200) });
		const tokens = initTokenClient({ sendHttp: http.sendHttp, secrets: fakeSecrets({ access: "", refresh: "" }).store, server: okServer });

		const result = await tokens.authorizedSend({ url: API_URL, method: "GET" });

		expect(result).toEqual({ kind: "signed-out" });
	});
});

describe("isSignedIn", () => {
	it.each([
		["both secrets", { access: "a", refresh: "r" }, true],
		["only the access secret", { access: "a", refresh: "" }, true],
		["only the refresh secret", { access: "", refresh: "r" }, true],
		["empty secrets", { access: "", refresh: "" }, false],
		["no secrets", {}, false],
	])("with %s", (_case, stored, expected) => {
		const tokens = initTokenClient({ sendHttp: fakeHttp({ api: () => answer(200) }).sendHttp, secrets: fakeSecrets(stored).store, server: okServer });

		expect(tokens.isSignedIn()).toBe(expected);
	});
});

describe("storeGrant", () => {
	it("writes both secrets", () => {
		const secrets = fakeSecrets({});
		const tokens = initTokenClient({ sendHttp: fakeHttp({ api: () => answer(200) }).sendHttp, secrets: secrets.store, server: okServer });

		tokens.storeGrant({ accessToken: "access-9", refreshToken: "refresh-9" });

		expect(secrets.access()).toBe("access-9");
		expect(secrets.refresh()).toBe("refresh-9");
	});
});

describe("signOut", () => {
	it("posts the refresh token and client id as JSON to the revocation endpoint, then clears both secrets", async () => {
		const secrets = fakeSecrets();
		const http = fakeHttp({ api: () => answer(200), revoke: () => answer(200) });
		const tokens = initTokenClient({ sendHttp: http.sendHttp, secrets: secrets.store, server: okServer });

		await tokens.signOut();

		const [revoke] = http.to(REVOKE_URL);
		expect(revoke?.method).toBe("POST");
		expect(revoke?.headers).toEqual({ "Content-Type": "application/json" });
		expect(JSON.parse(revoke?.body ?? "")).toEqual({ token: "refresh-1", client_id: "obsidian-plugin" });
		expect(secrets.access()).toBe("");
		expect(secrets.refresh()).toBe("");
	});

	it.each([
		["the revocation answers 500", () => answer(500)],
		["the revocation rejects", offline],
	])("clears both secrets when %s", async (_case, revoke) => {
		const secrets = fakeSecrets();
		const http = fakeHttp({ api: () => answer(200), revoke });
		const tokens = initTokenClient({ sendHttp: http.sendHttp, secrets: secrets.store, server: okServer });

		await tokens.signOut();

		expect(secrets.access()).toBe("");
		expect(secrets.refresh()).toBe("");
	});

	it("clears both secrets when the metadata is unavailable", async () => {
		const secrets = fakeSecrets();
		const http = fakeHttp({ api: () => answer(200) });
		const tokens = initTokenClient({
			sendHttp: http.sendHttp,
			secrets: secrets.store,
			server: async () => ({ kind: "unavailable", status: "network" }),
		});

		await tokens.signOut();

		expect(http.requests).toHaveLength(0);
		expect(secrets.refresh()).toBe("");
	});

	it("revokes nothing when no refresh token is held", async () => {
		const secrets = fakeSecrets({ access: "access-1" });
		const http = fakeHttp({ api: () => answer(200) });
		const tokens = initTokenClient({ sendHttp: http.sendHttp, secrets: secrets.store, server: okServer });

		await tokens.signOut();

		expect(http.requests).toHaveLength(0);
		expect(secrets.access()).toBe("");
	});

	it("does not store a refresh that finishes after sign-out", async () => {
		const secrets = fakeSecrets();
		let finishRefresh: (response: HttpResponse) => void = () => undefined;
		const refreshAnswer = new Promise<HttpResponse>((resolve) => {
			finishRefresh = resolve;
		});
		const http = fakeHttp({ api: staleUntilRefreshed, token: () => refreshAnswer, revoke: () => answer(200) });
		const client = initTokenClient({ sendHttp: http.sendHttp, secrets: secrets.store, server: okServer });

		const pending = client.authorizedSend({ url: API_URL, method: "GET" });
		while (http.to(TOKEN_URL).length === 0) await Promise.resolve();
		await client.signOut();
		finishRefresh(GRANT);
		const result = await pending;

		expect(result).toEqual({ kind: "signed-out" });
		expect(secrets.access()).toBe("");
		expect(secrets.refresh()).toBe("");
		expect(client.isSignedIn()).toBe(false);
	});
});

describe("parseGrant", () => {
	it("reads both tokens", () => {
		expect(parseGrant(GRANT.text)).toEqual({ accessToken: "access-2", refreshToken: "refresh-2" });
	});

	it("answers undefined for a body without them", () => {
		expect(parseGrant('{"access_token":"a"}')).toBeUndefined();
	});
});
