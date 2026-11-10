import { spawn, execFile } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, writeFile, copyFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium, expect } from "@playwright/test";

const execute = promisify(execFile);
const STORAGE_ERROR_PATTERNS = [
	["secret-decryption-failed", /Failed to decrypt secrets/i],
	["secret-loading-failed", /Failed to load secrets/i],
	["secure-storage-unavailable", /Secure storage is not available|safeStorage.*encryption is not available/i],
	["safe-storage-encryption-failed", /Error.*encrypt.*safeStorage|safeStorage.*encrypt.*(?:failed|error)/i],
	["safe-storage-decryption-failed", /Error.*decrypt.*safeStorage|safeStorage.*decrypt.*(?:failed|error)/i],
	["windows-data-protection-failed", /(?:CryptProtectData|CryptUnprotectData|DPAPI|OSCrypt).*(?:failed|error)|(?:failed|error).*(?:CryptProtectData|CryptUnprotectData|DPAPI|OSCrypt)/i],
	["browser-storage-failed", /(?:localStorage|IndexedDB|leveldb).*(?:failed|error)/i],
];

async function availablePort() {
	const server = createServer();
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	await new Promise((resolve) => server.close(resolve));
	return port;
}

export async function prepareVault(root) {
	const vault = join(root, "vault");
	const profile = process.env.OBSIDIAN_PROFILE ?? join(root, "profile");
	if (process.env.OBSIDIAN_PROFILE) {
		const exists = await stat(join(profile, "obsidian.json")).then(() => true, (error) => {
			if (error.code === "ENOENT") return false;
			throw error;
		});
		if (exists) throw new Error("OBSIDIAN_PROFILE must name a fresh profile; existing application data will not be overwritten");
	}
	const plugin = join(vault, ".obsidian", "plugins", "readplace");
	await mkdir(plugin, { recursive: true });
	await mkdir(profile, { recursive: true });
	await Promise.all(["main.js", "manifest.json"].map((file) => copyFile(file, join(plugin, file))));
	await writeFile(join(vault, ".obsidian", "community-plugins.json"), JSON.stringify(["readplace"]));
	await writeFile(join(vault, ".obsidian", "app.json"), JSON.stringify({ alwaysUpdateLinks: true }));
	await writeFile(join(profile, "obsidian.json"), JSON.stringify({
		vaults: { c0de1304aabbccdd: { path: vault, ts: Date.now(), open: true } },
	}));
	return { vault, profile };
}

