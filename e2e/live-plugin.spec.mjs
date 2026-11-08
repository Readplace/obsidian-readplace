import { test, expect, chromium } from "@playwright/test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { prepareVault, launchObsidian, openNativeUri } from "./obsidian-app.mjs";

const execute = promisify(execFile);
const productionOrigin = "https://readplace.com";
const stagingOrigin = "https://hkncrxpii6.execute-api.ap-southeast-2.amazonaws.com";
const stagingOrigins = new Set([stagingOrigin, "https://readplace-staging.com", "https://www.readplace-staging.com"]);

function environmentFor(value) {
	let url;
	try { url = new URL(value); } catch { throw new Error("A recognized Readplace HTTPS origin is required"); }
	if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Use a Readplace origin without a path or credentials");
	if (url.origin === productionOrigin) return { name: "production", origin: productionOrigin, key: "readplaceProduction", allowedOrigins: new Set([productionOrigin]) };
	if (stagingOrigins.has(url.origin)) return { name: "staging", origin: stagingOrigin, key: "readplaceStaging", allowedOrigins: stagingOrigins };
	throw new Error("Only the production origin and registered staging origins are supported");
}

async function readCredentials(environment) {
	const path = process.env.READPLACE_LIVE_CREDENTIALS_FILE;
	if (!path) throw new Error("READPLACE_LIVE_CREDENTIALS_FILE must identify an owner-only JSON file");
	let entry;
	try {
		const metadata = await lstat(path);
		if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) throw new Error("Invalid file permissions");
		entry = JSON.parse(await readFile(path, "utf8"))[environment.key];
	} catch {
		throw new Error("The credentials file must be readable, valid JSON, owned by this user, and inaccessible to other users");
	}
	if (!entry || typeof entry.email !== "string" || !entry.email || typeof entry.password !== "string" || !entry.password || entry.status !== "verified") throw new Error("A verified email/password account is required for the selected environment");
	if (environmentFor(entry.origin).name !== environment.name) throw new Error("The credentials entry does not match the selected environment");
	return { email: entry.email, password: entry.password };
}

test.use({ trace: "off", video: "off", screenshot: "off" });

