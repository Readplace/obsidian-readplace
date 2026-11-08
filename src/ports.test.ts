describe("ports", () => {
	it("exports types only, so nothing but the composition root binds an implementation", async () => {
		const ports = await import("./ports");

		expect(Object.keys(ports)).toEqual([]);
	});
});
