"use client";

import { AlertCircle, LoaderCircle, Lock, Save, Settings2 } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { toast } from "sonner";

import {
  getMeetingSettings,
  updateMeetingSchedule,
  type MeetingSettingsView,
} from "@/app/meeting/[code]/settings";
import { MeetingShareDetails } from "@/components/meeting/meeting-share-details";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TITLE_MAX_CHARS } from "@/lib/meetings/types";
import {
  toDateTimeLocalValue,
  validateClientInput,
  type FieldErrors,
} from "@/lib/meetings/validation";

const OFFLINE_MESSAGE =
  "We could not reach the server. Check your connection and try again.";

interface ScheduleDraft {
  title: string;
  /** Raw `datetime-local` values, exactly as the inputs hold them. */
  startsAtLocal: string;
  endsAtLocal: string;
}

function draftFrom(settings: MeetingSettingsView): ScheduleDraft {
  return {
    title: settings.title,
    startsAtLocal:
      settings.startsAt === null ? "" : toDateTimeLocalValue(settings.startsAt),
    endsAtLocal:
      settings.endsAt === null ? "" : toDateTimeLocalValue(settings.endsAt),
  };
}

function sameDraft(first: ScheduleDraft, second: ScheduleDraft): boolean {
  return (
    first.title === second.title &&
    first.startsAtLocal === second.startsAtLocal &&
    first.endsAtLocal === second.endsAtLocal
  );
}

const ERROR_KEY: Record<keyof ScheduleDraft, keyof FieldErrors> = {
  title: "title",
  startsAtLocal: "startsAt",
  endsAtLocal: "endsAt",
};

interface MeetingSettingsDialogProps {
  meetingCode: string;
  meetingTitle: string;
  /** The trigger sits on a dark dashboard card, which needs its own contrast. */
  triggerClassName?: string;
}

/**
 * Host settings for a scheduled meeting: the share details, and the title and
 * time while they can still be changed.
 *
 * Every rule here is a courtesy. The server action re-checks ownership, re-runs
 * validation, and refuses a meeting that has started even if this dialog still
 * thinks it is editable — which is what `locked` in its response is for.
 */
