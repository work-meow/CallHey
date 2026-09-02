"use client";

import { useState } from "react";
import { Activity, Gauge, Radio, RefreshCw, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { PeerStats, rttQuality } from "@/hooks/use-peer-stats";
import { STUN_PROVIDERS, StunProvider, measureStun, stunQuality } from "@/lib/ice";
import { cn } from "@/lib/utils";

type Participant = { id: string; name: string; live: boolean };

type Props = {
  provider: StunProvider;
  onProviderChange: (provider: StunProvider) => void;
  participants: Participant[];
  stats: Record<string, PeerStats>;
  trigger: React.ReactNode;
};

const ROUTE_LABEL: Record<NonNullable<PeerStats["route"]>, string> = {
  local: "Локальная сеть",
  direct: "Напрямую",
  relay: "Через TURN-релей",
};

export function CallSettings({ provider, onProviderChange, participants, stats, trigger }: Props) {
  const [open, setOpen] = useState(false);
  const [pings, setPings] = useState<Record<string, number | null>>({});
  const [probing, setProbing] = useState(false);

  const probe = async () => {
    setProbing(true);
    const measured = await Promise.all(
      STUN_PROVIDERS.map(async (item) => [item.id, await measureStun(item.urls)] as const),
    );
    setPings(Object.fromEntries(measured));
    setProbing(false);
  };

  // Меряем при открытии панели, а не фоном: каждый замер поднимает временное соединение.
  const toggle = (next: boolean) => {
    setOpen(next);
    if (next && !Object.keys(pings).length && !probing) void probe();
  };

  return (
    <Sheet open={open} onOpenChange={toggle}>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Соединение</SheetTitle>
          <SheetDescription>
            Качество связи с каждым участником и выбор сервера, который определяет ваш внешний адрес.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-3 px-4">
          <div className="flex items-center justify-between">
            <Label htmlFor="stun" className="text-xs font-semibold tracking-wide uppercase">
              <ShieldCheck className="size-3.5" /> STUN-сервер
            </Label>
            <Button variant="ghost" size="xs" onClick={() => void probe()} disabled={probing}>
              <RefreshCw className={cn("size-3", probing && "animate-spin")} />
              {probing ? "Замер…" : "Проверить"}
            </Button>
          </div>

          <Select value={provider.id} onValueChange={(id) => onProviderChange(STUN_PROVIDERS.find((item) => item.id === id)!)}>
            <SelectTrigger id="stun" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STUN_PROVIDERS.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  <span className="flex w-full items-center gap-2">
                    {item.label}
                    <Ping value={pings[item.id]} pending={probing} scale="stun" />
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs leading-snug">{provider.hint}</p>
          <p className="text-muted-foreground text-xs leading-snug">
            Замер — время до первого ответа сервера, включая DNS. Смена применяется сразу: соединения пересобирают маршрут, звонок не прерывается.
          </p>
        </div>

        <Separator className="my-5" />

        <div className="space-y-3 px-4 pb-6">
          <Label className="text-xs font-semibold tracking-wide uppercase">
            <Activity className="size-3.5" /> Участники
          </Label>

          {participants.length === 0 ? (
            <p className="text-muted-foreground text-sm">Пока никого нет — отправьте ссылку.</p>
          ) : (
            participants.map((participant) => (
              <ParticipantStats key={participant.id} participant={participant} stats={stats[participant.id]} />
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ParticipantStats({ participant, stats }: { participant: Participant; stats?: PeerStats }) {
  const quality = rttQuality(stats?.rtt ?? null);
  return (
    <div className="bg-card/60 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-semibold">{participant.name}</span>
        {participant.live
          ? <Ping value={stats?.rtt ?? null} />
          : <Badge variant="outline" className="text-[10px]">подключается</Badge>}
      </div>

      <dl className="text-muted-foreground mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono text-[11px]">
        <Row label="Задержка" value={stats?.rtt != null ? `${stats.rtt} мс` : "—"} tone={quality} />
        <Row label="Потери" value={stats?.loss != null ? `${stats.loss}%` : "—"} tone={(stats?.loss ?? 0) > 3 ? "poor" : "good"} />
        <Row label="Входящий" value={stats?.kbps != null ? `${stats.kbps} кбит/с` : "—"} />
        <Row label="Джиттер" value={stats?.jitter != null ? `${stats.jitter} мс` : "—"} />
        <Row label="Видео" value={stats?.width && stats?.height ? `${stats.width}×${stats.height}${stats.fps ? ` · ${stats.fps}` : ""}` : "—"} />
        <Row label="Кодек" value={stats?.codec ?? "—"} />
      </dl>

      {stats?.route && (
        <div className="text-muted-foreground mt-2.5 flex items-center gap-1.5 text-[11px]">
          <Radio className="size-3" />
          {ROUTE_LABEL[stats.route]}
        </div>
      )}
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: ReturnType<typeof rttQuality> | "good" | "poor" }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="shrink-0">{label}</dt>
      <dd className={cn("truncate font-semibold", toneClass(tone))}>{value}</dd>
    </div>
  );
}

function Ping({ value, pending, scale = "rtt" }: { value?: number | null; pending?: boolean; scale?: "rtt" | "stun" }) {
  if (pending && value === undefined) {
    return <span className="text-muted-foreground ml-auto font-mono text-[10px]">…</span>;
  }
  if (value === undefined) return null;
  if (value === null) {
    return <Badge variant="outline" className="ml-auto text-[10px]">нет ответа</Badge>;
  }
  const tone = scale === "stun" ? stunQuality(value) : rttQuality(value);
  return (
    <span className={cn("ml-auto flex items-center gap-1 font-mono text-[11px] font-semibold", toneClass(tone))}>
      <Gauge className="size-3" />
      {value} мс
    </span>
  );
}

function toneClass(tone?: string) {
  if (tone === "good") return "text-emerald-400";
  if (tone === "fair") return "text-amber-400";
  if (tone === "poor") return "text-destructive";
  return "text-foreground";
}
