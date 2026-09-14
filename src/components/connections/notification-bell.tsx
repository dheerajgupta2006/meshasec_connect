"use client";

import { Bell, Check, LoaderCircle, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { respondToConnectionRequest } from "@/app/connections/actions";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export interface BellRequest {
  requestId: string;
  senderUsername: string;
  senderName: string | null;
}

interface NotificationBellProps {
  requests: BellRequest[];
}

export function NotificationBell({ requests }: NotificationBellProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const count = requests.length;

  function respond(requestId: string, decision: "accept" | "decline") {
    if (isPending) {
      return;
    }

    setBusyId(requestId);
    setNotice(null);

    startTransition(async () => {
      const outcome = await respondToConnectionRequest(requestId, decision);
      setBusyId(null);
      setNotice(outcome.message);
      router.refresh();
    });
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={
            count > 0
              ? `Notifications, ${count} pending connection request${count === 1 ? "" : "s"}`
              : "Notifications"
          }
        >
          <Bell className="h-5 w-5" />
          {count > 0 && (
            <span
              aria-hidden="true"
              className="absolute -right-0.5 -top-0.5 grid h-5 min-w-5 place-items-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground"
            >
              {count > 9 ? "9+" : count}
            </span>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-[min(22rem,calc(100vw-2rem))]">
        <div className="border-b px-4 py-3">
          <p className="text-sm font-semibold">Connection requests</p>
          <p className="text-xs text-muted-foreground">
            {count === 0
              ? "You are all caught up."
              : `${count} waiting for your response.`}
          </p>
        </div>

        <div className="max-h-80 overflow-y-auto">
          {count === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              No pending requests.
            </p>
          ) : (
            <ul className="divide-y">
              {requests.map((request) => {
                const isBusy = busyId === request.requestId;

                return (
                  <li key={request.requestId} className="px-4 py-3">
                    <p className="truncate text-sm font-medium">
                      {request.senderName ?? `@${request.senderUsername}`}
                    </p>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      @{request.senderUsername}
                    </p>

                    <div className="mt-3 flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        className="flex-1"
                        disabled={isPending}
                        onClick={() => respond(request.requestId, "accept")}
                      >
                        {isBusy ? (
                          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Check className="h-3.5 w-3.5" />
                        )}
                        Accept
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="flex-1"
                        disabled={isPending}
                        onClick={() => respond(request.requestId, "decline")}
                      >
                        <X className="h-3.5 w-3.5" />
                        Decline
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {notice !== null && (
          <p
            role="status"
            className="border-t px-4 py-3 text-xs text-muted-foreground"
          >
            {notice}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
