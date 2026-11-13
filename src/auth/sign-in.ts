import { z } from "zod";
import { OAUTH_CLIENT_ID, OAUTH_REDIRECT_URI } from "../config";
import type { HttpResponse, OpenInBrowser, RandomBytes, SendHttp } from "../ports";
import type { AuthorizationServerResult } from "./authorization-server";
import { challengeFor, createVerifier, randomState } from "./pkce";
import { parseGrant, type TokenClient } from "./tokens";

type FailureStatus = number | "network" | "malformed";

export type SignInOutcome =
	| { kind: "signed-in" }
	| { kind: "denied"; error: string }
	| { kind: "no-pending-sign-in" }
	| { kind: "state-mismatch" }
	| { kind: "exchange-failed"; status: FailureStatus }
	| { kind: "unavailable"; status: FailureStatus };

export interface SignIn {
	prepare(): Promise<void>;
	begin(options: { screenHint: "login" | "signup" }): Promise<{ kind: "opened" } | { kind: "unavailable"; status: FailureStatus }>;
	complete(params: Record<string, string>): Promise<SignInOutcome>;
}

type Prepared = { kind: "ready"; authorizeUrl: string; verifier: string; state: string } | { kind: "unavailable"; status: FailureStatus };

const HandoffParams = z.object({
	code: z.string().optional(),
	state: z.string().optional(),
	error: z.string().optional(),
});

export function initSignIn(deps: {
	sendHttp: SendHttp;
	tokens: TokenClient;
	server: () => Promise<AuthorizationServerResult>;
	openInBrowser: OpenInBrowser;
	randomBytes: RandomBytes;
}): SignIn {
	let pending: { verifier: string; state: string } | undefined;
	let prepared: Prepared | undefined;
	let preparing: Promise<Prepared> | undefined;

	const build = async (): Promise<Prepared> => {
		const found = await deps.server();
		if (found.kind !== "ok") return found;

		const verifier = createVerifier(deps.randomBytes);
		const state = randomState(deps.randomBytes);
		const authorizeUrl = new URL(found.server.authorizationEndpoint);
		authorizeUrl.searchParams.set("client_id", OAUTH_CLIENT_ID);
		authorizeUrl.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI);
		authorizeUrl.searchParams.set("response_type", "code");
		authorizeUrl.searchParams.set("code_challenge", await challengeFor(verifier));
		authorizeUrl.searchParams.set("code_challenge_method", "S256");
		authorizeUrl.searchParams.set("state", state);
		return { kind: "ready", authorizeUrl: authorizeUrl.toString(), verifier, state };
	};

	const prepare = (): Promise<Prepared> => {
		preparing ??= build()
			.catch((): Prepared => ({ kind: "unavailable", status: "malformed" }))
			.then((next) => {
				prepared = next;
				preparing = undefined;
				return next;
			});
		return preparing;
	};

	const open = (ready: Prepared, screenHint: "login" | "signup"): { kind: "opened" } | { kind: "unavailable"; status: FailureStatus } => {
		if (ready.kind !== "ready") return ready;
		const authorizeUrl = new URL(ready.authorizeUrl);
		if (screenHint === "signup") authorizeUrl.searchParams.set("screen_hint", "signup");
		pending = { verifier: ready.verifier, state: ready.state };
		deps.openInBrowser(authorizeUrl.toString());
		void prepare();
		return { kind: "opened" };
	};

	const begin: SignIn["begin"] = async ({ screenHint }) => {
		const ready = prepared;
		prepared = undefined;
		if (ready?.kind === "ready") return open(ready, screenHint);
		const next = await prepare();
		prepared = undefined;
		return open(next, screenHint);
	};

	const exchange = async (options: { tokenEndpoint: string; code: string; verifier: string }): Promise<SignInOutcome> => {
		let response: HttpResponse;
		try {
			response = await deps.sendHttp({
				url: options.tokenEndpoint,
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "authorization_code",
					code: options.code,
					redirect_uri: OAUTH_REDIRECT_URI,
					client_id: OAUTH_CLIENT_ID,
					code_verifier: options.verifier,
				}).toString(),
			});
		} catch {
			return { kind: "exchange-failed", status: "network" };
		}
		if (response.status !== 200) return { kind: "exchange-failed", status: response.status };

		const grant = parseGrant(response.text);
		if (grant === undefined) return { kind: "exchange-failed", status: "malformed" };
		deps.tokens.storeGrant(grant);
		return { kind: "signed-in" };
	};

	const complete: SignIn["complete"] = async (params) => {
		const { code, state, error } = HandoffParams.parse(params);
		if (pending === undefined) return { kind: "no-pending-sign-in" };
		if (state !== pending.state) return { kind: "state-mismatch" };
		if (error !== undefined) {
			pending = undefined;
			return { kind: "denied", error };
		}

		const { verifier } = pending;
		const found = await deps.server();
		if (found.kind !== "ok") return found;

		pending = undefined;
		if (code === undefined) return { kind: "exchange-failed", status: "malformed" };
		return exchange({ tokenEndpoint: found.server.tokenEndpoint, code, verifier });
	};

	return {
		prepare: async () => {
			await prepare();
		},
		begin,
		complete,
	};
}
