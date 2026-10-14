import { describe, expect, it } from "vitest";
import { classify } from "./classifier.js";
import { openDb } from "./db.js";
import { companyKey, nextStatus } from "./dedup.js";
import { parseEmail } from "./parsers/index.js";
import { applyStatusMail } from "./sweep.js";
import { isTerminalState } from "./templates.js";
import type { Application, RawEmail } from "./types.js";

const mail = (over: Partial<RawEmail>): RawEmail => ({
  id: Math.random().toString(36).slice(2),
  from: "no-reply@example.com",
  subject: "",
  body: "",
  date: new Date("2026-10-03T12:00:00Z"),
  ...over,
});

describe("templates built from real inbox mail", () => {
  it("iCIMS location codes are locations, never companies", () => {
    const p = parseEmail(mail({ from: "Mackenzie Investments @ icims <jobs@icims.com>", subject: "Thank you for applying at CA-ON-Greater Toronto Area" }));
    expect(p).toMatchObject({ company: "Mackenzie Investments", location: "CA-ON-Greater Toronto Area" });
  });

  it("HiBob puts the company in the subject", () => {
    const p = parseEmail(mail({ from: '"No-reply (via Bob)" <no-reply@hibob.com>', subject: "Thank you for applying at Synpulse!" }));
    expect(p).toMatchObject({ company: "Synpulse", source: "hibob" });
  });

  it("LinkedIn and Wellfound confirmations", () => {
    const li = parseEmail(mail({ from: "LinkedIn <jobs-noreply@linkedin.com>", subject: "Chukwuemeka, your application was sent to Acme Robotics" }));
    expect(li).toMatchObject({ company: "Acme Robotics" });
    const wf = parseEmail(mail({ from: "Wellfound <team@hi.wellfound.com>", subject: "Application to Feathery successfully submitted" }));
    expect(wf).toMatchObject({ company: "Feathery" });
  });

  it("reads the company from the body when subject and sender don't name one", () => {
    const hibob = parseEmail(
      mail({
        from: '"No-reply (via Bob)" <no-reply@hibob.com>',
        subject: "Thank you for your application",
        body: "Thank you for applying for the Software Engineer position at Synpulse. We have received it.",
      }),
    );
    expect(hibob).toMatchObject({ company: "Synpulse", role: "Software Engineer" });

    const ibm = parseEmail(
      mail({ from: "talent@ibm.com", subject: "Submitted", body: "Thank you for applying to the role of AI Consultant - 135564 at IBM. We are excited." }),
    );
    expect(ibm).toMatchObject({ company: "IBM", role: "AI Consultant - 135564" });

    const adp = parseEmail(
      mail({ from: "<hr@adp.com>", subject: "Application Received", body: "This email is to confirm that York Hills Centre for Children has received your job application." }),
    );
    expect(adp?.company).toBe("York Hills Centre for Children");
  });

  it("does not mistake a job title for a company in 'your interest in'", () => {
    const p = parseEmail(
      mail({
        from: "generalmotors@myworkday.com",
        subject: "Your interest in Early Career Software Developer",
        body: "Thank you for your interest in Early Career Software Developer- Embedded Software at GM.",
      }),
    );
    expect(p?.company).toBe("Generalmotors");
  });

  it("falls back to the sender's own domain, but never an ATS domain", () => {
    expect(parseEmail(mail({ from: "careers@talent.autodesk.com", subject: "we have received your application" }))?.company).toBe("Autodesk");
    expect(parseEmail(mail({ from: "notify@dayforce.com", subject: "Application Confirmation" }))).toBeNull();
  });
});

describe("classifier: spam, no-reply and rejection rules", () => {
  const kind = (over: Partial<RawEmail>) => classify(mail(over)).kind;

  it("a decisive rejection phrase beats a 'thank you for applying' subject", () => {
    expect(kind({ subject: "Thank you for applying to Acme", body: "We have decided not to move forward with your candidacy." })).toBe("rejection");
  });

  it("a lone 'unfortunately' in a confirmation is not a rejection", () => {
    expect(
      kind({ subject: "Thanks for applying to Cohere!", body: "Unfortunately, due to volume we aren't able to respond to every candidate." }),
    ).toBe("confirmation");
  });

  it("PwC-style wording is a rejection", () => {
    expect(kind({ subject: "Job application: Progress update", body: "We regret to inform you that we will not be proceeding with your application." })).toBe("rejection");
  });

  it("promotional mail is noise even when it says 'interview'", () => {
    expect(kind({ from: "deals@shop.com", subject: "Flash sale: 40% off", body: "Interview outfits on sale. Unsubscribe here." })).toBe("noise");
  });

  it("one weak mention in a newsletter is not job mail", () => {
    expect(kind({ from: "news@micro1.ai", subject: "Your weekly digest", body: "Congrats on completing the AI interview. Unsubscribe." })).toBe("noise");
  });

  it("'unsubscribe' lowers confidence but never hides a real confirmation", () => {
    expect(
      kind({ from: "Wellfound <team@hi.wellfound.com>", subject: "Application to Feathery successfully submitted", body: "Thanks. Unsubscribe from these emails." }),
    ).toBe("confirmation");
  });

  it("no-reply is a positive signal only: a real person's rejection still counts", () => {
    expect(kind({ from: "Margarita <margarita@mastra.ai>", subject: "Your application", body: "We have decided not to move forward with your application." })).toBe(
      "rejection",
    );
  });
});

