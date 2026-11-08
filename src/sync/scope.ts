import type { TokenClient } from "../auth/tokens";
import type { ListedArticle, ScopeEntry, SirenCollection } from "../siren/siren";
import { fetchCollection, type FetchOutcome, walkPages } from "../siren/walk-collection";

export type FatalOutcome = Extract<FetchOutcome, { kind: "signed-out" | "unavailable" }>;

export interface WalkedArticles {
	articles: ListedArticle[];
	collectionsStopped: FetchOutcome[];
	fatal: FatalOutcome | undefined;
}

function isFatal(outcome: FetchOutcome): outcome is FatalOutcome {
	return outcome.kind === "signed-out" || outcome.kind === "unavailable";
}

export async function walkEverySave(deps: { tokens: TokenClient; origin: string }): Promise<WalkedArticles> {
	const { tokens } = deps;
	const firstSeen = new Map<string, ListedArticle>();
	const collectionsStopped: FetchOutcome[] = [];

	const keepFirstSeen = (page: SirenCollection) => {
		for (const article of page.articles) {
			if (!firstSeen.has(article.id)) firstSeen.set(article.id, article);
		}
	};

	const stop = (outcome: FetchOutcome): FatalOutcome | undefined => {
		if (isFatal(outcome)) return outcome;
		collectionsStopped.push(outcome);
		return undefined;
	};

	const openEntry = (input: { entry: ScopeEntry; inHand: FetchOutcome }): Promise<FetchOutcome> | FetchOutcome =>
		input.entry.rel === "current" ? input.inHand : fetchCollection({ tokens, url: input.entry.href });

	const walkTab = async (firstPage: SirenCollection): Promise<FatalOutcome | undefined> => {
		keepFirstSeen(firstPage);
		if (firstPage.nextHref === undefined) return undefined;
		const laterPages = walkPages({ tokens, firstPageUrl: firstPage.nextHref });
		for (;;) {
			const step = await laterPages.next();
			if (step.done) return step.value.stopped === undefined ? undefined : stop(step.value.stopped);
			keepFirstSeen(step.value);
		}
	};

	const walkReadlist = async (readlist: SirenCollection, inHand: FetchOutcome): Promise<FatalOutcome | undefined> => {
		for (const tab of readlist.tabs) {
			const opened = await openEntry({ entry: tab, inHand });
			const fatal = opened.kind === "collection" ? await walkTab(opened.collection) : stop(opened);
			if (fatal !== undefined) return fatal;
		}
		return undefined;
	};

	const walkRoot = async (): Promise<FatalOutcome | undefined> => {
		const root = await fetchCollection({ tokens, url: `${deps.origin}/` });
		if (root.kind !== "collection") return stop(root);
		for (const entry of root.collection.readlists) {
			const opened = await openEntry({ entry, inHand: root });
			const fatal = opened.kind === "collection" ? await walkReadlist(opened.collection, opened) : stop(opened);
			if (fatal !== undefined) return fatal;
		}
		return undefined;
	};

	const fatal = await walkRoot();
	return { articles: [...firstSeen.values()], collectionsStopped, fatal };
}
