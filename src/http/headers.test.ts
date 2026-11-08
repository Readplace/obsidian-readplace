import { headerOf, mediaTypeOf } from "./headers";

describe("headerOf", () => {
	it("finds a header whatever the case of its key", () => {
		expect(headerOf({ "Content-Type": "text/markdown" }, "content-type")).toBe("text/markdown");
	});

	it("answers undefined for a header the response lacks", () => {
		expect(headerOf({ Location: "/next" }, "content-type")).toBeUndefined();
	});
});

describe("mediaTypeOf", () => {
	it("keeps only the lower-cased part before the parameters", () => {
		expect(mediaTypeOf(" Text/Markdown ; charset=utf-8")).toBe("text/markdown");
	});

	it("answers an empty string when the header is absent", () => {
		expect(mediaTypeOf(undefined)).toBe("");
	});
});
