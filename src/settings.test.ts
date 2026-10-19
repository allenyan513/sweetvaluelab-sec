/**
 * `configureSec` — the package's only way in for settings. Unconfigured is an
 * error at the call, never a default identity; the optional knobs default to
 * values under SEC's and OpenFIGI's published ceilings.
 */
import { describe, expect, it } from "vitest";
import { configureSec, secSettings } from "./settings.js";

describe("configureSec / secSettings", () => {
  it("throws until configured, naming the call to make", () => {
    expect(() => secSettings()).toThrow(/configureSec/);
  });

  it("rejects a blank User-Agent (SEC fair access requires one)", () => {
    expect(() => configureSec({ userAgent: "  " })).toThrow(/userAgent/);
  });

  it("fills the optional knobs with defaults under the published ceilings", () => {
    configureSec({ userAgent: "acme research (ops@acme.test)" });
    expect(secSettings()).toEqual({
      userAgent: "acme research (ops@acme.test)",
      rateLimit: 8,
      openfigi: { baseUrl: "https://api.openfigi.com/v3", apiKey: null, rateLimit: 20 },
    });
  });

  it("keeps what the caller passes", () => {
    configureSec({ userAgent: "x (x@x.test)", rateLimit: 5, openfigi: { apiKey: "k", rateLimit: 200 } });
    expect(secSettings()).toMatchObject({ rateLimit: 5, openfigi: { apiKey: "k", rateLimit: 200, baseUrl: "https://api.openfigi.com/v3" } });
  });
});
