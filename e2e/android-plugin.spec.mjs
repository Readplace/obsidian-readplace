import { test, expect, chromium, _android } from "@playwright/test";
import { build } from "esbuild";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startReadplaceFixture } from "./readplace-fixture.mjs";

const execute = promisify(execFile);
const fixtureVault = "Readplace Android Spike";
const pluginFolder = ".obsidian/plugins/readplace";
const pluginFiles = ["main.js", "manifest.json", "data.json"];
const secretIds = ["readplace-access-token", "readplace-refresh-token"];

test.use({ trace: "off", screenshot: "off", video: "off" });

test("Android fixture sync preserves credentials across restart and notes across sign-out", async ({}, testInfo) => {
	test.setTimeout(600_000);
	const serial = process.env.OBSIDIAN_ANDROID_SERIAL;
	test.skip(!serial, "Set OBSIDIAN_ANDROID_SERIAL to opt into an already running disposable Android device");
	expect(process.env.OBSIDIAN_ANDROID_VAULT, "Explicitly confirm the disposable vault with OBSIDIAN_ANDROID_VAULT").toBe(fixtureVault);
	const wrapper = process.env.OBSIDIAN_ANDROID_AX;
	expect(typeof wrapper === "string" && isAbsolute(wrapper), "OBSIDIAN_ANDROID_AX must be the absolute path to the Android ax.sh wrapper").toBe(true);
	const nativeBrowser = process.env.OBSIDIAN_ANDROID_NATIVE_BROWSER === "1";
	const evidence = {
		boundary: nativeBrowser
			? "Controlled local fixture reached by adb reverse. Original window.open opens Playwright-managed Android Chrome; consent and Return to Obsidian use the real browser page. Chrome first-run UI is disabled by Playwright. No native confirmation is automated without inspecting it. Live accounts and PKCE survival after OS process death are not validated."
			: "Controlled local fixture reached by adb reverse. Browser-open intent is captured in Android Obsidian; consent runs in desktop Chrome. HOME backgrounds Obsidian and an Android VIEW intent returns to the same process. Actual Android browser launch, Android browser consent UI, external-app confirmation UI, live accounts, and PKCE survival after OS process death are not validated.",
		browserMode: nativeBrowser ? "android-chrome" : "captured-desktop-chrome",
		vault: fixtureVault,
		checks: [],
		backgroundRoundTrips: [],
		cleanup: [],
		completed: false,
	};
	let phase = "device and vault preflight";
	let device;
	let page;
	let web;
	let androidBrowser;
	let chromeCommandLineSnapshot;
	let chromeCommandLineTouched = false;
	let fixture;
	let reversePort;
	let previousPlugin;
	let installed = false;
	let syncInProgress = false;
	let cleanupIncomplete = false;

	const adb = async (args) => {
		try {
			const result = await execute(wrapper, ["adb", "-H", "127.0.0.1", "-P", "5037", "-s", serial, ...args], {
				cwd: dirname(wrapper), timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
			});
			return result.stdout.trim();
		} catch {
			throw new Error("Android command failed; command arguments and output are omitted");
		}
	};
	const requireOnlySelectedDevice = async () => {
		const devices = (await adb(["devices"])).split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("List of devices"));
		expect(devices, "Playwright enumerates every attached device; disconnect unrelated devices before this opt-in test").toEqual([`${serial}\tdevice`]);
	};
	const captureNativeUi = async () => {
		await writeFile(testInfo.outputPath("android-native-failure.png"), await device.screenshot());
		try {
			await adb(["shell", "uiautomator", "dump", "/sdcard/readplace-native-return.xml"]);
			const ui = await adb(["shell", "cat", "/sdcard/readplace-native-return.xml"]);
			const sanitized = ui
				.replace(/(?:(?:https?|obsidian):\/\/|(?:127\.0\.0\.1|localhost):\d+\/)[^\s"<>]+/g, (url) => url.split("?")[0])
				.replace(/((?:[?&]|&amp;)(?:code|state|approval|code_challenge|code_verifier|access_token|refresh_token|token)=)[^&\s"<>]*/gi, "$1[redacted]");
			await writeFile(testInfo.outputPath("android-native-failure.xml"), sanitized);
			evidence.nativeUiCaptured = true;
		} finally {
			await adb(["shell", "rm", "-f", "/sdcard/readplace-native-return.xml"]);
		}
	};
	const requireVault = async () => {
		expect(await page.evaluate((name) => app.vault.getName() === name, fixtureVault), "Only the named disposable vault may be changed").toBe(true);
	};
	const connect = async () => {
		await requireOnlySelectedDevice();
		const devices = await _android.devices({ host: "127.0.0.1", port: 5037, omitDriverInstall: true });
		device = devices.find((candidate) => candidate.serial() === serial);
		expect(Boolean(device)).toBe(true);
		device.setDefaultTimeout(120_000);
		page = await (await device.webView({ pkg: "md.obsidian" })).page();
		page.setDefaultTimeout(30_000);
		await page.waitForFunction(() => Boolean(window.app?.workspace?.layoutReady), null, { timeout: 120_000 });
		await requireVault();
	};
	const credentialsPresent = () => page.evaluate((ids) => ids.map((id) => Boolean(app.secretStorage.getSecret(id))), secretIds);
	const settings = async () => {
		await requireVault();
		await page.evaluate(() => { app.setting.open(); app.setting.openTabById("readplace"); });
		await expect(page.getByRole("button", { name: "Sync now", exact: true })).toBeVisible();
	};
	const foreground = async () => {
		const activities = await adb(["shell", "dumpsys", "activity", "activities"]);
		return {
			known: /(?:mResumedActivity|topResumedActivity)/.test(activities),
			obsidian: /(?:mResumedActivity|topResumedActivity)[^\n]*md\.obsidian/.test(activities),
		};
	};
	const restart = async () => {
		await requireVault();
		const before = await adb(["shell", "pidof md.obsidian || true"]);
		expect(/^\d+$/.test(before)).toBe(true);
		await device.close();
		device = undefined;
		page = undefined;
		await adb(["shell", "am", "force-stop", "md.obsidian"]);
		expect(await adb(["shell", "pidof md.obsidian || true"])).toBe("");
		await adb(["shell", "am", "start", "-n", "md.obsidian/.MainActivity"]);
		await connect();
		const after = await adb(["shell", "pidof md.obsidian || true"]);
		expect(/^\d+$/.test(after) && after !== before).toBe(true);
		await settings();
		return { previousPid: before, newPid: after, stoppedProcessAbsent: true };
	};

	try {
		await connect();
		expect(await credentialsPresent(), "Refusing to replace an existing Readplace account connection").toEqual([false, false]);
		evidence.runtime = await page.evaluate(() => ({ userAgent: navigator.userAgent, secureContext: isSecureContext, encryptionAvailable: app.secretStorage.isEncryptionAvailable() }));
		fixture = await startReadplaceFixture({ pageSize: 2 });
		fixture.articles.push(
			{ id: "android-alpha", title: "Android alpha", markdown: "# Android alpha\n\nExact fixture article.\n", contentVersion: "1" },
			{ id: "android-beta", title: "Android beta", markdown: "# Android beta\n\nSecond fixture article.\n", contentVersion: "1" },
			{ id: "android-read", title: "Android read", markdown: "# Android read\n\nAlready read, still synced.\n", status: "read", contentVersion: "1" },
		);
		const requestedReverse = `tcp:${new URL(fixture.origin).port}`;
		await adb(["reverse", "--no-rebind", requestedReverse, requestedReverse]);
		reversePort = requestedReverse;
		phase = "isolated fixture bundle and plugin installation";
		const bundle = await build({
			entryPoints: [fileURLToPath(new URL("../src/main.ts", import.meta.url))],
			define: { READPLACE_SERVER_ORIGIN: JSON.stringify(fixture.origin) },
			bundle: true, external: ["obsidian"], format: "cjs", target: "es2021", minify: true, treeShaking: true, write: false, logLevel: "silent",
		});
		const main = bundle.outputFiles[0].text;
		const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
		const folder = `Readplace Android Fixture ${randomUUID()}`;
		evidence.bundleSha256 = createHash("sha256").update(main).digest("hex");
		evidence.fixtureFolder = folder;
		previousPlugin = await page.evaluate(async ({ names, folder }) => {
			const files = {};
			for (const name of names) {
				const path = `${folder}/${name}`;
				files[name] = await app.vault.adapter.exists(path) ? await app.vault.adapter.read(path) : null;
			}
			return { files, enabled: app.plugins.enabledPlugins.has("readplace"), communityPluginsEnabled: app.plugins.isEnabled() };
		}, { names: pluginFiles, folder: pluginFolder });
		expect(previousPlugin.communityPluginsEnabled, "Enable community plugins in the disposable vault before running this test").toBe(true);
		await writeFile(testInfo.outputPath("android-plugin-before.json"), JSON.stringify(previousPlugin), { mode: 0o600 });
		await requireVault();
		installed = true;
		await page.evaluate(async ({ main, manifest, pluginFolder, folder }) => {
			await app.plugins.disablePluginAndSave("readplace");
			for (const directory of [".obsidian/plugins", pluginFolder]) if (!await app.vault.adapter.exists(directory)) await app.vault.adapter.mkdir(directory);
			await app.vault.adapter.write(`${pluginFolder}/main.js`, main);
			await app.vault.adapter.write(`${pluginFolder}/manifest.json`, JSON.stringify(manifest));
			await app.vault.adapter.write(`${pluginFolder}/data.json`, JSON.stringify({ version: 1, settings: { folder, automaticSync: false, syncOnOpen: false }, notes: {}, lastSyncAt: null }));
			await app.plugins.loadManifests();
			await app.plugins.enablePluginAndSave("readplace");
		}, { main, manifest, pluginFolder, folder });
		await settings();
		await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
		evidence.checks.push("Fixture bundle installed only in the named Android vault; repository build unchanged");
		let desktopPage;
		if (nativeBrowser) {
			phase = "Android Chrome preparation";
			chromeCommandLineSnapshot = await adb(["shell", "if [ -f /data/local/tmp/chrome-command-line ]; then base64 /data/local/tmp/chrome-command-line; else printf '__absent__'; fi"]);
			expect(chromeCommandLineSnapshot === "__absent__" || /^[A-Za-z0-9+/=\s]*$/.test(chromeCommandLineSnapshot)).toBe(true);
			chromeCommandLineTouched = true;
			androidBrowser = await device.launchBrowser({ pkg: "com.android.chrome" });
		}
		else {
			web = await chromium.launch({ channel: "chrome", headless: true });
			desktopPage = await web.newPage();
		}
		const signIn = async (decision) => {
			phase = `${nativeBrowser ? "native Android" : "captured"} ${decision}: foreground Obsidian and open authorization`;
			await requireVault();
			await adb(["shell", "am", "start", "-n", "md.obsidian/.MainActivity"]);
			await expect.poll(foreground).toEqual({ known: true, obsidian: true });
			const before = await adb(["shell", "pidof md.obsidian || true"]);
			await page.evaluate((capture) => {
				if (capture) {
					window.__readplaceAndroidOriginalOpen ??= window.open;
					window.__readplaceAndroidAuthorizationUrl = undefined;
					window.open = (url) => { window.__readplaceAndroidAuthorizationUrl = String(url); return null; };
				} else if (window.__readplaceAndroidOriginalOpen) throw new Error("An earlier browser capture hook is still installed");
				window.__readplaceAndroidNoticeObserver?.disconnect();
				window.__readplaceAndroidNotices = { cancelled: false, signedIn: false };
				window.__readplaceAndroidNoticeObserver = new MutationObserver(() => {
					for (const notice of document.querySelectorAll(".notice")) {
						if (notice.textContent.includes("sign-in cancelled")) window.__readplaceAndroidNotices.cancelled = true;
						if (notice.textContent.includes("signed in")) window.__readplaceAndroidNotices.signedIn = true;
					}
				});
				window.__readplaceAndroidNoticeObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
			}, !nativeBrowser);
			await page.getByRole("button", { name: "Sign in", exact: true }).click();
			let browserPage = desktopPage;
			let authorization;
			if (nativeBrowser) {
				phase = `native Android ${decision}: authorization page and Chrome foreground`;
				await expect.poll(() => {
					browserPage = androidBrowser.pages().find((candidate) => {
						try { const url = new URL(candidate.url()); return url.origin === fixture.origin && url.pathname === "/oauth/authorize"; } catch { return false; }
					});
					return Boolean(browserPage);
				}, { timeout: 30_000 }).toBe(true);
				authorization = new URL(browserPage.url());
				await expect.poll(foreground).toEqual({ known: true, obsidian: false });
				await expect.poll(async () => /(?:mResumedActivity|topResumedActivity)[^\n]*com\.android\.chrome/.test(await adb(["shell", "dumpsys", "activity", "activities"]))).toBe(true);
				evidence.androidChromeUserAgent = await browserPage.evaluate(() => navigator.userAgent);
			} else {
				await expect.poll(() => page.evaluate(() => Boolean(window.__readplaceAndroidAuthorizationUrl))).toBe(true);
				authorization = new URL(await page.evaluate(() => {
					const url = window.__readplaceAndroidAuthorizationUrl;
					delete window.__readplaceAndroidAuthorizationUrl;
					return url;
				}));
				await adb(["shell", "input", "keyevent", "KEYCODE_HOME"]);
				await expect.poll(foreground).toEqual({ known: true, obsidian: false });
			}
			expect(authorization.origin === fixture.origin && authorization.pathname === "/oauth/authorize").toBe(true);
			expect(authorization.searchParams.get("redirect_uri") === `${fixture.origin}/oauth/obsidian`).toBe(true);
			if (!nativeBrowser) await browserPage.goto(authorization.href);
			phase = `${nativeBrowser ? "native Android" : "captured"} ${decision}: browser consent and handoff link`;
			await browserPage.getByRole("button", { name: decision, exact: true }).click();
			const handoff = new URL(await browserPage.getByRole("link", { name: "Return to Obsidian", exact: true }).getAttribute("href"));
			expect(handoff.protocol === "obsidian:" && handoff.hostname === "readplace-auth").toBe(true);
			expect(handoff.searchParams.get("state") === authorization.searchParams.get("state")).toBe(true);
			expect(decision === "Cancel" ? handoff.searchParams.get("error") === "access_denied" : Boolean(handoff.searchParams.get("code"))).toBe(true);
			await requireVault();
			if (nativeBrowser) {
				phase = `native Android ${decision}: click Return to Obsidian`;
				await browserPage.getByRole("link", { name: "Return to Obsidian", exact: true }).click({ noWaitAfter: true });
				phase = `native Android ${decision}: foreground after Return link`;
				try {
					await expect.poll(foreground).toEqual({ known: true, obsidian: true });
				} catch {
					evidence.nativeReturnBlocked = { decision, nativeConfirmationAutomated: false };
					throw new Error("Native return did not foreground Obsidian; inspect captured native UI before adding dialog automation");
				}
			} else {
				const quotedUri = `'${handoff.href.replaceAll("'", "'\\''")}'`;
				await adb(["shell", `am start -a android.intent.action.VIEW -d ${quotedUri} -p md.obsidian`]);
				await expect.poll(foreground).toEqual({ known: true, obsidian: true });
			}
			phase = `${nativeBrowser ? "native Android" : "captured"} ${decision}: same-process callback result`;
			expect(await adb(["shell", "pidof md.obsidian || true"])).toBe(before);
			await expect.poll(() => page.evaluate((key) => window.__readplaceAndroidNotices[key], decision === "Cancel" ? "cancelled" : "signedIn")).toBe(true);
			await page.evaluate(() => {
				window.__readplaceAndroidNoticeObserver.disconnect();
				delete window.__readplaceAndroidNoticeObserver;
				delete window.__readplaceAndroidNotices;
			});
			await settings();
			evidence.backgroundRoundTrips.push({ decision, pid: before, sameProcessResumed: true, homeScreenUsed: !nativeBrowser, desktopConsentUsed: !nativeBrowser, androidBrowserUsed: nativeBrowser, realReturnLinkClicked: nativeBrowser, nativeConfirmationAutomated: false });
		};
		const state = () => page.evaluate(async (path) => JSON.parse(await app.vault.adapter.read(path)), `${pluginFolder}/data.json`);
		const sync = async () => {
			await requireVault();
			const previous = (await state()).lastSyncAt;
			syncInProgress = true;
			await page.getByRole("button", { name: "Sync now", exact: true }).click();
			await expect(async () => {
				const current = (await state()).lastSyncAt;
				expect(typeof current === "string" && Number.isFinite(Date.parse(current)) && current !== previous).toBe(true);
			}).toPass({ timeout: 60_000 });
			syncInProgress = false;
		};
		const verifyNotes = async () => {
			await requireVault();
			const notes = await page.evaluate(async (folder) => {
				const paths = (await app.vault.adapter.list(folder)).files.sort();
				return Promise.all(paths.map(async (path) => ({ path, markdown: await app.vault.adapter.read(path) })));
			}, folder);
			expect(notes).toEqual(fixture.articles.map((article) => ({ path: `${folder}/${article.title}.md`, markdown: article.markdown })).sort((a, b) => a.path.localeCompare(b.path)));
			expect(Object.keys((await state()).notes).sort()).toEqual(fixture.articles.map((article) => article.id).sort());
			return notes.length;
		};

		phase = "backgrounded cancellation and approval through native callback";
		await signIn("Cancel");
		expect(fixture.grantCounts.authorization_code).toBe(0);
		expect(await credentialsPresent()).toEqual([false, false]);
		await signIn("Approve");
		await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
		expect(fixture.grantCounts.authorization_code).toBe(1);
		expect(await credentialsPresent()).toEqual([true, true]);
		evidence.checks.push(nativeBrowser
			? "Original window.open reaches foreground Android Chrome; cancellation and approval use real browser consent and Return to Obsidian links, with the same Obsidian process resumed and no native confirmation interaction required"
			: "Captured PKCE intent, desktop consent cancellation and approval, HOME backgrounding, and Android native callback to the same process");
		if (androidBrowser) { await androidBrowser.close(); androidBrowser = undefined; }
		phase = "exact Markdown and repeat sync";
		await sync();
		evidence.noteCount = await verifyNotes();
		const markdownRequests = fixture.requests.filter((request) => request.path.endsWith("/view")).length;
		await sync();
		await verifyNotes();
		expect(fixture.requests.filter((request) => request.path.endsWith("/view")).length).toBe(markdownRequests);
		expect(fixture.requests.filter((request) => request.path === "/" || request.path.startsWith("/queue")).every((request) => request.hasAuthorization)).toBe(true);
		evidence.checks.push("All fixture pages including read articles sync as exact Markdown; repeat sync produces no duplicates or extra Markdown downloads");
		await page.screenshot({ path: testInfo.outputPath("android-signed-in.png") });
		phase = "signed-in process restart and token refresh";
		evidence.signedInRestart = await restart();
		expect(await credentialsPresent()).toEqual([true, true]);
		await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
		fixture.expireAccessToken();
		await sync();
		await verifyNotes();
		expect(fixture.grantCounts.refresh_token).toBeGreaterThan(0);
		expect(fixture.grantCounts.authorization_code).toBe(1);
		evidence.checks.push("Real SecretStorage credentials survive force-stop with a new PID and refresh without another authorization");
		phase = "sign-out and signed-out process restart";
		await page.getByRole("button", { name: "Sign out", exact: true }).click();
		await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
		expect(await credentialsPresent()).toEqual([false, false]);
		expect(fixture.grantCounts.revocation).toBe(1);
		await verifyNotes();
		evidence.signedOutRestart = await restart();
		expect(await credentialsPresent()).toEqual([false, false]);
		await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
		await verifyNotes();
		await page.screenshot({ path: testInfo.outputPath("android-signed-out.png") });
		evidence.checks.push("Sign-out revokes fixture credentials, remains signed out after restart, and preserves every fixture note");
		evidence.completed = true;
	} catch (error) {
		evidence.failedPhase = phase;
		evidence.failure = { operation: /^(?:locator|page|browserContext|androidDevice)\.\w+/.exec(error.message)?.[0] ?? "assertion-or-other", timeout: /timeout/i.test(error.message) };
		if (nativeBrowser && device) {
			try { await captureNativeUi(); } catch { evidence.nativeUiCaptured = false; }
		}
		throw new Error(`Android fixture failed during ${phase}; authorization and callback values are omitted`);
	} finally {
		if (installed && page && syncInProgress) {
			try {
				await requireVault();
				await page.evaluate(async (ids) => {
					await app.plugins.disablePluginAndSave("readplace");
					for (const id of ids) app.secretStorage.setSecret(id, "");
					if (window.__readplaceAndroidOriginalOpen) window.open = window.__readplaceAndroidOriginalOpen;
					delete window.__readplaceAndroidOriginalOpen;
					delete window.__readplaceAndroidAuthorizationUrl;
					window.__readplaceAndroidNoticeObserver?.disconnect();
					delete window.__readplaceAndroidNoticeObserver;
					delete window.__readplaceAndroidNotices;
				}, secretIds);
				evidence.cleanup.push("Plugin restoration incomplete because a sync was unfinished; fixture plugin disabled and credentials cleared. Previous files retained in android-plugin-before.json");
			} catch {
				evidence.cleanup.push("Plugin restoration incomplete after an unfinished sync; previous files retained in android-plugin-before.json");
			}
		} else if (installed && page && previousPlugin) {
			try {
				await requireVault();
				try {
					await settings();
					const signOut = page.getByRole("button", { name: "Sign out", exact: true });
					if (await signOut.isVisible()) {
						await signOut.click();
						await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
					}
				} catch {
					evidence.cleanup.push("Fixture sign-out UI unavailable; local fixture credentials cleared during restoration");
				}
				await requireVault();
				await page.evaluate(async ({ previous, folder, ids }) => {
					await app.plugins.disablePluginAndSave("readplace");
					for (const id of ids) app.secretStorage.setSecret(id, "");
					for (const [name, contents] of Object.entries(previous.files)) {
						const path = `${folder}/${name}`;
						if (contents !== null) await app.vault.adapter.write(path, contents);
						else if (await app.vault.adapter.exists(path)) await app.vault.adapter.remove(path);
					}
					await app.plugins.loadManifests();
					if (previous.enabled) await app.plugins.enablePluginAndSave("readplace");
					if (window.__readplaceAndroidOriginalOpen) window.open = window.__readplaceAndroidOriginalOpen;
					delete window.__readplaceAndroidOriginalOpen;
					delete window.__readplaceAndroidAuthorizationUrl;
					window.__readplaceAndroidNoticeObserver?.disconnect();
					delete window.__readplaceAndroidNoticeObserver;
					delete window.__readplaceAndroidNotices;
				}, { previous: previousPlugin, folder: pluginFolder, ids: secretIds });
				evidence.cleanup.push("Fixture credentials cleared and previous plugin files, state, and enabled status restored; fixture notes retained");
			} catch {
				evidence.cleanup.push("Plugin restoration incomplete; inspect only the named disposable vault before reusing it");
			}
		} else if (installed) evidence.cleanup.push("Plugin restoration incomplete because the app connection was lost");
		if (reversePort) {
			try { await adb(["reverse", "--remove", reversePort]); } catch { evidence.cleanup.push("Fixture adb reverse removal failed"); }
		}
		if (androidBrowser) {
			try { await androidBrowser.close(); } catch { evidence.cleanup.push("Android Chrome connection did not close cleanly"); }
		}
		if (chromeCommandLineTouched) {
			try {
				if (chromeCommandLineSnapshot === "__absent__") await adb(["shell", "rm", "-f", "/data/local/tmp/chrome-command-line"]);
				else await adb(["shell", `printf '%s' '${chromeCommandLineSnapshot.replace(/\s/g, "")}' | base64 -d > /data/local/tmp/chrome-command-line`]);
				evidence.cleanup.push("Android Chrome command-line file restored to its previous state");
			} catch { evidence.cleanup.push("Android Chrome command-line restoration failed"); }
		}
		const closing = await Promise.allSettled([device?.close(), web?.close(), fixture?.close()]);
		if (closing.some((result) => result.status === "rejected")) evidence.cleanup.push("A test connection did not close cleanly");
		evidence.grantCounts = fixture?.grantCounts;
		evidence.requestCount = fixture?.requests.length ?? 0;
		evidence.deviceLifecycle = "Attached to an existing device; test does not boot or stop the emulator. Operator retains emulator shutdown responsibility.";
		cleanupIncomplete = evidence.cleanup.some((entry) => /incomplete|failed|did not/.test(entry));
		if (cleanupIncomplete) evidence.completed = false;
		await writeFile(testInfo.outputPath("android-evidence.json"), JSON.stringify(evidence, null, 2));
		await testInfo.attach("android-automation-evidence", { path: testInfo.outputPath("android-evidence.json"), contentType: "application/json" });
	}
	if (cleanupIncomplete) throw new Error("Android fixture assertions passed but cleanup was incomplete; see sanitized evidence");
});
