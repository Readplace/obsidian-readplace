export function headerOf(headers: Record<string, string>, name: string): string | undefined {
	const wanted = name.toLowerCase();
	const match = Object.entries(headers).find(([key]) => key.toLowerCase() === wanted);
	return match?.[1];
}

export function mediaTypeOf(contentType: string | undefined): string {
	if (contentType === undefined) return "";
	return contentType.replace(/;.*$/, "").trim().toLowerCase();
}
