"use client";

import { useState, useEffect } from "react";
import styles from "@/styles/components/layout/InputDateDialog.module.css";
import { Modal } from "@/components/ui/Modal";

export default function InputDateDialog({
  open,
  title,
  initialValue,
  placeholder,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title?: string;
  initialValue?: string | null;
  placeholder?: string;
  onConfirm: (_value: string | null) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState<string>(initialValue ?? "");

  useEffect(() => {
    setValue(initialValue ?? "");
  }, [initialValue, open]);

  return (
    <Modal isOpen={open} onClose={onCancel} className={styles.dialog}>
      {title && <div className={styles.title}>{title}</div>}
      <div className={styles.content}>
        <input
          className={styles.input}
          type="date"
          placeholder={placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <div className={styles.hint}>Para remover o prazo, deixar vazio.</div>
      </div>
      <div className={styles.actions}>
        <button
          className={styles.confirm}
          onClick={() => onConfirm(value.trim() === "" ? null : value)}>
          Confirmar
        </button>
        <button className={styles.cancel} onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </Modal>
  );
}
