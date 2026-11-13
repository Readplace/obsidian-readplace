import { test, expect, chromium } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startReadplaceFixture } from "./readplace-fixture.mjs";
import { prepareVault, launchObsidian, openNativeUri } from "./obsidian-app.mjs";

const execute = promisify(execFile);
const executablePath = process.env.OBSIDIAN_EXECUTABLE ?? "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this suite with npm run test:e2e");
const benchmarkArticleCount = Number(process.env.READPLACE_BENCHMARK_ARTICLES ?? 0);
if (!Number.isSafeInteger(benchmarkArticleCount) || benchmarkArticleCount < 0) throw new Error("READPLACE_BENCHMARK_ARTICLES must be a nonnegative integer");

test("real Obsidian authenticates, preserves notes and credentials, and recovers from failures", async ({}, testInfo) => {
	if (benchmarkArticleCount > 0) test.setTimeout(600_000);
	const fixture = await startReadplaceFixture({ accessTokenLifetimeSeconds: 3 });
	fixture.articles.push(
		{ id: "alpha", title: "Alpha", markdown: "# Alpha\n\nOriginal article.\n", contentVersion: "1" },
		{ id: "beta", title: "Beta", markdown: "# Beta\n\nA note whose title will change.\n", contentVersion: "1" },
		{ id: "gamma", title: "Gamma", markdown: "# Gamma\n\nA note the reader will edit.\n", contentVersion: "1" },
		{ id: "delta", title: "Delta", markdown: "# Delta\n\nA note the reader will remove.\n", status: "read", contentVersion: "1" },
	);
	let obsidian;
	let web;
	const evidence = { boundary: "Real Obsidian opens the default browser to a controlled authorization endpoint; later consent uses captured browser-open intent and native URI dispatch. Browser external-app confirmation UI remains unverified.", checks: [], secretStorageDiagnostics: [] };
	try {
		await execute(process.execPath, [npmCli, "run", "build"], { env: { ...process.env, READPLACE_SERVER_ORIGIN: fixture.origin } });
		const root = testInfo.outputPath("obsidian");
		const { vault, profile } = await prepareVault(root);
		await mkdir(join(vault, "Readplace"));
		await writeFile(join(vault, "Readplace", "Alpha.md"), "My existing note.\n");
		obsidian = await launchObsidian({ profile, executablePath, secretStorageDiagnostics: evidence.secretStorageDiagnostics });
		let settings = await obsidian.settings();
		evidence.obsidianVersion = await obsidian.page.title();
		await test.step("open the authorization page in the native default browser", async () => {
			const before = fixture.requests.length;
			await settings.getByRole("button", { name: "Sign in", exact: true }).click();
			await expect.poll(() => fixture.requests.slice(before).filter((request) => request.method === "GET" && request.path === "/oauth/authorize").length, { timeout: 30_000 }).toBeGreaterThan(0);
			expect(fixture.requests.slice(before).filter((request) => request.method === "POST" && request.path === "/oauth/token")).toHaveLength(0);
			expect(fixture.grantCounts.authorization_code).toBe(0);
			evidence.checks.push("Original window.open launches the native default browser and reaches the authorization endpoint without exchanging a token; external-app confirmation UI remains unverified");
		});
		web = await chromium.launch({ channel: "chrome", headless: true });
		const browserPage = await web.newPage();
		const stateFile = join(vault, ".obsidian", "plugins", "readplace", "data.json");
		const state = async () => {
			try { return JSON.parse(await readFile(stateFile, "utf8")); } catch (error) { if (error.code === "ENOENT") return {}; throw error; }
		};
		const note = (name) => readFile(join(vault, "Readplace", name), "utf8");
		const sync = async ({ timeout } = {}) => {
			let previous;
			await expect(async () => { previous = (await state()).lastSyncAt; }).toPass({ timeout: 15_000 });
			await settings.getByRole("button", { name: "Sync now", exact: true }).click();
			await expect(async () => {
				const current = (await state()).lastSyncAt;
				expect(typeof current).toBe("string");
				expect(Number.isFinite(Date.parse(current))).toBe(true);
				expect(current).not.toBe(previous);
			}).toPass({ timeout: timeout ?? 15_000 });
		};
		const signIn = async (decision) => {
			await obsidian.page.evaluate(() => {
				window.__readplaceAuthorizationUrl = undefined;
				window.open = (url) => { window.__readplaceAuthorizationUrl = url; return null; };
			});
			await settings.getByRole("button", { name: "Sign in", exact: true }).click();
			await expect.poll(() => obsidian.page.evaluate(() => window.__readplaceAuthorizationUrl)).toBeTruthy();
			await browserPage.goto(await obsidian.page.evaluate(() => window.__readplaceAuthorizationUrl));
			await browserPage.getByRole("button", { name: decision, exact: true }).click();
			const handoff = await browserPage.getByRole("link", { name: "Return to Obsidian" }).getAttribute("href");
			expect(handoff.startsWith("obsidian://readplace-auth?")).toBe(true);
			await openNativeUri(handoff);
			await expect.poll(() => obsidian.notices()).toContainEqual(expect.stringContaining(decision === "Cancel" ? "sign-in cancelled" : "signed in"));
			settings = await obsidian.settings();
		};

		await test.step("cancel and approve PKCE sign-in through browser and native URI handler", async () => {
			await signIn("Cancel");
			expect(fixture.grantCounts.authorization_code).toBe(0);
			await signIn("Approve");
			await expect(settings.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
			await expect(settings.getByRole("button", { name: "Sign out", exact: true })).toHaveCount(1);
			await expect(settings.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0);
			expect(fixture.grantCounts.authorization_code).toBe(1);
			evidence.checks.push("OAuth cancellation, PKCE exchange, state and OS URI handler");
		});

		await test.step("find Readplace's settings through Obsidian's settings search", async () => {
			const search = settings.getByPlaceholder("Search settings...");
			await search.fill("Refresh all notes");
			const group = settings.locator(".setting-search-result-group").filter({ has: settings.locator(".setting-search-result-tab-label").filter({ hasText: /^Readplace$/ }) });
			await expect(group.locator(".setting-search-result-item")).toHaveText(["Refresh all notes"]);
			await search.fill("");
			await expect(settings.getByRole("button", { name: "Sync now", exact: true })).toBeVisible();
			evidence.checks.push("Obsidian settings search finds Readplace's settings");
		});

		await test.step("sync every page and preserve existing files", async () => {
			await sync();
			expect((await readdir(join(vault, "Readplace"))).sort()).toEqual(["Alpha (2).md", "Alpha.md", "Beta.md", "Delta.md", "Gamma.md"]);
			expect(await note("Alpha.md")).toBe("My existing note.\n");
			for (const article of fixture.articles) expect(await note(`${article.title === "Alpha" ? "Alpha (2)" : article.title}.md`)).toBe(article.markdown);
			const before = fixture.requests.filter((request) => request.path.endsWith("/view")).length;
			await sync();
			expect(fixture.requests.filter((request) => request.path.endsWith("/view")).length).toBe(before);
			expect(fixture.requests.filter((request) => request.path === "/" || request.path.startsWith("/queue")).every((request) => request.hasAuthorization)).toBe(true);
			evidence.checks.push("Bearer reaches the collection at the entry point; pagination includes read articles; repeat sync creates no duplicates or Markdown fetches; existing note preserved");
		});

		await test.step("keep reader edits, follow renames, update links, and respect deleted notes", async () => {
			await obsidian.page.evaluate(async () => {
				await app.vault.create("Links.md", "[[Readplace/Beta]]\n");
				await app.vault.modify(app.vault.getFileByPath("Readplace/Gamma.md"), "My annotations.\n");
				await app.vault.delete(app.vault.getFileByPath("Readplace/Delta.md"));
				await app.fileManager.renameFile(app.vault.getFileByPath("Readplace/Alpha (2).md"), "Readplace/Moved alpha.md");
			});
			await expect.poll(() => obsidian.page.evaluate(() => app.metadataCache.getFileCache(app.vault.getFileByPath("Links.md"))?.links?.length)).toBe(1);
			fixture.articles[0].markdown = "# Alpha\n\nUpdated after a reader rename.\n";
			fixture.articles[0].contentVersion = "2";
			fixture.articles[1].title = "Renamed beta";
			fixture.articles[1].markdown = "# Renamed beta\n\nUpdated article.\n";
			fixture.articles[1].contentVersion = "2";
			fixture.articles[2].markdown = "# Gamma\n\nServer update.\n";
			fixture.articles[2].contentVersion = "2";
			await sync();
			expect(await note("Moved alpha.md")).toBe(fixture.articles[0].markdown);
			expect(await note("Renamed beta.md")).toBe(fixture.articles[1].markdown);
			expect(await note("Gamma.md")).toBe("My annotations.\n");
			expect((await readdir(join(vault, "Readplace"))).sort()).toEqual(["Alpha.md", "Gamma.md", "Moved alpha.md", "Renamed beta.md"]);
			await expect.poll(() => readFile(join(vault, "Links.md"), "utf8")).toBe("[[Renamed beta]]\n");
			await expect.poll(() => obsidian.page.evaluate(() => app.metadataCache.resolvedLinks["Links.md"])).toEqual({ "Readplace/Renamed beta.md": 1 });
			fixture.articles.splice(0, 1);
			await sync();
			expect(await note("Moved alpha.md")).toBe("# Alpha\n\nUpdated after a reader rename.\n");
			evidence.checks.push("Reader edits protected; reader rename remains tracked; server rename updates Obsidian links; deleted notes stay deleted; removed saves keep their notes");
		});

		await test.step("restart with real secret storage and refresh naturally expired credentials", async () => {
			await settings.screenshot({ path: testInfo.outputPath("settings-signed-in.png") });
			const beforeRestart = obsidian;
			obsidian = undefined;
			await beforeRestart.close();
			obsidian = await launchObsidian({ profile, executablePath, secretStorageDiagnostics: evidence.secretStorageDiagnostics });
			settings = await obsidian.settings();
			await expect(settings.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
			await expect.poll(() => fixture.expiredAccessTokenCount).toBeGreaterThan(0);
			await sync();
			expect(fixture.grantCounts.refresh_token).toBeGreaterThan(0);
			expect(fixture.grantCounts.authorization_code).toBe(1);
			evidence.checks.push("Secret storage survives process restart; naturally expired fixture access token refreshes without a new login");
		});

		await test.step("recover on the next run after rate limiting", async () => {
			fixture.failNext({ path: "/queue", status: 429 });
			await settings.getByRole("button", { name: "Sync now", exact: true }).click();
			await expect.poll(() => obsidian.notices()).toContainEqual(expect.stringContaining("sync paused (rate-limited)"));
			await sync();
			evidence.checks.push("Rate limiting is reported and a later sync succeeds");
		});

		if (benchmarkArticleCount > 0) {
			await test.step(`sync ${benchmarkArticleCount} articles from the controlled HTTP fixture`, async () => {
				const paragraph = "A reading workflow starts with a question and keeps the original source close to the answer. Saving an article records a place to return, while a local Markdown copy makes the text available alongside working notes. Changes should preserve the reader's annotations and the links between related ideas.";
				const body = Array.from({ length: 40 }, (_, index) => `## Observation ${index + 1}\n\n${paragraph}\n\n`).join("");
				const benchmarkArticles = Array.from({ length: benchmarkArticleCount }, (_, index) => {
					const number = String(index + 1).padStart(4, "0");
					const title = `Benchmark article ${number}`;
					return {
						id: `benchmark-${number}`,
						title,
						markdown: `---\ntitle: ${title}\nsource: https://example.invalid/articles/${number}\nreadplace_content_status: ready\nreadplace_summary_status: ready\n---\n\n# ${title}\n\n## Summary\n\nA saved article about keeping useful sources with working notes.\n\n${body}`,
						status: index % 2 === 0 ? "unread" : "read",
						contentVersion: "1",
					};
				});
				const markdownSizes = benchmarkArticles.map((article) => Buffer.byteLength(article.markdown));
				expect(Math.min(...markdownSizes)).toBeGreaterThanOrEqual(10_000);
				expect(Math.max(...markdownSizes)).toBeLessThanOrEqual(20_000);
				const beforeNotes = await readdir(join(vault, "Readplace"));
				const benchmark = {
					boundary: "Real Obsidian with a controlled local HTTP fixture; not a live account or network performance benchmark. Live validation with about 2,000 saves remains pending.",
					articleCount: benchmarkArticleCount,
					existingArticleCount: fixture.articles.length,
					markdownBytes: markdownSizes.reduce((total, size) => total + size, 0),
					completed: false,
				};
				evidence.benchmark = benchmark;
				fixture.articles.push(...benchmarkArticles);
				fixture.setAccessTokenLifetimeSeconds(3600);
				fixture.expireAccessToken();
				const beforeRequests = fixture.requests.length;
				const started = performance.now();
				await sync({ timeout: 480_000 });
				benchmark.elapsedMs = Math.round(performance.now() - started);
				const firstRequests = fixture.requests.slice(beforeRequests);
				benchmark.requestCount = firstRequests.length;
				benchmark.markdownRequestCount = firstRequests.filter((request) => request.path.endsWith("/view")).length;
				expect(benchmark.markdownRequestCount).toBe(benchmarkArticleCount);
				const expectedNotes = [...beforeNotes, ...benchmarkArticles.map((article) => `${article.title}.md`)].sort();
				expect((await readdir(join(vault, "Readplace"))).sort()).toEqual(expectedNotes);
				for (const article of benchmarkArticles) expect(await note(`${article.title}.md`), article.title).toBe(article.markdown);
				const beforeRepeatRequests = fixture.requests.length;
				const repeatStarted = performance.now();
				await sync({ timeout: 120_000 });
				const repeatRequests = fixture.requests.slice(beforeRepeatRequests);
				benchmark.repeat = {
					elapsedMs: Math.round(performance.now() - repeatStarted),
					requestCount: repeatRequests.length,
					markdownRequestCount: repeatRequests.filter((request) => request.path.endsWith("/view")).length,
				};
				expect(benchmark.repeat.markdownRequestCount).toBe(0);
				expect((await readdir(join(vault, "Readplace"))).sort()).toEqual(expectedNotes);
				benchmark.completed = true;
				evidence.checks.push(`${benchmarkArticleCount} controlled-fixture articles written exactly; repeated sync adds no notes or Markdown downloads`);
			});
		}

		await test.step("sign out and reject a revoked grant without losing notes", async () => {
			const before = await readdir(join(vault, "Readplace"));
			await settings.getByRole("button", { name: "Sign out", exact: true }).click();
			await expect(settings.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
			expect(fixture.grantCounts.revocation).toBe(1);
			expect(await readdir(join(vault, "Readplace"))).toEqual(before);
			await signIn("Approve");
			await expect(settings.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
			fixture.revokeGrant();
			await settings.getByRole("button", { name: "Sync now", exact: true }).click();
			await expect(settings.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
			expect(await readdir(join(vault, "Readplace"))).toEqual(before);
			evidence.checks.push("Sign-out revokes credentials and retains notes; server revocation returns plugin to signed-out state");
		});
	} finally {
		if (obsidian) {
			for (const [index, page] of obsidian.browser.contexts().flatMap((context) => context.pages()).entries()) {
				await page.screenshot({ path: testInfo.outputPath(`obsidian-final-${index}.png`) });
			}
		}
		evidence.grantCounts = fixture.grantCounts;
		evidence.requestCount = fixture.requests.length;
		await writeFile(testInfo.outputPath("evidence.json"), JSON.stringify(evidence, null, 2));
		await testInfo.attach("automation-evidence", { path: testInfo.outputPath("evidence.json"), contentType: "application/json" });
		if (obsidian) await obsidian.close();
		if (web) await web.close();
		await fixture.close();
		await execute(process.execPath, [npmCli, "run", "build"]);
	}
});
