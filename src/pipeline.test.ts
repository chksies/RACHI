import { describe, expect, it } from "vitest";
import { classify } from "./classifier.js";
import { companyKey } from "./dedup.js";
import { openDb } from "./db.js";
import { parseEmail } from "./parsers/index.js";
import { processEmail, resolveReview } from "./pipeline.js";
import type { RawEmail } from "./types.js";

const mail = (over: Partial<RawEmail>): RawEmail => ({
  id: Math.random().toString(36).slice(2),
  from: "no-reply@example.com",
  subject: "",
  body: "",
  date: new Date("2026-10-03T12:00:00Z"),
  ...over,
});

describe("parsers", () => {
  it("ashby (subject names role and company)", () => {
    const p = parseEmail(mail({ from: "Render <no-reply@ashbyhq.com>", subject: "Application Received — Software Engineer, Dev Velocity (all levels) at Render" }));
    expect(p).toMatchObject({ company: "Render", role: "Software Engineer, Dev Velocity (all levels)", source: "ashby" });
  });
  it("ashby (pipe format strips the repeated company from the role)", () => {
    const p = parseEmail(mail({ from: "Quora Recruiting <no-reply@ashbyhq.com>", subject: "Quora | Thank you for applying! | Software Engineer New Grad - Quora (Remote)" }));
    expect(p).toMatchObject({ company: "Quora", role: "Software Engineer New Grad", source: "ashby" });
  });
  it("ashby (company only in the subject, hiring-team sender)", () => {
    expect(parseEmail(mail({ from: "Amplitude Hiring Team <no-reply@ashbyhq.com>", subject: "Thank you for Applying to Amplitude" }))).toMatchObject({ company: "Amplitude" });
  });
  it("lever", () => {
    const p = parseEmail(mail({ from: "Betstamp <no-reply@hire.lever.co>", subject: "Thanks for your interest in Betstamp, Chukwuemeka" }));
    expect(p).toMatchObject({ company: "Betstamp", role: null, source: "lever" });
  });
  it("workday (company from the sender)", () => {
    expect(parseEmail(mail({ from: "CAE <cae@myworkday.com>", subject: "Thank You for Your Application" }))).toMatchObject({ company: "CAE", source: "workday" });
    expect(parseEmail(mail({ from: "interac@myworkday.com", subject: "Thank you for applying!" }))).toMatchObject({ company: "Interac" });
  });
  it("workday (role and company in the subject)", () => {
    const p = parseEmail(mail({ from: "noreply workday <x@myworkday.com>", subject: "Application Received for Software Developer Intern at Perseus Group" }));
    expect(p).toMatchObject({ company: "Perseus Group", role: "Software Developer Intern" });
  });
  it("icims (location in the subject, company from the sender, noise stripped)", () => {
    const p = parseEmail(mail({ from: "Designer Brands Canada @ icims <jobs@icims.com>", subject: "Thank you for applying at CA-PE-Charlottetown" }));
    expect(p).toMatchObject({ company: "Designer Brands Canada", location: "CA-PE-Charlottetown", source: "icims" });
  });
  it("greenhouse", () => {
    expect(parseEmail(mail({ from: "no-reply@us.greenhouse-mail.io", subject: "Thanks for applying to Toast!" }))).toMatchObject({ company: "Toast", source: "greenhouse" });
    expect(parseEmail(mail({ from: "no-reply@us.greenhouse-mail.io", subject: "Your application for Software Engineering Intern 2027 (Toronto) at Pinterest" }))).toMatchObject({ company: "Pinterest", role: "Software Engineering Intern 2027 (Toronto)" });
    expect(parseEmail(mail({ from: "no-reply@us.greenhouse-mail.io", subject: "An update on your application to Canonical - Cloud Field Engineer" }))).toMatchObject({ company: "Canonical", role: "Cloud Field Engineer" });
  });
  it("returns null when nothing names a company", () => {
    expect(parseEmail(mail({ subject: "Hello there" }))).toBeNull();
  });
});

describe("classifier", () => {
  it("flags rejections", () => {
    expect(classify(mail({ subject: "Update", body: "We are moving forward with other candidates." })).kind).toBe("rejection");
  });
  it("treats unrelated mail as noise", () => {
    expect(classify(mail({ subject: "50% off shoes", body: "sale" })).kind).toBe("noise");
  });
});

