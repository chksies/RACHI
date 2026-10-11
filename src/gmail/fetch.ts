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

// Narrow the mailbox to likely job mail so we spend quota on relevant messages only.
const ATS_SENDERS = ["lever.co", "ashbyhq.com", "myworkday.com", "greenhouse.io", "greenhouse-mail.io", "icims.com", "smartrecruiters.com", "workable.com"];
const JOB_TERMS = ["application", "applying", "applied", "interview", "candidacy", "candidate", "recruiter", "assessment", "your candidacy"];

export function jobQuery(newerThanDays: number): string {
  const from = ATS_SENDERS.map((d) => `from:${d}`).join(" OR ");
  const terms = JOB_TERMS.map((t) => (t.includes(" ") ? `"${t}"` : `subject:${t}`)).join(" OR ");
  return `newer_than:${newerThanDays}d (${from} OR ${terms}) -category:promotions -category:social`;
}

/** users.messages.list: IDs only, which is cheap. Full messages are fetched one at a time later. */
export async function listJobMessageIds(auth: OAuth2Client, newerThanDays: number): Promise<string[]> {
  const gmail = google.gmail({ version: "v1", auth });
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const res = await withBackoff(() =>
      gmail.users.messages.list({ userId: "me", q: jobQuery(newerThanDays), maxResults: 100, pageToken }),
    );
    res.data.messages?.forEach((m) => m.id && ids.push(m.id));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return ids;
}

export async function fetchEmail(auth: OAuth2Client, id: string): Promise<RawEmail> {
  const gmail = google.gmail({ version: "v1", auth });
  const res = await withBackoff(() => gmail.users.messages.get({ userId: "me", id, format: "full" }));
  return toRawEmail(res.data);
}

function isRateLimit(err: unknown): boolean {
  const e = err as { code?: number; message?: string };
  return e?.code === 429 || /quota|rate limit/i.test(e?.message ?? "");
}

/** Retry with exponential backoff when Gmail throttles us (per-minute quota). */
async function withBackoff<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimit(err) || i >= attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, Math.min(60_000, 2_000 * 2 ** i)));
    }
  }
}
