import { addDays, endOfDay, format, startOfDay } from "date-fns";
import type { Order, OrderItem, OrderSource } from "@/types/shop/order";
import type { OrderStatus } from "@/types/shop/orderStatus";
import {
  PAYMENT_FEES,
  RESERVATION,
  type CheckoutChoice,
  type PaymentMethod,
} from "@/types/shop/payment";
import { formatMoney, fromCents, toCents } from "@/utils/shop/moneyUtils";
import { isSettledOrderStatus } from "@/utils/shop/orderStatusUtils";
import { formatCampus, isColorKey, isSizeKey, splitNameHex } from "@/utils/shop/shopUtils";

export type OverviewBucket = "paid" | "pending" | "cancelled";

export type OverviewMetric = "units" | "amount";

export interface OverviewFilters {
  from?: Date;
  to?: Date;
  productKey?: string;
}

export interface OverviewLine {
  order: Order;
  item: OrderItem;
  bucket: OverviewBucket;
  /** What the customer pays for this line, after the order discount is spread across its items. */
  netCents: number;
  /** Payment provider fee for this line (estimated while the order is not paid yet). */
  feeCents: number;
  /** What NEIIST pays per unit, or null when the product has no cost set. */
  unitCost: number | null;
}

export type ProductCosts = Record<number, number>;

export interface OverviewTotals {
  orders: number;
  units: number;
  amount: number;
}

export interface OverviewSummary {
  total: OverviewTotals;
  paid: OverviewTotals;
  pending: OverviewTotals;
  cancelled: OverviewTotals;
}

export interface OverviewRow {
  key: string;
  label: string;
  hex?: string;
  orders: number;
  units: number;
  amount: number;
  paidUnits: number;
  paidAmount: number;
  pendingUnits: number;
  pendingAmount: number;
  share: number;
}

export interface OverviewOptionGroup {
  key: string;
  name: string;
  rows: OverviewRow[];
}

export interface OverviewMatrix {
  rowName: string;
  colName: string;
  rows: Array<{ key: string; label: string; hex?: string }>;
  cols: Array<{ key: string; label: string }>;
  cells: Record<string, Record<string, number>>;
  rowTotals: Record<string, number>;
  colTotals: Record<string, number>;
  total: number;
}

export interface OverviewProductMatrix {
  key: string;
  name: string;
  matrix: OverviewMatrix;
}

export interface OverviewFinanceTotals {
  units: number;
  gross: number;
  discounts: number;
  net: number;
  fees: number;
  cost: number;
  profit: number;
  margin: number | null;
}

export interface OverviewFinance {
  paid: OverviewFinanceTotals;
  expected: OverviewFinanceTotals;
  pendingNet: number;
  missingCost: Array<{ productId: number; name: string }>;
}

export interface OverviewProductFinance extends OverviewFinanceTotals {
  key: string;
  productId: number;
  label: string;
  paidUnits: number;
  averagePrice: number;
  unitCost: number | null;
}

interface GroupKey {
  key: string;
  label: string;
  hex?: string;
}

const SIZE_ORDER = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "2XL", "XXXL", "3XL", "4XL"];

export function formatCount(count: number, one: string, other: string): string {
  return (count === 1 ? one : other).replace("{count}", String(count));
}

export function formatMetric(value: number, metric: OverviewMetric): string {
  return metric === "amount" ? formatMoney(value) : String(value);
}

export function getItemBucket(status: OrderStatus): OverviewBucket {
  if (status === "cancelled") return "cancelled";
  return isSettledOrderStatus(status) ? "paid" : "pending";
}

export function getItemProductKey(item: OrderItem): string {
  return item.product_id ? String(item.product_id) : item.product_name;
}

