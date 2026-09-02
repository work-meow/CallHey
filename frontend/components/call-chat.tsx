"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { Lock, SendHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger,
} from "@/components/ui/sheet";
import { ChatMessage, MAX_MESSAGE_LENGTH } from "@/lib/wire";
import { cn } from "@/lib/utils";

type Props = {
  messages: ChatMessage[];
  onSend: (text: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: React.ReactNode;
};

export function CallChat({ messages, onSend, open, onOpenChange, trigger }: Props) {
  const [draft, setDraft] = useState("");
  const bottom = useRef<HTMLDivElement>(null);

  // Держим ленту у последнего сообщения, как в любом мессенджере.
  useEffect(() => {
    if (open) bottom.current?.scrollIntoView({ block: "end" });
  }, [messages, open]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft("");
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent className="w-full gap-0 sm:max-w-md">
        <SheetHeader className="shrink-0">
          <SheetTitle>Чат</SheetTitle>
          <SheetDescription className="flex items-center gap-1.5">
            <Lock className="size-3" />
            Сообщения идут напрямую участникам, минуя сервер
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-2">
          {messages.length === 0 ? (
            <p className="text-muted-foreground py-8 text-center text-sm">
              Сообщений пока нет.<br />История не сохраняется после выхода.
            </p>
          ) : (
            messages.map((message) => <Bubble key={message.id} message={message} />)
          )}
          <div ref={bottom} />
        </div>

        <SheetFooter className="shrink-0">
          <form onSubmit={submit} className="flex w-full items-center gap-2">
            <Input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={MAX_MESSAGE_LENGTH}
              placeholder="Написать сообщение…"
              aria-label="Текст сообщения"
              autoComplete="off"
            />
            <Button type="submit" size="icon" disabled={!draft.trim()} aria-label="Отправить">
              <SendHorizontal />
            </Button>
          </form>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function Bubble({ message }: { message: ChatMessage }) {
  return (
    <div className={cn("flex flex-col gap-1", message.own && "items-end")}>
      <div className="text-muted-foreground flex items-baseline gap-2 px-1 text-[11px]">
        <span className="font-semibold">{message.own ? "Вы" : message.author}</span>
        <time className="font-mono">{formatClock(message.at)}</time>
      </div>
      <div
        className={cn(
          "max-w-[85%] rounded-lg px-3 py-2 text-sm wrap-anywhere whitespace-pre-wrap",
          message.own ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground",
        )}
      >
        {message.text}
      </div>
    </div>
  );
}

function formatClock(at: number) {
  return new Date(at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}
