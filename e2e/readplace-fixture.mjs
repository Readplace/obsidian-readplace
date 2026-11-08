import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const SIREN = "application/vnd.siren+json";
const CLIENT_ID = "obsidian-plugin";

function escapeHtml(value) {
	return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function randomValue() {
	return randomBytes(32).toString("base64url");
}

async function requestBody(request) {
	let body = "";
	for await (const chunk of request) {
		body += chunk;
		if (body.length > 65_536) throw new Error("Request body exceeds fixture limit");
	}
	return body;
}

export async function startReadplaceFixture({ port = 0, pageSize = 2, accessTokenLifetimeSeconds = 3600 } = {}) {
	if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error("pageSize must be a positive integer");
	if (!Number.isFinite(accessTokenLifetimeSeconds) || accessTokenLifetimeSeconds <= 0) throw new Error("accessTokenLifetimeSeconds must be positive");
	const articles = [];
	const requests = [];
	const grantCounts = { authorization_code: 0, refresh_token: 0, revocation: 0 };
	const approvals = new Map();
	const codes = new Map();
	const accessTokens = new Map();
	const refreshTokens = new Map();
	const grants = new Set();
	const failures = [];
	let origin;
	let tokenLifetimeSeconds = accessTokenLifetimeSeconds;

	const send = (response, status, body, contentType = "application/json", headers = {}) => {
		response.writeHead(status, { "Content-Type": `${contentType}; charset=utf-8`, "Cache-Control": "no-store", ...headers });
		response.end(typeof body === "string" ? body : JSON.stringify(body));
	};

	const redirect = (response, location) => send(response, 303, "", "text/plain", { Location: location });
	const oauthError = (response, error = "invalid_grant") => send(response, 400, { error });
	const issueTokens = (response, grant) => {
		const accessToken = randomValue();
		const refreshToken = randomValue();
		accessTokens.set(accessToken, { grant, expiresAt: Date.now() + tokenLifetimeSeconds * 1000 });
		refreshTokens.set(refreshToken, grant);
		send(response, 200, { access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: tokenLifetimeSeconds });
	};

	const authorized = (request) => {
		const authorization = request.headers.authorization;
		if (!authorization?.startsWith("Bearer ")) return false;
		const token = accessTokens.get(authorization.slice(7));
		return token !== undefined && !token.grant.revoked && token.expiresAt > Date.now();
	};

	const collection = (url) => {
		const all = url.searchParams.get("status") === "all";
		const selected = all ? articles : articles.filter((article) => (article.status ?? "unread") !== "read");
		const cursor = url.searchParams.get("cursor");
		const offset = cursor === null ? 0 : Number(Buffer.from(cursor, "base64url").toString());
		if (!Number.isInteger(offset) || offset < 0) return undefined;
		const page = selected.slice(offset, offset + pageSize);
		const links = [{ rel: ["self"], href: `${url.pathname}${url.search}` }];
		if (offset + pageSize < selected.length) {
			const next = Buffer.from(String(offset + pageSize)).toString("base64url");
			links.push({ rel: ["next"], href: `/queue?status=${all ? "all" : "unread"}&cursor=${next}` });
		}
		return {
			class: ["collection", "articles"],
			properties: {
				pageSize,
				tabs: [{ label: "All", rel: all ? "current" : "tab", href: "/queue?status=all" }],
				readlists: [{ label: "All", rel: "current", href: "/queue" }],
				total: { label: `${selected.length} articles` },
			},
			entities: page.map((article) => ({
				class: ["article"],
				rel: ["item"],
				properties: {
					id: article.id,
					title: article.title,
					siteName: article.siteName ?? "Fixture publication",
					status: article.status ?? "unread",
					readAt: article.readAt ?? null,
					contentVersion: article.contentVersion ?? "1",
				},
				links: [{ rel: ["read"], href: `/queue/${encodeURIComponent(article.id)}/view` }],
			})),
			links,
		};
	};

	const handle = async (request, response) => {
		const url = new URL(request.url, origin);
		requests.push({ method: request.method, path: url.pathname, hasAuthorization: Boolean(request.headers.authorization) });
		const failureIndex = failures.findIndex((failure) => failure.path === url.pathname && (failure.method ?? "GET") === request.method);
		if (failureIndex !== -1) {
			const [failure] = failures.splice(failureIndex, 1);
			if (failure.disconnect) {
				request.socket.destroy();
				return;
			}
			send(response, failure.status ?? 503, failure.body ?? { error: "fixture_failure" }, failure.contentType ?? "application/json", failure.headers);
			return;
		}

		if (request.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
			send(response, 200, {
				issuer: origin,
				authorization_endpoint: `${origin}/oauth/authorize`,
				token_endpoint: `${origin}/oauth/token`,
				revocation_endpoint: `${origin}/oauth/revoke`,
				response_types_supported: ["code"],
				grant_types_supported: ["authorization_code", "refresh_token"],
				code_challenge_methods_supported: ["S256"],
				token_endpoint_auth_methods_supported: ["none"],
			});
			return;
		}

		if (request.method === "GET" && url.pathname === "/oauth/authorize") {
			const params = url.searchParams;
			if (params.get("client_id") !== CLIENT_ID || params.get("redirect_uri") !== `${origin}/oauth/obsidian` || params.get("response_type") !== "code" || params.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(params.get("code_challenge") ?? "") || !params.get("state")) {
				oauthError(response, "invalid_request");
				return;
			}
			const approval = randomValue();
			approvals.set(approval, { challenge: params.get("code_challenge"), state: params.get("state"), redirectUri: params.get("redirect_uri"), expiresAt: Date.now() + 300_000 });
			send(response, 200, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Connect Readplace for Obsidian</title></head><body><main><h1>Connect Readplace for Obsidian</h1><p>Allow Readplace for Obsidian to copy saved articles into this test vault.</p><form method="post" action="/oauth/authorize"><input type="hidden" name="approval" value="${approval}"><button name="decision" value="approve">Approve</button><button name="decision" value="cancel">Cancel</button></form></main></body></html>`, "text/html");
			return;
		}

		if (request.method === "POST" && url.pathname === "/oauth/authorize") {
			const params = new URLSearchParams(await requestBody(request));
			const approval = approvals.get(params.get("approval"));
			approvals.delete(params.get("approval"));
			if (!approval || approval.expiresAt <= Date.now()) {
				oauthError(response, "invalid_request");
				return;
			}
			const handoff = new URL("/oauth/obsidian", origin);
			handoff.searchParams.set("state", approval.state);
			if (params.get("decision") === "approve") {
				const code = randomValue();
				codes.set(code, approval);
				handoff.searchParams.set("code", code);
			} else {
				handoff.searchParams.set("error", "access_denied");
			}
			redirect(response, `${handoff.pathname}${handoff.search}`);
			return;
		}

		if (request.method === "GET" && url.pathname === "/oauth/obsidian") {
			const params = url.searchParams;
			if (!params.get("code") && !params.get("error")) {
				send(response, 400, "This link is incomplete.", "text/plain");
				return;
			}
			const handoff = new URL("obsidian://readplace-auth");
			for (const name of ["code", "state", "error"]) {
				if (params.has(name)) handoff.searchParams.set(name, params.get(name));
			}
			const title = params.has("error") ? "Sign-in cancelled" : "Sign-in approved";
			send(response, 200, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>${title}</title></head><body><main><h1>${title}</h1><a href="${escapeHtml(handoff.href)}">Return to Obsidian</a></main></body></html>`, "text/html", { "Referrer-Policy": "no-referrer" });
			return;
		}

		if (request.method === "POST" && url.pathname === "/oauth/token") {
			const params = new URLSearchParams(await requestBody(request));
			const type = params.get("grant_type");
			if (type === "authorization_code" || type === "refresh_token") grantCounts[type] += 1;
			if (params.get("client_id") !== CLIENT_ID) {
				oauthError(response, "invalid_client");
				return;
			}
			if (type === "authorization_code") {
				const code = codes.get(params.get("code"));
				const verifier = params.get("code_verifier") ?? "";
				const challenge = createHash("sha256").update(verifier).digest("base64url");
				if (!code || code.expiresAt <= Date.now() || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || challenge !== code.challenge || params.get("redirect_uri") !== code.redirectUri) {
					oauthError(response);
					return;
				}
				codes.delete(params.get("code"));
				const grant = { revoked: false };
				grants.add(grant);
				issueTokens(response, grant);
				return;
			}
			if (type === "refresh_token") {
				const grant = refreshTokens.get(params.get("refresh_token"));
				if (!grant || grant.revoked) {
					oauthError(response);
					return;
				}
				refreshTokens.delete(params.get("refresh_token"));
				issueTokens(response, grant);
				return;
			}
			oauthError(response, "unsupported_grant_type");
			return;
		}

		if (request.method === "POST" && url.pathname === "/oauth/revoke") {
			grantCounts.revocation += 1;
			const body = await requestBody(request);
			const params = request.headers["content-type"]?.startsWith("application/json") ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body));
			if (params.client_id !== CLIENT_ID) {
				oauthError(response, "invalid_client");
				return;
			}
			const grant = refreshTokens.get(params.token) ?? accessTokens.get(params.token)?.grant;
			if (grant) grant.revoked = true;
			send(response, 200, {});
			return;
		}

		if (!authorized(request)) {
			send(response, 401, { error: "invalid_token" }, "application/json", { "WWW-Authenticate": 'Bearer error="invalid_token"' });
			return;
		}
		if (request.method === "GET" && url.pathname === "/") {
			redirect(response, "/queue");
			return;
		}
		if (request.method === "GET" && url.pathname === "/queue") {
			if (!request.headers.accept?.includes(SIREN)) {
				send(response, 406, { error: "siren_required" });
				return;
			}
			const page = collection(url);
			send(response, page ? 200 : 400, page ?? { error: "invalid_cursor" }, SIREN);
			return;
		}
		const articlePath = /^\/queue\/([^/]+)\/view$/.exec(url.pathname);
		if (request.method === "GET" && articlePath) {
			if (!request.headers.accept?.includes("text/markdown")) {
				send(response, 406, { error: "markdown_required" });
				return;
			}
			const article = articles.find((entry) => entry.id === decodeURIComponent(articlePath[1]));
			if (!article) {
				send(response, 404, { error: "not_found" });
				return;
			}
			send(response, article.httpStatus ?? 200, article.markdown, article.contentType ?? "text/markdown");
			return;
		}
		send(response, 404, { error: "not_found" });
	};

	const server = createServer((request, response) => {
		void handle(request, response).catch(() => {
			if (!response.headersSent) send(response, 400, { error: "invalid_request" });
			else response.end();
		});
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	origin = `http://127.0.0.1:${server.address().port}`;
	return {
		origin,
		articles,
		requests,
		grantCounts,
		get expiredAccessTokenCount() {
			return [...accessTokens.values()].filter((token) => token.expiresAt <= Date.now()).length;
		},
		expireAccessToken() {
			for (const token of accessTokens.values()) token.expiresAt = 0;
		},
		revokeGrant() {
			for (const grant of grants) grant.revoked = true;
		},
		setAccessTokenLifetimeSeconds(seconds) {
			if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("Token lifetime must be positive");
			tokenLifetimeSeconds = seconds;
		},
		failNext(failure) {
			failures.push({ ...failure });
		},
		async close() {
			await new Promise((resolve, reject) => {
				server.close((error) => error ? reject(error) : resolve());
				server.closeAllConnections();
			});
		},
	};
}
