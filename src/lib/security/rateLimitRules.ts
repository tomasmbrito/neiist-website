export interface RateLimitRule {
  limit: number;
  windowMs: number;
  useUser?: boolean;
}

const MIN = 60_000;

export function getRateLimitRule(pathname: string): RateLimitRule | null {
  if (pathname === "/api/auth/login" || pathname === "/api/auth/callback") {
    return { limit: 5, windowMs: 15 * MIN };
  }
  if (pathname === "/api/auth/refresh") {
    return { limit: 10, windowMs: MIN };
  }
  if (pathname.startsWith("/api/user/verify-email/")) {
    return { limit: 3, windowMs: 15 * MIN };
  }
  // The public, unauthenticated application-submission endpoint needs a tight anti-spam
  // limit. Every other /api/recruitment/ route is authenticated admin/coordinator/candidate
  // UI that legitimately makes several requests per session (see
  // docs/ai-workflow/problem-registry.md, "the blanket rate limit throttles the admin UI") -
  // those get the same allowance as /api/admin/, not the anti-spam one.
  if (pathname === "/api/recruitment/applications") {
    return { limit: 5, windowMs: 60 * MIN, useUser: true };
  }
  if (pathname.startsWith("/api/recruitment/")) {
    return { limit: 30, windowMs: MIN, useUser: true };
  }
  if (pathname.startsWith("/api/admin/")) {
    return { limit: 30, windowMs: MIN, useUser: true };
  }
  if (pathname.startsWith("/api/user/photo/") || pathname.startsWith("/api/shop/photo/")) {
    return null;
  }
  if (pathname.startsWith("/api/")) {
    return { limit: 60, windowMs: MIN };
  }
  return null;
}
