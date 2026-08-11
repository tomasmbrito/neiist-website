"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import { ReactNode } from "react";

/**
 * Client boundary for next-themes.
 *
 * `ThemeToggle` calls `useTheme()`, but nothing ever rendered a provider — so outside one,
 * next-themes returns a default context whose `setTheme` is a no-op and whose `resolvedTheme`
 * is undefined. The toggle in the navbar silently did nothing for every user.
 *
 * `attribute="class"` makes next-themes put `.dark` on <html>, which is what the `.dark` block
 * in globals.css expects.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange>
      {children}
    </NextThemesProvider>
  );
}
