/**
 * A small PayPal REST client, sandbox only.
 *
 * Two rules keep money safe:
 * - Every call that moves money carries a `PayPal-Request-Id`. Retries reuse the same id, so a retry
 *   after a timeout can never create a second order, capture, refund or payout.
 * - Only GETs and calls with an idempotency key are retried. Anything else fails loudly instead.
 */

export const SANDBOX_API = "https://api-m.sandbox.paypal.com";
export const SANDBOX_WEB = "https://www.sandbox.paypal.com";

export type PayPalConfig = {
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  /** Waits between retries. Tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  /** Per-attempt limit; a request that hangs is aborted and, if it is safe to, retried. */
  timeoutMs?: number;
};

export type RequestOptions = {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /** Sent as `PayPal-Request-Id`. Repeat the same key to repeat a call safely. */
  idempotencyKey?: string;
  headers?: Record<string, string>;
  /** Use this bearer token instead of the app's (for Log in with PayPal user tokens). */
  bearer?: string;
  /** A JSON body sent exactly as given (instead of `body`), for payloads that must not be re-serialized. */
  rawBody?: string;
};

type ErrorBody = {
  name?: string;
  message?: string;
  debug_id?: string;
  details?: { issue?: string; description?: string; field?: string }[];
  error?: string;
  error_description?: string;
};

export class PayPalError extends Error {
  readonly status: number;
  /** The most specific code PayPal gave, e.g. `NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE`. */
  readonly issue: string;
  readonly debugId: string | undefined;
  readonly details: NonNullable<ErrorBody["details"]>;

  constructor(status: number, body: ErrorBody | string | undefined) {
    const parsed: ErrorBody = typeof body === "object" && body !== null ? body : {};
    const issue = parsed.details?.[0]?.issue ?? parsed.name ?? parsed.error ?? `HTTP_${status}`;
    const description =
      parsed.details?.[0]?.description ??
      parsed.message ??
      parsed.error_description ??
      (typeof body === "string" ? body.slice(0, 200) : "");
    super(`${status} ${issue}${description ? `: ${description}` : ""}`);
    this.name = "PayPalError";
    this.status = status;
    this.issue = issue;
    this.debugId = parsed.debug_id;
    this.details = parsed.details ?? [];
  }
}

type AccessToken = { value: string; expiresAt: number; scopes: string[] };

export class PayPalClient {
  private token: Promise<AccessToken> | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;

  constructor(private readonly config: PayPalConfig) {
    this.fetchImpl = config.fetch ?? fetch;
    this.sleep = config.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRetries = config.maxRetries ?? 3;
    this.timeoutMs = config.timeoutMs ?? 20_000;
  }

  /** Builds a client from `PAYPAL_*` variables. Refuses anything but the sandbox. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): PayPalClient {
    if ((env.PAYPAL_ENV ?? "sandbox") !== "sandbox") {
      throw new Error("Rightful only talks to the PayPal sandbox. Set PAYPAL_ENV=sandbox.");
    }
    const clientId = env.PAYPAL_CLIENT_ID;
    const clientSecret = env.PAYPAL_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env (see .env.example).");
    }
    return new PayPalClient({ clientId, clientSecret });
  }

  get clientId(): string {
    return this.config.clientId;
  }

  /** Scopes on the app's access token. They show which features the app has switched on. */
  async scopes(): Promise<string[]> {
    return (await this.accessToken()).scopes;
  }

  async request<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(path, SANDBOX_API);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const retryable = method === "GET" || options.idempotencyKey !== undefined;

    for (let attempt = 0; ; attempt++) {
      const bearer = options.bearer ?? (await this.accessToken()).value;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${bearer}`,
        Accept: "application/json",
        ...options.headers,
      };
      if (options.body !== undefined || options.rawBody !== undefined) headers["Content-Type"] = "application/json";
      if (options.idempotencyKey) headers["PayPal-Request-Id"] = options.idempotencyKey;

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          body: options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        if (!retryable || attempt >= this.maxRetries) throw err;
        await this.sleep(backoff(attempt));
        continue;
      }

      if (response.status === 401 && !options.bearer && attempt < this.maxRetries) {
        this.token = undefined;
        continue;
      }
      if ((response.status === 429 || response.status >= 500) && retryable && attempt < this.maxRetries) {
        await this.sleep(backoff(attempt, response.headers.get("retry-after")));
        continue;
      }

      const text = await response.text();
      const body = parseJson(text);
      if (!response.ok) throw new PayPalError(response.status, body ?? text);
      return body as T;
    }
  }

  /** Swaps a Log in with PayPal authorization code for the user's access token. */
  async userTokenFromCode(code: string): Promise<string> {
    const body = await this.tokenRequest(new URLSearchParams({ grant_type: "authorization_code", code }));
    return body.access_token;
  }

  private accessToken(): Promise<AccessToken> {
    const cached = this.token;
    if (cached) {
      return cached.then((token) => (token.expiresAt > Date.now() ? token : this.refreshToken()));
    }
    return this.refreshToken();
  }

  private refreshToken(): Promise<AccessToken> {
    const pending = this.tokenRequest(new URLSearchParams({ grant_type: "client_credentials" })).then((body) => ({
      value: body.access_token,
      // Refresh a minute early so a token never expires mid-request.
      expiresAt: Date.now() + Math.max(0, body.expires_in - 60) * 1000,
      scopes: (body.scope ?? "").split(" ").filter(Boolean),
    }));
    this.token = pending;
    pending.catch(() => {
      if (this.token === pending) this.token = undefined;
    });
    return pending;
  }

  private async tokenRequest(form: URLSearchParams): Promise<{ access_token: string; expires_in: number; scope?: string }> {
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64");
    const response = await this.fetchImpl(new URL("/v1/oauth2/token", SANDBOX_API), {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: form.toString(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    const body = parseJson(text);
    if (!response.ok) throw new PayPalError(response.status, body ?? text);
    return body as { access_token: string; expires_in: number; scope?: string };
  }
}

/** Exponential backoff with jitter, or PayPal's `Retry-After` when it sends one. */
export function backoff(attempt: number, retryAfter?: string | null): number {
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  return 250 * 2 ** attempt + Math.floor(Math.random() * 100);
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
