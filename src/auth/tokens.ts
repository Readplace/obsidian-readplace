import { z } from "zod";
import { OAUTH_CLIENT_ID, SECRET_IDS } from "../config";
import { parseJsonBody } from "../http/json-body";
import type { HttpRequest, HttpResponse, SecretStore, SendHttp } from "../ports";
import type { AuthorizationServerResult } from "./authorization-server";

export type AuthorizedResult =
	| { kind: "response"; response: HttpResponse }
	| { kind: "signed-out" }
	| { kind: "unavailable"; reason: "network" | "rate-limited" | "server"; status?: number };

export interface TokenClient {
	isSignedIn(): boolean;
	authorizedSend(request: Omit<HttpRequest, "headers"> & { headers?: Record<string, string> }): Promise<AuthorizedResult>;
	storeGrant(grant: { accessToken: string; refreshToken: string }): void;
	signOut(): Promise<void>;
}

type Unavailable = Extract<AuthorizedResult, { kind: "unavailable" }>;
type RefreshOutcome = { kind: "refreshed"; accessToken: string } | { kind: "signed-out" } | Unavailable;

const Grant = z.object({ access_token: z.string(), refresh_token: z.string() });

export function parseGrant(text: string): { accessToken: string; refreshToken: string } | undefined {
	const grant = parseJsonBody(Grant, text);
	return grant && { accessToken: grant.access_token, refreshToken: grant.refresh_token };
}

function unavailableFor(status: number | "network" | "malformed"): Unavailable {
	if (status === "network") return { kind: "unavailable", reason: "network" };
	if (status === "malformed") return { kind: "unavailable", reason: "server" };
	if (status === 429) return { kind: "unavailable", reason: "rate-limited" };
	return { kind: "unavailable", reason: "server", status };
}

export function initTokenClient(deps: {
	sendHttp: SendHttp;
	secrets: SecretStore;
	server: () => Promise<AuthorizationServerResult>;
}): TokenClient {
	const storeGrant: TokenClient["storeGrant"] = ({ accessToken, refreshToken }) => {
		deps.secrets.set(SECRET_IDS.accessToken, accessToken);
		deps.secrets.set(SECRET_IDS.refreshToken, refreshToken);
	};

	const clearSecrets = () => {
		storeGrant({ accessToken: "", refreshToken: "" });
	};

	const exchangeRefreshToken = async (options: { tokenEndpoint: string; refreshToken: string }): Promise<RefreshOutcome> => {
		let response: HttpResponse;
		try {
			response = await deps.sendHttp({
				url: options.tokenEndpoint,
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "refresh_token",
					refresh_token: options.refreshToken,
					client_id: OAUTH_CLIENT_ID,
				}).toString(),
			});
		} catch {
			return unavailableFor("network");
		}
		if (response.status === 400) {
			clearSecrets();
			return { kind: "signed-out" };
		}
		if (response.status !== 200) return unavailableFor(response.status);

		const grant = parseGrant(response.text);
		if (grant === undefined) return unavailableFor(response.status);
		if (deps.secrets.get(SECRET_IDS.refreshToken) !== options.refreshToken) return { kind: "signed-out" };
		storeGrant(grant);
		return { kind: "refreshed", accessToken: grant.accessToken };
	};

	const refresh = async (): Promise<RefreshOutcome> => {
		const refreshToken = deps.secrets.get(SECRET_IDS.refreshToken);
		if (!refreshToken) {
			clearSecrets();
			return { kind: "signed-out" };
		}
		const found = await deps.server();
		if (found.kind !== "ok") return unavailableFor(found.status);
		return exchangeRefreshToken({ tokenEndpoint: found.server.tokenEndpoint, refreshToken });
	};

	let refreshing: Promise<RefreshOutcome> | undefined;

	const refreshOnce = (): Promise<RefreshOutcome> => {
		refreshing ??= refresh().finally(() => {
			refreshing = undefined;
		});
		return refreshing;
	};

	const sendWithToken = async (options: {
		request: Parameters<TokenClient["authorizedSend"]>[0];
		accessToken: string;
	}): Promise<AuthorizedResult> => {
		try {
			const response = await deps.sendHttp({
				...options.request,
				headers: { ...options.request.headers, Authorization: `Bearer ${options.accessToken}` },
			});
			return { kind: "response", response };
		} catch {
			return unavailableFor("network");
		}
	};

	const authorizedSend: TokenClient["authorizedSend"] = async (request) => {
		const accessToken = deps.secrets.get(SECRET_IDS.accessToken);
		if (!accessToken) return { kind: "signed-out" };

		const first = await sendWithToken({ request, accessToken });
		if (first.kind !== "response" || first.response.status !== 401) return first;

		const refreshed = await refreshOnce();
		if (refreshed.kind !== "refreshed") return refreshed;
		return sendWithToken({ request, accessToken: refreshed.accessToken });
	};

	const revoke = async (refreshToken: string): Promise<void> => {
		const found = await deps.server();
		if (found.kind !== "ok") return;
		await deps.sendHttp({
			url: found.server.revocationEndpoint,
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: refreshToken, client_id: OAUTH_CLIENT_ID }),
		});
	};

	const signOut: TokenClient["signOut"] = async () => {
		const refreshToken = deps.secrets.get(SECRET_IDS.refreshToken);
		if (refreshToken) await revoke(refreshToken).catch(() => undefined);
		clearSecrets();
	};

	const isSignedIn: TokenClient["isSignedIn"] = () =>
		Boolean(deps.secrets.get(SECRET_IDS.accessToken) || deps.secrets.get(SECRET_IDS.refreshToken));

	return { isSignedIn, authorizedSend, storeGrant, signOut };
}
