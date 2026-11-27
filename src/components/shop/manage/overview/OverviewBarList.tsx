import { Card, ColorSwatch } from "@neiist/ui";
import type { Dictionary } from "@/i18n/dictionaries";
import styles from "@/styles/components/shop/manage/overview/OverviewBarList.module.css";
import {
  formatMetric,
  type OverviewMetric,
  type OverviewRow,
} from "@/utils/shop/shopOverviewUtils";

interface OverviewBarListProps {
  title: string;
  rows: OverviewRow[];
  metric: OverviewMetric;
  dict: Dictionary["shop_overview"];
}

export default function OverviewBarList({ title, rows, metric, dict }: OverviewBarListProps) {
  const getTotal = (row: OverviewRow) => (metric === "amount" ? row.amount : row.units);
  const getPaid = (row: OverviewRow) => (metric === "amount" ? row.paidAmount : row.paidUnits);
  const getPending = (row: OverviewRow) =>
    metric === "amount" ? row.pendingAmount : row.pendingUnits;

  const grandTotal = rows.reduce((acc, row) => acc + getTotal(row), 0);
  const max = Math.max(...rows.map(getTotal), 0);

  return (
    <Card className={styles.card}>
      <Card.Header title={title} />
      <Card.Body>
        {rows.length === 0 ? (
          <p className={styles.empty}>{dict.no_data}</p>
        ) : (
          <ul className={styles.list}>
            {rows.map((row) => {
              const total = getTotal(row);
              const pending = getPending(row);
              const share = grandTotal > 0 ? Math.round((total / grandTotal) * 100) : 0;
              const barColour = row.hex ?? "var(--ui-primary)";

              return (
                <li key={row.key} className={styles.row}>
                  <div className={styles.rowHead}>
                    <span className={styles.label}>
                      {row.hex && <ColorSwatch color={row.hex} size="sm" ariaLabel={row.label} />}
                      {row.label}
                    </span>
                    <span className={styles.value}>{formatMetric(total, metric)}</span>
                  </div>
                  <div
                    className={styles.track}
                    style={{ "--bar-colour": barColour } as React.CSSProperties}>
                    <span
                      className={styles.paid}
                      style={{ width: max > 0 ? `${(getPaid(row) / max) * 100}%` : 0 }}
                    />
                    <span
                      className={styles.pending}
                      style={{ width: max > 0 ? `${(pending / max) * 100}%` : 0 }}
                    />
                  </div>
                  <div className={styles.rowFoot}>
                    <span>{dict.row_share.replace("{share}", String(share))}</span>
                    {pending > 0 && (
                      <span>
                        {dict.row_pending.replace("{value}", formatMetric(pending, metric))}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card.Body>
    </Card>
  );
}
