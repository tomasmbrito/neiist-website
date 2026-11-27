"use client";

import { useState } from "react";
import { Card } from "@neiist/ui";
import type { Dictionary } from "@/i18n/dictionaries";
import styles from "@/styles/components/shop/manage/overview/OverviewDailyChart.module.css";
import {
  formatCount,
  formatMetric,
  type OverviewMetric,
  type OverviewRow,
} from "@/utils/shop/shopOverviewUtils";

const MAX_AXIS_LABELS = 10;

interface OverviewDailyChartProps {
  days: OverviewRow[];
  metric: OverviewMetric;
  dict: Dictionary["shop_overview"];
}

export default function OverviewDailyChart({ days, metric, dict }: OverviewDailyChartProps) {
  const [activeKey, setActiveKey] = useState<string | null>(null);

  const getTotal = (day: OverviewRow) => (metric === "amount" ? day.amount : day.units);
  const getPaid = (day: OverviewRow) => (metric === "amount" ? day.paidAmount : day.paidUnits);
  const getPending = (day: OverviewRow) =>
    metric === "amount" ? day.pendingAmount : day.pendingUnits;
  const formatValue = (value: number) =>
    metric === "units"
      ? formatCount(value, dict.units_count_one, dict.units_count)
      : formatMetric(value, metric);

  const max = Math.max(...days.map(getTotal), 0);
  const peak = days.reduce<OverviewRow | null>(
    (best, day) => (!best || getTotal(day) > getTotal(best) ? day : best),
    null
  );
  const labelEvery = Math.ceil(days.length / MAX_AXIS_LABELS);

  const describeDay = (day: OverviewRow) =>
    dict.daily_tooltip
      .replace("{day}", day.label)
      .replace("{value}", formatValue(getTotal(day)))
      .replace("{pending}", formatMetric(getPending(day), metric));

  const activeDay = days.find((day) => day.key === activeKey);
  const description = activeDay
    ? describeDay(activeDay)
    : peak && max > 0
      ? dict.daily_peak.replace("{day}", peak.label).replace("{value}", formatValue(getTotal(peak)))
      : undefined;

  return (
    <Card>
      <Card.Header title={dict.daily_title} description={description} />
      <Card.Body>
        <div className={styles.chart}>
          <div className={styles.grid} aria-hidden="true">
            <span>{formatMetric(max, metric)}</span>
            <span>{formatMetric(metric === "units" ? Math.round(max / 2) : max / 2, metric)}</span>
            <span>0</span>
          </div>
          <ol className={styles.columns} onMouseLeave={() => setActiveKey(null)}>
            {days.map((day, index) => (
              <li key={day.key} className={styles.column}>
                <button
                  type="button"
                  className={styles.bar}
                  data-active={day.key === activeKey || undefined}
                  aria-label={describeDay(day)}
                  onMouseEnter={() => setActiveKey(day.key)}
                  onFocus={() => setActiveKey(day.key)}
                  onBlur={() => setActiveKey(null)}>
                  <span
                    className={styles.pending}
                    style={{ height: max > 0 ? `${(getPending(day) / max) * 100}%` : 0 }}
                  />
                  <span
                    className={styles.paid}
                    style={{ height: max > 0 ? `${(getPaid(day) / max) * 100}%` : 0 }}
                  />
                </button>
                <span className={styles.axisLabel} aria-hidden="true">
                  {index % labelEvery === 0 ? day.label : ""}
                </span>
              </li>
            ))}
          </ol>
        </div>
      </Card.Body>
    </Card>
  );
}
