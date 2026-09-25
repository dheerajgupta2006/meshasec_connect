"use client";

import {
  Check,
  LoaderCircle,
  LogOut,
  Search,
  Shield,
  ShieldOff,
  Trash2,
  UserMinus,
  UserPlus,
  UserRound,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  addGroupMembers,
  deleteGroup,
  leaveGroup,
  listAddableConnections,
  removeGroupMember,
  setGroupRole,
  updateGroup,
  type AddableConnection,
} from "@/app/groups/actions";
import type { GroupMemberSummary } from "@/components/groups/group-thread";
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

type Role = "OWNER" | "ADMIN" | "MEMBER";

interface GroupMembersPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupId: string;
  groupName: string;
  description: string | null;
  myRole: Role;
  myUserId: string;
  members: GroupMemberSummary[];
}

const ROLE_LABEL: Record<Role, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  MEMBER: "Member",
};

/**
 * Roster and settings for one group.
 *
 * Every control here is also gated server-side, and the server is the only gate
 * that counts. These `canManage` / `isOwner` branches decide what is worth showing
 * — a member who edits the DOM to reveal the delete button still gets a refusal
 * from `deleteGroup`.
 */
export function GroupMembersPanel({
  open,
  onOpenChange,
  groupId,
  groupName,
  description,
  myRole,
  myUserId,
  members,
}: GroupMembersPanelProps) {
  const router = useRouter();

  const canManage = myRole === "OWNER" || myRole === "ADMIN";
  const isOwner = myRole === "OWNER";

  const [name, setName] = useState(groupName);
  const [about, setAbout] = useState(description ?? "");
  const [query, setQuery] = useState("");
  const [connections, setConnections] = useState<AddableConnection[]>([]);
  const [capacity, setCapacity] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  /** Id of whichever row or control has a request in flight. */
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Re-synced when the server sends a new roster, so a rename made elsewhere is
  // not overwritten by a stale draft sitting in this panel.
  useEffect(() => {
    setName(groupName);
    setAbout(description ?? "");
  }, [groupName, description]);

  const loadConnections = useCallback(async () => {
    setLoading(true);

    const outcome = await listAddableConnections(groupId);

    if (!mountedRef.current) {
      return;
    }

    setLoading(false);

    if (!outcome.ok) {
      // Not surfaced as an error: a plain member is not allowed to list
      // candidates, and that is the expected answer rather than a failure.
      setConnections([]);
      setCapacity(0);
      return;
    }

    setConnections(outcome.connections);
    setCapacity(outcome.capacityLeft);
  }, [groupId]);

  useEffect(() => {
    if (open && canManage) {
      void loadConnections();
    }
  }, [open, canManage, loadConnections]);

  function resetFeedback(): void {
    setError(null);
    setNotice(null);
  }

  function handleOpenChange(next: boolean): void {
    onOpenChange(next);

    if (!next) {
      resetFeedback();
      setQuery("");
      setSelected(new Set());
      setConfirmLeave(false);
      setConfirmDelete(false);
    }
  }

  /** Runs one action, reports its message, and refreshes the server tree. */
  function run(
    key: string,
    action: () => Promise<{ ok: boolean; message: string }>,
    options: { navigateTo?: string } = {},
  ): void {
    if (busy !== null) {
      return;
    }

    setBusy(key);
    resetFeedback();

    void action().then((outcome) => {
      if (!mountedRef.current) {
        return;
      }

      setBusy(null);

      if (!outcome.ok) {
        setError(outcome.message);
        return;
      }

      setNotice(outcome.message);

      if (options.navigateTo !== undefined) {
        handleOpenChange(false);
        router.push(options.navigateTo);
        return;
      }

      setSelected(new Set());
      void loadConnections();
      router.refresh();
    });
  }

  const candidates = useMemo(() => {
    const needle = query.trim().toLowerCase();

    // Already-members are filtered out rather than shown disabled: the roster is
    // right above, so listing them twice adds nothing.
    const available = connections.filter((person) => !person.alreadyMember);

    if (needle.length === 0) {
      return available;
    }

    return available.filter((person) => {
      const label = person.name?.toLowerCase() ?? "";
      return (
        person.username.toLowerCase().includes(needle) || label.includes(needle)
      );
    });
  }, [connections, query]);

  function toggle(id: string): void {
    resetFeedback();

    setSelected((current) => {
      const next = new Set(current);

      if (next.has(id)) {
        next.delete(id);
        return next;
      }

      if (next.size >= capacity) {
        setError(
          capacity === 0
            ? "This group is full."
            : `You can add up to ${String(capacity)} more.`,
        );
        return current;
      }

      next.add(id);
      return next;
    });
  }

  const settingsChanged =
    name.trim() !== groupName || about.trim() !== (description ?? "");

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{groupName}</DialogTitle>
          <DialogDescription>
            {`${String(members.length)} members · you are ${ROLE_LABEL[myRole].toLowerCase()}`}
          </DialogDescription>
        </DialogHeader>

        {error !== null && (
          <Alert role="alert" variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {notice !== null && (
          <Alert role="status">
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}

        {canManage && (
          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Settings
            </h3>

            <div className="space-y-1.5">
              <label className="sr-only" htmlFor="group-rename">
                Group name
              </label>
              <Input
                id="group-rename"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={GROUP_NAME_MAX_CHARS}
                autoComplete="off"
                placeholder="Group name"
              />
              <label className="sr-only" htmlFor="group-about">
                Group description
              </label>
              <Input
                id="group-about"
                value={about}
                onChange={(event) => setAbout(event.target.value)}
                maxLength={GROUP_DESCRIPTION_MAX_CHARS}
                autoComplete="off"
                placeholder="Description (optional)"
              />
            </div>

            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy !== null || !settingsChanged}
              onClick={() =>
                run("settings", () => updateGroup(groupId, name, about))
              }
            >
              {busy === "settings" ? (
                <LoaderCircle
                  className="h-4 w-4 animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <Check className="h-4 w-4" aria-hidden="true" />
              )}
              Save changes
            </Button>
          </section>
        )}

        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Members
          </h3>

          <ul className="space-y-1.5">
            {members.map((member) => {
              const isMe = member.id === myUserId;
              // The owner can never be removed or demoted by anyone. Ownership has
              // to be surrendered by leaving, not taken.
              const removable =
                canManage &&
                !isMe &&
                member.role !== "OWNER" &&
                (isOwner || member.role !== "ADMIN");
              const roleChangeable =
                isOwner && !isMe && member.role !== "OWNER";

              return (
                <li
                  key={member.id}
                  className="flex items-center gap-3 rounded-xl border px-3 py-2"
                >
                  <span
                    aria-hidden="true"
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary/10 text-primary"
                  >
                    <UserRound className="h-4 w-4" />
                  </span>

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {member.name ?? `@${member.username}`}
                      {isMe && (
                        <span className="ml-1 font-normal text-muted-foreground">
                          (you)
                        </span>
                      )}
                    </p>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      @{member.username}
                    </p>
                  </div>

                  <span
                    className={cn(
                      "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                      member.role === "OWNER"
                        ? "border-primary/40 bg-primary/10 text-primary"
                        : member.role === "ADMIN"
                          ? "border-foreground/20 bg-muted text-foreground"
                          : "border-transparent text-muted-foreground",
                    )}
                  >
                    {ROLE_LABEL[member.role]}
                  </span>

                  {roleChangeable && (
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() =>
                        run(`role-${member.id}`, () =>
                          setGroupRole(
                            groupId,
                            member.id,
                            member.role !== "ADMIN",
                          ),
                        )
                      }
                      className="h-8 w-8 shrink-0 text-muted-foreground"
                      aria-label={
                        member.role === "ADMIN"
                          ? `Make @${member.username} a member`
                          : `Make @${member.username} an admin`
                      }
                    >
                      {busy === `role-${member.id}` ? (
                        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                      ) : member.role === "ADMIN" ? (
                        <ShieldOff className="h-3.5 w-3.5" />
                      ) : (
                        <Shield className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  )}

                  {removable && (
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() =>
                        run(`remove-${member.id}`, () =>
                          removeGroupMember(groupId, member.id),
                        )
                      }
                      className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                      aria-label={`Remove @${member.username} from the group`}
                    >
                      {busy === `remove-${member.id}` ? (
                        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <UserMinus className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        {canManage && (
          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Add people
            </h3>

            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              />
              <label className="sr-only" htmlFor="group-add-search">
                Search your connections
              </label>
              <Input
                id="group-add-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search connections"
                autoComplete="off"
                className="pl-9"
              />
            </div>

            <div className="max-h-44 space-y-1.5 overflow-y-auto">
              {loading ? (
                <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                  <LoaderCircle
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                  Loading…
                </p>
              ) : candidates.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  Everyone you are connected with is already in this group.
                </p>
              ) : (
                candidates.map((person) => {
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
                        className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground"
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

            <Button
              type="button"
              size="sm"
              disabled={busy !== null || selected.size === 0}
              onClick={() =>
                run("add", () =>
                  addGroupMembers(groupId, Array.from(selected)),
                )
              }
            >
              {busy === "add" ? (
                <LoaderCircle
                  className="h-4 w-4 animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <UserPlus className="h-4 w-4" aria-hidden="true" />
              )}
              {`Add ${String(selected.size)} to group`}
            </Button>
          </section>
        )}

        <section className="space-y-2 border-t pt-3">
          {/* Leaving is offered to everyone including the owner: ownership passes
              to the longest-standing remaining member rather than blocking the
              exit, so nobody is trapped in a group they started. */}
          {confirmLeave ? (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={busy !== null}
                onClick={() =>
                  run("leave", () => leaveGroup(groupId), {
                    navigateTo: "/groups",
                  })
                }
              >
                {busy === "leave" ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                  <LogOut className="h-4 w-4" aria-hidden="true" />
                )}
                Yes, leave
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setConfirmLeave(false)}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => setConfirmLeave(true)}
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              Leave group
            </Button>
          )}

          {isOwner &&
            (confirmDelete ? (
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={busy !== null}
                  onClick={() =>
                    run("delete", () => deleteGroup(groupId), {
                      navigateTo: "/groups",
                    })
                  }
                >
                  {busy === "delete" ? (
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  )}
                  Delete for everyone
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => setConfirmDelete(true)}
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                Delete group
              </Button>
            ))}
        </section>
      </DialogContent>
    </Dialog>
  );
}
