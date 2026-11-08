import type { z } from "zod";

export function parseJsonBody<T>(schema: z.ZodType<T>, text: string): T | undefined {
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return undefined;
	}
	const parsed = schema.safeParse(body);
	return parsed.success ? parsed.data : undefined;
}
