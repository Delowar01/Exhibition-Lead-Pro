import { describe, expect, it } from "vitest";

import {
  buildVCard,
  hasAnyContactField,
  mergeExtracted,
  parseContactText,
  parseMecard,
  parseQr,
  parseVCard,
} from "./contact-parse";

describe("buildVCard", () => {
  it("emits a 3.0 vCard with available fields and omits empty ones", () => {
    const out = buildVCard({
      fullName: "Layla Hassan",
      companyName: "Nexus Systems",
      designation: "Head of Sales",
      primaryPhone: "+971 50 123 4567",
      alternatePhone: "+971 4 555 0000",
      email: "layla@nexussys.io",
      website: "https://nexussys.io",
      officeAddress: "Sheikh Zayed Rd, Dubai",
    });
    expect(out.startsWith("BEGIN:VCARD\r\nVERSION:3.0")).toBe(true);
    expect(out.endsWith("END:VCARD")).toBe(true);
    expect(out).toContain("FN:Layla Hassan");
    expect(out).toContain("N:Hassan;Layla;;;");
    expect(out).toContain("ORG:Nexus Systems");
    expect(out).toContain("TITLE:Head of Sales");
    expect(out).toContain("TEL;TYPE=CELL:+971 50 123 4567");
    expect(out).toContain("TEL;TYPE=WORK,VOICE:+971 4 555 0000");
    expect(out).toContain("EMAIL;TYPE=INTERNET:layla@nexussys.io");
    expect(out).toContain("URL:https://nexussys.io");
    expect(out).toContain("ADR;TYPE=WORK:;;Sheikh Zayed Rd\\, Dubai;;;;");
  });

  it("carries no hosted-card URL when none is provided", () => {
    const out = buildVCard({ fullName: "Jo Lin", email: "jo@acme.com" });
    expect(out).not.toContain("URL:");
    expect(out).not.toContain("/card/");
  });

  it("omits properties for missing fields", () => {
    const out = buildVCard({ fullName: "Solo Name" });
    expect(out).toContain("FN:Solo Name");
    expect(out).not.toContain("ORG:");
    expect(out).not.toContain("TITLE:");
    expect(out).not.toContain("TEL");
    expect(out).not.toContain("EMAIL");
    expect(out).not.toContain("ADR");
  });

  it("round-trips through parseVCard", () => {
    const vcf = buildVCard({
      fullName: "Layla Hassan",
      companyName: "Nexus Systems",
      designation: "Head of Sales",
      primaryPhone: "+971 50 123 4567",
      email: "layla@nexussys.io",
      website: "https://nexussys.io",
    });
    const parsed = parseVCard(vcf);
    expect(parsed.firstName).toBe("Layla");
    expect(parsed.lastName).toBe("Hassan");
    expect(parsed.company).toBe("Nexus Systems");
    expect(parsed.jobTitle).toBe("Head of Sales");
    expect(parsed.email).toBe("layla@nexussys.io");
    expect(parsed.mobile).toBe("+971 50 123 4567");
    expect(parsed.website).toBe("https://nexussys.io");
  });
});

