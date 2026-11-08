const MAX_BASE_NAME_LENGTH = 100;
const MAX_BASE_NAME_BYTES = 200;
const UNSAFE_IN_NOTE_NAME = /[\\/:*?"<>|#^[\]]|%%/g;

function cleanName(raw: string): string {
	const collapsed = raw.replace(UNSAFE_IN_NOTE_NAME, " ").replace(/\s+/g, " ").trim();
	const visible = collapsed.replace(/^\.+/, "");
	const characters = Array.from(visible).slice(0, MAX_BASE_NAME_LENGTH);
	while (new TextEncoder().encode(characters.join("")).length > MAX_BASE_NAME_BYTES) characters.pop();
	return characters.join("").trim();
}

export function noteBaseName(input: { title: string; siteName: string; id: string }): string {
	return cleanName(input.title) || cleanName(input.siteName) || input.id;
}

export function notePath(input: { folder: string; baseName: string; suffix: number }): string {
	const folder = input.folder.replace(/\/+$/, "");
	const prefix = folder === "" ? "" : `${folder}/`;
	const numbering = input.suffix === 1 ? "" : ` (${input.suffix})`;
	return `${prefix}${input.baseName}${numbering}.md`;
}
