import type { HttpRequest, SendHttp } from "../ports";
import { fetchAuthorizationServer } from "./authorization-server";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

const answering = (status: number, text: string): SendHttp => async () => ({ status, headers: JSON_HEADERS, text });

const METADATA = JSON.stringify({
	issuer: "https://readplace.com",
	authorization_endpoint: "https://readplace.com/oauth/authorize",
	token_endpoint: "https://readplace.com/oauth/token",
	revocation_endpoint: "https://readplace.com/oauth/revoke",
});

describe("fetchAuthorizationServer", () => {
	it("reads the three endpoints from the well-known document and lets unknown keys pass", async () => {
		const requests: HttpRequest[] = [];
		const sendHttp: SendHttp = async (request) => {
			requests.push(request);
			return { status: 200, headers: JSON_HEADERS, text: METADATA };
		};

		const result = await fetchAuthorizationServer({ sendHttp, origin: "https://readplace.com" });

		expect(result).toEqual({
			kind: "ok",
			server: {
				authorizationEndpoint: "https://readplace.com/oauth/authorize",
				tokenEndpoint: "https://readplace.com/oauth/token",
				revocationEndpoint: "https://readplace.com/oauth/revoke",
			},
		});
		expect(requests.map(({ url, method }) => ({ url, method }))).toEqual([
			{ url: "https://readplace.com/.well-known/oauth-authorization-server", method: "GET" },
		]);
	});

	it("reports a status other than 200", async () => {
		const result = await fetchAuthorizationServer({ sendHttp: answering(503, ""), origin: "https://readplace.com" });

		expect(result).toEqual({ kind: "unavailable", status: 503 });
	});

	it("reports a transport failure as network", async () => {
		const sendHttp: SendHttp = async () => {
			throw new Error("offline");
		};

		const result = await fetchAuthorizationServer({ sendHttp, origin: "https://readplace.com" });

		expect(result).toEqual({ kind: "unavailable", status: "network" });
	});

	it("treats a 200 that is not JSON by media type as malformed", async () => {
		const sendHttp: SendHttp = async () => ({ status: 200, headers: { "Content-Type": "text/html" }, text: METADATA });

		const result = await fetchAuthorizationServer({ sendHttp, origin: "https://readplace.com" });

		expect(result).toEqual({ kind: "unavailable", status: "malformed" });
	});

	it.each([
		["text that is not JSON", "<html>"],
		["JSON without the endpoints", '{"issuer":"https://readplace.com"}'],
	])("reports %s as malformed", async (_case, text) => {
		const result = await fetchAuthorizationServer({ sendHttp: answering(200, text), origin: "https://readplace.com" });

		expect(result).toEqual({ kind: "unavailable", status: "malformed" });
	});
});