describe("parseVCard", () => {
  it("extracts the standard fields", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Layla Hassan",
      "ORG:Nexus Systems",
      "TITLE:Head of Sales",
      "TEL;TYPE=CELL:+971 50 123 4567",
      "EMAIL:layla@nexussys.io",
      "URL:https://nexussys.io",
      "ADR:;;Sheikh Zayed Rd;Dubai;;;UAE",
      "END:VCARD",
    ].join("\n");
    const out = parseVCard(vcf);
    expect(out.firstName).toBe("Layla");
    expect(out.lastName).toBe("Hassan");
    expect(out.company).toBe("Nexus Systems");
    expect(out.jobTitle).toBe("Head of Sales");
    expect(out.mobile).toBe("+971 50 123 4567");
    expect(out.email).toBe("layla@nexussys.io");
    expect(out.website).toBe("https://nexussys.io");
    expect(out.address).toContain("Dubai");
  });

  it("reads grouped (Apple/iOS) properties like item1.URL / item2.EMAIL", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "N:Hassan;Layla;;;",
      "FN:Layla Hassan",
      "ORG:Nexus Systems",
      "item1.URL:https://nexussys.io",
      "item1.X-ABLabel:_$!<HomePage>!$_",
      "item2.EMAIL;type=INTERNET:layla@nexussys.io",
      "item3.ADR;type=WORK:;;Sheikh Zayed Rd;Dubai;;;UAE",
      "END:VCARD",
    ].join("\n");
    const out = parseVCard(vcf);
    expect(out.website).toBe("https://nexussys.io");
    expect(out.email).toBe("layla@nexussys.io");
    expect(out.address).toContain("Dubai");
  });

  it("prefers the structured N name over a titled FN display string", () => {
    const vcf = [
      "BEGIN:VCARD",
      "FN:Dr. John Smith",
      "N:Smith;John;;Dr.;",
      "END:VCARD",
    ].join("\n");
    const out = parseVCard(vcf);
    expect(out.firstName).toBe("John");
    expect(out.lastName).toBe("Smith");
  });

  it("strips a leading honorific from FN even when N is reversed (Given;Family)", () => {
    // FN carries "Eng." and N is in the common non-compliant Given;Family order.
    const vcf = [
      "BEGIN:VCARD",
      "FN:Eng. Layla Hassan",
      "N:Layla;Hassan",
      "END:VCARD",
    ].join("\n");
    const out = parseVCard(vcf);
    expect(out.firstName).toBe("Layla");
    expect(out.lastName).toBe("Hassan");
  });

  it("does NOT swap names when FN is a nickname matching neither N part", () => {
    // FN:"Bob Smith" + N:"Robert;Smith" (Given;Family). FN matches neither N
    // component, so order is ambiguous — fall back to the FN split (Bob/Smith)
    // rather than forcing RFC order, which would swap to Smith/Robert.
    const vcf = ["BEGIN:VCARD", "FN:Bob Smith", "N:Robert;Smith", "END:VCARD"].join("\n");
    const out = parseVCard(vcf);
    expect(out.firstName).toBe("Bob");
    expect(out.lastName).toBe("Smith");
  });

  it("strips a Gulf honorific (Sheikh) from an FN-only card", () => {
    const out = parseVCard("BEGIN:VCARD\nFN:Sheikh Ahmed Al Maktoum\nEND:VCARD");
    expect(out.firstName).toBe("Ahmed");
    expect(out.lastName).toBe("Al Maktoum");
  });

  it("keeps the name intact when the FN is only a title token", () => {
    const out = parseVCard("BEGIN:VCARD\nFN:Dr.\nEND:VCARD");
    expect(out.firstName).toBe("Dr.");
  });

  it("strips vCard 4.0 tel:/mailto: URI schemes from phone and email", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "FN:Noura Said",
      "TEL;VALUE=uri;TYPE=cell:tel:+971501234567",
      "EMAIL:mailto:noura@example.ae",
      "END:VCARD",
    ].join("\n");
    const out = parseVCard(vcf);
    expect(out.mobile).toBe("+971501234567");
    expect(out.email).toBe("noura@example.ae");
  });

  it("falls back to FN when no N property is present", () => {
    const out = parseVCard("BEGIN:VCARD\nFN:Omar Farouk\nEND:VCARD");
    expect(out.firstName).toBe("Omar");
    expect(out.lastName).toBe("Farouk");
  });

  it("handles single-component N (no semicolons) — name goes to right fields", () => {
    // Some QR generators emit N:Full Name without the Family;Given separator.
    // Before the fix, the entire value landed in lastName with firstName=null.
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "N:John Smith",
      "ORG:Acme Corp",
      "END:VCARD",
    ].join("\n");
    const out = parseVCard(vcf);
    expect(out.firstName).toBe("John");
    expect(out.lastName).toBe("Smith");
    expect(out.company).toBe("Acme Corp");
  });

  it("extracts country from ADR 7th semicolon component, address from street/city/region/postal", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Sara Khan",
      "ADR;TYPE=WORK:;;Sheikh Zayed Rd;Dubai;Dubai;00000;UAE",
      "END:VCARD",
    ].join("\n");
    const out = parseVCard(vcf);
    expect(out.country).toBe("UAE");
    expect(out.address).toBe("Sheikh Zayed Rd, Dubai, Dubai, 00000");
    expect(out.address).not.toContain("UAE");
  });

  it("prefers CELL/MOBILE-typed TEL for mobile; routes WORK TEL to officePhone", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Ali Hassan",
      "TEL;TYPE=WORK,VOICE:+971 4 555 0000",
      "TEL;TYPE=CELL:+971 50 999 1234",
      "END:VCARD",
    ].join("\n");
    const out = parseVCard(vcf);
    expect(out.mobile).toBe("+971 50 999 1234");
    expect(out.officePhone).toBe("+971 4 555 0000");
  });

  it("routes an untyped TEL (no TYPE param) to mobile by default", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Bo Chen",
      "TEL:+86 138 0000 1234",
      "END:VCARD",
    ].join("\n");
    const out = parseVCard(vcf);
    expect(out.mobile).toBe("+86 138 0000 1234");
    expect(out.officePhone).toBeUndefined();
  });

  it("decodes a vCard 2.1 QUOTED-PRINTABLE value (Outlook / QR generators)", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:2.1",
      "N;CHARSET=utf-8;ENCODING=QUOTED-PRINTABLE:Smith;John",
      "ORG;CHARSET=utf-8;ENCODING=QUOTED-PRINTABLE:Acme=20Corp",
      "TITLE:Sales Director",
      "TEL;CELL:+1 555 0100",
      "EMAIL;INTERNET:john@acme.com",
      "END:VCARD",
    ].join("\n");
    const out = parseVCard(vcf);
    expect(out.firstName).toBe("John");
    expect(out.lastName).toBe("Smith");
    expect(out.company).toBe("Acme Corp");
    expect(out.jobTitle).toBe("Sales Director");
    expect(out.mobile).toBe("+1 555 0100");
    expect(out.email).toBe("john@acme.com");
  });

  it("decodes QUOTED-PRINTABLE multi-byte UTF-8 (Arabic) names", () => {
    // FN = "محمد علي" (Mohammed Ali) QP-encoded as UTF-8 bytes
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:2.1",
      "FN;CHARSET=utf-8;ENCODING=QUOTED-PRINTABLE:=D9=85=D8=AD=D9=85=D8=AF=20=D8=B9=D9=84=D9=8A",
      "END:VCARD",
    ].join("\n");
    const out = parseVCard(vcf);
    expect(out.firstName).toBe("محمد");
    expect(out.lastName).toBe("علي");
  });

  it("joins a QUOTED-PRINTABLE soft line break (= at end of line)", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:2.1",
      "ADR;ENCODING=QUOTED-PRINTABLE:;;Sheikh=20Zayed=20Road,=20Trade=20Centre,=",
      "=20Dubai,=20UAE;;;;",
      "END:VCARD",
    ].join("\n");
    const out = parseVCard(vcf);
    expect(out.address).toContain("Sheikh Zayed Road");
    expect(out.address).toContain("Dubai");
  });

  it("decodes a QUOTED-PRINTABLE value containing a literal %", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:2.1",
      "FN:Discount Bot",
      "TITLE;ENCODING=QUOTED-PRINTABLE:100%=20Sales=20Lead",
      "END:VCARD",
    ].join("\n");
    const out = parseVCard(vcf);
    expect(out.jobTitle).toBe("100% Sales Lead");
  });

  it("does NOT join a non-QP value that happens to end with '=' (no data loss)", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "URL:https://example.com/u?token=AbC=",
      "EMAIL:keep@example.com",
      "END:VCARD",
    ].join("\n");
    const out = parseVCard(vcf);
    expect(out.email).toBe("keep@example.com");
    expect(out.website).toBe("https://example.com/u?token=AbC=");
  });

  it("unfolds RFC folded continuation lines (leading space)", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Layla Hassan",
      "ADR:;;Sheikh Zayed Rd",
      "  Trade Centre;Dubai;;;UAE",
      "END:VCARD",
    ].join("\n");
    const out = parseVCard(vcf);
    expect(out.address).toContain("Sheikh Zayed Rd");
    expect(out.address).toContain("Dubai");
  });
});

