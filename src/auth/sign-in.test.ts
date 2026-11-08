import { OAUTH_REDIRECT_URI } from "../config";
import type { HttpRequest, HttpResponse, SendHttp } from "../ports";
import type { AuthorizationServerResult } from "./authorization-server";
import { challengeFor, createVerifier, randomState } from "./pkce";
import { initSignIn } from "./sign-in";
import type { TokenClient } from "./tokens";

const TOKEN_URL = "https://readplace.com/oauth/token";
const randomBytes = (length: number) => new Uint8Array(length).fill(7);
const VERIFIER = createVerifier(randomBytes);
const STATE = randomState(randomBytes);
const GRANT_BODY = JSON.stringify({ access_token: "access-1", refresh_token: "refresh-1", token_type: "Bearer" });

const answer = (status: number, text = ""): HttpResponse => ({ status, headers: {}, text });

const okServer = async (): Promise<AuthorizationServerResult> => ({
	kind: "ok",
	server: {
		authorizationEndpoint: "https://readplace.com/oauth/authorize",
		tokenEndpoint: TOKEN_URL,
		revocationEndpoint: "https://readplace.com/oauth/revoke",
	},
});

function harness(overrides: { exchange?: () => HttpResponse; server?: () => Promise<AuthorizationServerResult> } = {}) {
	const requests: HttpRequest[] = [];
	const opened: string[] = [];
	const grants: { accessToken: string; refreshToken: string }[] = [];
	const sendHttp: SendHttp = async (request) => {
		requests.push(request);
		return overrides.exchange ? overrides.exchange() : answer(200, GRANT_BODY);
	};
	const tokens: TokenClient = {
		isSignedIn: () => grants.length > 0,
		authorizedSend: async () => ({ kind: "signed-out" }),
		storeGrant: (grant) => {
			grants.push(grant);
		},
		signOut: async () => undefined,
	};
	const signIn = initSignIn({
		sendHttp,
		tokens,
		server: overrides.server ?? okServer,
		openInBrowser: (url) => {
			opened.push(url);
		},
		randomBytes,
	});
	return { signIn, requests, opened, grants };
}

describe("begin", () => {
	it("opens the authorize URL with every parameter and no hint for a login", async () => {
		const { signIn, opened } = harness();

		const result = await signIn.begin({ screenHint: "login" });

		expect(result).toEqual({ kind: "opened" });
		const url = new URL(opened[0] ?? "");
		expect(url.origin + url.pathname).toBe("https://readplace.com/oauth/authorize");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			client_id: "obsidian-plugin",
			redirect_uri: "https://readplace.com/oauth/obsidian",
			response_type: "code",
			code_challenge: await challengeFor(VERIFIER),
			code_challenge_method: "S256",
			state: STATE,
		});
	});

	it("adds screen_hint=signup for a signup", async () => {
		const { signIn, opened } = harness();

		await signIn.begin({ screenHint: "signup" });

		expect(new URL(opened[0] ?? "").searchParams.get("screen_hint")).toBe("signup");
	});

	it("reports unavailable metadata and opens nothing", async () => {
		const { signIn, opened } = harness({ server: async () => ({ kind: "unavailable", status: 503 }) });

		const result = await signIn.begin({ screenHint: "login" });

		expect(result).toEqual({ kind: "unavailable", status: 503 });
		expect(opened).toEqual([]);
	});

	it("replaces the pending sign-in, so the earlier state is refused", async () => {
		let bytes = 1;
		const opened: string[] = [];
		const signIn = initSignIn({
			sendHttp: async () => answer(200, GRANT_BODY),
			tokens: {
				isSignedIn: () => false,
				authorizedSend: async () => ({ kind: "signed-out" }),
				storeGrant: () => undefined,
				signOut: async () => undefined,
			},
			server: okServer,
			openInBrowser: (url) => {
				opened.push(url);
			},
			randomBytes: (length) => new Uint8Array(length).fill(bytes++),
		});
		await signIn.begin({ screenHint: "login" });
		const firstState = new URL(opened[0] ?? "").searchParams.get("state") ?? "";
		await signIn.begin({ screenHint: "login" });
		const secondState = new URL(opened[1] ?? "").searchParams.get("state") ?? "";

		expect(await signIn.complete({ code: "code-1", state: firstState })).toEqual({ kind: "state-mismatch" });
		expect(await signIn.complete({ code: "code-1", state: secondState })).toEqual({ kind: "signed-in" });
	});
});

