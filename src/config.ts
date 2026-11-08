declare const READPLACE_SERVER_ORIGIN: string | undefined;

export const SERVER_ORIGIN = typeof READPLACE_SERVER_ORIGIN === "undefined" ? "https://readplace.com" : READPLACE_SERVER_ORIGIN;
export const OAUTH_CLIENT_ID = "obsidian-plugin";
export const OAUTH_REDIRECT_URI = `${SERVER_ORIGIN}/oauth/obsidian`;
export const OAUTH_PROTOCOL_ACTION = "readplace-auth";
export const AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";
export const SECRET_IDS = { accessToken: "readplace-access-token", refreshToken: "readplace-refresh-token" } as const;
export const SIREN_MEDIA_TYPE = "application/vnd.siren+json";
export const MARKDOWN_MEDIA_TYPE = "text/markdown";
export const DEFAULT_NOTES_FOLDER = "Readplace";
export const AUTOMATIC_SYNC_INTERVAL_MINUTES = 60;
export const MAX_REDIRECT_HOPS = 5;
