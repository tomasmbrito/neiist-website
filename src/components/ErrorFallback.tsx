"use client";

import React, { useEffect } from "react";
import styles from "@/styles/components/ErrorFallback.module.css";

export default function ErrorFallback({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className={styles.container}>
      <h2 className={styles.title}>Ocorreu um erro inesperado</h2>
      <p className={styles.message}>{error.message || "Por favor, tente novamente mais tarde."}</p>
      <button className={styles.button} onClick={() => reset()}>
        Tentar novamente
      </button>
    </div>
  );
}
