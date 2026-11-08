import { spawn, execFile } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, writeFile, copyFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium, expect } from "@playwright/test";

const execute = promisify(execFile);

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

export async function launchObsidian({ profile, executablePath }) {
	const port = await availablePort();
	const child = spawn(executablePath, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "--no-sandbox"], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	let log = "";
	child.stdout.on("data", (data) => { log += data; });
	child.stderr.on("data", (data) => { log += data; });
	const endpoint = `http://127.0.0.1:${port}`;
	let browser;
	try {
		await expect.poll(async () => {
			if (child.exitCode !== null) throw new Error(`Obsidian exited (${child.exitCode}): ${log}`);
			try { return (await fetch(`${endpoint}/json/version`)).status; } catch { return 0; }
		}, { timeout: 30_000 }).toBe(200);
		browser = await chromium.connectOverCDP(endpoint);
		await expect.poll(() => browser.contexts().flatMap((context) => context.pages()).some((page) => page.url().endsWith("/index.html"))).toBe(true);
		const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().endsWith("/index.html"));
		await page.waitForFunction(() => Boolean(window.app?.vault));
		const trust = page.getByRole("button", { name: "Trust author and enable plugins" });
		await expect.poll(async () => (await trust.isVisible()) || await page.evaluate(() => Boolean(app.plugins.plugins.readplace))).toBe(true);
		if (await trust.isVisible()) await trust.click();
		await page.waitForFunction(() => Boolean(app.plugins.plugins.readplace));
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
				await settings.locator(".vertical-tab-nav-item").filter({ hasText: /^Readplace$/ }).click();
				await expect(settings.getByRole("button", { name: "Sync now", exact: true })).toBeVisible();
				return settings;
			},
			async close() {
				await browser.close();
				if (child.exitCode === null) {
					child.kill("SIGTERM");
					await new Promise((resolve) => child.once("exit", resolve));
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
