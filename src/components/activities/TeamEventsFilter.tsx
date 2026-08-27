"use client";

import Link from "next/link";
import styles from "@/styles/pages/Activities.module.css";

/**
 * The board's "every team" switch (#241).
 *
 * A pair of links rather than a checkbox, and that is the security-relevant part: the widening is
 * an **authorization decision**, so it belongs in the request. The server reads `?equipas=todas`,
 * re-checks `isBoardSignatory`, and only then runs the unscoped query.
 *
 * A checkbox filtering an already-fetched list would have put every team's internal meetings into
 * the payload of whoever loaded the page — including people who may not see them. That is the
 * mistake #127 records, and it is invisible in the rendered output.
 */
export default function TeamEventsFilter({ showingAllTeams }: { showingAllTeams: boolean }) {
  return (
    <div className={styles.teamFilter}>
      <span>A ver:</span>
      <Link
        href="/activities"
        className={!showingAllTeams ? styles.teamFilterActive : undefined}
        aria-current={!showingAllTeams ? "true" : undefined}>
        As minhas equipas
      </Link>
      <Link
        href="/activities?equipas=todas"
        className={showingAllTeams ? styles.teamFilterActive : undefined}
        aria-current={showingAllTeams ? "true" : undefined}>
        Todas as equipas
      </Link>
    </div>
  );
}