describe("dedup + pipeline", () => {
  it("normalizes company names", () => {
    expect(companyKey("Greenhouse Software, Inc.")).toBe(companyKey("greenhouse"));
  });

  it("creates once, then flips status on rejection instead of duplicating", () => {
    const db = openDb(":memory:");
    const confirm = mail({ subject: "Application Received — Engineer at Render", from: "Render <x@ashbyhq.com>", body: "Thank you for applying" });
    expect(processEmail(db, confirm)).toBe("created");
    expect(processEmail(db, confirm)).toBe("skipped"); // same Gmail id

    const reject = mail({ from: "Render <jobs@ashbyhq.com>", subject: "Your application to Render", body: "Unfortunately we are moving forward with other candidates." });
    expect(processEmail(db, reject)).toBe("updated");

    const rows = db.prepare("SELECT status FROM applications").all() as { status: string }[];
    expect(rows).toEqual([{ status: "rejected" }]);
  });

  it("logs a rejection for an application whose confirmation was never seen", () => {
    const db = openDb(":memory:");
    const m = mail({ from: "Superhuman Hiring Team <no-reply@ashbyhq.com>", subject: "Update on your application to Superhuman", body: "Unfortunately we are not moving forward." });
    expect(processEmail(db, m)).toBe("created");
    expect(db.prepare("SELECT company, status, date_applied FROM applications").all()).toEqual([{ company: "Superhuman", status: "rejected", date_applied: null }]);
  });

  it("ignores security-code mail from an ATS", () => {
    const db = openDb(":memory:");
    expect(processEmail(db, mail({ from: "Greenhouse <no-reply@us.greenhouse-mail.io>", subject: "Security code for your application to 2K Early Careers" }))).toBe("noise");
  });

  it("queues unparseable job mail instead of dropping it", () => {
    const db = openDb(":memory:");
    const m = mail({ from: "hr@unknown.com", subject: "Interview with Foo Corp", body: "Please share your availability for an interview" });
    expect(processEmail(db, m)).toBe("queued");
    expect(db.prepare("SELECT COUNT(*) AS n FROM review_queue").get()).toEqual({ n: 1 });
  });

  it("does not let a late confirmation undo a rejection", () => {
    const db = openDb(":memory:");
    processEmail(db, mail({ from: "Stripe <x@ashbyhq.com>", subject: "Application Received — Engineer at Stripe", body: "thank you for applying" }));
    processEmail(db, mail({ from: "Stripe <a@greenhouse.io>", subject: "Stripe update", body: "Unfortunately we are not moving forward" }));
    processEmail(db, mail({ from: "Stripe <x@ashbyhq.com>", subject: "Application Received — Engineer at Stripe", body: "thank you for applying" }));
    expect(db.prepare("SELECT status FROM applications").all()).toEqual([{ status: "rejected" }]);
  });
});

describe("resolveReview", () => {
  const queue = (db: ReturnType<typeof openDb>) => {
    const m = mail({ from: "Human Resources <do_not_reply@clearcompany.com>", subject: "Application Received", body: "We have received your application" });
    expect(processEmail(db, m)).toBe("queued");
    return m.id;
  };

  it("files a queued email as a new applied application", () => {
    const db = openDb(":memory:");
    const id = queue(db);
    expect(resolveReview(db, id, { company: "Acme Corp", role: "Analyst", status: "applied" })).toBe("created");
    expect(db.prepare("SELECT company, role, status, date_applied FROM applications").all()).toEqual([
      { company: "Acme Corp", role: "Analyst", status: "applied", date_applied: "2026-10-03" },
    ]);
    expect(db.prepare("SELECT resolved FROM review_queue").get()).toEqual({ resolved: 1 });
  });

  it("moves an existing application to the chosen status instead of duplicating", () => {
    const db = openDb(":memory:");
    processEmail(db, mail({ from: "Acme <x@ashbyhq.com>", subject: "Application Received — Analyst at Acme", body: "thank you for applying" }));
    const id = queue(db);
    expect(resolveReview(db, id, { company: "acme", status: "interviewing" })).toBe("updated");
    expect(db.prepare("SELECT status FROM applications").all()).toEqual([{ status: "interviewing" }]);
  });

  it("cannot be resolved twice", () => {
    const db = openDb(":memory:");
    const id = queue(db);
    resolveReview(db, id, { company: "Acme", status: "rejected" });
    expect(resolveReview(db, id, { company: "Acme", status: "rejected" })).toBe("not_found");
  });
});

describe("resolveReview without a typed company", () => {
  const queueMail = (db: ReturnType<typeof openDb>, from: string, subject: string) => {
    const m = mail({ from, subject, body: "We have received your application" });
    expect(processEmail(db, m)).toBe("queued");
    return m.id;
  };
  const company = (db: ReturnType<typeof openDb>) => (db.prepare("SELECT company FROM applications").get() as { company: string }).company;

  it("uses a company we already track when it appears in the email", () => {
    const db = openDb(":memory:");
    processEmail(db, mail({ from: "Veeva Systems <x@ashbyhq.com>", subject: "Application Received — Analyst at Veeva Systems", body: "thank you for applying" }));
    db.prepare("INSERT INTO review_queue (gmail_message_id, sender, subject, kind, received_at) VALUES (?, ?, ?, ?, ?)").run(
      "q1", "Veeva Systems <no-reply@hire.lever.co>", "Update on Your Application at Veeva", "status", "2026-10-08T00:00:00Z",
    );
    expect(resolveReview(db, "q1", { status: "rejected" })).toBe("updated");
    expect(db.prepare("SELECT status FROM applications").all()).toEqual([{ status: "rejected" }]);
  });

  it("falls back to the sender's domain", () => {
    const db = openDb(":memory:");
    const id = queueMail(db, "careers@talent.autodesk.com", "Chukwuemeka, we have received your application");
    resolveReview(db, id, { status: "applied" });
    expect(company(db)).toBe("Autodesk");
  });

  it("never invents an employer from an ATS domain", () => {
    const db = openDb(":memory:");
    const id = queueMail(db, "notify@dayforce.com", "Customer Service Specialist Application Confirmation");
    resolveReview(db, id, { status: "applied" });
    expect(company(db)).toBe("Unknown");
  });
});
