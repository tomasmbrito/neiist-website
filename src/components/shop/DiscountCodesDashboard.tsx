"use client";

import { useMemo, useState, ReactNode, useRef, useEffect } from "react";
import { DayPicker } from "react-day-picker";
import "react-day-picker/dist/style.css";
import { toast } from "sonner";
import {
  FaPlus,
  FaArrowLeft,
  FaTicketAlt,
  FaEnvelope,
  FaUsers,
  FaBox,
  FaList,
  FaTag,
  FaEuroSign,
  FaHashtag,
  FaCalendarAlt,
  FaEye,
  FaHeading,
  FaAlignLeft,
  FaPercent,
} from "react-icons/fa";
import { FiCheck } from "react-icons/fi";
import ColorfulText from "@/components/ColorfulText";
import MultiSelectDropdown from "@/components/MultiSelectDropdown";
import {
  DiscountCode,
  DiscountType,
  DiscountBulkGenerateResponse,
} from "@/types/shop/discountCode";
import { Product } from "@/types/shop/product";
import { User } from "@/types/user";
import styles from "@/styles/components/shop/DiscountCodesDashboard.module.css";
import {
  getDefaultDiscountEmailIntroLine,
  renderDiscountCampaignEmailHtml,
} from "@/utils/shop/discountEmail";
import { useRouter } from "next/navigation";

interface DiscountCodesDashboardProps {
  users: User[];
  products: Product[];
  discountCodes: DiscountCode[];
}

interface CreationDraft {
  selectedRecipients: string[];
  discount_type: DiscountType;
  discount_value: string;
  selectedProducts: string[];
  maxUses: string;
  expiresAt?: Date;
  emailSubject: string;
  emailIntroLine: string;
}

function Field({
  label,
  icon,
  iconAlignTop,
  children,
}: {
  label: string;
  icon: ReactNode;
  iconAlignTop?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={styles.fieldWrap}>
      <label className={styles.label}>{label}</label>
      <div className={styles.inputRow}>
        <span className={`${styles.inputIcon} ${iconAlignTop ? styles.alignTopIcon : ""}`}>
          {icon}
        </span>
        <div className={styles.inputControl}>{children}</div>
      </div>
    </div>
  );
}

function SectionTitle({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.sectionTitle}>
      <span className={styles.sectionTitleIcon}>{icon}</span>
      <span>{children}</span>
    </div>
  );
}

const PREVIEW_RECIPIENT = {
  name: "Nome",
  istid: "ist12345",
  email: "email@exemplo.com",
};

function buildProductOption(product: Product): string {
  return product.name;
}

function emptyCreationDraft(): CreationDraft {
  return {
    selectedRecipients: [],
    discount_type: "percentage",
    discount_value: "",
    selectedProducts: [],
    maxUses: "1",
    expiresAt: undefined,
    emailSubject: "O teu código de desconto NEIIST",
    emailIntroLine: getDefaultDiscountEmailIntroLine().trim(),
  };
}

function getStatus(code: DiscountCode): { label: string; tone: "active" | "warning" | "muted" } {
  const now = Date.now();
  const expiresAt = code.expires_at ? new Date(code.expires_at).getTime() : null;
  if (!code.active) return { label: "Inativo", tone: "muted" };
  if (expiresAt != null && !Number.isNaN(expiresAt) && expiresAt < now) {
    return { label: "Expirado", tone: "warning" };
  }
  if (code.max_uses != null && code.current_uses >= code.max_uses) {
    return { label: "Esgotado", tone: "warning" };
  }
  return { label: "Ativo", tone: "active" };
}

function formatUserLabel(user: User): string {
  return `${user.email} • ${user.istid}`;
}

