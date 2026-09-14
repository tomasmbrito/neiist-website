import { NextRequest } from "next/server";

export const BOT_USER_AGENTS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "Claude-Web",
  "ClaudeBot",
  "anthropic-ai",
  "Google-Extended",
  "Google-CloudVertex",
  "PerplexityBot",
  "DuckAssistBot",
  "MistralAI-User",
  "LinerBot",
  "QualifiedBot",
  "ICC-Crawler",
  "CCBot",
  "cohere-ai",
  "Amazonbot",
  "AhrefsBot",
  "AhrefsSiteAudit",
  "Bytespider",
  "Diffbot",
  "PetalBot",
  "YandexBot",
  "Applebot-Extended",
  "Meta-ExternalAgent",
  "facebookexternalhit",
  "YouBot",
];

export function isBot(request: NextRequest): boolean {
  const ua = request.headers.get("user-agent")?.toLowerCase() ?? "";
  return BOT_USER_AGENTS.some((bot) => ua.includes(bot.toLowerCase()));
}

export function getClientIp(request: NextRequest): string {
  // The client can send whatever it wants as X-Forwarded-For, but our reverse proxy appends
  // the IP it actually observed as the LAST hop rather than trusting or reordering earlier
  // ones — so that trailing entry is the only part of this header we can't spoof ourselves.
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const hops = forwardedFor
      .split(",")
      .map((ip) => ip.trim())
      .filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }

  return request.headers.get("x-real-ip") ?? "unknown";
}
