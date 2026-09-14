"use client";

import {
  Clock3,
  LoaderCircle,
  MessageSquare,
  UserMinus,
  UserRound,
  Users,
  Video,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { removeConnection, startDirectCall } from "@/app/connections/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export interface ContactSummary {
  id: string;
  username: string;
  name: string | null;
}

interface ContactsListProps {
  contacts: ContactSummary[];
  outgoing: ContactSummary[];
}

export function ContactsList({ contacts, outgoing }: ContactsListProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function remove(contactId: string, username: string) {
    if (isPending) {
      return;
    }

    // Removal closes chat and calling, so it gets an explicit confirmation.
    const confirmed = window.confirm(
      `Remove @${username}? You will no longer be able to message or call each other until you reconnect.`,
    );

    if (!confirmed) {
      return;
    }

    setRemovingId(contactId);
    setError(null);

    startTransition(async () => {
      const outcome = await removeConnection(contactId);
      setRemovingId(null);

      if (!outcome.ok) {
        setError(outcome.message);
        return;
      }

      router.refresh();
    });
  }

  function call(contactId: string) {
    if (isPending) {
      return;
    }

    setBusyId(contactId);
    setError(null);

    startTransition(async () => {
      const outcome = await startDirectCall(contactId);

      if (outcome.ok && outcome.meetingCode !== null) {
        router.push(
          `/meeting/${encodeURIComponent(outcome.meetingCode)}/lobby`,
        );
        return;
      }

      setBusyId(null);
      setError(outcome.message);
    });
  }

  return (
    <section className="space-y-5" aria-labelledby="contacts-heading">
      <div className="flex items-center justify-between">
        <div>
          <h2 id="contacts-heading" className="text-2xl font-semibold">
            Connected contacts
          </h2>
          <p className="text-sm text-muted-foreground">
            People who accepted your request, or whose request you accepted.
          </p>
        </div>
        <Badge variant="secondary">{contacts.length}</Badge>
      </div>

      {error !== null && (
        <Alert role="alert" variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {contacts.length === 0 ? (
        <Card className="border-dashed bg-card/60">
          <CardContent className="flex min-h-44 flex-col items-center justify-center px-6 text-center">
            <span className="mb-4 grid h-12 w-12 place-items-center rounded-full bg-muted text-muted-foreground">
              <Users className="h-5 w-5" />
            </span>
            <h3 className="font-semibold">No contacts yet</h3>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Use “New Chat / Connect” to send someone a request. Once they
              accept, you can call them from here.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {contacts.map((contact) => (
            <Card key={contact.id} className="transition-colors hover:border-primary/40">
              <CardContent className="flex items-center gap-4 p-5">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
                  <UserRound className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {contact.name ?? `@${contact.username}`}
                  </p>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    @{contact.username}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    disabled={isPending}
                    onClick={() => remove(contact.id, contact.username)}
                    aria-label={`Remove @${contact.username} from your contacts`}
                    title="Remove connection"
                    className="text-muted-foreground hover:text-destructive-text"
                  >
                    {removingId === contact.id ? (
                      <LoaderCircle className="h-4 w-4 animate-spin" />
                    ) : (
                      <UserMinus className="h-4 w-4" />
                    )}
                  </Button>
                  <Button
                    asChild
                    size="icon"
                    variant="outline"
                    aria-label={`Message @${contact.username}`}
                  >
                    <Link
                      href={`/messages/${encodeURIComponent(contact.username)}`}
                    >
                      <MessageSquare className="h-4 w-4" />
                    </Link>
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={isPending}
                    onClick={() => call(contact.id)}
                    aria-label={`Start a call with @${contact.username}`}
                  >
                    {busyId === contact.id ? (
                      <LoaderCircle className="h-4 w-4 animate-spin" />
                    ) : (
                      <Video className="h-4 w-4" />
                    )}
                    Call
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {outgoing.length > 0 && (
        <Card className="bg-muted/30">
          <CardContent className="p-5">
            <p className="flex items-center gap-2 text-sm font-medium">
              <Clock3 className="h-4 w-4 text-muted-foreground" />
              Awaiting their response
            </p>
            <ul className="mt-3 flex flex-wrap gap-2">
              {outgoing.map((person) => (
                <li key={person.id}>
                  <Badge variant="outline" className="font-mono">
                    @{person.username}
                  </Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </section>
  );
}
