import { readFileSync, writeFileSync } from "node:fs";

const version = process.env.npm_package_version;

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
manifest.version = version;
writeFileSync("manifest.json", `${JSON.stringify(manifest, null, "\t")}\n`);

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
if (!(version in versions)) {
	versions[version] = manifest.minAppVersion;
	writeFileSync("versions.json", `${JSON.stringify(versions, null, "\t")}\n`);
}
