import { Suspense } from "react";
import ApplicationForm from "@/components/recruitment/ApplicationForm";
import RecruitmentClosed from "@/components/recruitment/RecruitmentClosed";
import ApplicationReview from "@/components/recruitment/ApplicationReview";
import { requireUser } from "@/lib/auth";
import {
  getOpenRecruitmentEdition,
  getMyApplication,
} from "@/lib/db/repositories/recruitment.repository";
import { getAllTeams } from "@/lib/db/repositories/team.repository";
import GlobalLoading from "@/app/loading";
import { getDictionary } from "@/i18n/dictionaries";
import { defaultLocale, isValidLocale, LocaleParams } from "@/i18n/i18n-config";

async function RecruitmentContent({ params }: { params: LocaleParams }) {
  const { user } = await requireUser();
  const { locale: rawLocale } = await params;
  const locale = isValidLocale(rawLocale) ? rawLocale : defaultLocale;
  const dict = getDictionary(locale).recruitment;

  const edition = await getOpenRecruitmentEdition();
  if (!edition) {
    return <RecruitmentClosed dict={dict} />;
  }

  const teams = (await getAllTeams()).filter((t) => t.active);

  const existing = await getMyApplication(user.istid, edition.id);
  if (existing) {
    return (
      <ApplicationReview
        applicationId={existing.id}
        applicantIstid={user.istid}
        teams={teams}
        dict={dict}
        locale={locale}
      />
    );
  }

  return <ApplicationForm user={user} teams={teams} editionId={edition.id} dict={dict} />;
}

export default function RecruitmentPage({ params }: { params: LocaleParams }) {
  return (
    <Suspense fallback={<GlobalLoading />}>
      <RecruitmentContent params={params} />
    </Suspense>
  );
}
