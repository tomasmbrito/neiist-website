import Link from "next/link";
import styles from "@/styles/components/about-us/JoinUs.module.css";
import type { Dictionary } from "@/i18n/dictionaries";
import type { Locale } from "@/i18n/i18n-config";

interface JoinUsProps {
  dict: Dictionary["about_us_page"]["join_us"];
  locale: Locale;
}

export default function JoinUs({ dict, locale }: JoinUsProps) {
  return (
    <div className={styles.container}>
      <h2 className={styles.title}>{dict.title}</h2>
      <p className={styles.description}>{dict.description}</p>
      <Link href={`/${locale}/recruitment`} className={styles.apply}>
        {dict.apply}
      </Link>
    </div>
  );
}
