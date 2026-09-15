import { FaRegClock } from "react-icons/fa";
import styles from "@/styles/components/recruitment/StatusCard.module.css";
import type { Dictionary } from "@/i18n/dictionaries";

export default function RecruitmentClosed({ dict }: { dict: Dictionary["recruitment"] }) {
  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <FaRegClock className={styles.icon} />
        <h1 className={styles.title}>{dict.closed_title}</h1>
        <p className={styles.message}>{dict.closed_description}</p>
      </div>
    </div>
  );
}
