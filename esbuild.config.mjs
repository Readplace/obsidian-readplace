import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import esbuild from "esbuild";

const production = process.argv[2] === "production";
const serverOrigin = process.env.READPLACE_SERVER_ORIGIN ?? "https://readplace.com";
const [pluginLicense, zodLicense] = await Promise.all([
	readFile(new URL("./LICENSE", import.meta.url), "utf8"),
	readFile(new URL("./node_modules/zod/LICENSE", import.meta.url), "utf8"),
]);

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	define: { READPLACE_SERVER_ORIGIN: JSON.stringify(serverOrigin) },
	bundle: true,
	banner: { js: `/*!\nReadplace for Obsidian\n\n${pluginLicense.trim()}\n\nZod\n\n${zodLicense.trim()}\n*/` },
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		...builtinModules,
	],
	format: "cjs",
	target: "es2021",
	logLevel: "info",
	sourcemap: production ? false : "inline",
	minify: production,
	treeShaking: true,
	outfile: "main.js",
});

if (production) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
