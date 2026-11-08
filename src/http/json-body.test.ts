import { z } from "zod";
import { parseJsonBody } from "./json-body";

const Shape = z.object({ name: z.string() });

describe("parseJsonBody", () => {
	it("answers the parsed value and lets unknown keys pass", () => {
		expect(parseJsonBody(Shape, '{"name":"reader","extra":1}')).toEqual({ name: "reader" });
	});

	it("answers undefined for text that is not JSON", () => {
		expect(parseJsonBody(Shape, "Too many requests")).toBeUndefined();
	});

	it("answers undefined for JSON of the wrong shape", () => {
		expect(parseJsonBody(Shape, '{"name":1}')).toBeUndefined();
	});
});