describe("parseMecard", () => {
  it("parses MECARD compact contact syntax", () => {
    const out = parseMecard(
      "MECARD:N:Doe,John;ORG:Acme Corp;TITLE:CEO;TEL:+15551234567;EMAIL:john@acme.com;URL:https://acme.com;ADR:1 Main St,Austin,TX;;",
    );
    expect(out.firstName).toBe("John");
    expect(out.lastName).toBe("Doe");
    expect(out.company).toBe("Acme Corp");
    expect(out.jobTitle).toBe("CEO");
    expect(out.mobile).toBe("+15551234567");
    expect(out.email).toBe("john@acme.com");
    expect(out.website).toBe("https://acme.com");
    expect(out.address).toBe("1 Main St Austin TX");
  });
});

describe("parseContactText", () => {
  it("parses labeled multiline contact text incl. Designation/Website/Address", () => {
    const text = [
      "Name: Sara Khan",
      "Company: Innovatech",
      "Designation: Product Lead",
      "Mobile: +34 600 111 222",
      "Email: sara@innovatech.es",
      "Website: https://innovatech.es",
      "Address: Calle Mayor 10, Madrid",
    ].join("\n");
    const out = parseContactText(text);
    expect(out.firstName).toBe("Sara");
    expect(out.lastName).toBe("Khan");
    expect(out.company).toBe("Innovatech");
    expect(out.jobTitle).toBe("Product Lead");
    expect(out.mobile).toBe("+34 600 111 222");
    expect(out.email).toBe("sara@innovatech.es");
    expect(out.website).toBe("https://innovatech.es");
    expect(out.address).toBe("Calle Mayor 10, Madrid");
  });

  it("classifies unlabeled lines heuristically", () => {
    const out = parseContactText(
      ["Omar Farouk", "Globex", "+971501112233", "omar@globex.ae"].join("\n"),
    );
    expect(out.firstName).toBe("Omar");
    expect(out.lastName).toBe("Farouk");
    expect(out.company).toBe("Globex");
    expect(out.mobile).toBe("+971501112233");
    expect(out.email).toBe("omar@globex.ae");
  });

  it("routes LinkedIn URLs to the linkedin field", () => {
    const out = parseContactText("Website: https://linkedin.com/in/someone");
    expect(out.linkedin).toBe("https://linkedin.com/in/someone");
    expect(out.website).toBeUndefined();
  });
});