describe("terminal states", () => {
  it("rejected, offer and withdrawn are terminal", () => {
    expect(["rejected", "offer", "withdrawn"].every(isTerminalState)).toBe(true);
    expect(["applied", "interviewing"].some(isTerminalState)).toBe(false);
  });

  it("a withdrawal sticks, but never overwrites an offer", () => {
    expect(nextStatus("applied", "withdrawn")).toBe("withdrawn");
    expect(nextStatus("withdrawn", "applied")).toBe("withdrawn");
    expect(nextStatus("offer", "withdrawn")).toBe("offer");
  });
});

describe("status sweep (pass 2)", () => {
  type Db = ReturnType<typeof openDb>;
  const seed = (db: Db, company: string, role: string | null = null, status = "applied") =>
    db.prepare("INSERT INTO applications (company, company_key, role, status) VALUES (?, ?, ?, ?)").run(company, companyKey(company), role, status);
  const statuses = (db: Db) => db.prepare("SELECT status FROM applications ORDER BY id").all();
  const open = (db: Db, key: string) => db.prepare("SELECT * FROM applications WHERE company_key = ?").all(key) as Application[];

  it("a rejection from a real person's address closes the open application", () => {
    const db = openDb(":memory:");
    seed(db, "Mastra");
    const m = mail({ from: "Margarita <margarita@mastra.ai>", subject: "Your application", body: "Thanks for your time. We have decided not to move forward with your application." });
    expect(applyStatusMail(db, open(db, "mastra"), m)).toBe("updated");
    expect(statuses(db)).toEqual([{ status: "rejected" }]);
  });

  it("never touches an application that is already in a terminal state", () => {
    const db = openDb(":memory:");
    seed(db, "Mastra", null, "offer");
    const m = mail({ from: "a@mastra.ai", subject: "Update", body: "We will not be moving forward with your application." });
    expect(applyStatusMail(db, open(db, "mastra"), m)).toBe("ignored");
    expect(statuses(db)).toEqual([{ status: "offer" }]);
  });

  it("ignores mail that matched Gmail's search but doesn't name the company", () => {
    const db = openDb(":memory:");
    seed(db, "Clio");
    const m = mail({ from: "a@other.com", subject: "Update", body: "We will not be moving forward with your application." });
    expect(applyStatusMail(db, open(db, "clio"), m)).toBe("ignored");
  });

  it("a company name that only appears in the body is not enough", () => {
    const db = openDb(":memory:");
    seed(db, "Point");
    const m = mail({ from: "jobs@guardian.example", subject: "Newspaper Delivery Person", body: "Pick up at the point of sale. We will not be moving forward with your application." });
    expect(applyStatusMail(db, open(db, "point"), m)).toBe("ignored");
    expect(statuses(db)).toEqual([{ status: "applied" }]);
  });

  it("never creates an application", () => {
    const db = openDb(":memory:");
    const m = mail({ from: "a@acme.com", subject: "Update", body: "We will not be moving forward with your application." });
    expect(applyStatusMail(db, [], m)).toBe("ignored");
    expect(db.prepare("SELECT COUNT(*) AS n FROM applications").get()).toEqual({ n: 0 });
  });

  it("with several open roles it acts only when the mail names one, otherwise queues it", () => {
    const db = openDb(":memory:");
    seed(db, "Acme", "Data Analyst");
    seed(db, "Acme", "Backend Developer");
    const named = mail({ from: "a@acme.com", subject: "Backend Developer at Acme", body: "We will not be moving forward with your application." });
    expect(applyStatusMail(db, open(db, "acme"), named)).toBe("updated");
    expect(statuses(db)).toEqual([{ status: "applied" }, { status: "rejected" }]);

    seed(db, "Acme", "Designer");
    const vague = mail({ from: "a@acme.com", subject: "Update", body: "We will not be moving forward with your application." });
    expect(applyStatusMail(db, open(db, "acme"), vague)).toBe("queued");
  });
});