export async function launchObsidian({ profile, executablePath, secretStorageDiagnostics = [] }) {
	const port = await availablePort();
	const child = spawn(executablePath, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "--no-sandbox"], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	const diagnostics = { platform: process.platform, processId: child.pid, snapshots: [], errors: [] };
	secretStorageDiagnostics.push(diagnostics);
	const recordStorageError = (source, message) => {
		for (const [category, pattern] of STORAGE_ERROR_PATTERNS) {
			if (pattern.test(message) && !diagnostics.errors.some((error) => error.source === source && error.category === category)) {
				diagnostics.errors.push({ source, category });
			}
		}
	};
	let nativeLogTail = "";
	const inspectNativeLog = (data) => {
		nativeLogTail = (nativeLogTail + data.toString()).slice(-4096);
		recordStorageError("native", nativeLogTail);
	};
	child.stdout.on("data", inspectNativeLog);
	child.stderr.on("data", inspectNativeLog);
	const endpoint = `http://127.0.0.1:${port}`;
	let browser;
	try {
		await expect.poll(async () => {
			if (child.exitCode !== null) throw new Error(`Obsidian exited (${child.exitCode}); storage error categories: ${diagnostics.errors.map((error) => error.category).join(", ")}`);
			try { return (await fetch(`${endpoint}/json/version`)).status; } catch { return 0; }
		}, { timeout: 30_000 }).toBe(200);
		browser = await chromium.connectOverCDP(endpoint);
		for (const context of browser.contexts()) {
			const captureStorageErrors = async (page) => {
				const session = await context.newCDPSession(page);
				session.on("Runtime.consoleAPICalled", (event) => {
					if (event.type !== "error") return;
					for (const argument of event.args) recordStorageError("renderer-console", String(argument.value ?? argument.description ?? ""));
				});
				session.on("Runtime.exceptionThrown", (event) => recordStorageError("renderer-exception", event.exceptionDetails.exception?.description ?? event.exceptionDetails.text));
				await session.send("Runtime.enable");
			};
			context.on("page", (page) => { void captureStorageErrors(page).catch(() => undefined); });
			await Promise.all(context.pages().map(captureStorageErrors));
		}
		await expect.poll(() => browser.contexts().flatMap((context) => context.pages()).some((page) => page.url().endsWith("/index.html"))).toBe(true);
		const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().endsWith("/index.html"));
		await page.waitForFunction(() => Boolean(window.app?.vault));
		const trust = page.getByRole("button", { name: "Trust author and enable plugins" });
		await expect.poll(async () => (await trust.isVisible()) || await page.evaluate(() => Boolean(app.plugins.plugins.readplace))).toBe(true);
		if (await trust.isVisible()) await trust.click();
		await page.waitForFunction(() => Boolean(app.plugins.plugins.readplace));
		const captureSecretStorage = async (phase) => {
			try {
				const snapshot = await page.evaluate((expectedProfile) => {
					const storage = app.secretStorage;
					const encrypted = app.loadLocalStorage("secrets-encrypted");
					const remote = window.electron?.remote;
					const appId = typeof app.appId === "string" && /^[a-f0-9]{16}$/.test(app.appId) ? app.appId : "unexpected-format";
					const ids = storage.listSecrets();
					return {
						appId,
						profileMatches: remote?.app ? remote.app.getPath("userData") === expectedProfile : null,
						encryptionAvailable: remote?.safeStorage ? remote.safeStorage.isEncryptionAvailable() : null,
						secretIdCount: ids.length,
						accessTokenListed: ids.includes("readplace-access-token"),
						refreshTokenListed: ids.includes("readplace-refresh-token"),
						accessTokenPresent: Boolean(storage.peekSecret("readplace-access-token")),
						refreshTokenPresent: Boolean(storage.peekSecret("readplace-refresh-token")),
						encryptedEntryPresent: typeof encrypted === "string",
						encryptedEntryLength: typeof encrypted === "string" ? encrypted.length : 0,
						legacyEntryPresent: app.loadLocalStorage("secrets") !== null,
					};
				}, profile);
				diagnostics.snapshots.push({ phase, ...snapshot });
			} catch {
				diagnostics.snapshots.push({ phase, unavailable: true });
			}
		};
		await captureSecretStorage("after-start");
		return {
			browser, page,
			async notices() {
				const windows = browser.contexts().flatMap((context) => context.pages());
				const messages = await Promise.all(windows.map((window) => window.locator(".notice").allTextContents()));
				return messages.flat();
			},
			async settings() {
				await page.keyboard.press(process.platform === "darwin" ? "Meta+," : "Control+,");
				await expect.poll(async () => {
					for (const candidate of browser.contexts().flatMap((context) => context.pages())) {
						if (await candidate.locator(".vertical-tab-header-group-items").count()) return true;
					}
					return false;
				}).toBe(true);
				const pages = browser.contexts().flatMap((context) => context.pages());
				let settings = page;
				for (const candidate of pages) {
					if (await candidate.locator(".vertical-tab-header-group-items").count()) settings = candidate;
				}
				await settings.locator('.vertical-tab-nav-item[data-setting-id="readplace"]').click();
				await expect(settings.getByRole("button", { name: "Sync now", exact: true })).toBeVisible();
				return settings;
			},
			async close() {
				try {
					if (child.exitCode === null && child.signalCode === null) {
						await captureSecretStorage("before-close");
						if (process.platform === "win32") {
							for (const other of browser.contexts().flatMap((context) => context.pages())) {
								if (other !== page) await other.close();
							}
							await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$application = Get-Process -Id ${child.pid}; if (-not $application.CloseMainWindow()) { throw 'Obsidian main window could not be closed' }`]);
							await expect.poll(() => child.exitCode, { timeout: 15_000 }).toBe(0);
						} else {
							await browser.close();
							child.kill("SIGTERM");
							await expect.poll(() => child.exitCode !== null || child.signalCode !== null).toBe(true);
						}
					}
				} finally {
					await browser.close();
					if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				}
			},
		};
	} catch (error) {
		if (browser) await browser.close();
		child.kill("SIGTERM");
		throw error;
	}
}

export async function openNativeUri(uri) {
	if (process.platform === "darwin") await execute("open", [uri]);
	else if (process.platform === "win32") await execute("rundll32.exe", ["url.dll,FileProtocolHandler", uri]);
	else await execute("xdg-open", [uri]);
}
