"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, Headphones, Mic, SlidersHorizontal, Volume2, VolumeX, Waves } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Slider } from "@/components/ui/slider";
import { supportsOutputChoice } from "@/hooks/use-devices";
import { AUDIO_MODES, AudioMode, supportsVoiceIsolation } from "@/lib/mic";

type Participant = { id: string; name: string };

type Props = {
  devices: MediaDeviceInfo[];
  micId: string;
  onMicChange: (id: string) => void;
  cameraId: string;
  onCameraChange: (id: string) => void;
  hasCamera: boolean;
  outputId: string;
  onOutputChange: (id: string) => void;
  gain: number;
  onGainChange: (value: number) => void;
  mode: AudioMode;
  onModeChange: (mode: AudioMode) => void;
  level: () => number;
  participants: Participant[];
  volumes: Record<string, number>;
  onVolumeChange: (id: string, value: number) => void;
  trigger: React.ReactNode;
};

export function CallDevices({
  devices, micId, onMicChange, cameraId, onCameraChange, hasCamera,
  outputId, onOutputChange, gain, onGainChange, mode, onModeChange, level,
  participants, volumes, onVolumeChange, trigger,
}: Props) {
  const [open, setOpen] = useState(false);
  const canChooseOutput = supportsOutputChoice();
  const hint = AUDIO_MODES.find((item) => item.id === mode)?.hint ?? "";

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Звук и видео</SheetTitle>
          <SheetDescription>
            Настройки действуют только у вас: остальные участники ничего из этого не услышат и не увидят.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-3 px-4">
          <Label htmlFor="mic" className="text-xs font-semibold tracking-wide uppercase">
            <Mic className="size-3.5" /> Микрофон
          </Label>
          <DeviceSelect
            id="mic"
            kind="audioinput"
            devices={devices}
            value={micId}
            onChange={onMicChange}
            fallback="Микрофон"
            empty="Микрофон не найден"
          />

          {/* Полоска уровня отвечает на единственный вопрос, который тут возникает:
              «меня вообще слышно?» — без нее ползунок громкости настраивают вслепую. */}
          {open && <LevelMeter level={level} />}

          <SliderRow
            label="Громкость микрофона"
            value={gain}
            max={2}
            onChange={onGainChange}
            hint={gain > 1.4 ? "Выше 140% звук начинает хрипеть" : undefined}
          />
        </div>

        <Separator className="my-5" />

        <div className="space-y-3 px-4">
          <Label htmlFor="mode" className="text-xs font-semibold tracking-wide uppercase">
            <Waves className="size-3.5" /> Обработка звука
          </Label>
          <Select value={mode} onValueChange={(value) => onModeChange(value as AudioMode)}>
            <SelectTrigger id="mode" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AUDIO_MODES.map((item) => (
                <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs leading-snug">{hint}</p>
          {mode === "voice" && !supportsVoiceIsolation() && (
            <p className="text-amber-400 text-xs leading-snug">
              Этот браузер не умеет изоляцию голоса — включена стандартная обработка.
            </p>
          )}
        </div>

        <Separator className="my-5" />

        <div className="space-y-3 px-4">
          <Label htmlFor="camera" className="text-xs font-semibold tracking-wide uppercase">
            <Camera className="size-3.5" /> Камера
          </Label>
          <DeviceSelect
            id="camera"
            kind="videoinput"
            devices={devices}
            value={cameraId}
            onChange={onCameraChange}
            disabled={!hasCamera}
            fallback="Камера"
            empty="Камера не найдена"
          />
        </div>

        {canChooseOutput && (
          <>
            <Separator className="my-5" />
            <div className="space-y-3 px-4">
              <Label htmlFor="output" className="text-xs font-semibold tracking-wide uppercase">
                <Headphones className="size-3.5" /> Вывод звука
              </Label>
              <DeviceSelect
                id="output"
                kind="audiooutput"
                devices={devices}
                value={outputId}
                onChange={onOutputChange}
                fallback="Динамики"
                empty="Устройств вывода нет"
              />
            </div>
          </>
        )}

        <Separator className="my-5" />

        <div className="space-y-4 px-4 pb-6">
          <Label className="text-xs font-semibold tracking-wide uppercase">
            <SlidersHorizontal className="size-3.5" /> Громкость участников
          </Label>

          {participants.length === 0 ? (
            <p className="text-muted-foreground text-sm">Пока никого нет — отправьте ссылку.</p>
          ) : (
            participants.map((participant) => {
              const volume = volumes[participant.id] ?? 1;
              return (
                <div key={participant.id} className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={volume > 0 ? `Заглушить ${participant.name}` : `Включить ${participant.name}`}
                      onClick={() => onVolumeChange(participant.id, volume > 0 ? 0 : 1)}
                    >
                      {volume > 0 ? <Volume2 /> : <VolumeX className="text-destructive" />}
                    </Button>
                    <span className="truncate text-sm font-semibold">{participant.name}</span>
                    <span className="text-muted-foreground ml-auto font-mono text-[11px] tabular-nums">
                      {Math.round(volume * 100)}%
                    </span>
                  </div>
                  <Slider
                    value={[volume]}
                    max={1}
                    step={0.01}
                    aria-label={`Громкость: ${participant.name}`}
                    onValueChange={([next]) => onVolumeChange(participant.id, next)}
                  />
                </div>
              );
            })
          )}
          <p className="text-muted-foreground text-xs leading-snug">
            Заглушенного участника слышите только вы — он об этом не узнает.
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function DeviceSelect({ id, kind, devices, value, onChange, fallback, empty, disabled }: {
  id: string;
  kind: MediaDeviceKind;
  devices: MediaDeviceInfo[];
  value: string;
  onChange: (id: string) => void;
  fallback: string;
  empty: string;
  disabled?: boolean;
}) {
  // Пустой deviceId Radix не примет как значение, да и выбрать такое устройство нельзя.
  const list = devices.filter((device) => device.kind === kind && device.deviceId);
  if (!list.length) return <p className="text-muted-foreground text-sm">{empty}</p>;

  return (
    <Select value={list.some((device) => device.deviceId === value) ? value : list[0].deviceId} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {list.map((device, index) => (
          <SelectItem key={device.deviceId} value={device.deviceId}>
            {device.label || `${fallback} ${index + 1}`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function SliderRow({ label, value, max, onChange, hint }: {
  label: string;
  value: number;
  max: number;
  onChange: (value: number) => void;
  hint?: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <span className="text-muted-foreground text-xs">{label}</span>
        <span className="font-mono text-[11px] font-semibold tabular-nums">{Math.round(value * 100)}%</span>
      </div>
      <Slider value={[value]} max={max} step={0.05} aria-label={label} onValueChange={([next]) => onChange(next)} />
      {hint && <p className="text-amber-400 text-xs leading-snug">{hint}</p>}
    </div>
  );
}

/**
 * Уровень обновляется каждый кадр, поэтому двигаем ширину напрямую в DOM:
 * через состояние это был бы ре-рендер панели 60 раз в секунду.
 */
function LevelMeter({ level }: { level: () => number }) {
  const bar = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      if (bar.current) bar.current.style.transform = `scaleX(${level()})`;
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [level]);

  return (
    <div className="bg-muted h-1.5 overflow-hidden rounded-full" aria-hidden>
      <div ref={bar} className="bg-primary h-full origin-left scale-x-0" />
    </div>
  );
}
