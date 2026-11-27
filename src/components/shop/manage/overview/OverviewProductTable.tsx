"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Alert, Card, ColumnDef, DataTable, Input } from "@neiist/ui";
import { setProductCostAction } from "@/actions/shop/products";
import type { Dictionary } from "@/i18n/dictionaries";
import styles from "@/styles/components/shop/manage/overview/OverviewProductTable.module.css";
import { formatMoney } from "@/utils/shop/moneyUtils";
import type { OverviewProductFinance } from "@/utils/shop/shopOverviewUtils";

interface OverviewProductTableProps {
  rows: OverviewProductFinance[];
  canEditCosts: boolean;
  dict: Dictionary["shop_overview"];
}

interface CostInputProps {
  row: OverviewProductFinance;
  dict: Dictionary["shop_overview"];
}

function CostInput({ row, dict }: CostInputProps) {
  const router = useRouter();
  const [isSaving, startTransition] = useTransition();
  const initial = row.unitCost === null ? "" : row.unitCost.toFixed(2);
  const [value, setValue] = useState(initial);

  const save = () => {
    const trimmed = value.trim().replace(",", ".");
    if (trimmed === initial) return;
    const cost = trimmed === "" ? null : Number(trimmed);
    if (cost !== null && (!Number.isFinite(cost) || cost < 0)) {
      Alert.error(dict.cost_invalid);
      setValue(initial);
      return;
    }

    startTransition(async () => {
      try {
        await setProductCostAction(row.productId, cost);
        Alert.success(dict.cost_saved.replace("{product}", row.label));
        router.refresh();
      } catch {
        Alert.error(dict.cost_error);
        setValue(initial);
      }
    });
  };

  return (
    <div className={styles.costInput}>
      <Input
        type="text"
        inputMode="decimal"
        value={value}
        placeholder={dict.cost_placeholder}
        aria-label={dict.cost_label.replace("{product}", row.label)}
        disabled={isSaving}
        onChange={(event) => setValue(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      <span aria-hidden="true">€</span>
    </div>
  );
}

export default function OverviewProductTable({
  rows,
  canEditCosts,
  dict,
}: OverviewProductTableProps) {
  const columns = useMemo<ColumnDef<OverviewProductFinance>[]>(
    () => [
      {
        id: "product",
        header: dict.col_product,
        isCardHeader: true,
        cell: (row) => <strong>{row.label}</strong>,
      },
      {
        id: "units",
        header: dict.col_units,
        dataLabel: dict.col_units,
        align: "end",
        cell: (row) => (
          <span className={styles.stacked}>
            <strong>{row.units}</strong>
            {row.units !== row.paidUnits && (
              <span>{dict.units_paid.replace("{count}", String(row.paidUnits))}</span>
            )}
          </span>
        ),
      },
      {
        id: "averagePrice",
        header: dict.col_average_price,
        dataLabel: dict.col_average_price,
        align: "end",
        cell: (row) => formatMoney(row.averagePrice),
      },
      {
        id: "net",
        header: dict.col_revenue,
        dataLabel: dict.col_revenue,
        align: "end",
        cell: (row) => (
          <span className={styles.stacked}>
            <strong>{formatMoney(row.net)}</strong>
            {row.discounts > 0 && (
              <span>{dict.discounts_suffix.replace("{amount}", formatMoney(row.discounts))}</span>
            )}
          </span>
        ),
      },
      {
        id: "fees",
        header: dict.col_fees,
        dataLabel: dict.col_fees,
        align: "end",
        cell: (row) => formatMoney(row.fees),
      },
      {
        id: "unitCost",
        header: dict.col_unit_cost,
        dataLabel: dict.col_unit_cost,
        align: "end",
        width: "8.5rem",
        cell: (row) =>
          canEditCosts && row.productId ? (
            <CostInput key={row.unitCost ?? "none"} row={row} dict={dict} />
          ) : row.unitCost === null ? (
            <span className={styles.missing}>{dict.cost_missing}</span>
          ) : (
            formatMoney(row.unitCost)
          ),
      },
      {
        id: "profit",
        header: dict.col_profit,
        dataLabel: dict.col_profit,
        align: "end",
        cell: (row) =>
          row.unitCost === null ? (
            <span className={styles.missing}>—</span>
          ) : (
            <span className={styles.stacked}>
              <strong className={row.profit < 0 ? styles.loss : styles.gain}>
                {formatMoney(row.profit)}
              </strong>
              {row.margin !== null && (
                <span>
                  {dict.margin_short.replace("{margin}", String(Math.round(row.margin * 100)))}
                </span>
              )}
            </span>
          ),
      },
    ],
    [canEditCosts, dict]
  );

  return (
    <Card>
      <Card.Header title={dict.products_title} description={dict.products_subtitle} />
      <Card.Body>
        <DataTable
          data={rows}
          columns={columns}
          getRowId={(row) => row.key}
          emptyMessage={dict.no_data}
          responsive="cards"
        />
      </Card.Body>
    </Card>
  );
}
