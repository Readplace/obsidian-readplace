import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./e2e",
	testMatch: "**/*.spec.mjs",
	workers: 1,
	fullyParallel: false,
	timeout: 180_000,
	expect: { timeout: 15_000 },
	reporter: [["list"], ["html", { open: "never" }], ["json", { outputFile: "test-results/results.json" }]],
	use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
});