export default function DiscountCodesDashboard({
  users,
  products,
  discountCodes,
}: DiscountCodesDashboardProps) {
  const router = useRouter();
  const [codes, setCodes] = useState(discountCodes);
  const [search, setSearch] = useState("");
  const [creationDraft, setCreationDraft] = useState<CreationDraft>(emptyCreationDraft());
  const [isCreating, setIsCreating] = useState(false);
  const [selectedCodeIds, setSelectedCodeIds] = useState<Set<number>>(new Set());
  const [showActiveCodes, setShowActiveCodes] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const datePickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (datePickerRef.current && !datePickerRef.current.contains(e.target as Node))
        setShowDatePicker(false);
    };
    if (showDatePicker) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showDatePicker]);

  const productOptions = useMemo(() => products.map(buildProductOption), [products]);
  const productLabelsById = useMemo(
    () => new Map(products.map((product) => [product.id, buildProductOption(product)])),
    [products]
  );

  const productIdByLabel = useMemo(
    () => new Map(products.map((product) => [buildProductOption(product), product.id])),
    [products]
  );

  const userOptions = useMemo(() => users.map(formatUserLabel), [users]);
  const userByLabel = useMemo(
    () => new Map(users.map((user) => [formatUserLabel(user), user])),
    [users]
  );
  const userByIstid = useMemo(() => new Map(users.map((user) => [user.istid, user])), [users]);

  const filteredCodes = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return codes;

    return codes.filter((code) => {
      const matchesCode = code.code.toLowerCase().includes(query);
      const matchesProducts = code.valid_product_ids.some((productId) => {
        const label = productLabelsById.get(productId) ?? String(productId);
        return label.toLowerCase().includes(query);
      });
      const matchesUsers = code.valid_istids.some((istid) => {
        const user = userByIstid.get(istid);
        return (
          istid.toLowerCase().includes(query) ||
          user?.name.toLowerCase().includes(query) ||
          user?.email.toLowerCase().includes(query)
        );
      });

      return (
        matchesCode ||
        matchesProducts ||
        matchesUsers ||
        code.discount_type.toLowerCase().includes(query)
      );
    });
  }, [codes, productLabelsById, search, userByIstid]);

  const selectedBulkRecipients = useMemo(
    () =>
      creationDraft.selectedRecipients
        .map((label) => userByLabel.get(label))
        .filter((user): user is User => Boolean(user)),
    [creationDraft.selectedRecipients, userByLabel]
  );
  const previewRecipient = selectedBulkRecipients[0] ?? PREVIEW_RECIPIENT;
  const previewCode = "K9X2A1"; // 6 character alphanumeric format for the preview

  const previewHtml = renderDiscountCampaignEmailHtml(creationDraft.emailIntroLine, {
    recipientName: previewRecipient.name,
    recipientIstid: previewRecipient.istid,
    recipientEmail: previewRecipient.email,
    code: previewCode,
    discountType: creationDraft.discount_type,
    discountValue: Number(creationDraft.discount_value) || 0,
    expiresAt: creationDraft.expiresAt ? creationDraft.expiresAt.toISOString() : null,
    introLine: creationDraft.emailIntroLine,
  });

  const renderDiscountPreview = (
    type: DiscountType,
    value: string,
    selectedProductsList: string[]
  ) => {
    if (products.length === 0) return null;
    const label = selectedProductsList.length > 0 ? selectedProductsList[0] : productOptions[0];
    const productId = label ? productIdByLabel.get(label) : null;
    const product = products.find((p) => p.id === productId) || products[0];

    const numVal = Number(value) || 0;
    const calcPrice = (orig: number) =>
      Math.max(0, type === "percentage" ? orig * (1 - numVal / 100) : orig - numVal);

    const baseOriginal = product.price;
    const baseNew = calcPrice(baseOriginal);

    const variantsByPrice = new Map<number, string[]>();
    let hasVariantsWithDifferentPrices = false;

    (product.variants || []).forEach((v) => {
      const mod = Number(v.price_modifier) || 0;
      if (mod !== 0) hasVariantsWithDifferentPrices = true;
      const vName = Object.values(v.options || {}).join(" ") || `Var ${v.id}`;
      const existing = variantsByPrice.get(mod) || [];
      existing.push(vName);
      variantsByPrice.set(mod, existing);
    });

    return (
      <div
        className={styles.hint}
        style={{
          marginTop: "-0.5rem",
          marginBottom: "1rem",
          padding: "0.75rem",
          backgroundColor: "#f8f9fa",
          borderRadius: "0.6rem",
          border: "1px solid #e9ecef",
        }}>
        <div style={{ marginBottom: hasVariantsWithDifferentPrices ? "0.5rem" : "0" }}>
          <strong>{product.name}:</strong>{" "}
          {hasVariantsWithDifferentPrices ? "Preço Base de " : "Passará de "}
          {baseOriginal.toFixed(2)}€ para <strong>{baseNew.toFixed(2)}€</strong>.
        </div>
        {hasVariantsWithDifferentPrices && (
          <ul
            style={{
              margin: 0,
              paddingLeft: "1.25rem",
              display: "flex",
              flexDirection: "column",
              gap: "0.25rem",
            }}>
            {Array.from(variantsByPrice.entries())
              .sort(([modA], [modB]) => modA - modB)
              .map(([mod, names], idx) => {
                const vOrig = baseOriginal + mod;
                const vNew = calcPrice(vOrig);
                const labelStr = names.length > 3 ? `${names.length} variantes` : names.join(", ");
                return (
                  <li key={idx}>
                    <em>{labelStr}</em>: {vOrig.toFixed(2)}€ ➜ <strong>{vNew.toFixed(2)}€</strong>
                  </li>
                );
              })}
          </ul>
        )}
      </div>
    );
  };

  const createCodes = async () => {
    const recipients = selectedBulkRecipients.map((user) => ({
      istid: user.istid,
      name: user.name,
      email: user.email,
    }));

    const discountValue = Number(creationDraft.discount_value);
    const maxUses = creationDraft.maxUses.trim() ? Number(creationDraft.maxUses) : 1;
    const expiresAt = creationDraft.expiresAt ? creationDraft.expiresAt.toISOString() : null;
    const validProductIds = creationDraft.selectedProducts.length
      ? creationDraft.selectedProducts
          .map((item) => productIdByLabel.get(item) ?? null)
          .filter((item): item is number => item !== null)
      : null;

    if (recipients.length === 0) {
      toast.error("Seleciona pelo menos um utilizador.", { closeButton: true });
      return;
    }
    if (!Number.isFinite(discountValue) || discountValue < 0) {
      toast.error("Indica um valor de desconto válido.", { closeButton: true });
      return;
    }
    if (!Number.isInteger(maxUses) || maxUses <= 0) {
      toast.error("O limite máximo de usos deve ser um número positivo.", { closeButton: true });
      return;
    }
    if (!creationDraft.emailSubject.trim() || !creationDraft.emailIntroLine.trim()) {
      toast.error("O assunto e o texto do email são obrigatórios.", { closeButton: true });
      return;
    }

    setIsCreating(true);
    try {
      const response = await fetch("/api/shop/discounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipients,
          discount_type: creationDraft.discount_type,
          discount_value: discountValue,
          valid_product_ids: validProductIds,
          max_uses: maxUses,
          expires_at: expiresAt,
          active: true,
          email_subject: creationDraft.emailSubject,
          email_intro_line: creationDraft.emailIntroLine,
        }),
      });

      const data = (await response.json().catch(() => null)) as
        | (DiscountBulkGenerateResponse & {
            error?: string;
            failed_recipients?: Array<{ istid: string; error: string }>;
          })
        | null;

      if (!response.ok) {
        toast.error(data?.error ?? "Não foi possível gerar os códigos.", { closeButton: true });
        return;
      }

      const generatedCodes = data?.codes ?? [];
      if (generatedCodes.length > 0) {
        setCodes((prev) => [...generatedCodes, ...prev]);
      }
      setCreationDraft(emptyCreationDraft());

      const failedCount = data?.failed_count ?? 0;
      if (failedCount > 0) {
        toast.warning(
          `Gerados ${generatedCodes.length} códigos com ${failedCount} falhas no envio.`,
          { closeButton: true }
        );
      } else {
        toast.success(`Gerados ${generatedCodes.length} códigos e enviados os emails.`, {
          closeButton: true,
        });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não foi possível gerar os códigos.", {
        closeButton: true,
      });
    } finally {
      setIsCreating(false);
    }
  };

  const toggleCode = (id: number) => {
    setSelectedCodeIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelectedCodeIds((prev) =>
      prev.size === filteredCodes.length && filteredCodes.length > 0
        ? new Set()
        : new Set(filteredCodes.map((c) => c.id))
    );
  };

  const isAllSelected = selectedCodeIds.size === filteredCodes.length && filteredCodes.length > 0;
  const isSomeSelected = selectedCodeIds.size > 0 && selectedCodeIds.size < filteredCodes.length;

  const isAllSelectedActive = useMemo(
    () =>
      selectedCodeIds.size > 0 &&
      Array.from(selectedCodeIds).every((id) => codes.find((c) => c.id === id)?.active),
    [selectedCodeIds, codes]
  );

  const handleBulkStatus = async (active: boolean) => {
    let failures = 0;

    await Promise.all(
      Array.from(selectedCodeIds).map(async (id) => {
        try {
          const response = await fetch("/api/shop/discounts", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, active }),
          });
          const data = await response.json().catch(() => null);
          if (response.ok) {
            setCodes((prev) => prev.map((item) => (item.id === id ? data : item)));
          } else {
            failures++;
          }
        } catch {
          failures++;
        }
      })
    );

    if (failures > 0)
      toast.error(`Falha ao atualizar ${failures} código(s).`, { closeButton: true });
    else
      toast.success(`Códigos ${active ? "ativados" : "desativados"} com sucesso.`, {
        closeButton: true,
      });
    setSelectedCodeIds(new Set());
  };

  const handleBulkDelete = async () => {
    if (!window.confirm(`Tem a certeza que deseja eliminar ${selectedCodeIds.size} código(s)?`))
      return;
    let failures = 0;

    await Promise.all(
      Array.from(selectedCodeIds).map(async (id) => {
        try {
          const response = await fetch("/api/shop/discounts", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id }),
          });
          if (response.ok) {
            setCodes((prev) => prev.filter((item) => item.id !== id));
          } else {
            failures++;
          }
        } catch {
          failures++;
        }
      })
    );

    if (failures > 0)
      toast.error(`Falha ao eliminar ${failures} código(s).`, { closeButton: true });
    else toast.success("Códigos eliminados com sucesso.", { closeButton: true });
    setSelectedCodeIds(new Set());
  };

  return (
    <div className={styles.container}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          createCodes();
        }}>
        <div className={styles.header}>
          <button
            type="button"
            className={styles.btnSecondary}
            onClick={() => router.push("/shop/manage")}>
            <FaArrowLeft /> Voltar
          </button>
          <ColorfulText className={styles.title} text="Códigos de Desconto" />
          <button type="submit" className={styles.btnPrimary} disabled={isCreating}>
            <FaPlus /> {isCreating ? "A gerar..." : "Gerar e Enviar"}
          </button>
        </div>

        <div className={styles.grid}>
          <div className={styles.sectionCol}>
            <div className={styles.stackBlock}>
              <SectionTitle icon={<FaTicketAlt />}>Novo Desconto</SectionTitle>

              <Field label="Utilizadores" icon={<FaUsers />}>
                <MultiSelectDropdown
                  availableItems={userOptions}
                  selectedItems={creationDraft.selectedRecipients}
                  onChange={(items) =>
                    setCreationDraft((prev) => ({ ...prev, selectedRecipients: items }))
                  }
                  placeholder="Selecionar utilizadores..."
                />
              </Field>
              <div className={styles.row}>
                <Field label="Tipo" icon={<FaTag />}>
                  <select
                    className={styles.field}
                    value={creationDraft.discount_type}
                    onChange={(e) =>
                      setCreationDraft((prev) => ({
                        ...prev,
                        discount_type: e.target.value as DiscountType,
                      }))
                    }>
                    <option value="percentage">Percentagem</option>
                    <option value="fixed">Valor fixo</option>
                  </select>
                </Field>
                <Field
                  label="Valor"
                  icon={
                    creationDraft.discount_type === "percentage" ? <FaPercent /> : <FaEuroSign />
                  }>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    max={creationDraft.discount_type === "percentage" ? "100" : undefined}
                    className={styles.field}
                    value={creationDraft.discount_value}
                    onChange={(e) =>
                      setCreationDraft((prev) => ({ ...prev, discount_value: e.target.value }))
                    }
                    placeholder={creationDraft.discount_type === "percentage" ? "20" : "5.00"}
                  />
                </Field>
              </div>
              {renderDiscountPreview(
                creationDraft.discount_type,
                creationDraft.discount_value,
                creationDraft.selectedProducts
              )}
              <div className={styles.row}>
                <Field label="Max. usos por código" icon={<FaHashtag />}>
                  <input
                    type="number"
                    min="1"
                    className={styles.field}
                    value={creationDraft.maxUses}
                    onChange={(e) =>
                      setCreationDraft((prev) => ({ ...prev, maxUses: e.target.value }))
                    }
                    placeholder="1"
                  />
                </Field>
                <Field label="Expiração" icon={<FaCalendarAlt />}>
                  <div className={styles.datePickerWrap} ref={datePickerRef}>
                    <input
                      className={styles.field}
                      type="text"
                      value={creationDraft.expiresAt?.toLocaleDateString("pt-PT") ?? ""}
                      placeholder="Sem limite"
                      readOnly
                      onClick={() => setShowDatePicker((p) => !p)}
                    />
                    {showDatePicker && (
                      <div
                        className={styles.datePickerPopup}
                        onClick={(e) => {
                          if (e.target === e.currentTarget) setShowDatePicker(false);
                        }}>
                        <div className={styles.datePickerPanel}>
                          <DayPicker
                            mode="single"
                            selected={creationDraft.expiresAt}
                            onSelect={(d) => {
                              setCreationDraft((prev) => ({ ...prev, expiresAt: d }));
                              setShowDatePicker(false);
                            }}
                            weekStartsOn={1}
                            captionLayout="dropdown"
                            navLayout="around"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </Field>
              </div>
              <Field label="Produtos válidos" icon={<FaBox />}>
                <MultiSelectDropdown
                  availableItems={productOptions}
                  selectedItems={creationDraft.selectedProducts}
                  onChange={(items) =>
                    setCreationDraft((prev) => ({ ...prev, selectedProducts: items }))
                  }
                  placeholder="Opcional (Todos)"
                />
              </Field>
            </div>
          </div>

          <div className={styles.sectionCol}>
            <div className={styles.stackBlock}>
              <SectionTitle icon={<FaEnvelope />}>Email a Enviar</SectionTitle>
              <Field label="Assunto do email" icon={<FaHeading />}>
                <input
                  type="text"
                  className={styles.field}
                  value={creationDraft.emailSubject}
                  onChange={(e) =>
                    setCreationDraft((prev) => ({ ...prev, emailSubject: e.target.value }))
                  }
                  placeholder="O teu código de desconto NEIIST"
                />
              </Field>
              <Field label="Corpo do Email" icon={<FaAlignLeft />} iconAlignTop>
                <textarea
                  rows={10}
                  className={styles.field}
                  value={creationDraft.emailIntroLine}
                  onChange={(e) =>
                    setCreationDraft((prev) => ({ ...prev, emailIntroLine: e.target.value }))
                  }
                  placeholder="Olá {{name}},\n\nAqui tens o teu código de desconto: {{code}}"
                />
              </Field>
              <span className={styles.hint}>
                Variáveis: {"{{name}}"}, {"{{istid}}"}, {"{{code}}"}, {"{{discount}}"},{" "}
                {"{{expiry}}"}.<br />
              </span>

              <SectionTitle icon={<FaEye />}>Pré-visualização</SectionTitle>
              <div className={styles.previewEmailWrapper}>
                <article
                  className={styles.previewEmail}
                  dangerouslySetInnerHTML={{ __html: previewHtml }}
                />
              </div>
            </div>
          </div>
        </div>
      </form>

      <div className={styles.listControls}>
        <button
          className={styles.btnSecondary}
          onClick={() => setShowActiveCodes((prev) => !prev)}
          type="button">
          <FaList /> {showActiveCodes ? "Ocultar códigos ativos" : "Ver códigos ativos"}
        </button>
        {showActiveCodes && (
          <div className={styles.searchWrapper}>
            <FaTag className={styles.searchIcon} />
            <input
              className={`${styles.field} ${styles.searchInput}`}
              placeholder="Pesquisar código, ISTID, email ou produto..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        )}
      </div>

      {showActiveCodes && (
        <div className={styles.stackBlock}>
          {selectedCodeIds.size > 0 && (
            <div className={styles.bulkActions}>
              <span className={styles.bulkCount}>
                {selectedCodeIds.size} código{selectedCodeIds.size !== 1 ? "s" : ""} selecionado
                {selectedCodeIds.size !== 1 ? "s" : ""}
              </span>
              <div className={styles.bulkButtons}>
                <button
                  onClick={() => handleBulkStatus(!isAllSelectedActive)}
                  className={styles.btnSecondary}
                  type="button">
                  {isAllSelectedActive ? "Desativar" : "Ativar"}
                </button>
                <button onClick={handleBulkDelete} className={styles.btnDanger} type="button">
                  Eliminar
                </button>
              </div>
            </div>
          )}
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.checkboxCol}>
                    <div
                      className={`${styles.checkbox} ${isAllSelected ? styles.checked : ""} ${isSomeSelected ? styles.indeterminate : ""}`}
                      onClick={toggleAll}>
                      {isAllSelected && <FiCheck size={14} />}
                      {isSomeSelected && <span className={styles.indeterminateIcon}>−</span>}
                    </div>
                  </th>
                  <th>Código</th>
                  <th>Utilizador</th>
                  <th>Tipo</th>
                  <th>Valor</th>
                  <th>Usos</th>
                  <th>Restrições</th>
                  <th>Expira</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {filteredCodes.map((code) => {
                  const status = getStatus(code);
                  return (
                    <tr
                      key={code.id}
                      onClick={() => toggleCode(code.id)}
                      style={{ cursor: "pointer" }}>
                      <td className={styles.checkboxCell}>
                        <div
                          className={`${styles.checkbox} ${selectedCodeIds.has(code.id) ? styles.checked : ""}`}>
                          {selectedCodeIds.has(code.id) && <FiCheck size={14} />}
                        </div>
                      </td>
                      <td>
                        <strong>{code.code}</strong>
                      </td>
                      <td>
                        {code.valid_istids.length > 0 ? (
                          <div className={styles.metaList}>
                            {code.valid_istids.map((istid) => {
                              const user = userByIstid.get(istid);
                              return (
                                <span key={istid}>
                                  {user ? `${user.name} (${user.istid})` : istid}
                                </span>
                              );
                            })}
                          </div>
                        ) : (
                          "Todos"
                        )}
                      </td>
                      <td>{code.discount_type === "percentage" ? "Percentagem" : "Valor fixo"}</td>
                      <td>
                        {code.discount_type === "percentage"
                          ? `${code.discount_value}%`
                          : `€${code.discount_value.toFixed(2)}`}
                      </td>
                      <td>
                        {code.current_uses}
                        {code.max_uses != null ? ` / ${code.max_uses}` : ""}
                      </td>
                      <td>
                        <div className={styles.metaList}>
                          <span>
                            Produtos:{" "}
                            {code.valid_product_ids.length > 0
                              ? code.valid_product_ids
                                  .map((id) => productLabelsById.get(id) ?? String(id))
                                  .join(", ")
                              : "Todos"}
                          </span>
                        </div>
                      </td>
                      <td>
                        {code.expires_at
                          ? new Date(code.expires_at).toLocaleString("pt-PT")
                          : "Sem limite"}
                      </td>
                      <td>
                        <span className={`${styles.statusBadge} ${styles[status.tone]}`}>
                          {status.label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
                {filteredCodes.length === 0 && (
                  <tr>
                    <td colSpan={9} className={styles.emptyCell}>
                      Nenhum código de desconto encontrado.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
