import { FaCheckCircle } from "react-icons/fa";
import styles from "@/styles/components/recruitment/StatusCard.module.css";
import InterviewSlotPicker from "@/components/recruitment/InterviewSlotPicker";
import { getBookableInterviewSlots } from "@/lib/db/repositories/recruitment.repository";
import type { Dictionary } from "@/i18n/dictionaries";
import type { BookableInterviewSlot } from "@/types/recruitment";

export default async function AlreadyApplied({
  applicationId,
  applicantIstid,
  dict,
  locale,
}: {
  applicationId: number;
  applicantIstid: string;
  dict: Dictionary["recruitment"];
  locale: string;
}) {
  const bookable = await getBookableInterviewSlots(applicationId, applicantIstid);
  const slotsByTeam = bookable.reduce<Record<string, BookableInterviewSlot[]>>((acc, slot) => {
    (acc[slot.departmentName] ??= []).push(slot);
    return acc;
  }, {});

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <FaCheckCircle className={styles.icon} />
        <h1 className={styles.title}>{dict.already_applied_title}</h1>
        <p className={styles.message}>{dict.already_applied_description}</p>
        <InterviewSlotPicker
          applicationId={applicationId}
          slotsByTeam={slotsByTeam}
          dict={dict}
          locale={locale}
        />
      </div>
    </div>
  );
}
