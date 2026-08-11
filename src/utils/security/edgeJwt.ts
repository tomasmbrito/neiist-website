import type { JwtPayload } from "@/utils/authUtils";

/**
 * HS256 JWT verification for the Edge runtime.
 *
 * Why this exists: `getUserFromJWT` uses `jsonwebtoken`, which depends on Node's crypto module
 * and cannot run in middleware. That is why middleware previously used `decodeJWTPayload`,
 * which base64-decodes the payload **without checking the signature** — so any three-part
 * string was accepted as a valid session, and route authorization could be driven by a forged
 * cookie.
 *
 * Web Crypto is available in the Edge runtime, so the verification can be done here directly
 * rather than adding a dependency. This module must stay free of Node-only imports.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Allocates over an explicit ArrayBuffer so the result is a Uint8Array<ArrayBuffer>, which is
// what crypto.subtle accepts as a BufferSource. A bare `new Uint8Array(n)` is typed over
// ArrayBufferLike and is rejected.
function base64UrlToBytes(input: string): Uint8Array<ArrayBuffer> {
  const padded = input.length % 4 === 0 ? input : input + "=".repeat(4 - (input.length % 4));
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// importKey is not free and middleware runs on every request, so the key is cached — but keyed
// on the secret it was derived from, so a different secret can never reuse the wrong key.
let cachedKey: { secret: string; key: CryptoKey } | null = null;

async function getKey(secret: string): Promise<CryptoKey> {
  if (cachedKey?.secret === secret) return cachedKey.key;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  cachedKey = { secret, key };
  return key;
}

/**
 * Verifies an HS256 JWT and returns its payload, or null if the token is missing, malformed,
 * signed with the wrong key, using a different algorithm, or expired.
 *
 * Returning null for every failure is deliberate: callers must not be able to distinguish
 * "bad signature" from "expired" and act differently.
 */
export async function verifyJwtEdge(
  token: string | undefined,
  secret: string | undefined
): Promise<JwtPayload | null> {
  if (!token || !secret) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;

  try {
    // Pin the algorithm. Without this, a token with {"alg":"none"} or a swapped algorithm
    // could be crafted to bypass verification — the classic JWT confusion attack.
    const header = JSON.parse(decoder.decode(base64UrlToBytes(headerB64)));
    if (header?.alg !== "HS256") return null;

    const key = await getKey(secret);
    const isValid = await crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlToBytes(signatureB64),
      encoder.encode(`${headerB64}.${payloadB64}`)
    );
    if (!isValid) return null;

    const payload = JSON.parse(decoder.decode(base64UrlToBytes(payloadB64))) as JwtPayload & {
      exp?: number;
      nbf?: number;
    };

    const nowSeconds = Date.now() / 1000;
    if (typeof payload.exp === "number" && payload.exp <= nowSeconds) return null;
    if (typeof payload.nbf === "number" && payload.nbf > nowSeconds) return null;

    return payload;
  } catch {
    return null;
  }
}
