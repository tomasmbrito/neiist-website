"use client";

import React, { useEffect, useRef } from "react";
import styles from "@/styles/components/ui/Modal.module.css";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
  hideBackdrop?: boolean;
  unstyled?: boolean;
}

export function Modal({
  isOpen,
  onClose,
  children,
  className = "",
  hideBackdrop = false,
  unstyled = false,
}: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen && !dialog.open) {
      dialog.showModal();
    } else if (!isOpen && dialog.open) {
      dialog.close();
    }
  }, [isOpen]);

  const handleClose = () => {
    onClose();
  };

  const handleBackdropClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const rect = dialog.getBoundingClientRect();
    const isInDialog =
      rect.top <= e.clientY &&
      e.clientY <= rect.top + rect.height &&
      rect.left <= e.clientX &&
      e.clientX <= rect.left + rect.width;

    if (!isInDialog) {
      onClose();
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className={unstyled ? className : `${styles.modal} ${className}`}
      onClose={handleClose}
      onClick={handleBackdropClick}
      style={hideBackdrop ? { background: "transparent", boxShadow: "none" } : undefined}>
      {children}
    </dialog>
  );
}
