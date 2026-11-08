import { builtinModules } from "node:module";
import esbuild from "esbuild";

const production = process.argv[2] === "production";
const serverOrigin = process.env.READPLACE_SERVER_ORIGIN ?? "https://readplace.com";

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	define: { READPLACE_SERVER_ORIGIN: JSON.stringify(serverOrigin) },
	bundle: true,
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
