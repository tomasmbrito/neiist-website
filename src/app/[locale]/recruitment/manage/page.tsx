import { Suspense } from "react";
import RecruitmentPipeline from "@/components/recruitment/RecruitmentPipeline";
import { UserRole } from "@/types/user";
import { requireRoles } from "@/lib/auth";
import {
  getOpenRecruitmentEdition,
  getAllRecruitmentEditions,
  getRecruitmentPipeline,
} from "@/lib/db/repositories/recruitment.repository";
import { getAllTeams } from "@/lib/db/repositories/team.repository";
import GlobalLoading from "@/app/loading";
import { getDictionary } from "@/i18n/dictionaries";
import { defaultLocale, isValidLocale, LocaleParams } from "@/i18n/i18n-config";

async function RecruitmentManageContent({ params }: { params: LocaleParams }) {
  const { user, roles } = await requireRoles([UserRole._ADMIN, UserRole._COORDINATOR]);
  const { locale: rawLocale } = await params;
  const locale = isValidLocale(rawLocale) ? rawLocale : defaultLocale;
  const dict = getDictionary(locale);
  const isAdmin = roles.includes(UserRole._ADMIN);

  const [openEdition, editions, teams] = await Promise.all([
    getOpenRecruitmentEdition(),
    getAllRecruitmentEditions(),
    getAllTeams(),
  ]);

  const edition = openEdition ?? editions[0] ?? null;
  const applications = edition ? await getRecruitmentPipeline(user.istid, edition.id) : [];

  return (
    <RecruitmentPipeline
      edition={edition}
      initialApplications={applications}
      teamNames={teams.filter((t) => t.active).map((t) => t.name)}
      isAdmin={isAdmin}
      dict={dict.recruitment_management}
      recruitmentDict={dict.recruitment}
      locale={locale}
    />
  );
}

export default function RecruitmentManagePage({ params }: { params: LocaleParams }) {
  return (
    <Suspense fallback={<GlobalLoading />}>
      <RecruitmentManageContent params={params} />
    </Suspense>
  );
}
