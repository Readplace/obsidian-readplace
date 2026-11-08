import { SECRET_IDS } from "../config";
import { initSecretTokens } from "./secret-tokens";

function fakeSecretStorage() {
	const secrets = new Map<string, string>();
	return {
		secrets,
		getSecret: (id: string) => secrets.get(id) ?? null,
		setSecret: (id: string, secret: string) => {
			secrets.set(id, secret);
		},
	};
}

describe("initSecretTokens", () => {
	it("writes a secret under its id and reads it back", () => {
		const storage = fakeSecretStorage();
		const store = initSecretTokens(storage);

		store.set(SECRET_IDS.accessToken, "access-1");

		expect(store.get(SECRET_IDS.accessToken)).toBe("access-1");
		expect([...storage.secrets]).toEqual([["readplace-access-token", "access-1"]]);
	});

	it("reads a secret never written as null", () => {
		expect(initSecretTokens(fakeSecretStorage()).get(SECRET_IDS.refreshToken)).toBeNull();
	});

	it("clears a secret by writing an empty string, since the storage has no delete", () => {
		const storage = fakeSecretStorage();
		const store = initSecretTokens(storage);
		store.set(SECRET_IDS.refreshToken, "refresh-1");

		store.set(SECRET_IDS.refreshToken, "");

		expect(store.get(SECRET_IDS.refreshToken)).toBe("");
	});
});
