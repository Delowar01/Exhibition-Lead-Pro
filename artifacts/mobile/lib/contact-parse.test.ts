import { describe, expect, it } from "vitest";

import {
  hasAnyContactField,
  mergeExtracted,
  parseContactText,
  parseMecard,
  parseQr,
  parseVCard,
} from "./contact-parse";

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
