import type { TokenClient } from "../auth/tokens";
import { MAX_REDIRECT_HOPS, SIREN_MEDIA_TYPE } from "../config";
import { headerOf, mediaTypeOf } from "../http/headers";
import type { HttpResponse } from "../ports";
import { resolveHref } from "./resolve-href";
import { parseCollection, type SirenCollection } from "./siren";

export type FetchOutcome =
	| { kind: "collection"; collection: SirenCollection }
	| { kind: "not-siren"; status: number; mediaType: string }
	| { kind: "signed-out" }
	| { kind: "unavailable"; reason: "network" | "rate-limited" | "server" | "unauthorized" | "too-many-redirects"; status?: number };

function redirectTarget(input: { response: HttpResponse; url: string }): string | undefined {
	const { status, headers } = input.response;
	if (status < 300 || status >= 400) return undefined;
	const location = headerOf(headers, "Location");
	return location === undefined ? undefined : resolveHref({ href: location, base: input.url });
}

function classify(input: { response: HttpResponse; url: string }): FetchOutcome {
	const { status, headers, text } = input.response;
	if (status === 401) return { kind: "unavailable", reason: "unauthorized", status };
	if (status === 429) return { kind: "unavailable", reason: "rate-limited", status };
	const mediaType = mediaTypeOf(headerOf(headers, "Content-Type"));
	const collection = status === 200 && mediaType === SIREN_MEDIA_TYPE ? parseCollection({ text, base: input.url }) : undefined;
	return collection === undefined ? { kind: "not-siren", status, mediaType } : { kind: "collection", collection };
}

export async function fetchCollection(deps: { tokens: TokenClient; url: string }): Promise<FetchOutcome> {
	let url = deps.url;
	for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
		const result = await deps.tokens.authorizedSend({ url, method: "GET", headers: { Accept: SIREN_MEDIA_TYPE } });
		if (result.kind !== "response") return result;
		const target = redirectTarget({ response: result.response, url });
		if (target === undefined) return classify({ response: result.response, url });
		url = target;
	}
	return { kind: "unavailable", reason: "too-many-redirects" };
}

export async function* walkPages(deps: {
	tokens: TokenClient;
	firstPageUrl: string;
}): AsyncGenerator<SirenCollection, { stopped: FetchOutcome | undefined }> {
	let url: string | undefined = deps.firstPageUrl;
	while (url !== undefined) {
		const outcome: FetchOutcome = await fetchCollection({ tokens: deps.tokens, url });
		if (outcome.kind !== "collection") return { stopped: outcome };
		yield outcome.collection;
		url = outcome.collection.nextHref;
	}
	return { stopped: undefined };
}
