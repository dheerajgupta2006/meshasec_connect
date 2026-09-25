"use client";

import {
  Check,
  LoaderCircle,
  Plus,
  Search,
  UserRound,
  Users,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createGroup,
  listAddableConnections,
  type AddableConnection,
} from "@/app/dashboard/groups/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  GROUP_DESCRIPTION_MAX_CHARS,
  GROUP_NAME_MAX_CHARS,
} from "@/lib/groups/limits";
import { cn } from "@/lib/utils";

interface CreateGroupDialogProps {
  /** `sm` where the trigger sits in a section header rather than a page header. */
  size?: "default" | "sm";
}

/**
 * Creating a group.
 *
 * The member picker is multi-select, which no existing surface in the app needed
 * — the mid-call invite list acts on one person at a time. Selection is held as a
 * `Set` of ids rather than per-row state for that reason: the row's job here is to
 * toggle, and the action is taken once for the whole set.
 *
 * The connection list is loaded on open rather than on mount, since a connection
 * may have been accepted since the dialog was last shown, and filtered on the
 * client — the list is already in memory and a round trip per keystroke would buy
 * nothing.
 */
export function CreateGroupDialog({
  size = "default",
}: CreateGroupDialogProps = {}) {
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [connections, setConnections] = useState<AddableConnection[]>([]);
  const [capacity, setCapacity] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Checked after every await so a late response cannot set state post-unmount. */
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    const outcome = await listAddableConnections();

    if (!mountedRef.current) {
      return;
    }

    setLoading(false);

    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }

    setConnections(outcome.connections);
    setCapacity(outcome.capacityLeft);

    if (outcome.connections.length === 0) {
      setError(outcome.message);
    }
  }, []);

  useEffect(() => {
    if (open) {
      void load();
    }
  }, [open, load]);

  function reset(): void {
    setName("");
    setDescription("");
    setQuery("");
    setSelected(new Set());
    setError(null);
  }

  function handleOpenChange(next: boolean): void {
    setOpen(next);

    if (!next) {
      reset();
    }
  }

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();

    if (needle.length === 0) {
      return connections;
    }

    return connections.filter((person) => {
      const label = person.name?.toLowerCase() ?? "";
      return (
        person.username.toLowerCase().includes(needle) || label.includes(needle)
      );
    });
  }, [connections, query]);

  function toggle(id: string): void {
    setError(null);

    setSelected((current) => {
      const next = new Set(current);

      if (next.has(id)) {
        next.delete(id);
        return next;
      }

      // Stopped here as well as on the server so the person is told before they
      // fill in a name and press the button.
      if (next.size >= capacity) {
        setError(`You can add up to ${String(capacity)} people.`);
        return current;
      }

      next.add(id);
      return next;
    });
  }

  function submit(): void {
    if (saving) {
      return;
    }

    setSaving(true);
    setError(null);

    void createGroup(name, description, Array.from(selected)).then((outcome) => {
      if (!mountedRef.current) {
        return;
      }

      setSaving(false);

      if (!outcome.ok || outcome.groupId === null) {
        setError(outcome.message);
        return;
      }

      handleOpenChange(false);
      router.push(`/dashboard/groups/${encodeURIComponent(outcome.groupId)}`);
    });
  }

  return (
    <>
      <Button type="button" size={size} onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" aria-hidden="true" />
        New group
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New group</DialogTitle>
            <DialogDescription>
              Name the group and choose who is in it. You can add anyone you are
              connected with.
            </DialogDescription>
          </DialogHeader>

          {error !== null && (
            <Alert role="alert" variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-1.5">
            <label className="text-xs font-medium" htmlFor="group-name">
              Name
            </label>
            <Input
              id="group-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Design team"
              maxLength={GROUP_NAME_MAX_CHARS}
              autoComplete="off"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium" htmlFor="group-description">
              Description
              <span className="ml-1 font-normal text-muted-foreground">
                (optional)
              </span>
            </label>
            <Input
              id="group-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What this group is for"
              maxLength={GROUP_DESCRIPTION_MAX_CHARS}
              autoComplete="off"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium">Members</span>
              <span
                className="text-xs text-muted-foreground"
                aria-live="polite"
              >
                {`${String(selected.size)} selected`}
              </span>
            </div>

            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              />
              <label className="sr-only" htmlFor="group-member-search">
                Search your connections
              </label>
              <Input
                id="group-member-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search connections"
                autoComplete="off"
                className="pl-9"
              />
            </div>

            <div className="max-h-56 space-y-1.5 overflow-y-auto">
              {loading ? (
                <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                  <LoaderCircle
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                  Loading your connections…
                </p>
              ) : visible.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  {connections.length === 0
                    ? "Connect with someone first, then you can put them in a group."
                    : "No connections match that search."}
                </p>
              ) : (
                visible.map((person) => {
                  const chosen = selected.has(person.id);

                  return (
                    <button
                      key={person.id}
                      type="button"
                      onClick={() => toggle(person.id)}
                      aria-pressed={chosen}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors",
                        chosen
                          ? "border-primary/50 bg-primary/10"
                          : "hover:border-primary/30 hover:bg-muted/50",
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary/10 text-primary"
                      >
                        <UserRound className="h-4 w-4" />
                      </span>

                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {person.name ?? `@${person.username}`}
                        </span>
                        <span className="block truncate font-mono text-xs text-muted-foreground">
                          @{person.username}
                        </span>
                      </span>

                      <span
                        aria-hidden="true"
                        className={cn(
                          "grid h-5 w-5 shrink-0 place-items-center rounded-full border",
                          chosen
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-muted-foreground/40",
                        )}
                      >
                        {chosen && <Check className="h-3 w-3" />}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          <Button
            type="button"
            onClick={submit}
            disabled={saving || selected.size === 0 || name.trim().length === 0}
          >
            {saving ? (
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Users className="h-4 w-4" aria-hidden="true" />
            )}
            Create group
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
