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

test("real Obsidian authenticates, preserves notes and credentials, and recovers from failures", async ({}, testInfo) => {
	const fixture = await startReadplaceFixture({ accessTokenLifetimeSeconds: 3 });
	fixture.articles.push(
		{ id: "alpha", title: "Alpha", markdown: "# Alpha\n\nOriginal article.\n", contentVersion: "1" },
		{ id: "beta", title: "Beta", markdown: "# Beta\n\nA note whose title will change.\n", contentVersion: "1" },
		{ id: "gamma", title: "Gamma", markdown: "# Gamma\n\nA note the reader will edit.\n", contentVersion: "1" },
		{ id: "delta", title: "Delta", markdown: "# Delta\n\nA note the reader will remove.\n", status: "read", contentVersion: "1" },
	);
	let obsidian;
	let web;
	const evidence = { boundary: "Real Obsidian and native URI dispatch; controlled HTTP server and captured browser-open intent", checks: [] };
	try {
		await execute(process.execPath, [npmCli, "run", "build"], { env: { ...process.env, READPLACE_SERVER_ORIGIN: fixture.origin } });
		const root = testInfo.outputPath("obsidian");
		const { vault, profile } = await prepareVault(root);
		await mkdir(join(vault, "Readplace"));
		await writeFile(join(vault, "Readplace", "Alpha.md"), "My existing note.\n");
		obsidian = await launchObsidian({ profile, executablePath });
		let settings = await obsidian.settings();
		evidence.obsidianVersion = await obsidian.page.title();
		web = await chromium.launch({ channel: "chrome", headless: true });
		const browserPage = await web.newPage();
		const stateFile = join(vault, ".obsidian", "plugins", "readplace", "data.json");
		const state = async () => {
			try { return JSON.parse(await readFile(stateFile, "utf8")); } catch (error) { if (error.code === "ENOENT") return {}; throw error; }
		};
		const note = (name) => readFile(join(vault, "Readplace", name), "utf8");
		const sync = async () => {
			const previous = (await state()).lastSyncAt;
			await settings.getByRole("button", { name: "Sync now", exact: true }).click();
			await expect.poll(async () => (await state()).lastSyncAt).not.toBe(previous);
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
			expect(fixture.grantCounts.authorization_code).toBe(1);
			evidence.checks.push("OAuth cancellation, PKCE exchange, state and OS URI handler");
		});

		await test.step("sync every page and preserve existing files", async () => {
			await sync();
			expect((await readdir(join(vault, "Readplace"))).sort()).toEqual(["Alpha (2).md", "Alpha.md", "Beta.md", "Delta.md", "Gamma.md"]);
			expect(await note("Alpha.md")).toBe("My existing note.\n");
			for (const article of fixture.articles) expect(await note(`${article.title === "Alpha" ? "Alpha (2)" : article.title}.md`)).toBe(article.markdown);
			const before = fixture.requests.filter((request) => request.path.endsWith("/view")).length;
			await sync();
			expect(fixture.requests.filter((request) => request.path.endsWith("/view")).length).toBe(before);
			expect(fixture.requests.filter((request) => request.path.startsWith("/queue")).every((request) => request.hasAuthorization)).toBe(true);
			evidence.checks.push("Bearer survives entry redirect; pagination includes read articles; repeat sync creates no duplicates or Markdown fetches; existing note preserved");
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
			obsidian = await launchObsidian({ profile, executablePath });
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
