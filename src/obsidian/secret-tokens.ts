import type { SecretStorage } from "obsidian";
import type { SecretStore } from "../ports";

export function initSecretTokens(storage: Pick<SecretStorage, "getSecret" | "setSecret">): SecretStore {
	return {
		get: (id) => storage.getSecret(id),
		set: (id, value) => storage.setSecret(id, value),
	};
}
