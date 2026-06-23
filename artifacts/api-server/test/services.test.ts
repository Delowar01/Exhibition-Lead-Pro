import { describe, it, expect } from "vitest";
import { scanImageApiUrl } from "../src/services/scans.service.js";
import { authenticateLogin, verifyMfaLogin } from "../src/services/auth.service.js";
import { AppError } from "../src/middlewares/errorHandler.js";

// Pure unit tests for representative service-layer logic that does not require
// the database (input validation runs before any DB access; scanImageApiUrl is pure).
describe("scans.service / scanImageApiUrl", () => {
  it("returns the API image URL when an image is stored", () => {
    expect(scanImageApiUrl(42, true)).toBe("/api/scans/42/image");
  });

  it("returns null when no image is stored", () => {
    expect(scanImageApiUrl(42, false)).toBeNull();
  });
});

describe("auth.service / input validation (no DB)", () => {
  it("authenticateLogin throws 400 when credentials are missing", async () => {
    await expect(authenticateLogin({ ip: null, userAgent: null })).rejects.toMatchObject({
      statusCode: 400,
      message: "Email and password required",
    });
    await expect(authenticateLogin({ ip: null, userAgent: null })).rejects.toBeInstanceOf(AppError);
  });

  it("verifyMfaLogin throws 400 when mfaToken/code are missing", async () => {
    await expect(verifyMfaLogin({ ip: null, userAgent: null })).rejects.toMatchObject({
      statusCode: 400,
      message: "mfaToken and code are required",
    });
  });
});
