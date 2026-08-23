import { ReactNode } from "react";
import { isFrameworkSignal } from "@/lib/errors/frameworkSignal";
import { Metadata } from "next";
import { cookies } from "next/headers";
import { Secular_One } from "next/font/google";
import { getUserFromJWT } from "@/utils/authUtils";
import { getUser } from "@/utils/db/userQueries";
import { User } from "@/types/user";
import { ThemeProvider } from "@/components/ThemeProvider";
import NavBar from "@/components/layout/navbar/NavBar";
import Footer from "@/components/layout/Footer";
import Cart from "@/components/shop/Cart";
import { Toaster } from "sonner";
import { UserProvider } from "@/context/UserContext";
import { ShopProvider } from "@/context/ShopContext";
import "@/styles/globals.css";
import "@/styles/components/activities/ReactBigCalendar.css";
import "@/lib/autoCancelScheduler";

const secularOne = Secular_One({
  subsets: ["latin"],
  weight: "400",
  style: "normal",
  display: "swap",
});

export const metadata: Metadata = {
  title: "NEIIST",
  description: "Núcleo Estudantil de Informática do Instituto Superior Técnico",
};

/**
 * Resolves the signed-in user on the server.
 *
 * This used to fetch the app's own /api/auth/userdata over HTTP with `headers: { cookie: "" }`,
 * which guaranteed the route saw no session and returned 401 — so the layout always rendered
 * logged-out, then flipped once UserContext refetched on the client. That produced a visible
 * flash on every authenticated page load, and made the root layout issue a blocking request to
 * itself on every render.
 */
async function getInitialUser(): Promise<User | null> {
  try {
    const sessionToken = (await cookies()).get("session")?.value;
    const jwtUser = getUserFromJWT(sessionToken);
    if (!jwtUser) return null;
    return (await getUser(jwtUser.istid)) ?? null;
  } catch (error) {
    // Re-throw the framework's own signals (#153). `cookies()` throws `DynamicServerError` to
    // tell Next this route is dynamic, and this layout runs on EVERY route — so swallowing it
    // meant the root layout lied to the framework about dynamism on every page, which is why
    // every build logged "Failed to resolve the initial user … couldn't be rendered statically".
    //
    // Chosen deliberately over preserving static rendering (option 2 in #153): measured, this
    // costs nothing. `/sitemap.xml` is the only statically prerendered route and it is a route
    // handler outside this layout, so it stays static.
    if (isFrameworkSignal(error)) throw error;

    console.error("Failed to resolve the initial user", error);
    return null;
  }
}

export default async function Layout({ children }: { children: ReactNode }) {
  const user = await getInitialUser();
  return (
    <html lang="pt" suppressHydrationWarning>
      <body className={secularOne.className}>
        <ThemeProvider>
          <ShopProvider>
            <UserProvider initialUser={user}>
              <NavBar />
              <Cart />
              <Toaster
                position="top-right"
                offset={{ top: "96px", right: "16px", left: "16px" }}
                mobileOffset={{ top: "80px", right: "16px", left: "16px" }}
                toastOptions={{
                  style: {
                    // Was hardcoded to white, which is unreadable once dark mode works.
                    background: "var(--background-colour)",
                    color: "var(--foreground-colour)",
                    border: "1px solid var(--hover)",
                  },
                }}
              />
              <main>{children}</main>
              <Footer />
            </UserProvider>
          </ShopProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
