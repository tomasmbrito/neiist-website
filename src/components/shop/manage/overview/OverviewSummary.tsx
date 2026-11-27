import { Card } from "@neiist/ui";
import type { Dictionary } from "@/i18n/dictionaries";
import styles from "@/styles/components/shop/manage/overview/OverviewSummary.module.css";
import type { OrderStatus } from "@/types/shop/orderStatus";
import {
  formatCount,
  type OverviewRow,
  type OverviewSummary as Summary,
  type OverviewTotals,
} from "@/utils/shop/shopOverviewUtils";

interface OverviewSummaryProps {
  summary: Summary;
  statuses: OverviewRow[];
  dict: Dictionary["shop_overview"];
}

export default function OverviewSummary({ summary, statuses, dict }: OverviewSummaryProps) {
  const totalUnits = statuses.reduce((acc, row) => acc + row.units, 0);

  const figures: Array<{ id: string; label: string; totals: OverviewTotals }> = [
    { id: "paid", label: dict.summary_paid, totals: summary.paid },
    { id: "pending", label: dict.summary_pending, totals: summary.pending },
    { id: "cancelled", label: dict.summary_cancelled, totals: summary.cancelled },
  ];

  return (
    <Card className={styles.card}>
      <Card.Header title={dict.orders_title} />
      <Card.Body className={styles.body}>
        <div className={styles.figures}>
          <div className={styles.headline}>
            <strong className={styles.total}>{summary.total.units}</strong>
            <span className={styles.caption}>
              {dict.summary_total.replace(
                "{orders}",
                formatCount(summary.total.orders, dict.orders_count_one, dict.orders_count)
              )}
            </span>
          </div>
          {figures.map((figure) => (
            <div key={figure.id} className={styles.figure} data-status={figure.id}>
              <span className={styles.caption}>{figure.label}</span>
              <strong className={styles.amount}>{figure.totals.units}</strong>
              <span className={styles.counts}>
                {formatCount(figure.totals.orders, dict.orders_count_one, dict.orders_count)}
              </span>
            </div>
          ))}
        </div>

        <div className={styles.statusBar} role="img" aria-label={dict.status_bar_label}>
          {statuses.map((row) => (
            <span
              key={row.key}
              className={styles.segment}
              data-status={row.key as OrderStatus}
              style={{ flexGrow: row.units }}
              title={`${row.label}: ${row.units}`}
            />
          ))}
        </div>

        <ul className={styles.legend}>
          {statuses.map((row) => (
            <li key={row.key} className={styles.legendItem}>
              <span className={styles.dot} data-status={row.key as OrderStatus} />
              <span>{row.label}</span>
              <strong>{row.units}</strong>
              <span className={styles.legendShare}>
                {totalUnits > 0 ? Math.round((row.units / totalUnits) * 100) : 0}%
              </span>
            </li>
          ))}
        </ul>
      </Card.Body>
    </Card>
  );
}
