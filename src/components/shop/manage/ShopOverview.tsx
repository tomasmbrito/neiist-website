"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { format, startOfDay, subDays } from "date-fns";
import { enGB, pt } from "date-fns/locale";
import { FaArrowLeft } from "react-icons/fa";
import { FiBarChart2 } from "react-icons/fi";
import { Button, ColorfulText, DateInput, EmptyState, Field, Select } from "@neiist/ui";
import OverviewBarList from "@/components/shop/manage/overview/OverviewBarList";
import OverviewDailyChart from "@/components/shop/manage/overview/OverviewDailyChart";
import OverviewMatrix from "@/components/shop/manage/overview/OverviewMatrix";
import OverviewSummary from "@/components/shop/manage/overview/OverviewSummary";
import type { Dictionary } from "@/i18n/dictionaries";
import type { Locale } from "@/i18n/i18n-config";
import styles from "@/styles/components/shop/manage/ShopOverview.module.css";
import type { Order, OrderSource } from "@/types/shop/order";
import type { OrderStatus } from "@/types/shop/orderStatus";
import { RESERVATION, type PaymentMethod } from "@/types/shop/payment";
import { getAcademicYearForDate, parseAcademicYearRange } from "@/utils/academicYearUtils";
import {
  buildOverviewLines,
  buildProductMatrices,
  getOverviewProducts,
  groupByCampus,
  groupByChannel,
  groupByDay,
  groupByOptions,
  groupByPaymentMethod,
  groupByProduct,
  groupByStatus,
  summarizeDiscounts,
  summarizeOverview,
  type OverviewMetric,
} from "@/utils/shop/shopOverviewUtils";

const ALL_PRODUCTS = "all";

type PeriodPreset = "today" | "last_7" | "last_30" | "academic_year" | "all_time";

const PERIOD_PRESETS: PeriodPreset[] = ["today", "last_7", "last_30", "academic_year", "all_time"];

function getPresetRange(preset: PeriodPreset): { from?: Date; to?: Date } {
  const today = startOfDay(new Date());
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "last_7":
      return { from: subDays(today, 6) };
    case "last_30":
      return { from: subDays(today, 29) };
    case "academic_year":
      return { from: parseAcademicYearRange(getAcademicYearForDate()).start };
    default:
      return {};
  }
}

interface ShopOverviewProps {
  orders: Order[];
  locale: Locale;
  basePath: string;
  dict: Dictionary["shop_overview"];
  statusLabels: Record<OrderStatus, string>;
  paymentLabels: Record<PaymentMethod, string>;
  channelLabels: Record<OrderSource, string>;
}

