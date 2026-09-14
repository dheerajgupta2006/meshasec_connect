"use client";

import {
  AlertCircle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  LoaderCircle,
  Video,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";

import { createMeetingAction } from "@/app/meeting/new/actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { mintCreationRequestId } from "@/lib/meetings/creation-request-id";
import {
  draftSignature,
  initialFormState,
  meetingCreationReducer,
} from "@/lib/meetings/form-state";
import { TITLE_MAX_CHARS, type MeetingMode } from "@/lib/meetings/types";
import { validateClientInput } from "@/lib/meetings/validation";

/** How long to wait for lobby navigation before offering a direct link. */
const NAVIGATION_FALLBACK_MS = 4000;

const OFFLINE_MESSAGE =
  "We could not reach the server. Check your connection and try again.";

export function MeetingCreationForm() {
  const router = useRouter();
  const [state, dispatch] = useReducer(
    meetingCreationReducer,
    initialFormState,
  );

  // React state updates are asynchronous, so state alone can lose a
  // double-click race. This ref flips synchronously.
  const submitLockRef = useRef(false);

  const titleRef = useRef<HTMLInputElement | null>(null);
  const modeRef = useRef<HTMLButtonElement | null>(null);
  const startRef = useRef<HTMLInputElement | null>(null);
  const endRef = useRef<HTMLInputElement | null>(null);

  const [timeZone, setTimeZone] = useState<string | null>(null);

  // Read in an effect, not during render, to avoid a hydration mismatch.
  useEffect(() => {
    try {
      setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    } catch {
      setTimeZone(null);
    }
  }, []);

  useEffect(() => {
    if (state.focusTarget === null) {
      return;
    }

    const targets: Record<
      "title" | "mode" | "startsAt" | "endsAt",
      RefObject<HTMLElement>
    > = {
      title: titleRef,
      mode: modeRef,
      startsAt: startRef,
      endsAt: endRef,
    };

    targets[state.focusTarget].current?.focus();
    dispatch({ type: "FOCUS_APPLIED" });
  }, [state.focusTarget]);

  const status = state.status;

  useEffect(() => {
    if (status.kind !== "success" || status.navigationFailed) {
      return;
    }

    const target = `/meeting/${encodeURIComponent(
      status.result.meetingCode,
    )}/lobby`;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (!cancelled) {
        dispatch({ type: "NAVIGATION_FAILED" });
      }
    }, NAVIGATION_FALLBACK_MS);

    try {
      router.push(target);
    } catch {
      window.clearTimeout(timer);
      dispatch({ type: "NAVIGATION_FAILED" });
    }

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [status, router]);

  const isLoading = status.kind === "loading";
  const isSuccess = status.kind === "success";
  const isScheduled = state.draft.mode === "scheduled";
  const submitDisabled = isLoading || isSuccess;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (submitLockRef.current || isLoading || isSuccess) {
      return;
    }

    const validation = validateClientInput(state.draft);
    const signature = draftSignature(state.draft);
    const candidateRequestId = mintCreationRequestId();

    dispatch({
      type: "SUBMIT_REQUESTED",
      validation,
      signature,
      candidateRequestId,
    });

    if (!validation.ok) {
      return;
    }

    // Mirror the reducer's adoption rule so the request carries the identifier
    // the reducer just adopted. Retrying unchanged values reuses it, which is
    // what makes the server able to replay instead of creating a duplicate.
    const rotate =
      state.creationRequestId === null ||
      signature !== state.intentSignature;
    const creationRequestId = rotate
      ? candidateRequestId
      : state.creationRequestId;

    submitLockRef.current = true;

    try {
      const result = await createMeetingAction({
        ...validation.value,
        creationRequestId,
      });

      if (result.ok) {
        dispatch({ type: "SERVER_SUCCEEDED", result: result.result });
      } else {
        dispatch({ type: "SERVER_FAILED", failure: result.failure });
      }
    } catch {
      // The request never reached a server, so there is no correlation ID.
      dispatch({
        type: "SERVER_FAILED",
        failure: {
          kind: "operational",
          message: OFFLINE_MESSAGE,
          correlationId: "",
        },
      });
    } finally {
      submitLockRef.current = false;
    }
  }

  const titleError = state.fieldErrors.title;
  const startError = state.fieldErrors.startsAt;
  const endError = state.fieldErrors.endsAt;

  return (
    <>
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {state.announcement}
      </div>

      <Card>
        <CardContent className="pt-6">
          <form
            onSubmit={handleSubmit}
            aria-busy={isLoading}
            noValidate
            className="space-y-6"
          >
            <div className="space-y-2">
              <Label htmlFor="meeting-title">Meeting title</Label>
              <Input
                id="meeting-title"
                ref={titleRef}
                value={state.draft.title}
                onChange={(event) =>
                  dispatch({
                    type: "FIELD_CHANGED",
                    field: "title",
                    value: event.target.value,
                  })
                }
                maxLength={TITLE_MAX_CHARS}
                placeholder="Product weekly"
                autoComplete="off"
                disabled={submitDisabled}
                aria-invalid={titleError !== undefined}
                aria-describedby={
                  titleError !== undefined
                    ? "meeting-title-hint meeting-title-error"
                    : "meeting-title-hint"
                }
                className="h-11 min-w-0 border-input-strong sm:h-10"
              />
              <p
                id="meeting-title-hint"
                className="text-xs text-muted-foreground"
              >
                Up to {TITLE_MAX_CHARS} characters.
              </p>
              {titleError !== undefined && (
                <p
                  id="meeting-title-error"
                  className="break-words text-sm text-destructive-text"
                >
                  {titleError}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="meeting-mode" id="meeting-mode-label">
                Meeting type
              </Label>
              <Select
                value={state.draft.mode}
                onValueChange={(value) =>
                  dispatch({
                    type: "MODE_CHANGED",
                    mode: value as MeetingMode,
                  })
                }
                disabled={submitDisabled}
              >
                <SelectTrigger
                  id="meeting-mode"
                  ref={modeRef}
                  aria-labelledby="meeting-mode-label"
                  aria-describedby="meeting-mode-hint"
                  className="h-11 min-w-0 border-input-strong sm:h-10"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="instant">Instant meeting</SelectItem>
                  <SelectItem value="scheduled">Scheduled meeting</SelectItem>
                </SelectContent>
              </Select>
              <p
                id="meeting-mode-hint"
                className="flex items-start gap-1.5 text-xs text-muted-foreground"
              >
                {isScheduled ? (
                  <>
                    <CalendarClock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    Pick a start time. The lobby opens whenever you are ready.
                  </>
                ) : (
                  <>
                    <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    No start time needed. The lobby is available as soon as the
                    meeting is created.
                  </>
                )}
              </p>
            </div>

            {isScheduled && (
              <div className="space-y-4 rounded-lg border bg-muted/30 p-4">
                <p className="text-xs text-muted-foreground">
                  Times use{" "}
                  {timeZone === null
                    ? "your device time zone"
                    : `your device time zone (${timeZone})`}
                  .
                </p>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="meeting-start">Starts at</Label>
                    <Input
                      id="meeting-start"
                      ref={startRef}
                      type="datetime-local"
                      value={state.draft.startsAtLocal}
                      onChange={(event) =>
                        dispatch({
                          type: "FIELD_CHANGED",
                          field: "startsAtLocal",
                          value: event.target.value,
                        })
                      }
                      disabled={submitDisabled}
                      aria-invalid={startError !== undefined}
                      aria-describedby={
                        startError !== undefined
                          ? "meeting-start-hint meeting-start-error"
                          : "meeting-start-hint"
                      }
                      className="h-11 w-full min-w-0 border-input-strong sm:h-10"
                    />
                    <p
                      id="meeting-start-hint"
                      className="text-xs text-muted-foreground"
                    >
                      Required. Must be in the future.
                    </p>
                    {startError !== undefined && (
                      <p
                        id="meeting-start-error"
                        className="break-words text-sm text-destructive-text"
                      >
                        {startError}
                      </p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="meeting-end">Ends at</Label>
                    <Input
                      id="meeting-end"
                      ref={endRef}
                      type="datetime-local"
                      value={state.draft.endsAtLocal}
                      onChange={(event) =>
                        dispatch({
                          type: "FIELD_CHANGED",
                          field: "endsAtLocal",
                          value: event.target.value,
                        })
                      }
                      disabled={submitDisabled}
                      aria-invalid={endError !== undefined}
                      aria-describedby={
                        endError !== undefined
                          ? "meeting-end-hint meeting-end-error"
                          : "meeting-end-hint"
                      }
                      className="h-11 w-full min-w-0 border-input-strong sm:h-10"
                    />
                    <p
                      id="meeting-end-hint"
                      className="text-xs text-muted-foreground"
                    >
                      Optional. Must be after the start time.
                    </p>
                    {endError !== undefined && (
                      <p
                        id="meeting-end-error"
                        className="break-words text-sm text-destructive-text"
                      >
                        {endError}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )}

            {status.kind === "error" && (
              <Alert
                role="alert"
                variant={
                  status.failure.kind === "validation" ? "default" : "destructive"
                }
              >
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>
                  {status.failure.kind === "authorization"
                    ? "Sign in to continue"
                    : "Meeting not created"}
                </AlertTitle>
                <AlertDescription className="space-y-3">
                  <p>
                    {status.failure.kind === "validation"
                      ? (status.failure.formMessage ??
                        "Check the highlighted fields and try again.")
                      : status.failure.message}
                  </p>

                  {status.failure.kind === "operational" &&
                    status.failure.correlationId.length > 0 && (
                      <p className="text-xs">
                        Reference:{" "}
                        <span className="font-mono">
                          {status.failure.correlationId}
                        </span>
                      </p>
                    )}

                  {status.failure.kind === "authorization" && (
                    <Button asChild size="sm" variant="outline">
                      <Link href="/sign-in?redirect_url=/meeting/new">
                        Sign in
                      </Link>
                    </Button>
                  )}
                </AlertDescription>
              </Alert>
            )}

            {status.kind === "success" && (
              <Alert role="status">
                <CheckCircle2 className="h-4 w-4" />
                <AlertTitle>Meeting created</AlertTitle>
                <AlertDescription className="space-y-3">
                  <p>
                    {status.navigationFailed
                      ? "Your meeting is ready, but the lobby did not open automatically."
                      : "Opening your pre-join lobby…"}
                  </p>
                  <p className="text-xs">
                    Meeting code:{" "}
                    <span className="font-mono">
                      {status.result.meetingCode}
                    </span>
                  </p>
                  {status.navigationFailed && (
                    <Button asChild size="sm">
                      <Link
                        href={`/meeting/${encodeURIComponent(
                          status.result.meetingCode,
                        )}/lobby`}
                      >
                        Open the lobby
                        <ArrowRight className="h-4 w-4" />
                      </Link>
                    </Button>
                  )}
                </AlertDescription>
              </Alert>
            )}

            <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:justify-end">
              <Button
                asChild
                type="button"
                variant="outline"
                size="lg"
                className="w-full sm:w-auto"
              >
                <Link href="/dashboard">Cancel</Link>
              </Button>
              <Button
                type="submit"
                size="lg"
                disabled={submitDisabled}
                className="w-full bg-primary-emphasis text-primary-emphasis-foreground hover:bg-primary-emphasis/90 sm:w-auto"
              >
                {isLoading ? (
                  <>
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                    Creating…
                  </>
                ) : (
                  <>
                    <Video className="h-4 w-4" />
                    Create meeting
                  </>
                )}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </>
  );
}
