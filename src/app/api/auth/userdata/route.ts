import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { handleApiError } from "@/lib/errors/apiErrorHandler";
import fs from "fs/promises";
import path from "path";
import { getUser, createUser, getEmailVerificationByUser } from "@/utils/db/userQueries";
import { signUserJWT, getUserFromJWT } from "@/utils/authUtils";

type FenixRegistration = {
  degree?: {
    name?: { [locale: string]: string } | string | null;
    acronym?: string | null;
  } | null;
};

export async function GET() {
  const cookieStore = await cookies();
  const accessToken = cookieStore.get("access_token")?.value;
  const sessionToken = cookieStore.get("session")?.value;

  if (!accessToken) {
    if (sessionToken) {
      const payload = getUserFromJWT(sessionToken);
      if (payload) {
        const user = await getUser(payload.istid);
        if (user) {
          const notVerifiedEmail = await getEmailVerificationByUser(user.istid);
          if (notVerifiedEmail) {
            user.alternativeEmail = notVerifiedEmail.email;
            user.alternativeEmailVerified = false;
          } else {
            user.alternativeEmailVerified = true;
          }
          return NextResponse.json(user);
        }
      }
    }
    return NextResponse.json({ error: "Not Authenticated." }, { status: 401 });
  }

  try {
    const fenixResponse = await fetch("https://fenix.tecnico.ulisboa.pt/tecnico-api/v2/person", {
      cache: "no-store",
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!fenixResponse.ok) {
      const err = await fenixResponse.json().catch(() => ({}));
      return NextResponse.json({ error: "Invalid/Expired Token", details: err }, { status: 401 });
    }

    const info = await fenixResponse.json();

    const istid = info.username;
    const name = info.name ?? info.displayName;
    const email = info.email ?? info.institutionalEmail ?? null;
    const phone = info.phone ?? null;

    const registrations = (info?.roles?.student?.registrations ?? []) as FenixRegistration[];

    // Deduplicated: Fenix returns one registration per enrolment, so a student who enrolled in
    // the same degree more than once (a re-registration, or a transfer) yields the same course
    // name twice. neiist.user_courses is PRIMARY KEY (user_istid, course_name) and add_user
    // inserts without ON CONFLICT, so a repeat made the whole insert fail with
    // `23505 duplicate key value violates unique constraint "user_courses_pkey"` — which meant
    // createUser returned null and the student could not create an account or log in at all.
    const courses: string[] = [
      ...new Set(
        registrations
          .map((r) => {
            const nameField = r?.degree?.name;
            if (nameField && typeof nameField === "object") {
              return (
                nameField["pt-PT"] ??
                nameField["en-GB"] ??
                Object.values(nameField)[0] ??
                r?.degree?.acronym ??
                null
              );
            }
            return (nameField as string) ?? r?.degree?.acronym ?? null;
          })
          .filter((c): c is string => Boolean(c))
      ),
    ];

    let user = await getUser(istid);
    if (!user) {
      user = await createUser({ istid, name, email, phone, courses });
      if (!user) return NextResponse.json({ error: "Failed to create user" }, { status: 500 });
    }

    if ((!user?.photo || !user.photo.includes("?custom")) && info.photo?.data) {
      const photoBuffer = Buffer.from(info.photo.data, "base64");
      const fenixDir = path.join(process.cwd(), "data", "fenix_cache");
      await fs.mkdir(fenixDir, { recursive: true });
      await fs.writeFile(path.join(fenixDir, `${user.istid}.png`), photoBuffer);
    }

    const notVerifiedEmail = await getEmailVerificationByUser(user.istid);
    if (notVerifiedEmail) {
      user.alternativeEmail = notVerifiedEmail.email;
      user.alternativeEmailVerified = false;
    } else {
      user.alternativeEmailVerified = true;
    }

    const response = NextResponse.json(user);
    const jwtPayload = {
      istid: user.istid,
      roles: user.roles,
      name: user.name,
      email: user.email,
    };
    const jwtToken = signUserJWT(jwtPayload);

    response.cookies.set("session", jwtToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 60 * 60 * 24,
      path: "/",
    });
    return response;
  } catch (error) {
    return handleApiError(error);
  }
}
