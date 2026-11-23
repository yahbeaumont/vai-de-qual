// origin_guard.ts
// Exact Origin allowlist for a sensitive route, applied to reads as well as
// writes. The Origin header is a browser-enforced signal, not a credential: this
// guard is defence in depth behind the session and the role check.
// Run: node --experimental-strip-types origin_guard.ts

type RequestLike = { method: string; headers: Record<string, string | undefined> };

const ADMIN_ORIGINS = new Set(['https://admin.example.test']);

// Returns the canonical origin only when the header is already in canonical form,
// so "https://admin.example.test/" and "https://ADMIN.example.test" do not pass.
function canonicalOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.origin === value ? value : null;
  } catch {
    return null;
  }
}

function isAllowedOrigin(header: string | undefined, allowlist: Set<string>): boolean {
  if (header === undefined) return false;
  if (header === 'null') return false; // sandboxed iframe, file:// and some redirects
  const origin = canonicalOrigin(header);
  return origin !== null && allowlist.has(origin);
}

function assertAdminOrigin(request: RequestLike, allowlist: Set<string> = ADMIN_ORIGINS): void {
  if (!isAllowedOrigin(request.headers.origin, allowlist)) {
    throw new Error('403 admin_origin_forbidden');
  }
}

function attempt(label: string, request: RequestLike): void {
  try {
    assertAdminOrigin(request);
    console.log(`allowed  ${label}`);
  } catch (error) {
    console.log(`rejected ${label} -> ${(error as Error).message}`);
  }
}

const get = (origin?: string): RequestLike => ({ method: 'GET', headers: { origin } });

attempt('exact origin, GET', get('https://admin.example.test'));
attempt('exact origin, POST', { method: 'POST', headers: { origin: 'https://admin.example.test' } });
attempt('missing header', get(undefined));
attempt('trailing slash', get('https://admin.example.test/'));
attempt('different scheme', get('http://admin.example.test'));
attempt('lookalike host', get('https://admin.example.test.evil.test'));
attempt('subdomain', get('https://evil.admin.example.test'));
attempt('opaque origin', get('null'));
attempt('community origin', get('https://app.example.test'));
