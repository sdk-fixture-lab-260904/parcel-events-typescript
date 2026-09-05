/**
 * The SINGLE source of the TypeScript kernel version (doc 38 §1: `sdkSha`
 * includes `kernelVersion`; §3.4: a kernel change is a version input, never
 * invisible drift). Bump this on ANY behavioral change to a vendored kernel
 * file — the release factory folds it into semver computation.
 */

/** Semver of the hand-written TypeScript runtime kernel. */
// 0.3.0 (2026-09-03): APIPromise (`asResponse`/`withResponse`), `withOptions`,
// `defaultQuery`, `fetchOptions`, a redacting logger, telemetry headers,
// `retry-after-ms` + `x-should-retry`, undocumented-endpoint helpers.
export const KERNEL_VERSION = '0.3.0';

/** The kernel's User-Agent product token. */
export const KERNEL_NAME = 'doctorine-ts-kernel';

/**
 * Build the User-Agent value stamped on every request:
 * `<sdk>/<version> doctorine-ts-kernel/<kernelVersion>`.
 */
export function userAgent(sdkName: string, sdkVersion: string): string {
  return `${sdkName}/${sdkVersion} ${KERNEL_NAME}/${KERNEL_VERSION}`;
}

interface RuntimeGlobals {
  readonly Deno?: { readonly version?: { readonly deno?: string } };
  readonly Bun?: { readonly version?: string };
  readonly process?: { readonly versions?: { readonly node?: string } };
  readonly navigator?: { readonly userAgent?: string };
  readonly EdgeRuntime?: unknown;
}

/**
 * The runtime this kernel runs on, for the `x-doctorine-runtime` header:
 * `node/22.1.0`, `deno/2.0.0`, `bun/1.1.0`, `workerd`, `edge`, `browser`, or
 * `unknown`. Read once; never a secret, never user data.
 */
export function runtimeDescriptor(): string {
  const g = globalThis as RuntimeGlobals;
  if (g.Deno?.version?.deno !== undefined) return `deno/${g.Deno.version.deno}`;
  if (g.Bun?.version !== undefined) return `bun/${g.Bun.version}`;
  if (g.EdgeRuntime !== undefined) return 'edge';
  if (g.navigator?.userAgent === 'Cloudflare-Workers') return 'workerd';
  if (g.process?.versions?.node !== undefined) return `node/${g.process.versions.node}`;
  if (g.navigator?.userAgent !== undefined) return 'browser';
  return 'unknown';
}