test("live Readplace account signs in, syncs, survives restart and signs out in Obsidian", async ({}, testInfo) => {
	test.skip(!process.env.READPLACE_LIVE_ORIGIN, "Set READPLACE_LIVE_ORIGIN to enable live backend validation");
	test.setTimeout(360_000);
	const environment = environmentFor(process.env.READPLACE_LIVE_ORIGIN);
	const credentials = await readCredentials(environment);
	const npmCli = process.env.npm_execpath;
	if (!npmCli) throw new Error("Run this suite with npm run test:e2e -- live-plugin.spec.mjs");
	const executablePath = process.env.OBSIDIAN_EXECUTABLE ?? "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
	const evidence = {
		environment: environment.name,
		origin: environment.origin,
		boundary: "Real Readplace backend, account, installed Obsidian, and OS URI dispatch. Browser-open intent is captured and visited in a separate automated browser; default-browser launch is not validated. Markdown bytes are checked against the plugin's recorded response hashes, without extracting bearer tokens or independently fetching protected API responses. No articles are saved, edited, or deleted in Readplace.",
		checks: [],
		secretStorageDiagnostics: [],
		completed: false,
	};
	let phase = "build";
	let obsidian;
	let web;
	const cleanupFailures = [];
	try {
		await execute(process.execPath, [npmCli, "run", "build"], { env: { ...process.env, READPLACE_SERVER_ORIGIN: environment.origin } });
		phase = "isolated application setup";
		const root = testInfo.outputPath("live-obsidian");
		await mkdir(root, { recursive: true, mode: 0o700 });
		const { vault, profile } = await prepareVault(root);
		const stateFile = join(vault, ".obsidian", "plugins", "readplace", "data.json");
		const state = async () => {
			try { return JSON.parse(await readFile(stateFile, "utf8")); } catch (error) { if (error.code === "ENOENT") return {}; throw error; }
		};
		const stableState = async () => {
			let value;
			await expect(async () => { value = await state(); }).toPass({ timeout: 15_000 });
			return value;
		};
		const launch = () => launchObsidian({ profile, executablePath, secretStorageDiagnostics: evidence.secretStorageDiagnostics });
		obsidian = await launch();
		let settings = await obsidian.settings();
		web = await chromium.launch({ channel: "chrome", headless: true });
		const browserPage = await web.newPage();
		const allowedBrowserOrigin = () => environment.allowedOrigins.has(new URL(browserPage.url()).origin);

		const signIn = async (decision) => {
			await obsidian.page.evaluate(() => {
				window.__readplaceLiveAuthorizationUrl = undefined;
				window.open = (url) => { window.__readplaceLiveAuthorizationUrl = url; return null; };
			});
			await settings.getByRole("button", { name: "Sign in", exact: true }).click();
			await expect.poll(() => obsidian.page.evaluate(() => Boolean(window.__readplaceLiveAuthorizationUrl))).toBe(true);
			const authorizationUrl = new URL(await obsidian.page.evaluate(() => {
				const url = window.__readplaceLiveAuthorizationUrl;
				delete window.__readplaceLiveAuthorizationUrl;
				return url;
			}));
			expect(environment.allowedOrigins.has(authorizationUrl.origin)).toBe(true);
			expect(authorizationUrl.searchParams.get("client_id") === "obsidian-plugin").toBe(true);
			expect(authorizationUrl.searchParams.get("redirect_uri") === `${environment.origin}/oauth/obsidian`).toBe(true);
			await browserPage.goto(authorizationUrl.href);
			const login = browserPage.locator('[data-test-form="login"]');
			const allow = browserPage.getByRole("button", { name: "Allow access", exact: true });
			await expect.poll(async () => await login.isVisible() || await allow.isVisible()).toBe(true);
			expect(allowedBrowserOrigin()).toBe(true);
			if (await login.isVisible()) {
				const populated = await browserPage.evaluate(({ email, password }) => {
					const form = document.querySelector('[data-test-form="login"]');
					const emailInput = form?.querySelector('input[name="email"]');
					const passwordInput = form?.querySelector('input[name="password"]');
					if (!(emailInput instanceof HTMLInputElement) || !(passwordInput instanceof HTMLInputElement)) return false;
					emailInput.value = email;
					passwordInput.value = password;
					for (const input of [emailInput, passwordInput]) {
						input.dispatchEvent(new Event("input", { bubbles: true }));
						input.dispatchEvent(new Event("change", { bubbles: true }));
					}
					return true;
				}, credentials);
				expect(populated).toBe(true);
				await login.getByRole("button", { name: "Sign in", exact: true }).click();
				await expect(allow).toBeVisible({ timeout: 60_000 });
			}
			expect(allowedBrowserOrigin()).toBe(true);
			await browserPage.getByRole("button", { name: decision, exact: true }).click();
			const returnLink = browserPage.getByRole("link", { name: "Return to Obsidian", exact: true });
			await expect(returnLink).toBeVisible({ timeout: 60_000 });
			expect(allowedBrowserOrigin()).toBe(true);
			const handoff = new URL(await returnLink.getAttribute("href"));
			expect(handoff.protocol === "obsidian:" && handoff.hostname === "readplace-auth").toBe(true);
			expect(handoff.searchParams.get("state") === authorizationUrl.searchParams.get("state")).toBe(true);
			expect(decision === "Cancel" ? handoff.searchParams.get("error") === "access_denied" : Boolean(handoff.searchParams.get("code"))).toBe(true);
			await openNativeUri(handoff.href);
			await expect.poll(() => obsidian.notices()).toContainEqual(expect.stringContaining(decision === "Cancel" ? "sign-in cancelled" : "signed in"));
			settings = await obsidian.settings();
		};

		const sync = async () => {
			const previous = (await stableState()).lastSyncAt;
			await settings.getByRole("button", { name: "Sync now", exact: true }).click();
			await expect(async () => {
				const value = (await state()).lastSyncAt;
				expect(typeof value === "string" && Number.isFinite(Date.parse(value)) && value !== previous).toBe(true);
			}).toPass({ timeout: 120_000 });
		};
		const verifyNotes = async () => {
			const notes = Object.values((await stableState()).notes ?? {});
			expect(notes.length, "Seed the live account with at least one saved article before running this smoke test").toBeGreaterThan(0);
			const paths = new Set();
			let markdownBytes = 0;
			for (const note of notes) {
				const path = resolve(vault, note.path);
				expect(path.startsWith(`${resolve(vault)}${sep}`)).toBe(true);
				const content = await readFile(path);
				expect(content.length > 0).toBe(true);
				expect(createHash("sha256").update(content).digest("hex") === note.hash).toBe(true);
				markdownBytes += content.length;
				paths.add(path);
			}
			expect(paths.size).toBe(notes.length);
			return { noteCount: notes.length, markdownBytes };
		};

		phase = "live login and cancellation";
		await signIn("Cancel");
		await expect(settings.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
		evidence.checks.push("Live account login and OAuth consent cancellation return through the native URI handler");
		phase = "live approval and token exchange";
		await signIn("Allow access");
		await expect(settings.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
		evidence.checks.push("Live OAuth consent, matching state, native callback, and successful plugin token exchange");
		phase = "live article sync";
		const syncStarted = performance.now();
		await sync();
		evidence.sync = { elapsedMs: Math.round(performance.now() - syncStarted), ...await verifyNotes() };
		evidence.checks.push("Live account saves produce nonempty Markdown files matching recorded response hashes, with unique paths");

		phase = "signed-in restart";
		const firstRun = obsidian;
		obsidian = undefined;
		await firstRun.close();
		obsidian = await launch();
		settings = await obsidian.settings();
		await expect(settings.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
		await sync();
		evidence.afterRestart = await verifyNotes();
		expect(evidence.afterRestart.noteCount).toBe(evidence.sync.noteCount);
		evidence.checks.push("Credentials survive a real application restart and another live sync creates no duplicate notes");

		phase = "sign-out and signed-out restart";
		await settings.getByRole("button", { name: "Sign out", exact: true }).click();
		await expect(settings.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
		expect(await verifyNotes()).toEqual(evidence.afterRestart);
		const signedOutRun = obsidian;
		obsidian = undefined;
		await signedOutRun.close();
		obsidian = await launch();
		settings = await obsidian.settings();
		await expect(settings.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
		expect(await verifyNotes()).toEqual(evidence.afterRestart);
		evidence.checks.push("Plugin sign-out remains effective after restart and preserves all downloaded notes");
		evidence.completed = true;
	} catch {
		evidence.failedPhase = phase;
		throw new Error(`Live Obsidian smoke failed during ${phase}; credential and callback details are omitted`);
	} finally {
		if (obsidian) {
			try {
				const settings = await obsidian.settings();
				const signOut = settings.getByRole("button", { name: "Sign out", exact: true });
				if (await signOut.isVisible()) {
					await signOut.click();
					await expect(settings.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
				}
			} catch { cleanupFailures.push("plugin sign-out"); }
			try { await obsidian.close(); } catch { cleanupFailures.push("application shutdown"); }
		}
		if (web) {
			try { await web.close(); } catch { cleanupFailures.push("browser shutdown"); }
		}
		try {
			await execute(process.execPath, [npmCli, "run", "build"], { env: { ...process.env, READPLACE_SERVER_ORIGIN: productionOrigin } });
		} catch { cleanupFailures.push("production build restoration"); }
		evidence.cleanupFailures = cleanupFailures;
		if (cleanupFailures.length) evidence.completed = false;
		await mkdir(testInfo.outputDir, { recursive: true });
		const evidencePath = testInfo.outputPath("live-evidence.json");
		await writeFile(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
		await testInfo.attach("live-evidence", { path: evidencePath, contentType: "application/json" });
	}
	if (cleanupFailures.length) throw new Error(`Live smoke cleanup requires attention: ${cleanupFailures.join(", ")}`);
});
