import type { RandomBytes } from "../ports";

const VERIFIER_BYTES = 32;
const STATE_BYTES = 16;

export function base64Url(bytes: Uint8Array): string {
	const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function createVerifier(randomBytes: RandomBytes): string {
	return base64Url(randomBytes(VERIFIER_BYTES));
}

export async function challengeFor(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return base64Url(new Uint8Array(digest));
}

export function randomState(randomBytes: RandomBytes): string {
	return base64Url(randomBytes(STATE_BYTES));
}
