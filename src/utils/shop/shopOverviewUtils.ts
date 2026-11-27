import { addDays, endOfDay, format, startOfDay } from "date-fns";
import type { Order, OrderItem, OrderSource } from "@/types/shop/order";
import type { OrderStatus } from "@/types/shop/orderStatus";
import { RESERVATION, type CheckoutChoice } from "@/types/shop/payment";
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
}

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

export interface OverviewDiscounts {
  orders: number;
  amount: number;
  netPaidAmount: number;
  codes: Array<{ code: string; orders: number; amount: number }>;
}

interface GroupKey {
  key: string;
  label: string;
  hex?: string;
}

const SIZE_ORDER = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "2XL", "XXXL", "3XL", "4XL"];

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

export function buildOverviewLines(orders: Order[], filters: OverviewFilters): OverviewLine[] {
  const from = filters.from ? startOfDay(filters.from) : null;
  const to = filters.to ? endOfDay(filters.to) : null;

  return orders.flatMap((order) => {
    const createdAt = new Date(order.created_at);
    if ((from && createdAt < from) || (to && createdAt > to)) return [];

    return order.items
      .filter((item) => !filters.productKey || getItemProductKey(item) === filters.productKey)
      .map((item) => ({ order, item, bucket: getItemBucket(item.status) }));
  });
}

function sumLines(lines: OverviewLine[]): OverviewTotals {
  return {
    orders: new Set(lines.map((line) => line.order.order_number)).size,
    units: lines.reduce((acc, line) => acc + line.item.quantity, 0),
    amount: fromCents(lines.reduce((acc, line) => acc + toCents(line.item.total_price), 0)),
  };
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

export function groupByProduct(lines: OverviewLine[]): OverviewRow[] {
  return groupLines(lines, ({ item }) => ({
    key: getItemProductKey(item),
    label: item.product_name,
  }));
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
  labels: Record<CheckoutChoice, string>
): OverviewRow[] {
  return groupLines(lines, ({ order }) => {
    const method = order.payment_method ?? RESERVATION;
    return { key: method, label: labels[method] ?? method };
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

export function summarizeDiscounts(lines: OverviewLine[]): OverviewDiscounts {
  const orders = new Map<string, Order>();
  lines
    .filter((line) => line.bucket !== "cancelled")
    .forEach((line) => orders.set(line.order.order_number, line.order));

  const codes = new Map<string, { code: string; orders: number; cents: number }>();
  let discountCents = 0;
  let discountedOrders = 0;
  let netPaidCents = 0;

  orders.forEach((order) => {
    if (isSettledOrderStatus(order.status)) netPaidCents += toCents(order.total_amount);

    const cents = toCents(order.discount_amount);
    if (cents <= 0) return;
    discountCents += cents;
    discountedOrders += 1;

    const code = order.discount_code ?? "—";
    const entry = codes.get(code) ?? { code, orders: 0, cents: 0 };
    entry.orders += 1;
    entry.cents += cents;
    codes.set(code, entry);
  });

  return {
    orders: discountedOrders,
    amount: fromCents(discountCents),
    netPaidAmount: fromCents(netPaidCents),
    codes: [...codes.values()]
      .map(({ code, orders: count, cents }) => ({ code, orders: count, amount: fromCents(cents) }))
      .sort((a, b) => b.amount - a.amount),
  };
}