export default function ShopOverview({
  orders,
  locale,
  basePath,
  dict,
  statusLabels,
  paymentLabels,
  channelLabels,
}: ShopOverviewProps) {
  const router = useRouter();
  const dateLocale = locale === "en" ? enGB : pt;
  const [preset, setPreset] = useState<PeriodPreset | null>("academic_year");
  const [range, setRange] = useState(() => getPresetRange("academic_year"));
  const [productKey, setProductKey] = useState(ALL_PRODUCTS);
  const [metric, setMetric] = useState<OverviewMetric>("units");

  const isProductSelected = productKey !== ALL_PRODUCTS;

  const productOptions = useMemo(
    () => [{ value: ALL_PRODUCTS, label: dict.all_products }, ...getOverviewProducts(orders)],
    [orders, dict.all_products]
  );

  const lines = useMemo(
    () =>
      buildOverviewLines(orders, {
        ...range,
        productKey: isProductSelected ? productKey : undefined,
      }),
    [orders, range, productKey, isProductSelected]
  );

  const overview = useMemo(
    () => ({
      summary: summarizeOverview(lines),
      statuses: groupByStatus(lines, statusLabels),
      matrices: buildProductMatrices(lines),
      products: groupByProduct(lines),
      options: groupByOptions(lines),
      campuses: groupByCampus(lines, dict.no_campus),
      payments: groupByPaymentMethod(lines, { ...paymentLabels, [RESERVATION]: dict.reservation }),
      channels: groupByChannel(lines, channelLabels),
      days: groupByDay(lines),
      discounts: isProductSelected ? null : summarizeDiscounts(lines),
    }),
    [lines, isProductSelected, statusLabels, paymentLabels, channelLabels, dict]
  );

  const periodText = useMemo(() => {
    const from = range.from ? format(range.from, "dd/MM/yyyy") : null;
    const to = range.to ? format(range.to, "dd/MM/yyyy") : null;
    const product = productOptions.find((option) => option.value === productKey)?.label ?? "";
    const period =
      from && to
        ? dict.period_range.replace("{from}", from).replace("{to}", to)
        : from
          ? dict.period_from.replace("{from}", from)
          : to
            ? dict.period_to.replace("{to}", to)
            : dict.period_all;
    return `${period} ${dict.period_product.replace("{product}", product)}`;
  }, [range, productKey, productOptions, dict]);

  const handlePreset = (next: PeriodPreset) => {
    setPreset(next);
    setRange(getPresetRange(next));
  };

  const handleDateChange = (key: "from" | "to", date?: Date) => {
    setPreset(null);
    setRange((prev) => ({ ...prev, [key]: date }));
  };

  return (
    <main className={styles.container}>
      <Button
        type="button"
        variant="ghost"
        color="neutral"
        className={styles.backBtn}
        onClick={() => router.push(`${basePath}/orders`)}>
        <FaArrowLeft /> {dict.back}
      </Button>

      <header className={styles.header}>
        <ColorfulText as="h1" className={styles.title} text={dict.title} />
        <p className={styles.period}>{periodText}</p>
      </header>

      <section className={styles.filters} aria-label={dict.filters_label}>
        <div className={styles.presets} role="group" aria-label={dict.period_label}>
          {PERIOD_PRESETS.map((option) => (
            <Button
              key={option}
              size="sm"
              variant={preset === option ? "primary" : "outline"}
              aria-pressed={preset === option}
              onClick={() => handlePreset(option)}>
              {dict.presets[option]}
            </Button>
          ))}
        </div>
        <div className={styles.fields}>
          <Field label={dict.from_label} className={styles.dateField}>
            <DateInput
              value={range.from}
              onChange={(date) => handleDateChange("from", date)}
              placeholder={dict.date_placeholder}
              mobileDrawerTitle={dict.from_label}
              locale={dateLocale}
            />
          </Field>
          <Field label={dict.to_label} className={styles.dateField}>
            <DateInput
              value={range.to}
              onChange={(date) => handleDateChange("to", date)}
              placeholder={dict.date_placeholder}
              mobileDrawerTitle={dict.to_label}
              locale={dateLocale}
            />
          </Field>
          <Field label={dict.product_label} className={styles.productField}>
            <Select
              options={productOptions}
              value={productKey}
              onChange={setProductKey}
              title={dict.product_label}
            />
          </Field>
        </div>
      </section>

      {lines.length === 0 ? (
        <EmptyState
          icon={<FiBarChart2 size={64} />}
          title={dict.empty_title}
          description={dict.empty_hint}
          action={
            <Button variant="outline" size="sm" onClick={() => handlePreset("all_time")}>
              {dict.empty_action}
            </Button>
          }
        />
      ) : (
        <>
          <div className={styles.toolbar}>
            <div className={styles.metricToggle} role="group" aria-label={dict.metric_label}>
              <span>{dict.metric_label}</span>
              {(["units", "amount"] as const).map((option) => (
                <Button
                  key={option}
                  size="sm"
                  variant={metric === option ? "primary" : "ghost"}
                  aria-pressed={metric === option}
                  onClick={() => setMetric(option)}>
                  {option === "units" ? dict.metric_units : dict.metric_amount}
                </Button>
              ))}
            </div>
            <ul className={styles.legend}>
              <li className={styles.legendPaid}>{dict.legend_paid}</li>
              <li className={styles.legendPending}>{dict.legend_pending}</li>
            </ul>
          </div>

          <OverviewSummary
            summary={overview.summary}
            statuses={overview.statuses}
            discounts={overview.discounts}
            metric={metric}
            dict={dict}
          />

          {overview.matrices.length > 0 && (
            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>{dict.matrix_section}</h2>
              <div className={styles.matrixGrid}>
                {overview.matrices.map((product) => (
                  <OverviewMatrix key={product.key} product={product} dict={dict} />
                ))}
              </div>
            </section>
          )}

          <OverviewDailyChart days={overview.days} metric={metric} dict={dict} />

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>{dict.breakdown_section}</h2>
            <div className={styles.breakdownGrid}>
              {!isProductSelected && (
                <OverviewBarList
                  title={dict.section_products}
                  rows={overview.products}
                  metric={metric}
                  dict={dict}
                />
              )}
              {overview.options.map((option) => (
                <OverviewBarList
                  key={option.key}
                  title={option.name}
                  rows={option.rows}
                  metric={metric}
                  dict={dict}
                />
              ))}
              <OverviewBarList
                title={dict.section_campus}
                rows={overview.campuses}
                metric={metric}
                dict={dict}
              />
              <OverviewBarList
                title={dict.section_payment}
                rows={overview.payments}
                metric={metric}
                dict={dict}
              />
              <OverviewBarList
                title={dict.section_channel}
                rows={overview.channels}
                metric={metric}
                dict={dict}
              />
            </div>
          </section>
        </>
      )}
    </main>
  );
}
