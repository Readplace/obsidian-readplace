/** @type {import('jest').Config} */
module.exports = {
	testEnvironment: "node",
	transform: { "^.+\\.ts$": ["ts-jest", { tsconfig: { module: "commonjs" } }] },
	testMatch: ["<rootDir>/src/**/*.test.ts"],
	collectCoverage: true,
	coverageProvider: "v8",
	collectCoverageFrom: ["src/**/*.ts", "!src/**/*.test.ts"],
	coverageThreshold: { global: { branches: 100, functions: 100, lines: 100, statements: 100 } },
};
