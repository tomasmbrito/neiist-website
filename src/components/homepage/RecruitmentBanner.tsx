import Link from "next/link";
import styles from "@/styles/components/homepage/RecruitmentBanner.module.css";
import type { Dictionary } from "@/i18n/dictionaries";

export default function RecruitmentBanner({
  dict,
  basePath,
}: {
  dict: Dictionary["recruitment_banner"];
  basePath: string;
}) {
  return (
    <section className={styles.container}>
      <h2 className={styles.title}>{dict.title}</h2>
      <p className={styles.subtitle}>{dict.subtitle}</p>
      <Link href={`${basePath}/recruitment`} className={styles.button}>
        {dict.cta}
      </Link>
    </section>
  );
}