export function getOverviewProducts(orders: Order[]): Array<{ value: string; label: string }> {
  const products = new Map<string, string>();
  orders.forEach((order) =>
    order.items.forEach((item) => products.set(getItemProductKey(item), item.product_name))
  );
  return [...products.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function getPaymentFeeCents(method: PaymentMethod, amountCents: number): number {
  const fee = PAYMENT_FEES[method];
  if (!fee || amountCents <= 0) return 0;
  return Math.round((amountCents * fee.rate + toCents(fee.fixed)) * (1 + fee.vat));
}

/** Total of each payment across all the orders it settled, so fixed fees are charged once. */
function getPaymentTotals(orders: Order[]): Map<number, number> {
  const totals = new Map<number, number>();
  orders.forEach((order) =>
    (order.payments ?? []).forEach((payment) =>
      totals.set(payment.id, (totals.get(payment.id) ?? 0) + toCents(payment.amount))
    )
  );
  return totals;
}

function getOrderFeeCents(order: Order, paymentTotals: Map<number, number>): number {
  const payments = order.payments ?? [];
  const successful = payments.filter((payment) => payment.status === "successful");

  if (successful.length > 0) {
    return successful.reduce((acc, payment) => {
      const paymentTotal = paymentTotals.get(payment.id) ?? toCents(payment.amount);
      const fee = getPaymentFeeCents(payment.method, paymentTotal);
      return (
        acc + (paymentTotal > 0 ? Math.round((fee * toCents(payment.amount)) / paymentTotal) : 0)
      );
    }, 0);
  }

  const pendingPayment = payments.find((payment) => payment.status === "pending");
  return pendingPayment
    ? getPaymentFeeCents(pendingPayment.method, toCents(order.total_amount))
    : 0;
}

/** Splits an order-level amount across its items in proportion to their price. */
function splitByItem(totalCents: number, weights: number[]): number[] {
  const weightSum = weights.reduce((acc, weight) => acc + weight, 0);
  if (weightSum <= 0) return weights.map(() => 0);

  let remaining = totalCents;
  return weights.map((weight, index) => {
    if (index === weights.length - 1) return remaining;
    const share = Math.round((totalCents * weight) / weightSum);
    remaining -= share;
    return share;
  });
}

export function buildOverviewLines(
  orders: Order[],
  filters: OverviewFilters,
  costs: ProductCosts = {}
): OverviewLine[] {
  const from = filters.from ? startOfDay(filters.from) : null;
  const to = filters.to ? endOfDay(filters.to) : null;
  const paymentTotals = getPaymentTotals(orders);

  return orders.flatMap((order) => {
    const createdAt = new Date(order.created_at);
    if ((from && createdAt < from) || (to && createdAt > to)) return [];

    const weights = order.items.map((item) =>
      item.status === "cancelled" ? 0 : toCents(item.total_price)
    );
    const netShares = splitByItem(toCents(order.total_amount), weights);
    const feeShares = splitByItem(getOrderFeeCents(order, paymentTotals), weights);

    return order.items.flatMap((item, index) => {
      if (filters.productKey && getItemProductKey(item) !== filters.productKey) return [];
      const bucket = getItemBucket(item.status);
      return {
        order,
        item,
        bucket,
        netCents: bucket === "cancelled" ? toCents(item.total_price) : netShares[index],
        feeCents: bucket === "cancelled" ? 0 : feeShares[index],
        unitCost: item.product_id in costs ? costs[item.product_id] : null,
      };
    });
  });
}

function sumLines(lines: OverviewLine[]): OverviewTotals {
  return {
    orders: new Set(lines.map((line) => line.order.order_number)).size,
    units: lines.reduce((acc, line) => acc + line.item.quantity, 0),
    amount: fromCents(lines.reduce((acc, line) => acc + line.netCents, 0)),
  };
}

function sumFinance(lines: OverviewLine[]): OverviewFinanceTotals {
  const grossCents = lines.reduce((acc, line) => acc + toCents(line.item.total_price), 0);
  const netCents = lines.reduce((acc, line) => acc + line.netCents, 0);
  const feeCents = lines.reduce((acc, line) => acc + line.feeCents, 0);
  const costCents = lines.reduce(
    (acc, line) => acc + (line.unitCost === null ? 0 : toCents(line.unitCost) * line.item.quantity),
    0
  );
  const profitCents = netCents - feeCents - costCents;

  return {
    units: lines.reduce((acc, line) => acc + line.item.quantity, 0),
    gross: fromCents(grossCents),
    discounts: fromCents(grossCents - netCents),
    net: fromCents(netCents),
    fees: fromCents(feeCents),
    cost: fromCents(costCents),
    profit: fromCents(profitCents),
    margin: netCents > 0 ? profitCents / netCents : null,
  };
}

export function summarizeFinance(lines: OverviewLine[]): OverviewFinance {
  const active = lines.filter((line) => line.bucket !== "cancelled");

  const missingCost = new Map<number, string>();
  active.forEach(({ item, unitCost }) => {
    if (unitCost === null && item.product_id) missingCost.set(item.product_id, item.product_name);
  });

  return {
    paid: sumFinance(active.filter((line) => line.bucket === "paid")),
    expected: sumFinance(active),
    pendingNet: fromCents(
      active
        .filter((line) => line.bucket === "pending")
        .reduce((acc, line) => acc + line.netCents, 0)
    ),
    missingCost: [...missingCost.entries()].map(([productId, name]) => ({ productId, name })),
  };
}

export function groupProductFinance(lines: OverviewLine[]): OverviewProductFinance[] {
  const products = new Map<string, OverviewLine[]>();
  lines
    .filter((line) => line.bucket !== "cancelled")
    .forEach((line) => {
      const key = getItemProductKey(line.item);
      products.set(key, [...(products.get(key) ?? []), line]);
    });

  return [...products.entries()]
    .map(([key, productLines]) => {
      const totals = sumFinance(productLines);
      const [{ item, unitCost }] = productLines;
      return {
        ...totals,
        key,
        productId: item.product_id,
        label: item.product_name,
        paidUnits: productLines
          .filter((line) => line.bucket === "paid")
          .reduce((acc, line) => acc + line.item.quantity, 0),
        averagePrice:
          totals.units > 0 ? fromCents(Math.round(toCents(totals.net) / totals.units)) : 0,
        unitCost,
      };
    })
    .sort((a, b) => b.units - a.units);
}

/** Fees paid per payment method, with the share of the money they took. */
export function summarizeFeesByMethod(
  lines: OverviewLine[]
): Record<string, { fees: number; rate: number }> {
  const methods = new Map<string, { net: number; fees: number }>();
  lines
    .filter((line) => line.bucket === "paid" && line.order.payment_method)
    .forEach((line) => {
      const method = line.order.payment_method as string;
      const entry = methods.get(method) ?? { net: 0, fees: 0 };
      entry.net += line.netCents;
      entry.fees += line.feeCents;
      methods.set(method, entry);
    });

  return Object.fromEntries(
    [...methods.entries()].map(([method, { net, fees }]) => [
      method,
      { fees: fromCents(fees), rate: net > 0 ? fees / net : 0 },
    ])
  );
}

export function summarizeOverview(lines: OverviewLine[]): OverviewSummary {
  return {
    total: sumLines(lines.filter((line) => line.bucket !== "cancelled")),
    paid: sumLines(lines.filter((line) => line.bucket === "paid")),
    pending: sumLines(lines.filter((line) => line.bucket === "pending")),
    cancelled: sumLines(lines.filter((line) => line.bucket === "cancelled")),
  };
}

function groupLines(
  lines: OverviewLine[],
  getKey: (_line: OverviewLine) => GroupKey | null,
  includeCancelled = false
): OverviewRow[] {
  const groups = new Map<string, GroupKey & { lines: OverviewLine[] }>();

  lines.forEach((line) => {
    if (!includeCancelled && line.bucket === "cancelled") return;
    const group = getKey(line);
    if (!group) return;
    const existing = groups.get(group.key);
    if (existing) existing.lines.push(line);
    else groups.set(group.key, { ...group, lines: [line] });
  });

  const totalUnits = [...groups.values()].reduce(
    (acc, group) => acc + group.lines.reduce((sum, line) => sum + line.item.quantity, 0),
    0
  );

  return [...groups.values()]
    .map(({ lines: groupedLines, ...group }) => {
      const totals = sumLines(groupedLines);
      const paid = sumLines(groupedLines.filter((line) => line.bucket === "paid"));
      const pending = sumLines(groupedLines.filter((line) => line.bucket === "pending"));
      return {
        ...group,
        ...totals,
        paidUnits: paid.units,
        paidAmount: paid.amount,
        pendingUnits: pending.units,
        pendingAmount: pending.amount,
        share: totalUnits > 0 ? (totals.units / totalUnits) * 100 : 0,
      };
    })
    .sort((a, b) => b.units - a.units || a.label.localeCompare(b.label));
}

function getSizeRank(value: string): number {
  const index = SIZE_ORDER.indexOf(value.trim().toUpperCase());
  return index === -1 ? SIZE_ORDER.length : index;
}

function sortOptionValues<T extends { key: string; label: string }>(
  optionName: string,
  values: T[]
): T[] {
  if (!isSizeKey(optionName)) return values;
  return [...values].sort(
    (a, b) => getSizeRank(a.label) - getSizeRank(b.label) || a.label.localeCompare(b.label)
  );
}

function getOptionGroupKey(optionName: string, value: string): GroupKey {
  if (!isColorKey(optionName)) return { key: value.trim().toLowerCase(), label: value.trim() };
  const { name, hex } = splitNameHex(value);
  const label = name || hex;
  return { key: label.toLowerCase(), label, hex: hex || undefined };
}

function getOptionNames(lines: OverviewLine[]): Map<string, string> {
  const names = new Map<string, string>();
  lines.forEach(({ item }) =>
    Object.keys(item.variant_options ?? {}).forEach((name) => {
      const key = isColorKey(name) ? "color" : name.trim().toLowerCase();
      if (!names.has(key)) names.set(key, name);
    })
  );
  return names;
}

function findOptionValue(item: OrderItem, optionKey: string): string | undefined {
  const entry = Object.entries(item.variant_options ?? {}).find(([name]) =>
    optionKey === "color" ? isColorKey(name) : name.trim().toLowerCase() === optionKey
  );
  return entry?.[1];
}

export function groupByStatus(
  lines: OverviewLine[],
  labels: Record<OrderStatus, string>
): OverviewRow[] {
  const order = Object.keys(labels);
  return groupLines(
    lines,
    ({ item }) => ({ key: item.status, label: labels[item.status] ?? item.status }),
    true
  ).sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
}

export function groupByOptions(lines: OverviewLine[]): OverviewOptionGroup[] {
  return [...getOptionNames(lines).entries()].map(([key, name]) => ({
    key,
    name,
    rows: sortOptionValues(
      name,
      groupLines(lines, ({ item }) => {
        const value = findOptionValue(item, key);
        return value ? getOptionGroupKey(name, value) : null;
      })
    ),
  }));
}

export function groupByCampus(lines: OverviewLine[], noneLabel: string): OverviewRow[] {
  return groupLines(lines, ({ order }) => {
    const campus = formatCampus(order.campus);
    return { key: campus.toLowerCase(), label: campus || noneLabel };
  });
}

export function groupByPaymentMethod(
  lines: OverviewLine[],
  labels: Record<CheckoutChoice, string>,
  noPaymentLabel: string
): OverviewRow[] {
  return groupLines(lines, ({ order }) => {
    if (order.payment_method)
      return { key: order.payment_method, label: labels[order.payment_method] };
    if (isSettledOrderStatus(order.status)) return { key: "none", label: noPaymentLabel };
    return { key: RESERVATION, label: labels[RESERVATION] };
  });
}

export function groupByChannel(
  lines: OverviewLine[],
  labels: Record<OrderSource, string>
): OverviewRow[] {
  return groupLines(lines, ({ order }) => {
    const source = order.order_source ?? "web";
    return { key: source, label: labels[source] ?? source };
  });
}

export function groupByDay(lines: OverviewLine[]): OverviewRow[] {
  const rows = groupLines(lines, ({ order }) => {
    const date = new Date(order.created_at);
    return { key: format(date, "yyyy-MM-dd"), label: format(date, "dd/MM") };
  }).sort((a, b) => a.key.localeCompare(b.key));
  if (rows.length === 0) return rows;

  const byDay = new Map(rows.map((row) => [row.key, row]));
  const days: OverviewRow[] = [];
  const last = new Date(`${rows[rows.length - 1].key}T00:00:00`);
  for (let day = new Date(`${rows[0].key}T00:00:00`); day <= last; day = addDays(day, 1)) {
    const key = format(day, "yyyy-MM-dd");
    days.push(
      byDay.get(key) ?? {
        key,
        label: format(day, "dd/MM"),
        orders: 0,
        units: 0,
        amount: 0,
        paidUnits: 0,
        paidAmount: 0,
        pendingUnits: 0,
        pendingAmount: 0,
        share: 0,
      }
    );
  }
  return days;
}

function buildVariantMatrix(lines: OverviewLine[]): OverviewMatrix | null {
  const activeLines = lines.filter((line) => line.bucket !== "cancelled");
  const optionNames = [...getOptionNames(activeLines).entries()];
  if (optionNames.length !== 2) return null;

  const [[rowKey, rowName], [colKey, colName]] =
    optionNames[1][0] === "color" ? [optionNames[1], optionNames[0]] : optionNames;

  const rows = new Map<string, GroupKey>();
  const cols = new Map<string, GroupKey>();
  const cells: Record<string, Record<string, number>> = {};
  const rowTotals: Record<string, number> = {};
  const colTotals: Record<string, number> = {};
  let total = 0;

  activeLines.forEach(({ item }) => {
    const rowValue = findOptionValue(item, rowKey);
    const colValue = findOptionValue(item, colKey);
    if (!rowValue || !colValue) return;

    const row = getOptionGroupKey(rowName, rowValue);
    const col = getOptionGroupKey(colName, colValue);
    rows.set(row.key, rows.get(row.key) ?? row);
    cols.set(col.key, cols.get(col.key) ?? col);

    cells[row.key] = cells[row.key] ?? {};
    cells[row.key][col.key] = (cells[row.key][col.key] ?? 0) + item.quantity;
    rowTotals[row.key] = (rowTotals[row.key] ?? 0) + item.quantity;
    colTotals[col.key] = (colTotals[col.key] ?? 0) + item.quantity;
    total += item.quantity;
  });

  if (total === 0) return null;

  const sortedRows = isSizeKey(rowName)
    ? sortOptionValues(rowName, [...rows.values()])
    : [...rows.values()].sort((a, b) => (rowTotals[b.key] ?? 0) - (rowTotals[a.key] ?? 0));

  return {
    rowName,
    colName,
    rows: sortedRows,
    cols: sortOptionValues(colName, [...cols.values()]),
    cells,
    rowTotals,
    colTotals,
    total,
  };
}

export function buildProductMatrices(lines: OverviewLine[]): OverviewProductMatrix[] {
  const products = new Map<string, { name: string; lines: OverviewLine[] }>();
  lines.forEach((line) => {
    const key = getItemProductKey(line.item);
    const product = products.get(key) ?? { name: line.item.product_name, lines: [] };
    product.lines.push(line);
    products.set(key, product);
  });

  return [...products.entries()]
    .map(([key, product]) => ({
      key,
      name: product.name,
      matrix: buildVariantMatrix(product.lines),
    }))
    .filter((entry): entry is OverviewProductMatrix => entry.matrix !== null)
    .sort((a, b) => b.matrix.total - a.matrix.total);
}
