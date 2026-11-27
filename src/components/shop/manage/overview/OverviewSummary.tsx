import { Card } from "@neiist/ui";
import type { Dictionary } from "@/i18n/dictionaries";
import styles from "@/styles/components/shop/manage/overview/OverviewSummary.module.css";
import type { OrderStatus } from "@/types/shop/orderStatus";
import { formatMoney } from "@/utils/shop/moneyUtils";
import {
  formatMetric,
  type OverviewDiscounts,
  type OverviewMetric,
  type OverviewRow,
  type OverviewSummary as Summary,
  type OverviewTotals,
} from "@/utils/shop/shopOverviewUtils";

interface OverviewSummaryProps {
  summary: Summary;
  statuses: OverviewRow[];
  discounts: OverviewDiscounts | null;
  metric: OverviewMetric;
  dict: Dictionary["shop_overview"];
}

export default function OverviewSummary({
  summary,
  statuses,
  discounts,
  metric,
  dict,
}: OverviewSummaryProps) {
  const getValue = (row: OverviewRow) => (metric === "amount" ? row.amount : row.units);
  const statusTotal = statuses.reduce((acc, row) => acc + getValue(row), 0);

  const counts = (totals: OverviewTotals) => (
    <span className={styles.counts}>
      <span>{dict.units_count.replace("{count}", String(totals.units))}</span>
      <span>{dict.orders_count.replace("{count}", String(totals.orders))}</span>
    </span>
  );

  const figures = [
    { id: "paid", label: dict.summary_paid, totals: summary.paid },
    { id: "pending", label: dict.summary_pending, totals: summary.pending },
    { id: "cancelled", label: dict.summary_cancelled, totals: summary.cancelled },
  ];

  return (
    <Card className={styles.card}>
      <Card.Body className={styles.body}>
        <div className={styles.figures}>
          <div className={styles.headline}>
            <span className={styles.caption}>{dict.summary_total}</span>
            <strong className={styles.total}>{formatMoney(summary.total.amount)}</strong>
            {counts(summary.total)}
          </div>
          {figures.map((figure) => (
            <div key={figure.id} className={styles.figure} data-status={figure.id}>
              <span className={styles.caption}>{figure.label}</span>
              <strong className={styles.amount}>{formatMoney(figure.totals.amount)}</strong>
              {counts(figure.totals)}
            </div>
          ))}
        </div>

        <div className={styles.statusBar} role="img" aria-label={dict.status_bar_label}>
          {statuses.map((row) => (
            <span
              key={row.key}
              className={styles.segment}
              data-status={row.key as OrderStatus}
              style={{ flexGrow: getValue(row) }}
              title={`${row.label}: ${formatMetric(getValue(row), metric)}`}
            />
          ))}
        </div>

        <ul className={styles.legend}>
          {statuses.map((row) => (
            <li key={row.key} className={styles.legendItem}>
              <span className={styles.dot} data-status={row.key as OrderStatus} />
              <span>{row.label}</span>
              <strong>{formatMetric(getValue(row), metric)}</strong>
              <span className={styles.legendShare}>
                {statusTotal > 0 ? Math.round((getValue(row) / statusTotal) * 100) : 0}%
              </span>
            </li>
          ))}
        </ul>

        {discounts && discounts.orders > 0 && (
          <div className={styles.discounts}>
            <p>
              {dict.discounts_text
                .replace("{amount}", formatMoney(discounts.amount))
                .replace("{count}", String(discounts.orders))
                .replace("{net}", formatMoney(discounts.netPaidAmount))}
            </p>
            <ul>
              {discounts.codes.map((code) => (
                <li key={code.code}>
                  <strong>{code.code}</strong>
                  {dict.discount_code_line
                    .replace("{count}", String(code.orders))
                    .replace("{amount}", formatMoney(code.amount))}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card.Body>
    </Card>
  );
}
