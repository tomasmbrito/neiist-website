import { Order } from "@/types/shop/order";
import { getColorFromOptions, formatVariantSimple } from "@/utils/shop/shopUtils";
import { getOrderKindFromItems, getOrderStatusLabelForKind } from "@/utils/shop/orderKindUtils";

interface ItemStats {
  modelo: string;
  cor: string;
  tamanho: string;
  quantidade: number;
}

interface CampusItemStats extends ItemStats {
  campus: string;
}

interface CampusDateItemStats extends CampusItemStats {
  data: string;
}

function sortByMultipleFields<T>(a: T, b: T, ...fields: (keyof T)[]): number {
  for (const field of fields) {
    const aValue = String(a[field]);
    const bValue = String(b[field]);
    const orderComparison = aValue.localeCompare(bValue);
    if (orderComparison !== 0) return orderComparison;
  }
  return 0;
}

function buildOrdersSheet(orders: Order[]) {
  return orders.map((order) => ({
    Estado: getOrderStatusLabelForKind(
      getOrderKindFromItems(order.items).orderKind,
      order.status,
      order
    ),
    Número: order.order_number,
    Data: new Date(order.created_at).toLocaleString("pt-PT"),
    Nome: order.customer_name,
    Email: order.customer_email,
    NIF: order.customer_nif || "",
    "IST ID": order.user_istid,
    Campus: order.campus,
    Telefone: order.customer_phone,
    "Método de pagamento": order.payment_method,
    "Referencia de Pagamento": order.payment_reference,
    "Total (€)": order.total_amount,
    Notas: order.notes || "",
    "Ultima modificação por": order.updated_by,
    Produtos: order.items
      .map((item) => `${item.product_name} ${item.variant_label || ""} x${item.quantity}`)
      .join("; "),
  }));
}

function buildStatsSheets(orders: Order[]) {
  const statsMapDetalhes: Record<string, ItemStats> = {};
  const statsMapCampusInventory: Record<string, CampusItemStats> = {};
  const statsMapCampusDate: Record<string, CampusDateItemStats> = {};

  orders.forEach((order) =>
    order.items.forEach((item) => {
      const modelo = item.product_name;
      const colorInfo = getColorFromOptions(item.variant_options, item.variant_label);
      const cor = colorInfo.name || "";
      const tamanho =
        formatVariantSimple(item.variant_options ?? undefined, item.variant_label ?? undefined)
          .text || "";
      const key = `${modelo}|||${cor}|||${tamanho}`;
      if (!statsMapDetalhes[key]) {
        statsMapDetalhes[key] = { modelo, cor, tamanho, quantidade: 0 };
      }
      statsMapDetalhes[key].quantidade += item.quantity;
      const campus = order.campus || "Unknown";
      const ciKey = `${campus}|||${modelo}|||${cor}|||${tamanho}`;
      if (!statsMapCampusInventory[ciKey]) {
        statsMapCampusInventory[ciKey] = {
          campus,
          modelo,
          cor,
          tamanho,
          quantidade: 0,
        };
      }
      statsMapCampusInventory[ciKey].quantidade += item.quantity;
      const dateStr = new Date(order.created_at).toISOString().slice(0, 10);
      const cdKey = `${campus}|||${modelo}|||${dateStr}|||${cor}|||${tamanho}`;
      if (!statsMapCampusDate[cdKey]) {
        statsMapCampusDate[cdKey] = {
          campus,
          modelo,
          data: dateStr,
          cor,
          tamanho,
          quantidade: 0,
        };
      }
      statsMapCampusDate[cdKey].quantidade += item.quantity;
    })
  );

  const statsSheet = Object.values(statsMapDetalhes)
    .sort((a, b) => sortByMultipleFields(a, b, "modelo", "cor", "tamanho"))
    .map((itemData) => ({
      Modelo: itemData.modelo,
      Cor: itemData.cor,
      Tamanho: itemData.tamanho,
      Quantidade: itemData.quantidade,
    }));

  const statsCampusInventorySheet = Object.values(statsMapCampusInventory)
    .sort((a, b) => sortByMultipleFields(a, b, "campus", "modelo", "cor", "tamanho"))
    .map((itemData) => ({
      Campus: itemData.campus,
      Modelo: itemData.modelo,
      Cor: itemData.cor,
      Tamanho: itemData.tamanho,
      Quantidade: itemData.quantidade,
    }));

  const statsCampusDateSheet = Object.values(statsMapCampusDate)
    .sort((a, b) => sortByMultipleFields(a, b, "campus", "modelo", "data", "cor", "tamanho"))
    .map((itemData) => ({
      Campus: itemData.campus,
      Modelo: itemData.modelo,
      Data: itemData.data,
      Cor: itemData.cor,
      Tamanho: itemData.tamanho,
      Quantidade: itemData.quantidade,
    }));

  return { statsSheet, statsCampusInventorySheet, statsCampusDateSheet };
}

/**
 * Builds and downloads the orders spreadsheet.
 *
 * `xlsx` is ~1 MB, so it is imported on demand instead of being pulled into the
 * orders page bundle.
 */
export async function exportOrdersToXlsx(orders: Order[]): Promise<void> {
  const ordersSheet = buildOrdersSheet(orders);
  const { statsSheet, statsCampusInventorySheet, statsCampusDateSheet } = buildStatsSheets(orders);

  const XLSX = await import("xlsx");

  const excelWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(excelWorkbook, XLSX.utils.json_to_sheet(ordersSheet), "Encomendas");
  XLSX.utils.book_append_sheet(excelWorkbook, XLSX.utils.json_to_sheet(statsSheet), "Detalhes");
  XLSX.utils.book_append_sheet(
    excelWorkbook,
    XLSX.utils.json_to_sheet(statsCampusInventorySheet),
    "InventarioPorCampus"
  );
  XLSX.utils.book_append_sheet(
    excelWorkbook,
    XLSX.utils.json_to_sheet(statsCampusDateSheet),
    "InventarioPorCampusPorDia"
  );
  XLSX.writeFile(excelWorkbook, `encomendas_${new Date().toISOString().slice(0, 10)}.xlsx`);
}
