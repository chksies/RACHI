import { google, type gmail_v1 } from "googleapis";

import type { createOAuthClient } from "./auth.js";

type OAuth2Client = ReturnType<typeof createOAuthClient>;
import type { RawEmail } from "../types.js";

function header(msg: gmail_v1.Schema$Message, name: string): string {
  return msg.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function decode(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Prefer text/plain, fall back to stripped text/html, walking nested multipart parts. */
function extractBody(part: gmail_v1.Schema$MessagePart | undefined): string {
  if (!part) return "";
  const plain: string[] = [];
  const html: string[] = [];
  const walk = (p: gmail_v1.Schema$MessagePart) => {
    if (p.body?.data && p.mimeType === "text/plain") plain.push(decode(p.body.data));
    else if (p.body?.data && p.mimeType === "text/html") html.push(stripHtml(decode(p.body.data)));
    p.parts?.forEach(walk);
  };
  walk(part);
  return (plain.length ? plain : html).join("\n").trim();
}

export function toRawEmail(msg: gmail_v1.Schema$Message): RawEmail {
  return {
    id: msg.id!,
    from: header(msg, "From"),
    subject: header(msg, "Subject"),
    body: extractBody(msg.payload),
    date: new Date(Number(msg.internalDate ?? Date.now())),
  };
}

/** users.messages.list for IDs, then users.messages.get for each full message. */
export async function fetchRecent(auth: OAuth2Client, newerThanDays: number): Promise<RawEmail[]> {
  const gmail = google.gmail({ version: "v1", auth });
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const res = await gmail.users.messages.list({
      userId: "me",
      q: `newer_than:${newerThanDays}d`,
      maxResults: 100,
      pageToken,
    });
    res.data.messages?.forEach((m) => m.id && ids.push(m.id));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return ids.length ? fetchByIds(auth, ids) : [];
}

export async function fetchByIds(auth: OAuth2Client, ids: string[]): Promise<RawEmail[]> {
  const gmail = google.gmail({ version: "v1", auth });
  const emails: RawEmail[] = [];
  for (const id of ids) {
    const res = await gmail.users.messages.get({ userId: "me", id, format: "full" });
    emails.push(toRawEmail(res.data));
  }
  return emails;
}