export function MeetingSettingsDialog({
  meetingCode,
  meetingTitle,
  triggerClassName,
}: MeetingSettingsDialogProps) {
  const router = useRouter();
  const idBase = useId();

  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<MeetingSettingsView | null>(null);
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [timeZone, setTimeZone] = useState<string | null>(null);

  /** Checked after every await so a late response cannot set state post-unmount. */
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Read in an effect, not during render, to avoid a hydration mismatch.
  useEffect(() => {
    try {
      setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    } catch {
      setTimeZone(null);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);

    try {
      const outcome = await getMeetingSettings(meetingCode);

      if (!mountedRef.current) {
        return;
      }

      if (!outcome.ok) {
        setLoadError(outcome.message);
        return;
      }

      setSettings(outcome.settings);
      setDraft(draftFrom(outcome.settings));
    } catch {
      if (mountedRef.current) {
        setLoadError(OFFLINE_MESSAGE);
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [meetingCode]);

  // Reloaded on every open rather than once: the meeting may have been changed in
  // another tab, or reached its start time, since the dialog was last shown.
  useEffect(() => {
    if (open) {
      void load();
    }
  }, [open, load]);

  function handleOpenChange(next: boolean): void {
    setOpen(next);

    if (!next) {
      setFieldErrors({});
      setFormError(null);
    }
  }

  function change(field: keyof ScheduleDraft, value: string): void {
    setDraft((current) =>
      current === null ? current : { ...current, [field]: value },
    );

    const key = ERROR_KEY[field];

    setFieldErrors((current) => {
      if (current[key] === undefined) {
        return current;
      }

      const next = { ...current };
      delete next[key];
      return next;
    });

    setFormError(null);
  }

  const original = settings === null ? null : draftFrom(settings);
  const dirty = draft !== null && original !== null && !sameDraft(draft, original);
  const editable = settings?.editable === true;
  const fieldsDisabled = !editable || saving;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (draft === null || !editable || !dirty || saving) {
      return;
    }

    // The same client rules the creation form runs. They also turn the
    // zone-less `datetime-local` values into the explicit-offset instants the
    // server insists on.
    const validation = validateClientInput({
      title: draft.title,
      mode: "scheduled",
      startsAtLocal: draft.startsAtLocal,
      endsAtLocal: draft.endsAtLocal,
    });

    if (!validation.ok) {
      setFieldErrors(validation.fieldErrors);
      setFormError(validation.formMessage);
      return;
    }

    setSaving(true);
    setFormError(null);

    try {
      const outcome = await updateMeetingSchedule(meetingCode, {
        title: validation.value.title,
        startsAt: validation.value.startsAt,
        endsAt: validation.value.endsAt,
      });

      if (!mountedRef.current) {
        return;
      }

      if (!outcome.ok) {
        setFieldErrors(outcome.fieldErrors);
        setFormError(outcome.message);

        if (outcome.locked) {
          setSettings((current) =>
            current === null ? current : { ...current, editable: false },
          );
        }

        return;
      }

      setSettings(outcome.settings);
      setDraft(draftFrom(outcome.settings));
      setFieldErrors({});
      toast.success(outcome.message);

      // The dashboard card still shows the old title and time until the server
      // tree is read again.
      router.refresh();
    } catch {
      if (mountedRef.current) {
        setFormError(OFFLINE_MESSAGE);
      }
    } finally {
      if (mountedRef.current) {
        setSaving(false);
      }
    }
  }

  const ids = {
    shareHeading: `${idBase}-share`,
    scheduleHeading: `${idBase}-schedule`,
    title: `${idBase}-title`,
    titleError: `${idBase}-title-error`,
    start: `${idBase}-start`,
    startError: `${idBase}-start-error`,
    end: `${idBase}-end`,
    endHint: `${idBase}-end-hint`,
    endError: `${idBase}-end-error`,
  };

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
        className={triggerClassName}
        aria-label={`Manage ${meetingTitle}`}
      >
        <Settings2 className="h-4 w-4" aria-hidden="true" />
        Manage meeting
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="pr-6">Meeting settings</DialogTitle>
            <DialogDescription>
              Share the meeting, or change its title and time before it starts.
            </DialogDescription>
          </DialogHeader>

          {loading && settings === null ? (
            <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <LoaderCircle
                className="h-4 w-4 animate-spin"
                aria-hidden="true"
              />
              Loading meeting…
            </p>
          ) : loadError !== null && settings === null ? (
            <Alert role="alert" variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Could not open the settings</AlertTitle>
              <AlertDescription className="space-y-3">
                <p>{loadError}</p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void load()}
                >
                  Try again
                </Button>
              </AlertDescription>
            </Alert>
          ) : settings !== null && draft !== null ? (
            <div className="space-y-6">
              <section aria-labelledby={ids.shareHeading} className="space-y-3">
                <h3
                  id={ids.shareHeading}
                  className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  Share
                </h3>
                <MeetingShareDetails
                  meetingCode={settings.meetingCode}
                  title={settings.title}
                  startsAt={settings.startsAt}
                  endsAt={settings.endsAt}
                  passcode={settings.passcode}
                />
              </section>

              <section
                aria-labelledby={ids.scheduleHeading}
                className="space-y-4 border-t pt-4"
              >
                <h3
                  id={ids.scheduleHeading}
                  className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  Schedule
                </h3>

                {!editable && (
                  <Alert role="status">
                    <Lock className="h-4 w-4" />
                    <AlertDescription>
                      This meeting has already started, so its title and time
                      can no longer be changed.
                    </AlertDescription>
                  </Alert>
                )}

                <form
                  onSubmit={handleSubmit}
                  aria-busy={saving}
                  noValidate
                  className="space-y-4"
                >
                  <div className="space-y-2">
                    <Label htmlFor={ids.title}>Meeting title</Label>
                    <Input
                      id={ids.title}
                      value={draft.title}
                      onChange={(event) => change("title", event.target.value)}
                      maxLength={TITLE_MAX_CHARS}
                      autoComplete="off"
                      disabled={fieldsDisabled}
                      aria-invalid={fieldErrors.title !== undefined}
                      aria-describedby={
                        fieldErrors.title !== undefined
                          ? ids.titleError
                          : undefined
                      }
                    />
                    {fieldErrors.title !== undefined && (
                      <p
                        id={ids.titleError}
                        className="break-words text-sm text-destructive-text"
                      >
                        {fieldErrors.title}
                      </p>
                    )}
                  </div>

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor={ids.start}>Starts at</Label>
                      <Input
                        id={ids.start}
                        type="datetime-local"
                        value={draft.startsAtLocal}
                        onChange={(event) =>
                          change("startsAtLocal", event.target.value)
                        }
                        disabled={fieldsDisabled}
                        aria-invalid={fieldErrors.startsAt !== undefined}
                        aria-describedby={
                          fieldErrors.startsAt !== undefined
                            ? ids.startError
                            : undefined
                        }
                        className="w-full min-w-0"
                      />
                      {fieldErrors.startsAt !== undefined && (
                        <p
                          id={ids.startError}
                          className="break-words text-sm text-destructive-text"
                        >
                          {fieldErrors.startsAt}
                        </p>
                      )}
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor={ids.end}>Ends at</Label>
                      <Input
                        id={ids.end}
                        type="datetime-local"
                        value={draft.endsAtLocal}
                        onChange={(event) =>
                          change("endsAtLocal", event.target.value)
                        }
                        disabled={fieldsDisabled}
                        aria-invalid={fieldErrors.endsAt !== undefined}
                        aria-describedby={
                          fieldErrors.endsAt !== undefined
                            ? `${ids.endHint} ${ids.endError}`
                            : ids.endHint
                        }
                        className="w-full min-w-0"
                      />
                      <p
                        id={ids.endHint}
                        className="text-xs text-muted-foreground"
                      >
                        Optional. Clear it to leave the end open.
                      </p>
                      {fieldErrors.endsAt !== undefined && (
                        <p
                          id={ids.endError}
                          className="break-words text-sm text-destructive-text"
                        >
                          {fieldErrors.endsAt}
                        </p>
                      )}
                    </div>
                  </div>

                  <p className="text-xs text-muted-foreground">
                    Times use{" "}
                    {timeZone === null
                      ? "your device time zone"
                      : `your device time zone (${timeZone})`}
                    .
                  </p>

                  {formError !== null && (
                    <p role="alert" className="text-sm text-destructive-text">
                      {formError}
                    </p>
                  )}

                  {editable && (
                    <div className="flex justify-end">
                      <Button type="submit" disabled={!dirty || saving}>
                        {saving ? (
                          <LoaderCircle
                            className="h-4 w-4 animate-spin"
                            aria-hidden="true"
                          />
                        ) : (
                          <Save className="h-4 w-4" aria-hidden="true" />
                        )}
                        {saving ? "Saving…" : "Save changes"}
                      </Button>
                    </div>
                  )}
                </form>
              </section>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
