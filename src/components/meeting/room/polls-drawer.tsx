"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  BarChart3,
  Check,
  CircleHelp,
  LoaderCircle,
  Play,
  Plus,
  ThumbsUp,
  Trash2,
  X,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  MAX_OPTION_CHARS,
  MAX_POLL_OPTIONS,
  MAX_POLL_QUESTION_CHARS,
  MAX_QUESTION_CHARS,
  isVotable,
  sortPolls,
  sortQuestions,
  totalVotes,
  visiblePolls,
  votePercentage,
  votedOption,
  type Poll,
  type PollStatus,
} from "@/lib/meetings/poll-state";
import { cn } from "@/lib/utils";

import { useMeetingPolls } from "./polls-provider";
import { useMeetingRoles } from "./roles-provider";

export interface PollsDrawerProps {
  open: boolean;
  onClose: () => void;
}

type Tab = "polls" | "qa";
type QuestionFilter = "open" | "answered";

const STATUS_LABEL: Record<PollStatus, string> = {
  draft: "Draft",
  live: "Live",
  closed: "Closed",
};

const STATUS_PILL: Record<PollStatus, string> = {
  draft: "border-amber-400/30 bg-amber-500/10 text-amber-200",
  live: "border-emerald-400/30 bg-emerald-500/10 text-emerald-200",
  closed: "border-white/15 bg-white/[0.06] text-zinc-400",
};

/**
 * Polls and Q&A for the room.
 *
 * Who sees what:
 *
 * - Everyone can vote on a live poll, ask a question and upvote one.
 * - The host and co-hosts additionally get Create Poll, Launch Poll, Close Poll
 *   and Mark answered.
 *
 * The gating here is presentational only, and is not what enforces the rules. A
 * hidden button is a courtesy to honest participants; the actual check lives in
 * `src/app/meeting/[code]/polls.ts`, which the provider calls and which publishes
 * the change itself only after confirming the caller moderates this meeting. So
 * these `canModerate` branches can be wrong — someone editing the DOM, roles still
 * loading — without any consequence beyond a refused action.
 */
