import { base64Url, challengeFor, createVerifier, randomState } from "./pkce";

const filledWith = (value: number) => (length: number) => new Uint8Array(length).fill(value);

describe("base64Url", () => {
	it("uses the URL alphabet and drops the padding", () => {
		expect(base64Url(new Uint8Array([0xfb, 0xff, 0xfe, 0xff]))).toBe("-__-_w");
	});
});

describe("createVerifier", () => {
	it("encodes 32 injected bytes as 43 base64url characters", () => {
		const verifier = createVerifier(filledWith(0xff));

		expect(verifier).toBe("_".repeat(42) + "8");
		expect(verifier).toHaveLength(43);
	});
});

describe("challengeFor", () => {
	it("matches the RFC 7636 Appendix B vector", async () => {
		const challenge = await challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");

		expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
	});
});

describe("randomState", () => {
	it("encodes 16 injected bytes as 22 base64url characters", () => {
		expect(randomState(filledWith(0))).toBe("A".repeat(22));
	});
});
