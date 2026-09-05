/**
 * Auth providers (doc 38 §3.2 row 5, `auth:` in `doctorine.sdk.yml`):
 * apiKey (header or query) · bearer · basic · oauth2 client-credentials with
 * a token cache, early refresh, and a configurable token endpoint. The client
 * calls `authorize()` per ATTEMPT (fresh material after refresh) and
 * `invalidate()` once on a 401 — a cached-but-revoked token earns exactly one
 * transparent re-auth retry.
 *
 * Vendored kernel file — imports only sibling kernel modules.
 */
import { APIConnectionError, APIError } from './errors.js';
import { encodeBase64 } from './serialization.js';
import { headersToRecord, type KernelFetch } from './transport.js';

export interface AuthMaterial {
  readonly headers?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
}

export interface AuthProvider {
  /** Material for one attempt — may fetch/refresh tokens. */
  authorize(): Promise<AuthMaterial>;
  /**
   * 401 hook: drop cached material. Return true when a single re-auth retry
   * is worthwhile (i.e. something WAS cached and may simply have expired).
   */
  invalidate?(): boolean;
}

export interface ApiKeyAuthOptions {
  readonly placement: 'header' | 'query';
  readonly name: string;
  readonly key: string;
}

export function apiKeyAuth(options: ApiKeyAuthOptions): AuthProvider {
  const material: AuthMaterial =
    options.placement === 'header'
      ? { headers: { [options.name.toLowerCase()]: options.key } }
      : { query: { [options.name]: options.key } };
  return { authorize: () => Promise.resolve(material) };
}

export function bearerAuth(token: string): AuthProvider {
  const material: AuthMaterial = { headers: { authorization: `Bearer ${token}` } };
  return { authorize: () => Promise.resolve(material) };
}

export interface BasicAuthOptions {
  readonly username: string;
  readonly password: string;
}

export function basicAuth(options: BasicAuthOptions): AuthProvider {
  const encoded = encodeBase64(`${options.username}:${options.password}`);
  const material: AuthMaterial = { headers: { authorization: `Basic ${encoded}` } };
  return { authorize: () => Promise.resolve(material) };
}

// ── oauth2 client-credentials ──────────────────────────────────────────────

export interface OAuth2ClientCredentialsOptions {
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scopes?: readonly string[];
  /** Injected fetch (share the client's). */
  readonly fetch: KernelFetch;
  /** Clock injection for tests; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Refresh this many ms BEFORE nominal expiry (default 60s). */
  readonly earlyRefreshMs?: number;
}

interface CachedToken {
  readonly accessToken: string;
  readonly expiresAtMs: number;
}

export class OAuth2ClientCredentials implements AuthProvider {
  private token: CachedToken | null = null;
  private pending: Promise<CachedToken> | null = null;

  constructor(private readonly options: OAuth2ClientCredentialsOptions) {}

  async authorize(): Promise<AuthMaterial> {
    const token = await this.currentToken();
    return { headers: { authorization: `Bearer ${token.accessToken}` } };
  }

  invalidate(): boolean {
    const hadMaterial = this.token !== null || this.pending !== null;
    this.token = null;
    this.pending = null;
    return hadMaterial;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private async currentToken(): Promise<CachedToken> {
    const earlyRefreshMs = this.options.earlyRefreshMs ?? 60_000;
    if (this.token !== null && this.token.expiresAtMs - earlyRefreshMs > this.now()) {
      return this.token;
    }
    // Concurrent authorize() calls share one in-flight token request.
    this.pending ??= this.fetchToken().finally(() => {
      this.pending = null;
    });
    const token = await this.pending;
    this.token = token;
    return token;
  }

  private async fetchToken(): Promise<CachedToken> {
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
    });
    const scopes = this.options.scopes;
    if (scopes !== undefined && scopes.length > 0) form.set('scope', scopes.join(' '));
    const response = await this.options.fetch(this.options.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString(),
    });
    const text = await response.text();
    const body = parseJsonSafe(text);
    if (!response.ok) {
      throw APIError.generate({
        status: response.status,
        headers: headersToRecord(response.headers),
        body: body ?? text,
        message: `OAuth token endpoint responded ${response.status}`,
      });
    }
    return this.tokenFromBody(body);
  }

  private tokenFromBody(body: unknown): CachedToken {
    const record = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const accessToken = record['access_token'];
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new APIConnectionError('OAuth token endpoint returned a malformed body (no access_token)');
    }
    const expiresIn = record['expires_in'];
    const expiresInSeconds = typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn : 3600;
    return { accessToken, expiresAtMs: this.now() + expiresInSeconds * 1000 };
  }
}

function parseJsonSafe(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
