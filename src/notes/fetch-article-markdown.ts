import type { TokenClient } from "../auth/tokens";
import { MARKDOWN_MEDIA_TYPE } from "../config";
import { headerOf, mediaTypeOf } from "../http/headers";

export type MarkdownOutcome =
	| { kind: "document"; markdown: string; complete: boolean }
	| { kind: "unsupported-type"; mediaType: string }
	| { kind: "not-found" }
	| { kind: "skipped"; status: number }
	| { kind: "signed-out" }
	| { kind: "unavailable"; reason: "network" | "rate-limited" | "server" | "unauthorized"; status?: number };

const LEADING_FRONTMATTER = /^---\n([\s\S]*?)\n---(?:\n|$)/;
const STILL_ARRIVING = /^(?:readplace_content_status: processing|readplace_summary_status: pending)$/m;

export function isCompleteDocument(markdown: string): boolean {
	const frontmatter = LEADING_FRONTMATTER.exec(markdown)?.[1];
	return frontmatter === undefined || !STILL_ARRIVING.test(frontmatter);
}

export async function fetchArticleMarkdown(deps: { tokens: TokenClient; readHref: string }): Promise<MarkdownOutcome> {
	const result = await deps.tokens.authorizedSend({ url: deps.readHref, method: "GET", headers: { Accept: MARKDOWN_MEDIA_TYPE } });
	if (result.kind !== "response") return result;
	const { status, headers, text } = result.response;
	if (status === 401) return { kind: "unavailable", reason: "unauthorized", status };
	if (status === 429) return { kind: "unavailable", reason: "rate-limited", status };
	if (status === 404) return { kind: "not-found" };
	if (status !== 200) return { kind: "skipped", status };
	const mediaType = mediaTypeOf(headerOf(headers, "Content-Type"));
	if (mediaType !== MARKDOWN_MEDIA_TYPE) return { kind: "unsupported-type", mediaType };
	return { kind: "document", markdown: text, complete: isCompleteDocument(text) };
}
