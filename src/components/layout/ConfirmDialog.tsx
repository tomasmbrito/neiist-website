import styles from "@/styles/components/layout/ConfirmDialog.module.css";
import { Modal } from "@/components/ui/Modal";

export default function ConfirmDialog({
  open,
  message,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal isOpen={open} onClose={onCancel} className={styles.dialog}>
      <div className={styles.message}>{message}</div>
      <div className={styles.actions}>
        <button className={styles.confirm} onClick={onConfirm}>
          Sim
        </button>
        <button className={styles.cancel} onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </Modal>
  );
}
