import Link from "next/link";
import { Card } from "@neiist/ui";
import type { Dictionary } from "@/i18n/dictionaries";
import styles from "@/styles/components/shop/manage/overview/OverviewFinance.module.css";
import { formatMoney } from "@/utils/shop/moneyUtils";
import { formatCount, type OverviewFinance as Finance } from "@/utils/shop/shopOverviewUtils";

interface OverviewFinanceProps {
  finance: Finance;
  pendingUnits: number;
  inventoryHref: string;
  dict: Dictionary["shop_overview"];
}

function formatMargin(margin: number | null): string {
  return margin === null ? "—" : `${Math.round(margin * 100)}%`;
}

export default function OverviewFinance({
  finance,
  pendingUnits,
  inventoryHref,
  dict,
}: OverviewFinanceProps) {
  const { expected, paid } = finance;
  const isLoss = expected.profit < 0;

  const flow = [
    { id: "profit", label: dict.flow_profit, value: Math.max(expected.profit, 0) },
    { id: "cost", label: dict.flow_cost, value: expected.cost },
    { id: "fees", label: dict.flow_fees, value: expected.fees },
    { id: "discounts", label: dict.flow_discounts, value: expected.discounts },
  ];
  const flowTotal = flow.reduce((acc, segment) => acc + segment.value, 0);

  return (
    <Card className={styles.card}>
      <Card.Body className={styles.body}>
        <div className={styles.figures}>
          <div className={styles.headline}>
            <span className={styles.caption}>{dict.finance_expected_profit}</span>
            <strong className={styles.profit} data-loss={isLoss || undefined}>
              {formatMoney(expected.profit)}
            </strong>
            <span className={styles.note}>
              {dict.finance_margin.replace("{margin}", formatMargin(expected.margin))}{" "}
              {dict.finance_expected_hint}
            </span>
          </div>
          <div className={styles.figure}>
            <span className={styles.caption}>{dict.finance_received}</span>
            <strong className={styles.amount}>{formatMoney(paid.net)}</strong>
            <span className={styles.note}>
              {formatCount(paid.units, dict.units_count_one, dict.units_count)}
            </span>
          </div>
          <div className={styles.figure}>
            <span className={styles.caption}>{dict.finance_to_receive}</span>
            <strong className={styles.amount}>{formatMoney(finance.pendingNet)}</strong>
            <span className={styles.note}>
              {formatCount(pendingUnits, dict.units_count_one, dict.units_count)}
            </span>
          </div>
          <div className={styles.figure}>
            <span className={styles.caption}>{dict.finance_profit_so_far}</span>
            <strong className={styles.amount}>{formatMoney(paid.profit)}</strong>
            <span className={styles.note}>
              {dict.finance_margin.replace("{margin}", formatMargin(paid.margin))}
            </span>
          </div>
        </div>

        <div className={styles.flow}>
          <div className={styles.flowHead}>
            <span className={styles.flowTitle}>{dict.flow_title}</span>
            <span className={styles.note}>
              {dict.flow_subtitle.replace("{gross}", formatMoney(expected.gross))}
            </span>
          </div>
          <div className={styles.flowBar} role="img" aria-label={dict.flow_title}>
            {flow.map((segment) => (
              <span
                key={segment.id}
                className={styles.segment}
                data-flow={segment.id}
                style={{ flexGrow: segment.value }}
                title={`${segment.label}: ${formatMoney(segment.value)}`}
              />
            ))}
          </div>
          <ul className={styles.legend}>
            {flow.map((segment) => (
              <li key={segment.id}>
                <span className={styles.dot} data-flow={segment.id} />
                <span>{segment.label}</span>
                <strong>{formatMoney(segment.value)}</strong>
                <span className={styles.share}>
                  {flowTotal > 0 ? Math.round((segment.value / flowTotal) * 100) : 0}%
                </span>
              </li>
            ))}
          </ul>
        </div>

        {finance.missingCost.length > 0 && (
          <p className={styles.warning}>
            {dict.finance_missing_cost.replace(
              "{products}",
              finance.missingCost.map((product) => product.name).join(", ")
            )}{" "}
            <Link href={inventoryHref}>{dict.finance_missing_cost_link}</Link>
          </p>
        )}
      </Card.Body>
    </Card>
  );
}
