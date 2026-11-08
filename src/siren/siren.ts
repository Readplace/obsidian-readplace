import { z } from "zod";
import { resolveHref } from "./resolve-href";

export const ScopeEntrySchema = z.object({ label: z.string(), rel: z.string(), href: z.string() });
export type ScopeEntry = z.infer<typeof ScopeEntrySchema>;

export const LinkSchema = z.object({ rel: z.array(z.string()), href: z.string() });

export const ArticleEntitySchema = z.object({
	class: z.array(z.string()),
	properties: z.object({
		id: z.string(),
		title: z.string(),
		siteName: z.string().nullish(),
		status: z.string(),
		readAt: z.string().nullish(),
		contentVersion: z.string().optional(),
	}),
	links: z.array(z.unknown()).optional(),
});
type ArticleEntity = z.infer<typeof ArticleEntitySchema>;

export const CollectionSchema = z.object({
	class: z.array(z.string()),
	properties: z.object({ tabs: z.array(z.unknown()).optional(), readlists: z.array(z.unknown()).optional() }),
	entities: z.array(z.unknown()).optional(),
	links: z.array(z.unknown()).optional(),
});

export interface ListedArticle {
	id: string;
	title: string;
	siteName: string;
	status: string;
	readAt: string | null;
	contentVersion: string;
	readHref: string | undefined;
}

export interface SirenCollection {
	tabs: ScopeEntry[];
	readlists: ScopeEntry[];
	articles: ListedArticle[];
	nextHref: string | undefined;
}

function parseEach<T>(input: { items: unknown[] | undefined; schema: z.ZodType<T> }): T[] {
	return (input.items ?? []).flatMap((item) => {
		const parsed = input.schema.safeParse(item);
		return parsed.success ? [parsed.data] : [];
	});
}

function hrefOfRel(input: { links: unknown[] | undefined; rel: string; base: string }): string | undefined {
	const link = parseEach({ items: input.links, schema: LinkSchema }).find((candidate) => candidate.rel.includes(input.rel));
	return link === undefined ? undefined : resolveHref({ href: link.href, base: input.base });
}

function resolvedEntries(input: { items: unknown[] | undefined; base: string }): ScopeEntry[] {
	return parseEach({ items: input.items, schema: ScopeEntrySchema }).flatMap((entry) => {
		const href = resolveHref({ href: entry.href, base: input.base });
		return href === undefined ? [] : [{ ...entry, href }];
	});
}

function toListedArticle(input: { entity: ArticleEntity; base: string }): ListedArticle {
	const { properties, links } = input.entity;
	return {
		id: properties.id,
		title: properties.title,
		siteName: properties.siteName ?? "",
		status: properties.status,
		readAt: properties.readAt ?? null,
		contentVersion: properties.contentVersion ?? "",
		readHref: hrefOfRel({ links, rel: "read", base: input.base }),
	};
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

export function parseCollection(input: { text: string; base: string }): SirenCollection | undefined {
	const { base } = input;
	const parsed = CollectionSchema.safeParse(parseJson(input.text));
	if (!parsed.success || !parsed.data.class.includes("collection")) return undefined;
	const { properties, entities, links } = parsed.data;
	return {
		tabs: resolvedEntries({ items: properties.tabs, base }),
		readlists: resolvedEntries({ items: properties.readlists, base }),
		articles: parseEach({ items: entities, schema: ArticleEntitySchema })
			.filter((entity) => entity.class.includes("article"))
			.map((entity) => toListedArticle({ entity, base })),
		nextHref: hrefOfRel({ links, rel: "next", base }),
	};
}
