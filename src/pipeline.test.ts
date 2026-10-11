import { describe, expect, it } from "vitest";
import { classify } from "./classifier.js";
import { companyKey } from "./dedup.js";
import { openDb } from "./db.js";
import { parseEmail } from "./parsers/index.js";
import { processEmail } from "./pipeline.js";
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
  it("ashby", () => {
    const p = parseEmail(mail({ subject: "Application Received — Software Engineer, Dev Velocity (all levels) at Render" }));
    expect(p).toMatchObject({ company: "Render", role: "Software Engineer, Dev Velocity (all levels)", source: "ashby" });
  });
  it("lever", () => {
    const p = parseEmail(mail({ subject: "Thank you for your application to Mechanical Orchard", body: "applying for the Data Engineer position" }));
    expect(p).toMatchObject({ company: "Mechanical Orchard", role: "Data Engineer", source: "lever" });
  });
  it("workday", () => {
    const p = parseEmail(mail({ from: "CAE <cae@myworkday.com>", subject: "Thank You for Your Application" }));
    expect(p).toMatchObject({ company: "CAE", source: "workday" });
  });
  it("icims", () => {
    const p = parseEmail(mail({ from: "Designer Brands Careers <jobs@icims.com>", subject: "Thank you for applying at CA-PE-Charlottetown" }));
    expect(p).toMatchObject({ company: "Designer Brands", location: "CA-PE-Charlottetown", source: "icims" });
  });
  it("greenhouse", () => {
    const p = parseEmail(mail({ subject: "Thank you for applying to the Software Engineer role at Greenhouse!" }));
    expect(p).toMatchObject({ company: "Greenhouse", role: "Software Engineer", source: "greenhouse" });
  });
  it("returns null for unknown formats", () => {
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
    const confirm = mail({ subject: "Application Received — Engineer at Render", from: "x@ashbyhq.com", body: "Thank you for applying" });
    expect(processEmail(db, confirm)).toBe("created");
    expect(processEmail(db, confirm)).toBe("skipped"); // same Gmail id

    const reject = mail({ from: "Render <jobs@ashbyhq.com>", subject: "Your application to Render", body: "Unfortunately we are moving forward with other candidates." });
    expect(processEmail(db, reject)).toBe("updated");

    const rows = db.prepare("SELECT status FROM applications").all() as { status: string }[];
    expect(rows).toEqual([{ status: "rejected" }]);
  });

  it("queues unparseable job mail instead of dropping it", () => {
    const db = openDb(":memory:");
    const m = mail({ from: "hr@unknown.com", subject: "Interview with Foo Corp", body: "Please share your availability for an interview" });
    expect(processEmail(db, m)).toBe("queued");
    expect(db.prepare("SELECT COUNT(*) AS n FROM review_queue").get()).toEqual({ n: 1 });
  });

  it("does not let a late confirmation undo a rejection", () => {
    const db = openDb(":memory:");
    processEmail(db, mail({ subject: "Application Received — Engineer at Stripe", body: "thank you for applying" }));
    processEmail(db, mail({ from: "Stripe <a@greenhouse.io>", subject: "Stripe update", body: "Unfortunately we are not moving forward" }));
    processEmail(db, mail({ subject: "Application Received — Engineer at Stripe", body: "thank you for applying" }));
    expect(db.prepare("SELECT status FROM applications").all()).toEqual([{ status: "rejected" }]);
  });
});
