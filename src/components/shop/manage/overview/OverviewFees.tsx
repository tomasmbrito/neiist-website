import { Card } from "@neiist/ui";
import type { Dictionary } from "@/i18n/dictionaries";
import styles from "@/styles/components/shop/manage/overview/OverviewFees.module.css";
import { formatMoney } from "@/utils/shop/moneyUtils";
import { formatCount, type OverviewFeeRow } from "@/utils/shop/shopOverviewUtils";

interface OverviewFeesProps {
  rows: OverviewFeeRow[];
  dict: Dictionary["shop_overview"];
}

export default function OverviewFees({ rows, dict }: OverviewFeesProps) {
  const total = rows.reduce((acc, row) => acc + row.fees, 0);

  return (
    <Card>
      <Card.Header
        title={dict.fees_title}
        description={dict.fees_subtitle.replace("{amount}", formatMoney(total))}
      />
      <Card.Body>
        {rows.length === 0 ? (
          <p className={styles.empty}>{dict.no_data}</p>
        ) : (
          <ul className={styles.list}>
            {rows.map((row) => (
              <li key={row.key} className={styles.row}>
                <span className={styles.label}>
                  {row.label}
                  <span>
                    {dict.fees_row
                      .replace(
                        "{payments}",
                        formatCount(row.payments, dict.payments_count_one, dict.payments_count)
                      )
                      .replace("{amount}", formatMoney(row.amount))}
                  </span>
                </span>
                <span className={styles.value}>
                  <strong>{formatMoney(row.fees)}</strong>
                  <span>{(row.rate * 100).toFixed(1)}%</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card.Body>
    </Card>
  );
}
