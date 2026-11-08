import { z } from "zod";
import { AUTHORIZATION_SERVER_METADATA_PATH } from "../config";
import { headerOf, mediaTypeOf } from "../http/headers";
import { parseJsonBody } from "../http/json-body";
import type { HttpResponse, SendHttp } from "../ports";

export interface AuthorizationServer {
	authorizationEndpoint: string;
	tokenEndpoint: string;
	revocationEndpoint: string;
}

export type AuthorizationServerResult =
	| { kind: "ok"; server: AuthorizationServer }
	| { kind: "unavailable"; status: number | "network" | "malformed" };

const Metadata = z.object({
	authorization_endpoint: z.string(),
	token_endpoint: z.string(),
	revocation_endpoint: z.string(),
});

export async function fetchAuthorizationServer(deps: { sendHttp: SendHttp; origin: string }): Promise<AuthorizationServerResult> {
	let response: HttpResponse;
	try {
		response = await deps.sendHttp({
			url: `${deps.origin}${AUTHORIZATION_SERVER_METADATA_PATH}`,
			method: "GET",
			headers: { Accept: "application/json" },
		});
	} catch {
		return { kind: "unavailable", status: "network" };
	}
	if (response.status !== 200) return { kind: "unavailable", status: response.status };
	if (mediaTypeOf(headerOf(response.headers, "Content-Type")) !== "application/json") return { kind: "unavailable", status: "malformed" };

	const metadata = parseJsonBody(Metadata, response.text);
	if (metadata === undefined) return { kind: "unavailable", status: "malformed" };
	return {
		kind: "ok",
		server: {
			authorizationEndpoint: metadata.authorization_endpoint,
			tokenEndpoint: metadata.token_endpoint,
			revocationEndpoint: metadata.revocation_endpoint,
		},
	};
}