export function PollsDrawer({
  open,
  onClose,
}: PollsDrawerProps): React.JSX.Element {
  const { canModerate } = useMeetingRoles();
  const {
    state,
    localIdentity,
    vote,
    askQuestion,
    upvoteQuestion,
    draftPoll,
    discardDraft,
    launchPoll,
    closePoll,
    markAnswered,
  } = useMeetingPolls();

  const [tab, setTab] = React.useState<Tab>("polls");
  const [filter, setFilter] = React.useState<QuestionFilter>("open");
  const [composing, setComposing] = React.useState(false);
  const [question, setQuestion] = React.useState("");
  const [options, setOptions] = React.useState<string[]>(["", ""]);
  const [ask, setAsk] = React.useState("");
  /** Id of the item whose moderation request is in flight, if any. */
  const [busy, setBusy] = React.useState<string | null>(null);

  const shouldReduceMotion = useReducedMotion() === true;

  React.useEffect(() => {
    if (!open) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  // Drafts belong to the client that composed them, so a viewer only ever sees
  // their own. Belt and braces: they are not broadcast in the first place.
  const polls = React.useMemo(
    () => sortPolls(visiblePolls(state.polls, localIdentity)),
    [state.polls, localIdentity],
  );

  const questions = React.useMemo(
    () => sortQuestions(state.questions),
    [state.questions],
  );

  const openQuestions = React.useMemo(
    () => questions.filter((entry) => !entry.answered),
    [questions],
  );

  const answeredQuestions = React.useMemo(
    () => questions.filter((entry) => entry.answered),
    [questions],
  );

  const shownQuestions =
    filter === "open" ? openQuestions : answeredQuestions;

  function saveDraft(): void {
    const outcome = draftPoll(question, options);

    if (!outcome.ok) {
      toast.error(outcome.message);
      return;
    }

    setQuestion("");
    setOptions(["", ""]);
    setComposing(false);
  }

  function submitQuestion(): void {
    const outcome = askQuestion(ask);

    if (!outcome.ok) {
      toast.error(outcome.message);
      return;
    }

    setAsk("");
  }

  /**
   * Runs a server-checked moderation action.
   *
   * Nothing is applied optimistically. The state change arrives over the data
   * channel from the server, so the moderator's own view updates at the same
   * moment everyone else's does — and stays unchanged if the action was refused.
   */
  async function moderate(
    id: string,
    run: () => Promise<{ ok: boolean; message: string }>,
  ): Promise<void> {
    setBusy(id);

    try {
      const outcome = await run();

      if (outcome.ok) {
        if (outcome.message.length > 0) {
          toast.success(outcome.message);
        }
      } else {
        toast.error(outcome.message);
      }
    } finally {
      setBusy(null);
    }
  }

  const tabClass = (id: Tab) =>
    cn(
      "flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
      tab === id
        ? "bg-white/[0.12] text-white"
        : "text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200",
    );

  const filterClass = (id: QuestionFilter) =>
    cn(
      "flex-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
      filter === id
        ? "bg-white/[0.12] text-white"
        : "text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-300",
    );

  function renderPoll(poll: Poll): React.JSX.Element {
    const mine = localIdentity === null ? null : votedOption(poll, localIdentity);
    const votable = isVotable(poll);
    const isDraft = poll.status === "draft";
    const pending = busy === poll.id;
    const total = totalVotes(poll);

    return (
      <div
        key={poll.id}
        className={cn(
          "rounded-xl border p-3",
          isDraft
            ? "border-amber-400/25 bg-amber-500/[0.04]"
            : "border-white/10 bg-white/[0.04]",
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 text-sm font-medium">{poll.question}</p>
          <span
            className={cn(
              "shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
              STATUS_PILL[poll.status],
            )}
          >
            {STATUS_LABEL[poll.status]}
          </span>
        </div>

        <p className="mt-0.5 text-[11px] text-zinc-500">
          {isDraft
            ? "Only you can see this until you launch it."
            : `${String(total)} vote${total === 1 ? "" : "s"}${poll.status === "closed" ? " · final" : ""}`}
        </p>

        <div className="mt-2 space-y-1.5">
          {poll.options.map((option, index) => {
            const share = votePercentage(poll, index);
            const chosen = mine === index;

            // Only a live poll is interactive. A draft has nothing to vote on yet
            // and a closed one is a result, so both render as plain text rather
            // than as disabled buttons nobody should be tabbing through.
            if (!votable) {
              return (
                <div
                  key={index}
                  className="relative w-full overflow-hidden rounded-lg border border-white/10 px-2.5 py-2 text-left text-xs"
                >
                  {!isDraft && (
                    <span
                      aria-hidden="true"
                      className="absolute inset-y-0 left-0 bg-white/[0.07]"
                      style={{ width: `${String(share)}%` }}
                    />
                  )}
                  <span className="relative flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-zinc-300">
                      {option}
                    </span>
                    {!isDraft && (
                      <span className="shrink-0 text-[11px] text-zinc-400">
                        {share}%
                        {chosen && (
                          <span className="ml-1 text-zinc-500">· your vote</span>
                        )}
                      </span>
                    )}
                  </span>
                </div>
              );
            }

            return (
              <button
                key={index}
                type="button"
                onClick={() => vote(poll.id, index)}
                aria-pressed={chosen}
                className={cn(
                  "relative w-full overflow-hidden rounded-lg border px-2.5 py-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400",
                  chosen
                    ? "border-blue-400/60 bg-blue-500/10"
                    : "border-white/10 hover:border-white/25",
                )}
              >
                {/* Result bar sits behind the label so the option stays readable
                    at any share. */}
                <span
                  aria-hidden="true"
                  className="absolute inset-y-0 left-0 bg-blue-400/15"
                  style={{ width: `${String(share)}%` }}
                />
                <span className="relative flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate">{option}</span>
                  <span className="shrink-0 text-[11px] text-zinc-400">
                    {share}%
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        {canModerate && isDraft && (
          <div className="mt-2 flex gap-1.5">
            <Button
              type="button"
              size="sm"
              disabled={pending}
              onClick={() => void moderate(poll.id, () => launchPoll(poll.id))}
              className="h-8 flex-1 text-xs"
            >
              {pending ? (
                <LoaderCircle
                  className="h-3.5 w-3.5 animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <Play className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              Launch poll
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              disabled={pending}
              onClick={() => discardDraft(poll.id)}
              aria-label="Discard draft"
              className="h-8 w-8 shrink-0 text-zinc-500 hover:text-red-300"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}

        {canModerate && poll.status === "live" && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => void moderate(poll.id, () => closePoll(poll.id))}
            className="mt-2 h-7 w-full border-white/15 bg-white/[0.06] text-[11px] font-medium text-zinc-200 hover:bg-white/[0.14] hover:text-white"
          >
            {pending && (
              <LoaderCircle
                className="h-3.5 w-3.5 animate-spin"
                aria-hidden="true"
              />
            )}
            Close poll
          </Button>
        )}
      </div>
    );
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          role="dialog"
          aria-label="Polls and questions"
          initial={shouldReduceMotion ? undefined : { x: "100%" }}
          animate={shouldReduceMotion ? undefined : { x: 0 }}
          exit={shouldReduceMotion ? undefined : { x: "100%" }}
          transition={
            shouldReduceMotion
              ? { duration: 0 }
              : { type: "spring", stiffness: 320, damping: 34 }
          }
          className="absolute inset-y-0 right-0 z-40 flex w-full max-w-sm flex-col border-l border-white/10 bg-zinc-950/95 text-zinc-100 shadow-2xl backdrop-blur-xl"
        >
          <header className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
            <h2 className="text-sm font-semibold tracking-tight">
              Polls &amp; Q&amp;A
            </h2>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onClose}
              aria-label="Close polls"
              className="h-8 w-8 text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
            >
              <X className="h-4 w-4" />
            </Button>
          </header>

          <div
            className="flex shrink-0 gap-1 border-b border-white/10 p-2"
            role="tablist"
            aria-label="Polls or questions"
          >
            <button
              type="button"
              role="tab"
              id="polls-tab"
              aria-selected={tab === "polls"}
              aria-controls="polls-panel"
              onClick={() => setTab("polls")}
              className={tabClass("polls")}
            >
              <BarChart3 className="h-3.5 w-3.5" aria-hidden="true" />
              Polls
              {polls.length > 0 && (
                <span className="rounded-full bg-white/10 px-1.5 text-[10px]">
                  {polls.length}
                </span>
              )}
            </button>
            <button
              type="button"
              role="tab"
              id="qa-tab"
              aria-selected={tab === "qa"}
              aria-controls="qa-panel"
              onClick={() => setTab("qa")}
              className={tabClass("qa")}
            >
              <CircleHelp className="h-3.5 w-3.5" aria-hidden="true" />
              Q&amp;A
              {openQuestions.length > 0 && (
                <span className="rounded-full bg-white/10 px-1.5 text-[10px]">
                  {openQuestions.length}
                </span>
              )}
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            {tab === "polls" ? (
              <div
                className="space-y-3"
                role="tabpanel"
                id="polls-panel"
                aria-labelledby="polls-tab"
              >
                {canModerate && !composing && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setComposing(true)}
                    className="h-9 w-full border-white/15 bg-white/[0.06] text-zinc-100 hover:bg-white/[0.14] hover:text-white"
                  >
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    Create poll
                  </Button>
                )}

                {canModerate && composing && (
                  <div className="space-y-2 rounded-xl border border-white/10 bg-white/[0.04] p-3">
                    <label className="sr-only" htmlFor="poll-question">
                      Poll question
                    </label>
                    <Input
                      id="poll-question"
                      value={question}
                      onChange={(event) => setQuestion(event.target.value)}
                      placeholder="Ask something…"
                      maxLength={MAX_POLL_QUESTION_CHARS}
                      className="h-9 border-zinc-700 bg-zinc-950/70 text-sm text-zinc-100"
                    />

                    {options.map((option, index) => (
                      <div key={index} className="flex items-center gap-1.5">
                        <label
                          className="sr-only"
                          htmlFor={`poll-option-${String(index)}`}
                        >
                          {`Option ${String(index + 1)}`}
                        </label>
                        <Input
                          id={`poll-option-${String(index)}`}
                          value={option}
                          onChange={(event) => {
                            const next = [...options];
                            next[index] = event.target.value;
                            setOptions(next);
                          }}
                          placeholder={`Option ${String(index + 1)}`}
                          maxLength={MAX_OPTION_CHARS}
                          className="h-8 border-zinc-700 bg-zinc-950/70 text-sm text-zinc-100"
                        />
                        {options.length > 2 && (
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            onClick={() =>
                              setOptions(options.filter((_, i) => i !== index))
                            }
                            className="h-8 w-8 shrink-0 text-zinc-500 hover:text-red-300"
                            aria-label={`Remove option ${String(index + 1)}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    ))}

                    {options.length < MAX_POLL_OPTIONS && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setOptions([...options, ""])}
                        className="h-8 w-full text-xs text-zinc-400 hover:text-zinc-100"
                      >
                        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                        Add option
                      </Button>
                    )}

                    <div className="flex gap-1.5 pt-1">
                      <Button
                        type="button"
                        size="sm"
                        onClick={saveDraft}
                        className="h-8 flex-1 text-xs"
                      >
                        Save draft
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setComposing(false)}
                        className="h-8 flex-1 text-xs"
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}

                {polls.length === 0 && !composing && (
                  <p className="py-8 text-center text-xs text-zinc-500">
                    No polls yet.
                    {canModerate ? "" : " The host can open one."}
                  </p>
                )}

                {polls.map(renderPoll)}
              </div>
            ) : (
              <div
                className="space-y-3"
                role="tabpanel"
                id="qa-panel"
                aria-labelledby="qa-tab"
              >
                <div className="flex items-center gap-1.5">
                  <label className="sr-only" htmlFor="qa-input">
                    Ask a question
                  </label>
                  <Input
                    id="qa-input"
                    value={ask}
                    onChange={(event) => setAsk(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        submitQuestion();
                      }
                    }}
                    placeholder="Ask a question…"
                    maxLength={MAX_QUESTION_CHARS}
                    className="h-9 border-zinc-700 bg-zinc-950/70 text-sm text-zinc-100"
                  />
                  <Button
                    type="button"
                    size="icon"
                    onClick={submitQuestion}
                    disabled={ask.trim().length === 0}
                    className="h-9 w-9 shrink-0"
                    aria-label="Post question"
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>

                {/* Answered questions move out of the way rather than vanishing:
                    the host needs to be able to point back at one. */}
                <div
                  className="flex gap-1 rounded-lg border border-white/10 bg-white/[0.03] p-1"
                  role="tablist"
                  aria-label="Open or answered questions"
                >
                  <button
                    type="button"
                    role="tab"
                    id="qa-filter-open"
                    aria-selected={filter === "open"}
                    aria-controls="qa-list"
                    onClick={() => setFilter("open")}
                    className={filterClass("open")}
                  >
                    {`Open (${String(openQuestions.length)})`}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    id="qa-filter-answered"
                    aria-selected={filter === "answered"}
                    aria-controls="qa-list"
                    onClick={() => setFilter("answered")}
                    className={filterClass("answered")}
                  >
                    {`Answered (${String(answeredQuestions.length)})`}
                  </button>
                </div>

                <div
                  className="space-y-3"
                  role="tabpanel"
                  id="qa-list"
                  aria-labelledby={
                    filter === "open" ? "qa-filter-open" : "qa-filter-answered"
                  }
                >
                {shownQuestions.length === 0 && (
                  <p className="py-8 text-center text-xs text-zinc-500">
                    {filter === "open"
                      ? answeredQuestions.length > 0
                        ? "Everything has been answered. The rest are under Answered."
                        : "No open questions. Ask the first one."
                      : "Nothing has been marked answered yet."}
                  </p>
                )}

                {shownQuestions.map((item) => {
                  const upvoted =
                    localIdentity !== null &&
                    item.upvotes.includes(localIdentity);
                  const pending = busy === item.id;

                  return (
                    <div
                      key={item.id}
                      className={cn(
                        "rounded-xl border p-3 transition-opacity",
                        item.answered
                          ? "border-emerald-400/20 bg-emerald-500/[0.05] opacity-60"
                          : "border-white/10 bg-white/[0.04]",
                      )}
                    >
                      <p
                        className={cn(
                          "text-sm",
                          item.answered && "text-zinc-400 line-through",
                        )}
                      >
                        {item.body}
                      </p>
                      <p className="mt-0.5 text-[11px] text-zinc-500">
                        {item.askedByName}
                        {item.answered && (
                          <span className="text-emerald-300/80">
                            {" · answered"}
                          </span>
                        )}
                      </p>

                      <div className="mt-2 flex items-center gap-1.5">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => upvoteQuestion(item.id)}
                          aria-pressed={upvoted}
                          aria-label={`Upvote${upvoted ? "d" : ""}, ${String(item.upvotes.length)} so far`}
                          className={cn(
                            "h-7 px-2 text-[11px]",
                            upvoted
                              ? "bg-blue-500/15 text-blue-200"
                              : "text-zinc-400 hover:text-zinc-100",
                          )}
                        >
                          <ThumbsUp className="h-3.5 w-3.5" aria-hidden="true" />
                          {item.upvotes.length}
                        </Button>

                        {canModerate && !item.answered && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={pending}
                            onClick={() =>
                              void moderate(item.id, () =>
                                markAnswered(item.id),
                              )
                            }
                            className="h-7 border-emerald-400/30 bg-emerald-500/10 px-2 text-[11px] font-medium text-emerald-200 hover:border-emerald-400/50 hover:bg-emerald-500/20 hover:text-emerald-100"
                          >
                            {pending ? (
                              <LoaderCircle
                                className="h-3.5 w-3.5 animate-spin"
                                aria-hidden="true"
                              />
                            ) : (
                              <Check
                                className="h-3.5 w-3.5"
                                aria-hidden="true"
                              />
                            )}
                            Mark answered
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
                </div>
              </div>
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
