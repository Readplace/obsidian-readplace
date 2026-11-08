# Readplace for Obsidian

Copies the articles you've saved in [Readplace](https://readplace.com) into your vault as Markdown notes.

## What it does

- Syncs every save in your Readplace account. There's no choice of readlist or tab: every article you've saved becomes 1 note.
- Writes each article as one Markdown note in a single folder, `Readplace` by default. The note holds the document Readplace returns: properties, the AI summary once it's ready, and the full text as Markdown.
- Syncs every 60 minutes while Obsidian is open, and whenever you run **Sync now**.
- Shows a notice with what a sync did: created, updated, left as edited, still processing and skipped.

## What it does not do

- It doesn't sync highlights or notes.
- It doesn't write tags or an author. A note has a published date only when one is known.
- It doesn't sync a subset of your saves. Saves in every readlist come across.
- Sync goes one way, into the vault. Changes in Obsidian don't reach Readplace.
- A note you edit is yours. The plugin stops updating it, so a summary that arrives later won't reach it.
- It never deletes notes. Removing an article in Readplace leaves its note in place.
- An article still being processed arrives with its properties and little or no text. It fills in on a later sync, as long as you haven't edited the note.

## Requirements

- A Readplace account.
- Obsidian 1.11.4 or later, on desktop. The plugin doesn't run on Obsidian's mobile apps yet.

## Setup

The plugin isn't in Obsidian's community directory yet, so it's installed from source:

1. Run `npm ci` and `npm run build` in this repository.
2. Copy `main.js` and `manifest.json` into `.obsidian/plugins/readplace/` inside your vault.
3. In Obsidian, open **Settings → Community plugins** and turn on **Readplace**.

Then connect your account:

1. Open **Settings → Readplace** and choose **Sign in**, or **Create account** if you don't have one. Readplace opens in your browser.
2. Approve the connection, then choose **Return to Obsidian**.
3. Run **Sync now**.

## Settings

| Setting | Default | What it does |
|---|---|---|
| Sign in, Create account, Sign out | Signed out | Connects this vault to your account. Signing out leaves your notes where they are. |
| Folder | `Readplace` | Where new notes go. Notes already synced stay where they are. |
| Sync every 60 minutes while Obsidian is open | On | Runs in the background and shows a notice only when something changed. |
| Sync when Obsidian opens | Off | Off by default, because creating notes at startup can conflict with Obsidian Sync. |
| Sync now | | Copies new and changed articles into your vault. |
| Refresh all notes | | Rewrites every note you haven't edited, including the readlists each article sits in. Run it by hand; nothing schedules it. |

The commands are **Sync now**, **Refresh all notes**, **Sign in** and **Sign out**. None has a default hotkey.

## How notes are updated

The plugin stores a SHA-256 hash of what it last wrote to each note, and compares it before every write.

| Situation | What the plugin does |
|---|---|
| A new article | Creates the note. If a file you own has that name, the note gets a ` (2)` suffix, and so on. It never overwrites an unknown file. |
| The note is unchanged since the last write, and the article changed | Rewrites the note. |
| The note has been edited | Leaves it alone and counts it as edited in the notice. |
| The note was removed from the vault | Doesn't recreate it. |
| The article is no longer in Readplace | Leaves the note alone. |

A sync fetches an article again when Readplace reports a change to its content, summary, title, reading status or read date. If the title changes on an unedited note that still has its original name, the note is renamed and Obsidian updates links to it.

A note you move or rename while the plugin is running keeps receiving updates. A note moved while the plugin is off, or on another device, counts as removed.

## Account and payment

The plugin is free. It needs a Readplace account, which has a 14-day trial with no card, then a subscription. A lapsed account is read-only and still syncs.

## Network use

The plugin talks to `readplace.com` for:

- sign-in, which happens in your browser
- token exchange and revocation
- listing your articles
- downloading each note

The plugin only reads your articles. Its token has the same access as every Readplace app, because Readplace has one access level.

Images in a note stay as links, so they load from their own hosts when Obsidian renders the note.

## Server-side data

Readplace's server logs requests and records sign-in events with the client id. See the [privacy page](https://readplace.com/privacy).

## No client-side telemetry

The plugin has no analytics or usage tracking, and sends only the requests listed under [Network use](#network-use). Sign-in tokens stay in Obsidian's secret storage. Article ids, titles, note paths, hashes and reading status stay in the plugin's data file in your vault.

## Security reports

Report a security issue through the [support page](https://readplace.com/support).

## Validation

The desktop automation opens the real Obsidian application in a separate test vault. It uses Playwright for the settings and consent pages, and the operating system's `obsidian://` handler for the sign-in callback. It checks pagination, repeated sync, existing files, reader edits, deleted notes, renames and backlinks, credentials across a restart, token refresh, rate limiting, and revocation.

The HTTP server in this suite is a controlled fixture. It checks the application's integration with Obsidian; it does not establish that a deployed Readplace environment works. The first sign-in uses the original browser-opening action and checks that the system browser reaches the authorization page. Later sign-ins capture the browser-opening intent and open consent with Playwright. The browser's external-app confirmation still needs a separate check.

The [recorded macOS run](./docs/automation/macos.json) passed. The Desktop E2E workflow runs the same suite on macOS, Windows, and Linux's Debian and AppImage distributions, and uploads screenshots and results. See [Contributing](./CONTRIBUTING.md) for running it locally. Mobile, live staging and production authentication, two-device Obsidian Sync, and a live 2,000-save benchmark remain release checks.

An optional [2,000-article macOS run](./docs/automation/macos-2000-articles.json) wrote 26.2 MB of fixture Markdown in 21.2 seconds. Its repeated sync took 3.0 seconds and downloaded no Markdown. These timings describe a local fixture with two articles per page; they do not predict live-account performance.

## License

[MIT](./LICENSE), copyright Proficient Pty Ltd.
