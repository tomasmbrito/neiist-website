import { NextRequest, NextResponse } from "next/server";
import pLimit from "p-limit";
import { Client } from "@notionhq/client";
import crypto from "crypto";
import type { NotionPage, NotionApiResponse } from "@/types/notion";
import { mapNotionResultToPage } from "@/types/notion";
import type { NotionEvent } from "@/types/events";
import { syncAllEventsToCalendar, getCalendarClient } from "@/utils/googleCalendar";
import { getAllUsers } from "@/utils/db/userQueries";
import { syncNotionEventsToDb } from "@/utils/eventsUtils";
import { parseNotionPageToEvent } from "@/utils/eventsUtils";

const NOTION_API_KEY = process.env.NOTION_API_KEY!;
const DATABASE_ID = process.env.DATABASE_ID!;

type NotionWebhookPayload = {
  verification_token?: string;
  [key: string]: unknown;
};

const notion = new Client({ auth: NOTION_API_KEY });

async function fetchAllNotionEvents(): Promise<NotionEvent[]> {
  const pages: NotionPage[] = [];
  let cursor: string | undefined = undefined;
  do {
    const response = (await notion.dataSources.query({
      data_source_id: DATABASE_ID,
      start_cursor: cursor,
    })) as unknown as NotionApiResponse;
    const mappedPages = response.results.map(mapNotionResultToPage);
    pages.push(...mappedPages);
    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
  } while (cursor);

  return pages.map(parseNotionPageToEvent);
}

async function getExistingNEIISTCalendars() {
  const calendar = getCalendarClient();
  const response = await calendar.calendarList.list();
  const calendars = response.data.items || [];
  return calendars.filter((cal) => cal.summary?.startsWith("NEIIST-"));
}

async function syncAllEventsToGoogleCalendars(events: NotionEvent[]) {
  const allUsers = await getAllUsers();
  const existingCalendars = await getExistingNEIISTCalendars();
  const calendarByIstid = new Map<string, { id: string; summary: string }>();

  existingCalendars.forEach((cal) => {
    const istidMatch = cal.description?.match(/istid:([a-zA-Z0-9]+)/);
    if (istidMatch) {
      calendarByIstid.set(istidMatch[1], { id: cal.id!, summary: cal.summary! });
    }
  });

  const usersWithCalendars = allUsers.filter(
    (u) => u.email && u.istid && calendarByIstid.has(u.istid)
  );

  const limit = pLimit(2);

  const results = await Promise.all(
    usersWithCalendars.map((user) =>
      limit(async () => {
        try {
          const alternativeEmailRaw = user.alternativeEmailVerified
            ? user.alternativeEmail
            : undefined;
          const alternativeEmail = alternativeEmailRaw ?? undefined;
          const calendarId = calendarByIstid.get(user.istid)!.id;
          const stats = await syncAllEventsToCalendar(
            calendarId,
            events,
            user.email!,
            alternativeEmail
          );
          return stats;
        } catch (error) {
          console.error(`Error syncing calendar for ${user.istid}:`, error);
          return { updated: 0, deleted: 0, unchanged: 0 };
        }
      })
    )
  );

  const totals = results.reduce(
    (acc, stat) => ({
      updated: acc.updated + stat.updated,
      deleted: acc.deleted + stat.deleted,
      unchanged: acc.unchanged + stat.unchanged,
    }),
    { updated: 0, deleted: 0, unchanged: 0 }
  );

  return totals;
}

function getVerificationToken(): string | undefined {
  return process.env.VERIFICATION_TOKEN;
}

// The endpoint is unauthenticated by necessity (the handshake precedes any shared secret), so
// bound the body before buffering it. Notion webhook payloads are a few KB at most.
const MAX_BODY_BYTES = 64 * 1024;

// Notion verification tokens are URL-safe strings. Anything else is not from Notion, and must
// never reach the log: the token is written to the log for an operator to copy, so a value
// containing newlines could forge a second, convincing handshake line and trick them into
// installing an attacker-chosen HMAC key.
const NOTION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Constant-time comparison of the Notion request signature.
 * Returns false on any malformed input rather than throwing.
 */
function hasValidSignature(req: NextRequest, bodyText: string, secret: string): boolean {
  // Headers.get is case-insensitive per spec, so one lookup covers every casing.
  const signatureHeader = req.headers.get("x-notion-signature") ?? "";
  if (!signatureHeader) return false;

  const calculatedSignature =
    "sha256=" + crypto.createHmac("sha256", secret).update(bodyText, "utf8").digest("hex");

  const expected = Buffer.from(calculatedSignature);
  const received = Buffer.from(signatureHeader);
  // timingSafeEqual throws when lengths differ, so guard first. This leaks nothing: `expected`
  // is always 71 bytes ("sha256=" + 64 hex chars), a public constant. The digest comparison
  // itself remains constant-time.
  if (expected.length !== received.length) return false;
  return crypto.timingSafeEqual(expected, received);
}

export async function POST(req: NextRequest) {
  const declaredLength = Number(req.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_BODY_BYTES) {
    return new NextResponse("Payload too large", { status: 413 });
  }

  const bodyText = await req.text();
  if (bodyText.length > MAX_BODY_BYTES) {
    return new NextResponse("Payload too large", { status: 413 });
  }

  let payload: NotionWebhookPayload;
  try {
    payload = JSON.parse(bodyText) as NotionWebhookPayload;
  } catch {
    return new NextResponse("Invalid JSON", { status: 400 });
  }

  const verificationToken = getVerificationToken();

  // One-time Notion subscription handshake. Notion sends the token in the clear, before any
  // signature can exist, so this branch is necessarily unauthenticated — it must therefore
  // never persist anything. The operator reads the token from the server log and sets
  // VERIFICATION_TOKEN by hand. See docs/installation.md § Notion calendar webhook.
  if (payload.verification_token) {
    if (verificationToken) {
      // Already configured: a further handshake is not something Notion initiates.
      return new NextResponse("Already verified", { status: 409 });
    }
    if (!NOTION_TOKEN_PATTERN.test(payload.verification_token)) {
      return new NextResponse("Invalid verification token", { status: 400 });
    }
    // JSON.stringify escapes any control character that slipped through, so a single log
    // line stays a single log line.
    console.warn(
      "[notion-webhook] Handshake received. Set VERIFICATION_TOKEN to " +
        `${JSON.stringify(payload.verification_token)} and restart. ` +
        "Confirm this value against the Notion integration page before trusting it."
    );
    return NextResponse.json({
      message: "Verification token received. Check the server logs to complete setup.",
    });
  }

  // Every other request must be signed. Missing configuration is a rejection, not a bypass:
  // treating an unset token as "no verification needed" would leave the sync open to anyone.
  if (!verificationToken) {
    console.error("[notion-webhook] VERIFICATION_TOKEN is not set; rejecting webhook request.");
    return new NextResponse("Webhook not configured", { status: 503 });
  }

  if (!hasValidSignature(req, bodyText, verificationToken)) {
    return new NextResponse("Invalid signature", { status: 401 });
  }

  try {
    const events = await fetchAllNotionEvents();
    const stats = await syncAllEventsToGoogleCalendars(events);
    await syncNotionEventsToDb();

    return NextResponse.json({
      ok: true,
      synced: true,
      eventCount: events.length,
      stats,
      message: `Synced: ${stats.updated} updated, ${stats.deleted} deleted, ${stats.unchanged} unchanged`,
    });
  } catch (error) {
    console.error("Webhook error:", error);
    return new NextResponse("Failed to sync calendars", { status: 500 });
  }
}
