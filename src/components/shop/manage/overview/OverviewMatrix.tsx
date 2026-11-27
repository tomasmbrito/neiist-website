import { Card, ColorSwatch } from "@neiist/ui";
import type { Dictionary } from "@/i18n/dictionaries";
import styles from "@/styles/components/shop/manage/overview/OverviewMatrix.module.css";
import { formatCount, type OverviewProductMatrix } from "@/utils/shop/shopOverviewUtils";

interface OverviewMatrixProps {
  product: OverviewProductMatrix;
  dict: Dictionary["shop_overview"];
}

export default function OverviewMatrix({ product, dict }: OverviewMatrixProps) {
  const { matrix } = product;
  const max = Math.max(...Object.values(matrix.cells).flatMap((row) => Object.values(row)), 1);

  return (
    <Card className={styles.card}>
      <Card.Header
        title={product.name}
        description={dict.matrix_subtitle
          .replace("{rows}", matrix.rowName)
          .replace("{cols}", matrix.colName)
          .replace("{units}", formatCount(matrix.total, dict.units_count_one, dict.units_count))}
      />
      <Card.Body>
        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col" className={styles.corner}>
                  {matrix.rowName}
                </th>
                {matrix.cols.map((col) => (
                  <th key={col.key} scope="col">
                    {col.label}
                  </th>
                ))}
                <th scope="col" className={styles.totalHead}>
                  {dict.col_total}
                </th>
              </tr>
            </thead>
            <tbody>
              {matrix.rows.map((row) => (
                <tr key={row.key}>
                  <th scope="row" className={styles.rowHead}>
                    {row.hex && <ColorSwatch color={row.hex} size="sm" ariaLabel={row.label} />}
                    {row.label}
                  </th>
                  {matrix.cols.map((col) => {
                    const value = matrix.cells[row.key]?.[col.key] ?? 0;
                    const intensity = value / max;
                    return (
                      <td
                        key={col.key}
                        className={value === 0 ? styles.emptyCell : styles.cell}
                        data-strong={intensity > 0.55 || undefined}
                        style={
                          { "--heat": `${Math.round(10 + intensity * 80)}%` } as React.CSSProperties
                        }>
                        {value || "–"}
                      </td>
                    );
                  })}
                  <td className={styles.totalCell}>{matrix.rowTotals[row.key] ?? 0}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" className={styles.rowHead}>
                  {dict.col_total}
                </th>
                {matrix.cols.map((col) => (
                  <td key={col.key} className={styles.totalCell}>
                    {matrix.colTotals[col.key] ?? 0}
                  </td>
                ))}
                <td className={styles.grandTotal}>{matrix.total}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card.Body>
    </Card>
  );
}
