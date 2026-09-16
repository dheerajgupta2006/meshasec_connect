"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  BarChart3,
  Check,
  CircleHelp,
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
  MAX_POLL_OPTIONS,
  sortPolls,
  sortQuestions,
  totalVotes,
  votePercentage,
  votedOption,
} from "@/lib/meetings/poll-state";
import { cn } from "@/lib/utils";

import { useMeetingPolls } from "./polls-provider";
import { useMeetingRoles } from "./roles-provider";

export interface PollsDrawerProps {
  open: boolean;
  onClose: () => void;
}

type Tab = "polls" | "qa";

/**
 * Polls and Q&A for the room.
 *
 * Creating and closing polls, and marking questions answered, are moderation
 * actions — offered to the host and co-hosts. Voting, asking and upvoting are open
 * to everyone, which is the point of both features.
 */
export function PollsDrawer({
  open,
  onClose,
}: PollsDrawerProps): React.JSX.Element {
  const { canModerate } = useMeetingRoles();
  const {
    state,
    localIdentity,
    openPoll,
    vote,
    closePoll,
    askQuestion,
    upvoteQuestion,
    markAnswered,
  } = useMeetingPolls();

  const [tab, setTab] = React.useState<Tab>("polls");
  const [composing, setComposing] = React.useState(false);
  const [question, setQuestion] = React.useState("");
  const [options, setOptions] = React.useState<string[]>(["", ""]);
  const [ask, setAsk] = React.useState("");

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

  const polls = React.useMemo(() => sortPolls(state.polls), [state.polls]);
  const questions = React.useMemo(
    () => sortQuestions(state.questions),
    [state.questions],
  );

  function submitPoll(): void {
    const outcome = openPoll(question, options);

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

  const tabClass = (id: Tab) =>
    cn(
      "flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
      tab === id
        ? "bg-white/[0.12] text-white"
        : "text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200",
    );

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
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
              aria-selected={tab === "polls"}
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
              aria-selected={tab === "qa"}
              onClick={() => setTab("qa")}
              className={tabClass("qa")}
            >
              <CircleHelp className="h-3.5 w-3.5" aria-hidden="true" />
              Q&amp;A
              {questions.length > 0 && (
                <span className="rounded-full bg-white/10 px-1.5 text-[10px]">
                  {questions.length}
                </span>
              )}
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            {tab === "polls" ? (
              <div className="space-y-3">
                {canModerate && !composing && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setComposing(true)}
                    className="h-9 w-full border-white/15 bg-white/[0.06] text-zinc-100 hover:bg-white/[0.14] hover:text-white"
                  >
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    New poll
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
                      maxLength={200}
                      className="h-9 border-zinc-700 bg-zinc-950/70 text-sm text-zinc-100"
                    />

                    {options.map((option, index) => (
                      <div key={index} className="flex items-center gap-1.5">
                        <label className="sr-only" htmlFor={`poll-option-${index}`}>
                          {`Option ${index + 1}`}
                        </label>
                        <Input
                          id={`poll-option-${index}`}
                          value={option}
                          onChange={(event) => {
                            const next = [...options];
                            next[index] = event.target.value;
                            setOptions(next);
                          }}
                          placeholder={`Option ${index + 1}`}
                          maxLength={80}
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
                            aria-label={`Remove option ${index + 1}`}
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
                        onClick={submitPoll}
                        className="h-8 flex-1 text-xs"
                      >
                        Open poll
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

                {polls.map((poll) => {
                  const mine =
                    localIdentity === null
                      ? null
                      : votedOption(poll, localIdentity);

                  return (
                    <div
                      key={poll.id}
                      className="rounded-xl border border-white/10 bg-white/[0.04] p-3"
                    >
                      <p className="text-sm font-medium">{poll.question}</p>
                      <p className="mt-0.5 text-[11px] text-zinc-500">
                        {totalVotes(poll)} vote
                        {totalVotes(poll) === 1 ? "" : "s"}
                        {poll.closed ? " · closed" : ""}
                      </p>

                      <div className="mt-2 space-y-1.5">
                        {poll.options.map((option, index) => {
                          const share = votePercentage(poll, index);
                          const chosen = mine === index;

                          return (
                            <button
                              key={index}
                              type="button"
                              disabled={poll.closed}
                              onClick={() => vote(poll.id, index)}
                              aria-pressed={chosen}
                              className={cn(
                                "relative w-full overflow-hidden rounded-lg border px-2.5 py-2 text-left text-xs transition-colors",
                                chosen
                                  ? "border-blue-400/60 bg-blue-500/10"
                                  : "border-white/10 hover:border-white/25",
                                poll.closed && "cursor-default",
                              )}
                            >
                              {/* Result bar sits behind the label so the option
                                  stays readable at any share. */}
                              <span
                                aria-hidden="true"
                                className="absolute inset-y-0 left-0 bg-blue-400/15"
                                style={{ width: `${share}%` }}
                              />
                              <span className="relative flex items-center justify-between gap-2">
                                <span className="min-w-0 truncate">
                                  {option}
                                </span>
                                <span className="shrink-0 text-[11px] text-zinc-400">
                                  {share}%
                                </span>
                              </span>
                            </button>
                          );
                        })}
                      </div>

                      {canModerate && !poll.closed && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => closePoll(poll.id)}
                          className="mt-2 h-7 w-full text-[11px] text-zinc-400 hover:text-zinc-100"
                        >
                          Close poll
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="space-y-3">
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
                    maxLength={300}
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

                {questions.length === 0 && (
                  <p className="py-8 text-center text-xs text-zinc-500">
                    No questions yet. Ask the first one.
                  </p>
                )}

                {questions.map((item) => {
                  const upvoted =
                    localIdentity !== null &&
                    item.upvotes.includes(localIdentity);

                  return (
                    <div
                      key={item.id}
                      className={cn(
                        "rounded-xl border p-3",
                        item.answered
                          ? "border-emerald-400/25 bg-emerald-500/[0.06]"
                          : "border-white/10 bg-white/[0.04]",
                      )}
                    >
                      <p className="text-sm">{item.body}</p>
                      <p className="mt-0.5 text-[11px] text-zinc-500">
                        {item.askedByName}
                        {item.answered ? " · answered" : ""}
                      </p>

                      <div className="mt-2 flex items-center gap-1.5">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => upvoteQuestion(item.id)}
                          aria-pressed={upvoted}
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
                            variant="ghost"
                            onClick={() => markAnswered(item.id)}
                            className="h-7 px-2 text-[11px] text-zinc-400 hover:text-emerald-300"
                          >
                            <Check className="h-3.5 w-3.5" aria-hidden="true" />
                            Mark answered
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
