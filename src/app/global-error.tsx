"use client";

import ErrorFallback from "@/components/ErrorFallback";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="pt">
      <body>
        <ErrorFallback error={error} reset={reset} />
      </body>
    </html>
  );
}
