import { Card } from "@neiist/ui";
import type { Dictionary } from "@/i18n/dictionaries";
import styles from "@/styles/components/shop/manage/overview/OverviewDailyChart.module.css";
import {
  formatMetric,
  type OverviewMetric,
  type OverviewRow,
} from "@/utils/shop/shopOverviewUtils";

const MAX_AXIS_LABELS = 12;

interface OverviewDailyChartProps {
  days: OverviewRow[];
  metric: OverviewMetric;
  dict: Dictionary["shop_overview"];
}

export default function OverviewDailyChart({ days, metric, dict }: OverviewDailyChartProps) {
  const getTotal = (day: OverviewRow) => (metric === "amount" ? day.amount : day.units);
  const getPaid = (day: OverviewRow) => (metric === "amount" ? day.paidAmount : day.paidUnits);
  const getPending = (day: OverviewRow) =>
    metric === "amount" ? day.pendingAmount : day.pendingUnits;

  const max = Math.max(...days.map(getTotal), 0);
  const peak = days.reduce<OverviewRow | null>(
    (best, day) => (!best || getTotal(day) > getTotal(best) ? day : best),
    null
  );
  const labelEvery = Math.ceil(days.length / MAX_AXIS_LABELS);

  return (
    <Card className={styles.card}>
      <Card.Header
        title={dict.daily_title}
        description={
          peak && max > 0
            ? dict.daily_peak
                .replace("{day}", peak.label)
                .replace(
                  "{value}",
                  metric === "units"
                    ? dict.units_count.replace("{count}", String(getTotal(peak)))
                    : formatMetric(getTotal(peak), metric)
                )
            : undefined
        }
      />
      <Card.Body>
        <div className={styles.chart}>
          <span className={styles.maxLabel}>{formatMetric(max, metric)}</span>
          <ol className={styles.columns}>
            {days.map((day, index) => {
              const tooltip = dict.daily_tooltip
                .replace("{day}", day.label)
                .replace("{value}", formatMetric(getTotal(day), metric))
                .replace("{pending}", formatMetric(getPending(day), metric));
              return (
                <li key={day.key} className={styles.column} title={tooltip} aria-label={tooltip}>
                  <span className={styles.stack}>
                    <span
                      className={styles.pending}
                      style={{ height: max > 0 ? `${(getPending(day) / max) * 100}%` : 0 }}
                    />
                    <span
                      className={styles.paid}
                      style={{ height: max > 0 ? `${(getPaid(day) / max) * 100}%` : 0 }}
                    />
                  </span>
                  <span className={styles.axisLabel} aria-hidden="true">
                    {index % labelEvery === 0 ? day.label : ""}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      </Card.Body>
    </Card>
  );
}
