import { google } from "googleapis";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createOAuthClient, SCOPES, tokenPath } from "./auth.js";

// One-time consent flow: prints a Google URL, catches the redirect on a local port,
// and stores the access + refresh tokens in token.json.
const client = createOAuthClient();
const redirect = new URL(process.env.GOOGLE_REDIRECT_URI!);

const authUrl = client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent", // guarantees a refresh token is issued
  scope: SCOPES,
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", redirect.origin);
  if (url.pathname !== redirect.pathname) {
    res.writeHead(404).end();
    return;
  }
  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400).end("Missing code");
    return;
  }
  try {
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    // Refuse to store tokens for any mailbox other than the configured one.
    const expected = process.env.GMAIL_ACCOUNT?.trim().toLowerCase();
    const profile = await google.gmail({ version: "v1", auth: client }).users.getProfile({ userId: "me" });
    const actual = profile.data.emailAddress?.toLowerCase();
    if (expected && actual !== expected) {
      res.writeHead(403).end("Wrong Google account. Sign in as the account set in GMAIL_ACCOUNT.");
      console.error(`Signed in as ${actual}, expected ${expected}. Tokens not saved.`);
      return;
    }

    writeFileSync(tokenPath(), JSON.stringify(tokens, null, 2));
    res.end("RACHI is connected. You can close this tab.");
    console.log(`Saved tokens for ${actual} to ${tokenPath()}`);
  } catch (err) {
    res.writeHead(500).end("Token exchange failed");
    console.error(err);
  } finally {
    server.close();
  }
});

server.listen(Number(redirect.port || 80), () => {
  console.log("Open this URL in your browser and grant read-only Gmail access:\n");
  console.log(authUrl);
});
