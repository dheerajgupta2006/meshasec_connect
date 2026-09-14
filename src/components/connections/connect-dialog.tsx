"use client";

import { AtSign, CheckCircle2, LoaderCircle, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import { sendConnectionRequest } from "@/app/connections/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface ConnectDialogProps {
  myUsername: string;
}

export function ConnectDialog({ myUsername }: ConnectDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(
    null,
  );
  const [isPending, startTransition] = useTransition();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isPending || username.trim().length === 0) {
      return;
    }

    startTransition(async () => {
      const outcome = await sendConnectionRequest(username);
      setResult(outcome);

      if (outcome.ok) {
        setUsername("");
        router.refresh();
      }
    });
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setResult(null);
      setUsername("");
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="lg" className="shadow-sm">
          <UserPlus className="h-5 w-5" />
          New Chat / Connect
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect with someone</DialogTitle>
          <DialogDescription>
            Enter their username. They will get a request to approve before you
            can message or call each other.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="connect-username">Username</Label>
            <div className="relative">
              <AtSign className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="connect-username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="username"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                disabled={isPending}
                aria-describedby="connect-username-hint"
                className="h-11 border-input-strong pl-9 sm:h-10"
              />
            </div>
            <p
              id="connect-username-hint"
              className="text-xs text-muted-foreground"
            >
              Your username is{" "}
              <span className="font-mono text-foreground">@{myUsername}</span>{" "}
              — share it so others can find you.
            </p>
          </div>

          {result !== null && (
            <Alert
              role={result.ok ? "status" : "alert"}
              variant={result.ok ? "default" : "destructive"}
            >
              {result.ok && <CheckCircle2 className="h-4 w-4" />}
              <AlertDescription>{result.message}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="w-full sm:w-auto"
              onClick={() => handleOpenChange(false)}
            >
              Close
            </Button>
            <Button
              type="submit"
              size="lg"
              disabled={isPending || username.trim().length === 0}
              className="w-full bg-primary-emphasis text-primary-emphasis-foreground hover:bg-primary-emphasis/90 sm:w-auto"
            >
              {isPending ? (
                <>
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                  Sending…
                </>
              ) : (
                <>
                  <UserPlus className="h-4 w-4" />
                  Send request
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
