import { signInNotice, syncNotice } from "./notices";

const counts = { created: 1, updated: 2, edited: 3, processing: 4, errors: 5 };

describe("syncNotice", () => {
	it("reports every count of a finished run", () => {
		expect(syncNotice({ kind: "done", counts })).toBe("Readplace: 1 created, 2 updated, 3 left as edited, 4 still processing, 5 skipped");
	});

	it("asks the reader to sign in again", () => {
		expect(syncNotice({ kind: "signed-out", counts })).toBe("Readplace: sign in again from Settings → Readplace");
	});

	it("names why a run paused", () => {
		expect(syncNotice({ kind: "unavailable", reason: "rate-limited", counts })).toBe("Readplace: sync paused (rate-limited), it will try again on the next run");
	});

	it("says when a run is already going", () => {
		expect(syncNotice({ kind: "already-running" })).toBe("Readplace: a sync is already running");
	});
});

describe("signInNotice", () => {
	it.each([
		[{ kind: "signed-in" } as const, "Readplace: signed in. Choose Sync now in Settings → Readplace to copy your articles"],
		[{ kind: "denied", error: "access_denied" } as const, "Readplace: sign-in cancelled, nothing was connected"],
		[{ kind: "no-pending-sign-in" } as const, "Readplace: start the sign-in again from Settings → Readplace"],
		[{ kind: "state-mismatch" } as const, "Readplace: this sign-in link does not match the one you started. Start again from Settings → Readplace"],
		[{ kind: "exchange-failed", status: 400 } as const, "Readplace: sign-in failed (400). Start again from Settings → Readplace"],
		[{ kind: "unavailable", status: "network" } as const, "Readplace: sign-in is unavailable right now (network), try again later"],
	])("words %j", (outcome, notice) => {
		expect(signInNotice(outcome)).toBe(notice);
	});
});
