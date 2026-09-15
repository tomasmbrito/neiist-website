import ApplicationReviewClient from "@/components/recruitment/ApplicationReviewClient";
import {
  getBookableInterviewSlots,
  getMyApplicationFull,
} from "@/lib/db/repositories/recruitment.repository";
import type { Dictionary } from "@/i18n/dictionaries";
import type { BookableInterviewSlot } from "@/types/recruitment";

interface Team {
  name: string;
  description: string;
}

export default async function ApplicationReview({
  applicationId,
  applicantIstid,
  teams,
  dict,
  locale,
}: {
  applicationId: number;
  applicantIstid: string;
  teams: Team[];
  dict: Dictionary["recruitment"];
  locale: string;
}) {
  const application = await getMyApplicationFull(applicationId, applicantIstid);
  if (!application) return null;

  const bookable = await getBookableInterviewSlots(applicationId, applicantIstid);
  const slotsByTeam = bookable.reduce<Record<string, BookableInterviewSlot[]>>((acc, slot) => {
    (acc[slot.departmentName] ??= []).push(slot);
    return acc;
  }, {});

  return (
    <ApplicationReviewClient
      applicationId={applicationId}
      application={application}
      slotsByTeam={slotsByTeam}
      teams={teams}
      dict={dict}
      locale={locale}
    />
  );
}
