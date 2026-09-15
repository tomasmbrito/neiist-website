import { Suspense } from "react";
import Hero from "@/components/homepage/Hero";
import Activities from "@/components/homepage/Activities";
import RecruitmentBanner from "@/components/homepage/RecruitmentBanner";
// import Partnerships from "@/components/homepage/Partnerships";
import { getOpenRecruitmentEdition } from "@/lib/db/repositories/recruitment.repository";
import { getDictionary, Dictionary } from "@/i18n/dictionaries";
import { defaultLocale, isValidLocale, locales, LocaleParams } from "@/i18n/i18n-config";

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

// This page has generateStaticParams (prerendered per locale), so a plain top-level await here
// would bake "is there an open edition" in at build time instead of reading it live. Isolating
// the read in its own Suspense boundary keeps the rest of the page statically shelled while
// this slot streams in per-request (Cache Components/PPR) - same reasoning as the DB read
// src/app/[locale]/shop/[id]/page.tsx already does at build time, just avoided here since the
// banner should reflect whether recruitment is open right now, not as of the last deploy.
async function RecruitmentBannerSlot({
  locale,
  dict,
}: {
  locale: string;
  dict: Dictionary["recruitment_banner"];
}) {
  const openEdition = await getOpenRecruitmentEdition();
  if (!openEdition) return null;
  return <RecruitmentBanner dict={dict} basePath={`/${locale}`} />;
}

async function HomePage({ params }: { params: LocaleParams }) {
  const { locale: rawLocale } = await params;
  const locale = isValidLocale(rawLocale) ? rawLocale : defaultLocale;
  const dict = getDictionary(locale);

  return (
    <>
      <Hero dict={dict.hero} />
      <Suspense fallback={null}>
        <RecruitmentBannerSlot locale={locale} dict={dict.recruitment_banner} />
      </Suspense>
      <Activities dict={dict.activities} />
      {/* <Partnerships dict={dict.partnerships} /> */}
    </>
  );
}

export default HomePage;