describe("parseQr", () => {
  it("delegates to vCard and MECARD parsers", () => {
    expect(parseQr("BEGIN:VCARD\nFN:Jo Lin\nEND:VCARD").firstName).toBe("Jo");
    expect(parseQr("MECARD:N:Lin,Jo;;").firstName).toBe("Jo");
  });

  it("handles a bare URL and a bare email", () => {
    expect(parseQr("https://example.com").website).toBe("https://example.com");
    expect(parseQr("https://linkedin.com/in/x").linkedin).toBe("https://linkedin.com/in/x");
    expect(parseQr("hi@example.com").email).toBe("hi@example.com");
  });

  it("parses structured text but treats opaque single tokens as company", () => {
    expect(parseQr("Name: Ada Lovelace\nCompany: Analytical").firstName).toBe("Ada");
    expect(parseQr("BOOTH-42").company).toBe("BOOTH-42");
  });

  it("treats a scheme-less website QR as a website (normalized to https)", () => {
    expect(parseQr("www.example.com").website).toBe("https://www.example.com");
    expect(parseQr("acme.com/me").website).toBe("https://acme.com/me");
    // Still routes a bare LinkedIn domain to the linkedin field.
    expect(parseQr("linkedin.com/in/jo").linkedin).toBe("https://linkedin.com/in/jo");
    // A plain token without a TLD stays a company name.
    expect(parseQr("BOOTH-42").website).toBeUndefined();
  });

  it("LinkedIn QR carries only a profile URL — no name/email is extractable", () => {
    // A LinkedIn personal QR encodes only the profile URL; by design the rest of
    // the contact must be confirmed/entered on the review screen.
    const out = parseQr("https://www.linkedin.com/in/layla-hassan");
    expect(out.linkedin).toBe("https://www.linkedin.com/in/layla-hassan");
    expect(out.firstName).toBeUndefined();
    expect(out.email).toBeUndefined();
    expect(hasAnyContactField(out)).toBe(true);
  });

  it("parses a full vCard 2.1 QR payload (QP) end-to-end via parseQr", () => {
    const qr = [
      "BEGIN:VCARD",
      "VERSION:2.1",
      "N;ENCODING=QUOTED-PRINTABLE:Hassan;Layla",
      "ORG;ENCODING=QUOTED-PRINTABLE:Nexus=20Systems",
      "TEL;CELL:+971501234567",
      "EMAIL:layla@nexussys.io",
      "END:VCARD",
    ].join("\r\n");
    const out = parseQr(qr);
    expect(out.firstName).toBe("Layla");
    expect(out.lastName).toBe("Hassan");
    expect(out.company).toBe("Nexus Systems");
    expect(out.mobile).toBe("+971501234567");
    expect(out.email).toBe("layla@nexussys.io");
  });
});

describe("mergeExtracted / hasAnyContactField", () => {
  it("fills only empty fields (first non-empty wins)", () => {
    const merged = mergeExtracted(
      { firstName: "Ada", company: null },
      { firstName: "Zed", company: "Analytical", email: "a@b.co" },
    );
    expect(merged.firstName).toBe("Ada");
    expect(merged.company).toBe("Analytical");
    expect(merged.email).toBe("a@b.co");
  });

  it("detects presence/absence of any field", () => {
    expect(hasAnyContactField({})).toBe(false);
    expect(hasAnyContactField({ firstName: null, company: "" })).toBe(false);
    expect(hasAnyContactField({ email: "x@y.z" })).toBe(true);
  });
});
