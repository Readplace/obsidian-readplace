import { OAUTH_REDIRECT_URI, SECRET_IDS, SERVER_ORIGIN } from "./config";
import type { SecretId } from "./ports";

declare const global: object;

describe("config", () => {
	it("uses production when no build origin is supplied", () => {
		expect(SERVER_ORIGIN).toBe("https://readplace.com");
	});

	it("uses the supplied build origin for requests and the OAuth handoff", async () => {
		Reflect.set(global, "READPLACE_SERVER_ORIGIN", "http://127.0.0.1:3000");
		try {
			await jest.isolateModulesAsync(async () => {
				const config = await import("./config");

				expect(config.SERVER_ORIGIN).toBe("http://127.0.0.1:3000");
				expect(config.OAUTH_REDIRECT_URI).toBe("http://127.0.0.1:3000/oauth/obsidian");
			});
		} finally {
			Reflect.deleteProperty(global, "READPLACE_SERVER_ORIGIN");
		}
	});

	it("returns the handoff page on the server origin as the redirect URI", () => {
		expect(OAUTH_REDIRECT_URI).toBe(`${SERVER_ORIGIN}/oauth/obsidian`);
	});

	it("names each secret with an id the secret store accepts", () => {
		const ids: SecretId[] = [SECRET_IDS.accessToken, SECRET_IDS.refreshToken];

		expect(ids).toEqual(["readplace-access-token", "readplace-refresh-token"]);
	});
});
