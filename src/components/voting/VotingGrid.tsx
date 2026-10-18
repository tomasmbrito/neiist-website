"use client";

import React, { useState } from "react";
import Image from "next/image";
import { Modal, Button, Alert } from "@neiist/ui";
import { FaCheck } from "react-icons/fa";
import { VotingNominee, VotingType, isUserVotingType } from "@/types/voting";
import { submitVoteAction } from "@/lib/votingSystem";
import { getFirstAndLastName } from "@/utils/userUtils";
import Search from "@/components/search/Search";
import CommandPalette from "@/components/search/CommandPalette";
import { useSearch } from "@/hooks/useSearch";
import styles from "@/styles/components/voting/VotingGrid.module.css";
import ReactMarkdown from "react-markdown";
import type { Dictionary } from "@/i18n/dictionaries";

interface VotingGridProps {
  sessionId: number;
  sessionName: string | null;
  sessionDescription?: string | null;
  sessionType?: VotingType;
  nominees: VotingNominee[];
  maxChoices?: number;
  selectedNomineeIds?: string[];
  onVote?: (_nomineeIds: string[]) => Promise<void> | void;
  dict: Dictionary["voting"];
}

const PAGE_SIZE = 36;

export default function VotingGrid({
  sessionId,
  sessionName,
  sessionDescription,
  sessionType,
  nominees,
  maxChoices = 1,
  selectedNomineeIds = [],
  onVote,
  dict,
}: VotingGridProps) {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [modalNominee, setModalNominee] = useState<VotingNominee | null>(null);
  // Multiple-choice sessions build a ballot locally and submit it in one go
  const [draftIds, setDraftIds] = useState<string[]>(selectedNomineeIds);

  const isUserType = isUserVotingType(sessionType);
  const isMultiChoice = maxChoices > 1;
  const selectedNomineeId = selectedNomineeIds[0] ?? null;
  const isBallotFull = draftIds.length >= maxChoices;
  const isBallotUnchanged =
    draftIds.length === selectedNomineeIds.length &&
    draftIds.every((id) => selectedNomineeIds.includes(id));

  const toggleChoice = (nomineeId: string) => {
    if (draftIds.includes(nomineeId)) {
      setDraftIds(draftIds.filter((id) => id !== nomineeId));
    } else if (isBallotFull) {
      Alert.info(dict.max_choices_reached.replace("{max}", String(maxChoices)));
    } else {
      setDraftIds([...draftIds, nomineeId]);
    }
  };

  const {
    results: filteredNominees,
    query: searchQuery,
    setQuery: setSearchQuery,
  } = useSearch<VotingNominee>({
    data: nominees,
    fields: [
      { field: "name", boost: 3 },
      { field: "id", boost: 4 },
      { field: "description", boost: 2 },
    ],
    returnAllWhenEmpty: true,
  });

  const visibleNominees = filteredNominees.slice(0, visibleCount);
  const hasMore = filteredNominees.length > visibleCount;

  const handleCastVote = async (nomineeIds: string[]) => {
    try {
      if (onVote) {
        await onVote(nomineeIds);
      } else {
        const formData = new FormData();
        formData.set("sessionId", String(sessionId));
        nomineeIds.forEach((id) => formData.append("nomineeId", id));
        await submitVoteAction(formData);
      }
    } catch (err) {
      console.error("Failed to cast vote:", err);
      Alert.error(err instanceof Error ? err.message : dict.vote_error);
    }
  };

  const handlePick = (nomineeId: string) =>
    isMultiChoice ? toggleChoice(nomineeId) : handleCastVote([nomineeId]);

  return (
    <section className={styles.wrapper}>
      <CommandPalette<VotingNominee>
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        placeholder={isUserType ? dict.search_nominee_placeholder : dict.search_options_placeholder}
        groups={[
          {
            heading: sessionName ?? (isUserType ? dict.candidates : dict.options),
            items: nominees,
          },
        ]}
        getItemKey={(n) => n.id}
        getItemLabel={(n) => (isUserType ? `${getFirstAndLastName(n.name)} (${n.id})` : n.name)}
        onSelect={(n) => handlePick(n.id)}
      />

      <header className={styles.header}>
        <p className={styles.kicker}>{dict.voting_in_progress}</p>
        <h1 className={styles.title}>{sessionName ?? dict.select_your_vote}</h1>
        {sessionDescription && (
          <div className={styles.description}>
            <ReactMarkdown
              components={{
                a: ({ ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
              }}>
              {sessionDescription}
            </ReactMarkdown>
          </div>
        )}
        {isMultiChoice && (
          <p className={styles.choiceHint}>
            {dict.choose_up_to.replace("{max}", String(maxChoices))}
          </p>
        )}
      </header>

      <div className={styles.toolbar}>
        <div className={styles.searchContainer}>
          <Search
            className={styles.searchInput}
            placeholder={
              isUserType ? dict.search_nominee_placeholder : dict.search_options_placeholder
            }
            value={searchQuery}
            onChange={(val) => {
              setSearchQuery(val);
              setVisibleCount(PAGE_SIZE);
            }}
          />
        </div>
        <p className={styles.count}>
          {(isUserType ? dict.showing_nominees_count : dict.showing_options_count)
            .replace("{visible}", String(visibleNominees.length))
            .replace("{total}", String(filteredNominees.length))}
        </p>
      </div>

      <div className={styles.grid}>
        {visibleNominees.map((nominee) => {
          const isSelected = isMultiChoice
            ? draftIds.includes(nominee.id)
            : selectedNomineeId === nominee.id;
          const isUnavailable = isMultiChoice && isBallotFull && !isSelected;
          const displayName = isUserType ? getFirstAndLastName(nominee.name) : nominee.name;
          const hasPhoto = Boolean(nominee.photoPath);
          const hasDetails =
            !isUserType && (Boolean(nominee.description) || Boolean(nominee.descriptionPhotoPath));
          const ctaLabel = isMultiChoice
            ? dict.choose
            : isSelected
              ? dict.current_vote
              : selectedNomineeId
                ? dict.change_vote
                : dict.vote;
          const cardStateClass = isMultiChoice
            ? `${isSelected ? styles.chosenCard : ""} ${isUnavailable ? styles.unavailableCard : ""}`
            : isSelected
              ? styles.selectedCard
              : "";

          return (
            <div key={nominee.id} className={styles.gridItem}>
              <button
                type="button"
                onClick={hasDetails ? () => setModalNominee(nominee) : () => handlePick(nominee.id)}
                aria-label={displayName}
                aria-pressed={isMultiChoice ? isSelected : undefined}
                className={`${styles.card} ${cardStateClass}`}>
                <div className={styles.imageCard}>
                  {isMultiChoice && isSelected && (
                    <span className={styles.choiceBadge} aria-hidden="true">
                      <FaCheck />
                    </span>
                  )}
                  {hasPhoto ? (
                    <Image
                      src={nominee.photoPath!}
                      alt={nominee.name}
                      fill
                      className={styles.photo}
                    />
                  ) : isUserType ? (
                    <Image
                      src="/default_user.png"
                      alt={nominee.name}
                      fill
                      className={styles.photo}
                    />
                  ) : (
                    <div className={styles.textFront}>
                      {nominee.description ? (
                        <p className={styles.textFrontDescription}>{nominee.description}</p>
                      ) : (
                        <span className={styles.textFrontTitle}>{displayName}</span>
                      )}
                    </div>
                  )}

                  <div className={styles.overlay}>
                    <span className={styles.cta}>
                      {isSelected ? (
                        <>
                          <FaCheck className={styles.ctaIcon} />
                          <span>{isMultiChoice ? dict.remove_choice : dict.current_vote}</span>
                        </>
                      ) : hasDetails ? (
                        dict.view_details
                      ) : (
                        ctaLabel
                      )}
                    </span>
                  </div>
                </div>

                {(hasPhoto || isUserType || Boolean(nominee.description)) && (
                  <h4 className={styles.name}>{displayName}</h4>
                )}
              </button>
            </div>
          );
        })}
      </div>

      {modalNominee && (
        <Modal
          open={Boolean(modalNominee)}
          onClose={() => setModalNominee(null)}
          title={modalNominee.name}
          size="md">
          {Boolean(modalNominee.descriptionPhotoPath || modalNominee.photoPath) && (
            <div className={styles.modalImageWrapper}>
              <Image
                src={(modalNominee.descriptionPhotoPath || modalNominee.photoPath)!}
                alt={modalNominee.name}
                fill
                className={styles.modalImage}
              />
            </div>
          )}

          {modalNominee.description && (
            <div className={styles.modalDescription}>
              <ReactMarkdown
                components={{
                  a: ({ ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
                }}>
                {modalNominee.description}
              </ReactMarkdown>
            </div>
          )}

          <Modal.Footer>
            <Button variant="outline" type="button" onClick={() => setModalNominee(null)}>
              {dict.close}
            </Button>
            <Button
              variant="primary"
              type="button"
              onClick={async () => {
                const id = modalNominee.id;
                setModalNominee(null);
                await handlePick(id);
              }}>
              {isMultiChoice ? (
                draftIds.includes(modalNominee.id) ? (
                  dict.remove_choice
                ) : (
                  dict.choose
                )
              ) : selectedNomineeId === modalNominee.id ? (
                <>
                  <FaCheck className={styles.checkIcon} />
                  {dict.current_vote}
                </>
              ) : (
                dict.vote
              )}
            </Button>
          </Modal.Footer>
        </Modal>
      )}

      {hasMore && (
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.loadMoreButton}
            onClick={() => setVisibleCount((prev) => prev + PAGE_SIZE)}>
            {isUserType ? dict.show_more_nominees : dict.show_more_options}
          </button>
        </div>
      )}

      {isMultiChoice && (
        <div className={styles.ballotBar} role="region" aria-label={dict.your_ballot}>
          <div className={styles.ballotInfo}>
            <span className={styles.ballotCount}>
              {draftIds.length}/{maxChoices}
            </span>
            <span className={styles.ballotLabel}>
              {dict.choices_selected
                .replace("{count}", String(draftIds.length))
                .replace("{max}", String(maxChoices))}
            </span>
          </div>
          <Button
            variant="primary"
            type="button"
            shape="pill"
            className={styles.ballotSubmit}
            disabled={draftIds.length === 0 || isBallotUnchanged}
            onClick={() => handleCastVote(draftIds)}>
            {selectedNomineeIds.length > 0 ? dict.update_votes : dict.submit_votes}
          </Button>
        </div>
      )}
    </section>
  );
}
