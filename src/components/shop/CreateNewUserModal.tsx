"use client";

import React, { useState, useEffect } from "react";
import styles from "@/styles/components/shop/CreateNewUserModal.module.css";
import { MdClose } from "react-icons/md";
import type { User } from "@/types/user";
import ConfirmDialog from "@/components/layout/ConfirmDialog";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { toast } from "sonner";

interface CreateNewUserModalProps {
  onClose: () => void;
  onSubmit?: (_user: User) => void;
  initialIstId?: string;
}

const CreateNewUserModal: React.FC<CreateNewUserModalProps> = ({
  onClose,
  onSubmit,
  initialIstId = "",
}) => {
  const [istId, setIstId] = useState(initialIstId);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [onClose]);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const handleSubmit = async () => {
    if (!istId || !name || !email) {
      toast.error("Por favor, preencha todos os campos.", { closeButton: true });
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          istid: istId,
          name,
          email,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to create user");
      }

      const newUser = await response.json();
      onSubmit?.(newUser);
      toast.success("Operação concluída com sucesso.", { closeButton: true });
      onClose();
    } catch (error) {
      console.error("Error creating user:", error);
      toast.error(error instanceof Error ? error.message : "Failed to create user", {
        closeButton: true,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleConfirm = (e: React.FormEvent) => {
    e.preventDefault();
    setShowConfirm(true);
  };

  return (
    <div role="button" tabIndex={0} className={styles.backdrop} onClick={handleBackdropClick}>
      <div className={styles.modal}>
        <Button variant="ghost" className={styles.closeButton} onClick={onClose}>
          <MdClose size={20} />
        </Button>

        <h2>Novo Utilizador</h2>

        <form onSubmit={handleConfirm}>
          <div className={styles.formGroup}>
            <label>IST ID</label>
            <Input
              type="text"
              placeholder="ist1119999"
              value={istId}
              onChange={(e) => setIstId(e.target.value)}
              className={styles.input}
              autoFocus
              disabled={isSubmitting}
            />
          </div>

          <div className={styles.formGroup}>
            <label>Nome</label>
            <Input
              type="text"
              placeholder="John Doe"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={styles.input}
              disabled={isSubmitting}
            />
          </div>

          <div className={styles.formGroup}>
            <label>Email</label>
            <Input
              type="email"
              placeholder="john.doe@tecnico.ulisboa.pt"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={styles.input}
              disabled={isSubmitting}
            />
          </div>

          <div className={styles.buttonRow}>
            <Button variant="secondary" onClick={onClose} disabled={isSubmitting} type="button">
              Cancelar
            </Button>
            <Button variant="primary" disabled={isSubmitting} type="submit">
              {isSubmitting ? "A criar..." : "Guardar"}
            </Button>
          </div>
        </form>
        {showConfirm && (
          <ConfirmDialog
            open={showConfirm}
            message={`Tem a certeza que deseja criar o utilizador ${name}?`}
            onConfirm={async () => {
              setShowConfirm(false);
              await handleSubmit();
            }}
            onCancel={() => setShowConfirm(false)}
          />
        )}
      </div>
    </div>
  );
};

export default CreateNewUserModal;
