import { describe, it, expect, vi, beforeEach } from "vitest";

describe("api client", () => {
  beforeEach(() => vi.resetModules());

  it("sends the CSRF token and retries once with a fresh token", async () => {
    const calls = [];
    let token = "t1";
    global.fetch = vi.fn(async (url, opts) => {
      calls.push({ url, opts });
      if (url.endsWith("/auth/session")) return { ok: true, status: 200, json: async () => ({ user: null, csrfToken: token }) };
      if (opts.headers["X-CSRF-Token"] === "t1") {
        token = "t2";
        return { ok: false, status: 403, json: async () => ({ error: { code: "permission-denied", message: "Invalid or missing CSRF token." } }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });
    const api = await import("../src/lib/api");
    expect((await api.apiPost("/me/addresses", { line1: "x" })).ok).toBe(true);
    expect(calls.filter((c) => c.opts.method === "POST").map((c) => c.opts.headers["X-CSRF-Token"])).toEqual(["t1", "t2"]);
  });

  it("maps server errors to ApiError with code and field", async () => {
    global.fetch = vi.fn(async (url) =>
      url.endsWith("/auth/session")
        ? { ok: true, status: 200, json: async () => ({ csrfToken: "t" }) }
        : { ok: false, status: 400, json: async () => ({ error: { code: "invalid-argument", message: "Enter a valid ZIP code.", details: { field: "address.zip" } } }) }
    );
    const api = await import("../src/lib/api");
    await expect(api.apiPost("/bookings", {})).rejects.toMatchObject({ code: "invalid-argument", field: "address.zip", status: 400 });
  });
});
