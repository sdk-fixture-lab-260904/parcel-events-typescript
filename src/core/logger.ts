/**
 * Request logging (`ClientOptions.logger` + `logLevel`): every attempt and
 * its outcome, at the level the caller chose, with credentials REDACTED
 * before a line is formed — an `authorization`, `x-api-key`, `cookie` or
 * any `*-key`/`*-token`/`*-secret` header is never written, and neither is
 * a query parameter named like one. Default: `warn` to `console`, which
 * means retries and terminal failures are visible and successes are silent.
 *
 * Vendored kernel file — imports nothing.
 */
/* oxlint-disable no-console -- the default sink IS the console */

export type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'debug';

export interface Logger {
  error(message: string, ...details: unknown[]): void;
  warn(message: string, ...details: unknown[]): void;
  info(message: string, ...details: unknown[]): void;
  debug(message: string, ...details: unknown[]): void;
}

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = { off: 0, error: 1, warn: 2, info: 3, debug: 4 };
const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$|(-key|-token|-secret|-signature)$/;
const SECRET_QUERY = /(^|_|-)(key|token|secret|signature|password|sig)($|_|-)/i;

export const REDACTED = '[redacted]';

/** `console` as a Logger. */
export const consoleLogger: Logger = {
  error: (message, ...details) => console.error(message, ...details),
  warn: (message, ...details) => console.warn(message, ...details),
  info: (message, ...details) => console.info(message, ...details),
  debug: (message, ...details) => console.debug(message, ...details),
};

/** Copy a header record with credential-bearing values replaced. */
export function redactHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = SECRET_HEADER.test(name.toLowerCase()) ? REDACTED : value;
  }
  return out;
}

/** Copy a URL with credential-shaped query values replaced (the path is never a secret). */
export function redactUrl(url: string): string {
  const at = url.indexOf('?');
  if (at === -1) return url;
  const query = url
    .slice(at + 1)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const name = eq === -1 ? pair : pair.slice(0, eq);
      return SECRET_QUERY.test(decodeURIComponent(name)) ? `${name}=${REDACTED}` : pair;
    })
    .join('&');
  return `${url.slice(0, at)}?${query}`;
}

/** A level-gated logger: below the threshold every call is a no-op. */
export function leveledLogger(logger: Logger, level: LogLevel): Logger {
  const rank = LEVEL_RANK[level];
  const gate =
    (own: LogLevel, sink: (message: string, ...details: unknown[]) => void) =>
    (message: string, ...details: unknown[]): void => {
      if (LEVEL_RANK[own] <= rank) sink(message, ...details);
    };
  return {
    error: gate('error', (message, ...details) => logger.error(message, ...details)),
    warn: gate('warn', (message, ...details) => logger.warn(message, ...details)),
    info: gate('info', (message, ...details) => logger.info(message, ...details)),
    debug: gate('debug', (message, ...details) => logger.debug(message, ...details)),
  };
}
