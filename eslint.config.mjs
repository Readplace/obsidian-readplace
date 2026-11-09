import obsidianmd from "eslint-plugin-obsidianmd";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
	globalIgnores(["node_modules", "coverage", "test-results", "playwright-report", "main.js", "esbuild.config.mjs", "version-bump.mjs", "versions.json", "package.json", "package-lock.json", "tsconfig.json", "jest.config.js"]),
	{
		files: ["src/**/*.ts"],
		extends: obsidianmd.configs.recommended,
	},
	{
		files: ["manifest.json"],
		plugins: { obsidianmd },
		languageOptions: { parser: tseslint.parser },
		rules: { "obsidianmd/validate-manifest": "warn" },
	},
	{
		files: ["eslint.config.mjs", "playwright.config.mjs", "e2e/**/*.mjs"],
		extends: [js.configs.recommended],
		languageOptions: {
			globals: { ...globals.node },
		},
	},
	{
		files: ["e2e/**/*.mjs"],
		languageOptions: {
			globals: { ...globals.browser, app: "readonly" },
		},
	},
	{
		files: ["e2e/**/*.spec.mjs"],
		rules: {
			"no-empty-pattern": ["error", { allowObjectPatternsAsParameters: true }],
		},
	},
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			globals: { ...globals.browser },
			parserOptions: {
				projectService: { allowDefaultProject: ["eslint.config.mjs", "manifest.json"] },
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: [".json"],
			},
		},
	},
	{
		files: ["src/main.ts"],
		rules: {
			"@typescript-eslint/no-deprecated": "off",
		},
	},
	{
		files: ["src/**/*.test.ts"],
		languageOptions: {
			globals: { ...globals.jest },
		},
	},
]);
