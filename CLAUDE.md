# Readplace for Obsidian

An Obsidian community plugin that copies a reader's Readplace saves into their vault. `ls src` and the `package.json` scripts show the layout and the commands. The [README](./README.md) states what the plugin promises readers; keep every claim there true of the code.

## Binding conventions

| Rule | Why |
|---|---|
| Ports are injected, and only the composition root value-imports `obsidian` | The `obsidian` npm package is types only, with no runtime module. A value import anywhere else can't load under test. |
| No `node:*` imports | The plugin runs on mobile (`isDesktopOnly` is false), where Node isn't available. Mobile support is pending verification on a device. |
| zod at the HTTP boundary with `safeParse`, never for internal types; parse the response text, not `json` | Server responses are the only untyped input, and the `json` getter is typed `any`. |
| No `as`, except `as const` and a test fake bound to a fixed signature | A cast hides an upstream type change. |
| Named parameters where 2 consecutive parameters share a type | Swapped positional arguments compile. |
| Invariants use the plugin's own assert module | `node:assert` is off limits, and an assert leaves no uncovered branch in the caller. |
| No code comments without human approval | Prefer a clearer name, a type or a test. |
| 100% coverage, with one `c8 ignore`: the composition root | The composition root has nothing but wiring. Jest counts a never-loaded file as 0%, so a type-only module needs a test that loads it. |
| No `jest.mock`; an HTTP fake takes an explicit status | Fakes through the ports test the real seam, and a boolean hides which failure is simulated. |
| No new script, workflow or dependency without human approval | The set in the repo was approved as a set. |

## Hypermedia contract

The plugin reads Readplace's Siren API. Installed copies update only when readers choose to, so it has to tolerate server change.

- Hrefs are opaque: follow what the server sends, and never build one, including a page parameter.
- Every href goes through the one resolver. A scheme other than `http` or `https` counts as no href.
- `rel` is the only published discriminator.
- Nothing persists across runs but the sync state. v1 syncs every save and stores no tab or readlist href.
- Parse leniently: a malformed entity is skipped, not fatal.

## Obsidian facts that shape the code

| Fact | Consequence |
|---|---|
| `requestUrl` throws on 400+ by default | Every call passes `throw: false`, or the 401 refresh and the 404 skip become exceptions. |
| `requestUrl` doesn't document header case or redirects | Look headers up case-insensitively, and follow a returned 3xx with the bearer. |
| The `Vault.process` callback is synchronous, and `crypto.subtle` isn't | Hash before the call, then compare strings inside the callback, so a concurrent edit wins. |
| `SecretStorage` is synchronous and has no delete | Sign-out stores `""`, and `""` and `null` both mean signed out. |
| The ESLint plugin refuses inline disables of its rules | Change a rule in the lint config, or change the code. |

## Reader-facing rules

- Note content is exactly what the server returns. The plugin adds nothing.
- The plugin never deletes a note, and never overwrites a note it didn't write or one the reader edited.
- Requests run one at a time, with no retries inside a run. That sequence is the pacing the server relies on.
- No client-side telemetry, and no request the README doesn't list.
- UI text goes through `createEl` and `setText`, never `innerHTML`. Server messages are plain text.
- Settings use sentence case, with no top-level heading.

## Public copy

The README and all UI text follow Readplace's voice: impersonal, specific, no superlatives, contractions, sentence case, and no person named. Readplace is the actor, never "we". Links to readplace.com stay untagged until a UTM vocabulary is approved.

## Releases

A tag must equal the manifest version with no `v` prefix, which `npm version` produces through the repo's npm config. `main.js` is built by the release workflow and never committed. No `styles.css` ships, so it must not appear in the release steps.
