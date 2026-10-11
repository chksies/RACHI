import { google } from "googleapis";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/** Read-only: the app cannot send, modify or delete mail. */
export const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

export function tokenPath(): string {
  return process.env.GOOGLE_TOKEN_PATH ?? "token.json";
}

export function createOAuthClient() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    throw new Error("Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI in .env");
  }
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}

/** Load the saved tokens and persist refreshed ones, so the user never logs in twice. */
export function loadAuthorizedClient() {
  const path = tokenPath();
  if (!existsSync(path)) throw new Error(`No ${path} found. Run "npm run auth" first.`);
  const client = createOAuthClient();
  client.setCredentials(JSON.parse(readFileSync(path, "utf8")));
  client.on("tokens", (fresh) => {
    const merged = { ...JSON.parse(readFileSync(path, "utf8")), ...fresh };
    writeFileSync(path, JSON.stringify(merged, null, 2));
  });
  return client;
}
