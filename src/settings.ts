/**
 * The package's settings, handed in by the caller once at startup. This package
 * reads no environment and imports no app config: whoever runs it says who it
 * is (SEC's fair-access policy requires a User-Agent with a contact address)
 * and how fast it may go. Calling a fetcher before `configureSec` throws at the
 * call, the way a missing required setting should — never a silent default
 * identity.
 */

export interface SecSettings {
  /** Sent on every EDGAR request: a descriptive name plus a contact e-mail. */
  userAgent: string;
  /** EDGAR requests per second, process-wide. SEC's ceiling is 10. Default 8. */
  rateLimit?: number;
  openfigi?: {
    /** Default https://api.openfigi.com/v3. */
    baseUrl?: string;
    /** Null or absent runs anonymously (10 jobs per request instead of 100). */
    apiKey?: string | null;
    /** OpenFIGI requests per minute. Default 20, under the anonymous throttle. */
    rateLimit?: number;
  };
}

export interface ResolvedSecSettings {
  userAgent: string;
  rateLimit: number;
  openfigi: { baseUrl: string; apiKey: string | null; rateLimit: number };
}

let current: ResolvedSecSettings | null = null;

/** Sets the package's settings for this process. Call once, before any fetch. */
export function configureSec(settings: SecSettings): void {
  if (!settings.userAgent.trim()) throw new Error("configureSec: userAgent is required (SEC fair access)");
  current = {
    userAgent: settings.userAgent,
    rateLimit: settings.rateLimit ?? 8,
    openfigi: {
      baseUrl: settings.openfigi?.baseUrl ?? "https://api.openfigi.com/v3",
      apiKey: settings.openfigi?.apiKey ?? null,
      rateLimit: settings.openfigi?.rateLimit ?? 20,
    },
  };
}

/** The settings in force; throws when `configureSec` has not been called. */
export function secSettings(): ResolvedSecSettings {
  if (!current) throw new Error("SEC client is not configured: call configureSec({ userAgent, ... }) at startup");
  return current;
}
