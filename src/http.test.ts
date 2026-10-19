/**
 * `secGet` — the one SEC fetcher every SEC module goes through. fetch is mocked
 * and the clock is fake, so the backoff waits are asserted to the millisecond
 * without being slept.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SecError, secGet } from "./http.js";
import { configureSec } from "./settings.js";

configureSec({ userAgent: "qt-sec tests (tests@example.com)" });

const URL_ = "https://data.sec.gov/submissions/CIK0000921669.json";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const text = (body: string, status: number) => new Response(body, { status });

/** Observe a promise's outcome without leaving a rejection unhandled while timers run. */
const settle = <T>(p: Promise<T>) => p.then((value) => ({ value }), (error: unknown) => ({ error }));

// The throttle's window is process-global and keyed on Date.now(): start every
// test a minute after the last so no earlier request is still in it.
let clock = Date.UTC(2026, 8, 25);
let fetchMock: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers();
  clock += 60_000;
  vi.setSystemTime(clock);
  fetchMock = vi.spyOn(globalThis, "fetch");
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("secGet", () => {
  it("returns parsed JSON and sends a User-Agent with a contact address (SEC fair access)", async () => {
    fetchMock.mockResolvedValueOnce(json({ name: "ICAHN CARL C" }));
    await expect(secGet(URL_)).resolves.toEqual({ name: "ICAHN CARL C" });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Accept).toBe("application/json");
    expect(headers["User-Agent"]).toMatch(/\S+@\S+/);
  });

  it("returns the raw body for a non-JSON accept", async () => {
    fetchMock.mockResolvedValueOnce(text("<SEC-HEADER>", 200));
    await expect(secGet<string>(URL_, "application/sgml")).resolves.toBe("<SEC-HEADER>");
  });

  it("turns a 404 into null without retrying", async () => {
    fetchMock.mockResolvedValueOnce(text("not found", 404));
    await expect(secGet(URL_)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws on another 4xx without retrying", async () => {
    fetchMock.mockResolvedValue(text("forbidden", 403));
    const r = await settle(secGet(URL_));
    expect(r).toMatchObject({ error: expect.any(SecError) });
    expect((r as { error: Error }).error.message).toBe(`SEC 403 for ${URL_}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("backs off 500 ms after a 429, then 1000 ms after a 5xx, and succeeds on the third try", async () => {
    fetchMock.mockResolvedValueOnce(text("slow down", 429)).mockResolvedValueOnce(text("oops", 503)).mockResolvedValueOnce(json({ ok: 1 }));
    const r = settle(secGet(URL_));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499); // 2^0 × 500 − 1
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999); // 2^1 × 500 − 1
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await r).toEqual({ value: { ok: 1 } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives up after three 5xx and names the status", async () => {
    fetchMock.mockResolvedValue(text("down", 500));
    const r = settle(secGet(URL_));
    await vi.runAllTimersAsync();
    const { error } = (await r) as { error: Error };
    expect(error).toBeInstanceOf(SecError);
    expect(error.message).toBe(`SEC 500 for ${URL_}`);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries a 200 whose body is not JSON, instead of aborting on a SyntaxError", async () => {
    fetchMock.mockResolvedValueOnce(text("<html>maintenance</html>", 200)).mockResolvedValueOnce(json({ ok: 2 }));
    const r = settle(secGet(URL_));
    await vi.runAllTimersAsync();
    expect(await r).toEqual({ value: { ok: 2 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a network error and wraps the last one in a SecError", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const r = settle(secGet(URL_));
    await vi.runAllTimersAsync();
    const { error } = (await r) as { error: Error };
    expect(error).toBeInstanceOf(SecError);
    expect(error.message).toBe("SEC fetch failed: fetch failed");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
