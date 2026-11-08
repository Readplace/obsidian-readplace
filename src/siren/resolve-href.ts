const WEB_URL = /^https?:\/\//i;
const ANY_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

export function resolveHref(input: { href: string; base: string }): string | undefined {
	if (WEB_URL.test(input.href)) return input.href;
	if (ANY_SCHEME.test(input.href)) return undefined;
	try {
		return new URL(input.href, input.base).toString();
	} catch {
		return undefined;
	}
}
