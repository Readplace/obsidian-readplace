import { assert } from "./assert";

describe("assert", () => {
	it("returns when the condition is truthy", () => {
		expect(assert(true, "unused")).toBeUndefined();
	});

	it("throws the message when the condition is falsy", () => {
		expect(() => assert(false, "the invariant broke")).toThrow("the invariant broke");
	});
});
