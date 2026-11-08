import type { SignInOutcome } from "../auth/sign-in";
import type { SyncResult } from "../sync/run-sync";

export const SIGNED_OUT_NOTICE = "Readplace: signed out";
export const SYNC_FAILED_NOTICE = "Readplace: sync stopped by an error, it will try again on the next run";

export function syncNotice(result: Exclude<SyncResult, { kind: "stopped" }>): string {
	switch (result.kind) {
		case "done": {
			const { created, updated, edited, processing, errors } = result.counts;
			return `Readplace: ${created} created, ${updated} updated, ${edited} left as edited, ${processing} still processing, ${errors} skipped`;
		}
		case "signed-out":
			return "Readplace: sign in again from Settings → Readplace";
		case "unavailable":
			return `Readplace: sync paused (${result.reason}), it will try again on the next run`;
		case "already-running":
			return "Readplace: a sync is already running";
	}
}

export function signInUnavailableNotice(status: number | string): string {
	return `Readplace: sign-in is unavailable right now (${status}), try again later`;
}

export function signInNotice(outcome: SignInOutcome): string {
	switch (outcome.kind) {
		case "signed-in":
			return "Readplace: signed in. Choose Sync now in Settings → Readplace to copy your articles";
		case "denied":
			return "Readplace: sign-in cancelled, nothing was connected";
		case "no-pending-sign-in":
			return "Readplace: start the sign-in again from Settings → Readplace";
		case "state-mismatch":
			return "Readplace: this sign-in link does not match the one you started. Start again from Settings → Readplace";
		case "exchange-failed":
			return `Readplace: sign-in failed (${outcome.status}). Start again from Settings → Readplace`;
		case "unavailable":
			return signInUnavailableNotice(outcome.status);
	}
}
