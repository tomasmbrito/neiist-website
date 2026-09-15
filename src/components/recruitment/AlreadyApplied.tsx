import { FaCheckCircle } from "react-icons/fa";
import styles from "@/styles/components/recruitment/StatusCard.module.css";
import type { Dictionary } from "@/i18n/dictionaries";

export default function AlreadyApplied({ dict }: { dict: Dictionary["recruitment"] }) {
  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <FaCheckCircle className={styles.icon} />
        <h1 className={styles.title}>{dict.already_applied_title}</h1>
        <p className={styles.message}>{dict.already_applied_description}</p>
      </div>
    </div>
  );
}