describe("complete", () => {
	it("exchanges the code with the pending verifier, stores the grant and clears the pending sign-in", async () => {
		const { signIn, requests, grants } = harness();
		await signIn.begin({ screenHint: "login" });

		const outcome = await signIn.complete({ code: "code-1", state: STATE });

		expect(outcome).toEqual({ kind: "signed-in" });
		expect(grants).toEqual([{ accessToken: "access-1", refreshToken: "refresh-1" }]);
		expect(requests[0]?.url).toBe(TOKEN_URL);
		expect(requests[0]?.method).toBe("POST");
		expect(requests[0]?.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded" });
		expect(Object.fromEntries(new URLSearchParams(requests[0]?.body))).toEqual({
			grant_type: "authorization_code",
			code: "code-1",
			redirect_uri: OAUTH_REDIRECT_URI,
			client_id: "obsidian-plugin",
			code_verifier: VERIFIER,
		});
		expect(await signIn.complete({ code: "code-1", state: STATE })).toEqual({ kind: "no-pending-sign-in" });
	});

	it("refuses a handoff when nothing is pending", async () => {
		const { signIn, requests } = harness();

		expect(await signIn.complete({ code: "code-1", state: STATE })).toEqual({ kind: "no-pending-sign-in" });
		expect(requests).toEqual([]);
	});

	it("keeps the pending sign-in when the state differs", async () => {
		const { signIn, requests } = harness();
		await signIn.begin({ screenHint: "login" });

		expect(await signIn.complete({ code: "code-1", state: "forged" })).toEqual({ kind: "state-mismatch" });
		expect(requests).toEqual([]);
		expect(await signIn.complete({ code: "code-1", state: STATE })).toEqual({ kind: "signed-in" });
	});

	it("treats an absent state as a mismatch, even beside an error", async () => {
		const { signIn } = harness();
		await signIn.begin({ screenHint: "login" });

		expect(await signIn.complete({ error: "access_denied" })).toEqual({ kind: "state-mismatch" });
		expect(await signIn.complete({ code: "code-1", state: STATE })).toEqual({ kind: "signed-in" });
	});

	it("reports a denial and clears the pending sign-in", async () => {
		const { signIn, requests } = harness();
		await signIn.begin({ screenHint: "login" });

		expect(await signIn.complete({ error: "access_denied", state: STATE })).toEqual({ kind: "denied", error: "access_denied" });
		expect(requests).toEqual([]);
		expect(await signIn.complete({ code: "code-1", state: STATE })).toEqual({ kind: "no-pending-sign-in" });
	});

	it("reports the status of a refused exchange and clears the pending sign-in", async () => {
		const { signIn, grants } = harness({ exchange: () => answer(400, '{"error":"invalid_grant"}') });
		await signIn.begin({ screenHint: "login" });

		expect(await signIn.complete({ code: "code-1", state: STATE })).toEqual({ kind: "exchange-failed", status: 400 });
		expect(grants).toEqual([]);
		expect(await signIn.complete({ code: "code-1", state: STATE })).toEqual({ kind: "no-pending-sign-in" });
	});

	it('sends the "true" of a valueless code param to the exchange, which the server refuses', async () => {
		const { signIn, requests } = harness({ exchange: () => answer(400) });
		await signIn.begin({ screenHint: "login" });

		expect(await signIn.complete({ code: "true", state: STATE })).toEqual({ kind: "exchange-failed", status: 400 });
		expect(new URLSearchParams(requests[0]?.body).get("code")).toBe("true");
	});

	it("reports a handoff without a code as malformed, without posting", async () => {
		const { signIn, requests } = harness();
		await signIn.begin({ screenHint: "login" });

		expect(await signIn.complete({ state: STATE })).toEqual({ kind: "exchange-failed", status: "malformed" });
		expect(requests).toEqual([]);
	});

	it("reports a transport failure of the exchange as network", async () => {
		const { signIn } = harness({
			exchange: () => {
				throw new Error("offline");
			},
		});
		await signIn.begin({ screenHint: "login" });

		expect(await signIn.complete({ code: "code-1", state: STATE })).toEqual({ kind: "exchange-failed", status: "network" });
	});

	it("reports a 200 without tokens as malformed", async () => {
		const { signIn, grants } = harness({ exchange: () => answer(200, "{}") });
		await signIn.begin({ screenHint: "login" });

		expect(await signIn.complete({ code: "code-1", state: STATE })).toEqual({ kind: "exchange-failed", status: "malformed" });
		expect(grants).toEqual([]);
	});

	it("reports unavailable metadata and keeps the pending sign-in, so the same handoff can be tried again", async () => {
		let metadataUp = true;
		const { signIn } = harness({
			server: async () => (metadataUp ? okServer() : { kind: "unavailable", status: "network" }),
		});
		await signIn.begin({ screenHint: "login" });
		metadataUp = false;

		expect(await signIn.complete({ code: "code-1", state: STATE })).toEqual({ kind: "unavailable", status: "network" });
		metadataUp = true;
		expect(await signIn.complete({ code: "code-1", state: STATE })).toEqual({ kind: "signed-in" });
	});
});
