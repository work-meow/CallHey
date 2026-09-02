"use client";

import * as React from "react";
import { FormEvent, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowRight, Camera, Check, Link2, Lock, Mic, MicOff, MonitorUp,
  PhoneOff, ShieldCheck, Sparkles, Video, VideoOff, Zap,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

// Совпадает с maxParticipants на бэкенде — выше mesh перестает тянуть.
const MAX_PARTICIPANTS = 8;

type Props = {
  initialRoom: string;
  signalUrl: string;
  turn?: RTCIceServer;
};

type ServerEvent = {
  type: "peer-joined" | "peer-left" | "offer" | "answer" | "ice";
  from?: string;
  name?: string;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};

type Peer = {
  id: string;
  name: string;
  stream: MediaStream | null;
  live: boolean;
};

export function CallApp({ initialRoom, signalUrl, turn }: Props) {
  const api = signalUrl.replace(/\/+$/, "");
  const [screen, setScreen] = useState<"lobby" | "joining" | "call">("lobby");
  const [name, setName] = useState("");
  const [inviteRoom, setInviteRoom] = useState(initialRoom);
  const [room, setRoom] = useState("");
  const [peers, setPeers] = useState<Peer[]>([]);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [hasCamera, setHasCamera] = useState(true);
  const [copied, setCopied] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [sharing, setSharing] = useState(false);
  const [preview, setPreview] = useState<MediaStream | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const screenTrack = useRef<MediaStreamTrack | null>(null);
  const connections = useRef(new Map<string, RTCPeerConnection>());
  const startedAt = useRef(0);
  const cleanup = useRef<(resetUrl?: boolean) => void>(() => undefined);
  const canShare = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia;

  const live = peers.filter((peer) => peer.live).length;
  const status = notice || (peers.length === 0
    ? "Ждем участников"
    : live === peers.length ? "Все на связи" : `Соединяемся · ${live} из ${peers.length}`);

  useEffect(() => {
    if (!live) return;
    if (!startedAt.current) startedAt.current = Date.now();
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - startedAt.current) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [live]);

  // Закрытие вкладки должно освобождать место в комнате, иначе призрак живет до TTL.
  useEffect(() => {
    const release = () => cleanup.current(false);
    window.addEventListener("pagehide", release);
    return () => {
      window.removeEventListener("pagehide", release);
      release();
    };
  }, []);

  async function startCall(event: FormEvent) {
    event.preventDefault();
    const cleanName = name.trim();
    if (!cleanName) {
      setError("Введите имя.");
      return;
    }

    const roomId = inviteRoom || createRoomId();
    setError("");
    setNotice("");
    setScreen("joining");

    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio,
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
      });
    } catch {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio });
      } catch {
        setScreen("lobby");
        setError("Разрешите доступ к микрофону, затем попробуйте снова.");
        return;
      }
    }
    const camera = stream.getVideoTracks().length > 0;
    setHasCamera(camera);
    setCameraOff(!camera);

    let token = "";
    try {
      const response = await fetch(`${api}/rooms/${roomId}/participants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: cleanName }),
      });
      const body = await response.json() as { token?: string; id?: string; peers?: Peer[]; error?: string };
      if (!response.ok || !body.token || !body.id) throw new Error(body.error || "Не удалось войти в звонок.");
      token = body.token;
      const selfId = body.id;

      setLocalStream(stream);
      setRoom(roomId);
      setPeers((body.peers ?? []).map((peer) => ({ id: peer.id, name: peer.name, stream: null, live: false })));
      window.history.replaceState(null, "", `?room=${roomId}`);

      const pending = new Map<string, RTCIceCandidateInit[]>();
      const offering = new Set<string>();
      let closed = false;

      const send = async (message: object) => {
        const response = await fetch(`${api}/rooms/${roomId}/signals?token=${encodeURIComponent(token)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(message),
        });
        // 409 — собеседник уже вышел, это не сбой соединения.
        if (!response.ok && response.status !== 409) throw new Error("Сигналинг недоступен.");
      };

      const patchPeer = (id: string, patch: Partial<Peer>) =>
        setPeers((current) => current.map((peer) => (peer.id === id ? { ...peer, ...patch } : peer)));

      const connect = (peerId: string) => {
        const existing = connections.current.get(peerId);
        if (existing) return existing;

        const iceServers: RTCIceServer[] = [
          { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
        ];
        if (turn?.urls) iceServers.push(turn);
        const peer = new RTCPeerConnection({ iceServers, bundlePolicy: "max-bundle" });
        connections.current.set(peerId, peer);

        // Отдаем то, что показываем прямо сейчас: камеру или демонстрацию экрана.
        stream.getAudioTracks().forEach((track) => peer.addTrack(track, stream));
        const video = screenTrack.current ?? stream.getVideoTracks()[0];
        if (video) peer.addTrack(video, stream);
        else peer.addTransceiver("video", { direction: "recvonly" });

        peer.onicecandidate = ({ candidate }) => {
          if (candidate) void send({ type: "ice", to: peerId, candidate: candidate.toJSON() }).catch(reportProblem);
        };
        peer.ontrack = ({ streams }) => patchPeer(peerId, { stream: streams[0] });
        peer.onnegotiationneeded = () => {
          void (async () => {
            offering.add(peerId);
            try {
              await peer.setLocalDescription();
              await send({ type: "offer", to: peerId, sdp: peer.localDescription! });
            } finally {
              offering.delete(peerId);
            }
          })().catch(reportProblem);
        };
        peer.onconnectionstatechange = () => {
          patchPeer(peerId, { live: peer.connectionState === "connected" });
          if (peer.connectionState === "failed" && !closed) peer.restartIce();
        };
        return peer;
      };

      const drop = (peerId: string) => {
        connections.current.get(peerId)?.close();
        connections.current.delete(peerId);
        pending.delete(peerId);
        setPeers((current) => current.filter((peer) => peer.id !== peerId));
      };

      // Сигналы обрабатываем строго по очереди: параллельный setRemoteDescription ломает состояние.
      let queue = Promise.resolve();
      const handle = async (message: ServerEvent) => {
        const from = message.from ?? "";
        if (!from) return;

        if (message.type === "peer-joined") {
          setPeers((current) => current.some((peer) => peer.id === from)
            ? current
            : [...current, { id: from, name: message.name || "Гость", stream: null, live: false }]);
          connect(from); // addTrack поднимет negotiationneeded, оффер уйдет сам
          return;
        }
        if (message.type === "peer-left") {
          drop(from);
          return;
        }

        const peer = connect(from);
        if (message.type === "ice" && message.candidate) {
          if (!peer.remoteDescription) {
            pending.set(from, [...(pending.get(from) ?? []), message.candidate]);
            return;
          }
          await peer.addIceCandidate(message.candidate);
          return;
        }
        if (!message.sdp) return;

        // Perfect negotiation: при встречных офферах уступает тот, чей id больше.
        const collision = message.type === "offer" && (offering.has(from) || peer.signalingState !== "stable");
        if (collision && selfId < from) return;
        if (collision) await peer.setLocalDescription({ type: "rollback" });

        await peer.setRemoteDescription(message.sdp);
        for (const candidate of pending.get(from) ?? []) await peer.addIceCandidate(candidate);
        pending.delete(from);
        if (message.type === "offer") {
          await peer.setLocalDescription();
          await send({ type: "answer", to: from, sdp: peer.localDescription! });
        }
      };

      const events = new EventSource(`${api}/rooms/${roomId}/events?token=${encodeURIComponent(token)}`);
      events.onmessage = ({ data }) => {
        queue = queue.then(() => handle(JSON.parse(data) as ServerEvent)).catch(reportProblem);
      };
      events.onopen = () => setNotice("");
      events.onerror = () => {
        if (events.readyState === EventSource.CLOSED) setNotice("Связь с сервером потеряна");
      };

      cleanup.current = (resetUrl = true) => {
        closed = true;
        events.close();
        connections.current.forEach((peer) => peer.close());
        connections.current.clear();
        screenTrack.current?.stop();
        screenTrack.current = null;
        stream.getTracks().forEach((track) => track.stop());
        // sendBeacon переживает закрытие вкладки; fetch — запасной путь.
        const leave = `${api}/rooms/${roomId}/leave?token=${encodeURIComponent(token)}`;
        if (!navigator.sendBeacon?.(leave)) {
          void fetch(leave, { method: "POST", keepalive: true }).catch(() => undefined);
        }
        setLocalStream(null);
        cleanup.current = () => undefined;
        if (resetUrl) window.history.replaceState(null, "", window.location.pathname);
      };

      setScreen("call");
    } catch (reason) {
      stream.getTracks().forEach((track) => track.stop());
      if (token) void fetch(`${api}/rooms/${roomId}/participants?token=${encodeURIComponent(token)}`, { method: "DELETE" });
      setScreen("lobby");
      setError(reason instanceof Error ? reason.message : "Не удалось войти в звонок.");
    }
  }

  function endCall() {
    cleanup.current();
    startedAt.current = 0;
    setScreen("lobby");
    setInviteRoom("");
    setRoom("");
    setPeers([]);
    setNotice("");
    setSeconds(0);
    setMuted(false);
    setCameraOff(false);
  }

  function toggleTrack(kind: "audio" | "video") {
    const track = localStream?.getTracks().find((item) => item.kind === kind);
    if (!track) return;
    track.enabled = !track.enabled;
    if (kind === "audio") setMuted(!track.enabled);
    else setCameraOff(!track.enabled);
  }

  // Демонстрация экрана подменяет исходящий видеотрек через replaceTrack —
  // это не требует переговоров и не рвет соединение.
  async function toggleShare() {
    if (screenTrack.current) {
      stopShare();
      return;
    }
    let display: MediaStream;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { max: 30 } }, audio: false });
    } catch {
      return; // пользователь отменил выбор окна
    }
    const track = display.getVideoTracks()[0];
    if (!track) return;
    screenTrack.current = track;
    setPreview(new MediaStream([track]));
    track.addEventListener("ended", stopShare);
    connections.current.forEach((peer) => {
      const sender = peer.getSenders().find((item) => item.track?.kind === "video");
      if (sender) void sender.replaceTrack(track);
      else if (localStream) peer.addTrack(track, localStream);
    });
    setSharing(true);
  }

  function stopShare() {
    const track = screenTrack.current;
    if (!track) return;
    screenTrack.current = null;
    setPreview(null);
    track.removeEventListener("ended", stopShare);
    track.stop();
    const camera = localStream?.getVideoTracks()[0] ?? null;
    connections.current.forEach((peer) => {
      const sender = peer.getSenders().find((item) => item.track === track || item.track?.kind === "video");
      if (sender) void sender.replaceTrack(camera);
    });
    setSharing(false);
  }

  async function copyInvite() {
    const link = `${window.location.origin}${window.location.pathname}?room=${room}`;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setNotice("Не удалось скопировать ссылку");
    }
  }

  function reportProblem() {
    setNotice("Проблема с соединением");
  }

  if (screen === "call") {
    const tiles = [
      { id: "self", name: sharing ? `${name} · ваш экран` : `${name} · вы`, stream: preview ?? localStream, live: true, self: true, mirror: !sharing },
      ...peers.map((peer) => ({ ...peer, self: false, mirror: false })),
    ];
    return (
      <main className="dark bg-background text-foreground grid h-svh grid-rows-[auto_minmax(0,1fr)_auto] px-4 pb-5 sm:px-6 lg:px-10">
        <header className="flex h-[76px] items-center justify-between gap-4">
          <Logo />
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            <span className={cn("size-1.5 rounded-full", live ? "bg-success shadow-[0_0_0_4px] shadow-success/15" : "bg-amber-400 shadow-[0_0_0_4px] shadow-amber-400/15")} />
            <span className="hidden sm:inline">{status}</span>
            {live > 0 && <time className="text-foreground border-border ml-1 border-l pl-3 font-mono text-[11px]">{formatTime(seconds)}</time>}
          </div>
          <Button variant="secondary" size="sm" onClick={copyInvite} className="gap-2">
            {copied ? <Check className="text-success" /> : <Link2 />}
            <span className="hidden sm:inline">{copied ? "Ссылка скопирована" : "Пригласить"}</span>
          </Button>
        </header>

        <section className="border-border bg-stage relative min-h-0 overflow-hidden rounded-xl border shadow-2xl" aria-label="Видеозвонок">
          {peers.length === 0 ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center px-6 pb-24 text-center" role="status">
              <div className="relative mb-6 grid size-32 place-items-center rounded-full border border-primary/40">
                <span className="absolute -inset-4 animate-[breathe_2.4s_ease-in-out_infinite] rounded-full border border-primary/15" />
                <span className="absolute -inset-8 animate-[breathe_2.4s_ease-in-out_-0.8s_infinite] rounded-full border border-primary/10" />
                <span className="bg-primary text-primary-foreground grid size-22 place-items-center rounded-full text-2xl font-bold">{initials(name)}</span>
              </div>
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Комната готова</h1>
              <p className="text-muted-foreground mt-2 mb-6 text-sm">Отправьте ссылку — участники подключатся сюда</p>
              <Button variant="secondary" onClick={copyInvite} className="gap-2">
                <Link2 />{copied ? "Скопировано" : "Скопировать ссылку"}
              </Button>
            </div>
          ) : (
            <div className={cn("grid h-full auto-rows-[minmax(0,1fr)] gap-2.5 p-2.5 pb-24", gridColumns(tiles.length))}>
              {tiles.map((tile) => <VideoTile key={tile.id} {...tile} />)}
            </div>
          )}

          {peers.length === 0 && (
            <div className="absolute top-4 right-4 w-36 sm:w-48 lg:w-60">
              <VideoTile id="self" name={name} stream={preview ?? localStream} live self mirror={!sharing} compact />
            </div>
          )}

          <nav
            className="absolute bottom-4 left-1/2 flex w-[calc(100%-1.25rem)] max-w-fit -translate-x-1/2 gap-2 rounded-2xl border border-white/10 bg-black/70 p-2 backdrop-blur-md"
            aria-label="Управление звонком"
          >
            <ControlButton active={!muted} onClick={() => toggleTrack("audio")} label={muted ? "Включить" : "Микрофон"} title={muted ? "Включить микрофон" : "Выключить микрофон"}>
              {muted ? <MicOff /> : <Mic />}
            </ControlButton>
            <ControlButton active={!cameraOff} disabled={!hasCamera} onClick={() => toggleTrack("video")} label={hasCamera ? (cameraOff ? "Включить" : "Камера") : "Нет камеры"} title={cameraOff ? "Включить камеру" : "Выключить камеру"}>
              {cameraOff ? <VideoOff /> : <Video />}
            </ControlButton>
            {canShare && (
              <ControlButton active={!sharing} onClick={toggleShare} label={sharing ? "Остановить" : "Экран"} title={sharing ? "Остановить демонстрацию" : "Показать экран"}>
                <MonitorUp />
              </ControlButton>
            )}
            <Button variant="destructive" size="xl" onClick={endCall} className="min-w-14 flex-col gap-1 px-3 text-[11px] sm:min-w-24" aria-label="Выйти из звонка">
              <PhoneOff className="size-5" />
              <span className="hidden sm:inline">Выйти</span>
            </Button>
          </nav>
        </section>

        <div className="text-muted-foreground mono-label pt-3 text-center text-[9px]">
          Комната · {room.slice(0, 8)} · участников {tiles.length}
        </div>
      </main>
    );
  }

  return (
    <main className="relative grid min-h-svh grid-rows-[auto_1fr_auto] overflow-hidden px-6 sm:px-10 lg:px-20">
      <div aria-hidden className="border-primary/15 pointer-events-none absolute top-[5vh] -right-[16vw] aspect-square w-[min(54vw,780px)] rounded-full border shadow-[0_0_0_8vw_var(--color-primary)]/3" />

      <header className="relative z-10 flex h-22 items-center justify-between">
        <Logo dark />
        <span className="text-muted-foreground flex items-center gap-2 text-[13px] font-semibold">
          <ShieldCheck className="text-primary size-4" />
          <span className="hidden sm:inline">Прямое соединение</span>
        </span>
      </header>

      <section className="relative z-10 mx-auto grid w-full max-w-[1180px] items-center gap-12 py-12 lg:grid-cols-[1.12fr_0.72fr] lg:gap-24">
        <div>
          <div className="text-primary mono-label mb-6 flex items-center gap-2.5">
            <span className="bg-primary h-0.5 w-7" /> Звонок для своих
          </div>
          <h1 className="text-[clamp(3.25rem,7vw,6.5rem)] leading-[0.88] font-bold tracking-[-0.075em]">
            Слышать.<br />Видеть.<br /><span className="text-primary">Быть рядом.</span>
          </h1>
          <p className="text-muted-foreground my-8 max-w-lg text-lg leading-relaxed">
            Одна ссылка — и вы на связи. До {MAX_PARTICIPANTS} человек, без регистрации, установки и лишних экранов.
          </p>
          <div className="text-muted-foreground flex flex-wrap gap-6 text-[13px] font-semibold">
            <span className="flex items-center gap-2"><Sparkles className="text-primary size-4" /> HD-видео</span>
            <span className="flex items-center gap-2"><Zap className="text-primary size-4" /> WebRTC</span>
            <span className="flex items-center gap-2"><MonitorUp className="text-primary size-4" /> Экран</span>
            <span className="flex items-center gap-2"><Lock className="text-primary size-4" /> Приватно</span>
          </div>
        </div>

        <Card className="w-full max-w-lg justify-self-center p-2 shadow-xl lg:justify-self-end">
          <form onSubmit={startCall} noValidate>
            <CardHeader className="gap-2">
              <div className="text-primary mono-label">{inviteRoom ? "Вас пригласили" : "Новый разговор"}</div>
              <CardTitle className="text-3xl tracking-tight">{inviteRoom ? "Войти в звонок" : "Создать звонок"}</CardTitle>
              <CardDescription>
                {inviteRoom ? "Представьтесь участникам и подключайтесь." : "Назовите себя. Ссылку для друзей покажем сразу."}
              </CardDescription>
            </CardHeader>

            <CardContent className="mt-6 space-y-2">
              <Label htmlFor="name">Ваше имя</Label>
              <Input
                id="name"
                name="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={32}
                autoComplete="name"
                placeholder="Например, Саша"
                aria-invalid={!!error}
                aria-describedby={error ? "join-error" : undefined}
                autoFocus
              />
              {error && <p id="join-error" role="alert" className="text-destructive text-xs leading-snug">{error}</p>}

              <Button type="submit" size="xl" disabled={screen === "joining"} className="mt-4 w-full justify-between">
                {screen === "joining" ? "Подключаем…" : inviteRoom ? "Войти в звонок" : "Создать и войти"}
                <ArrowRight />
              </Button>

              {inviteRoom && (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => { setInviteRoom(""); setError(""); window.history.replaceState(null, "", window.location.pathname); }}
                >
                  Создать свою комнату
                </Button>
              )}

              <p className="text-muted-foreground mt-4 flex items-start gap-2 text-[11px] leading-snug">
                <Camera className="mt-px size-3.5 shrink-0" /> Браузер попросит доступ к камере и микрофону
              </p>
            </CardContent>
          </form>
        </Card>
      </section>

      <footer className="border-border text-muted-foreground mono-label flex min-h-16 items-center justify-between border-t text-[10px]">
        <span>CallHey / Звонки</span>
        <span className="hidden sm:inline">Разговор остается между вами</span>
      </footer>
    </main>
  );
}

function ControlButton({ active, label, title, children, ...props }: React.ComponentProps<typeof Button> & { active: boolean; label: string }) {
  return (
    <Button
      type="button"
      variant={active ? "secondary" : "default"}
      size="xl"
      title={title}
      aria-pressed={!active}
      className={cn("min-w-14 flex-col gap-1 px-3 text-[11px] sm:min-w-24", !active && "bg-white text-neutral-900 hover:bg-white/90")}
      {...props}
    >
      <span className="[&_svg]:size-5">{children}</span>
      <span className="hidden sm:inline">{label}</span>
    </Button>
  );
}

function gridColumns(count: number) {
  if (count <= 1) return "grid-cols-1";
  if (count <= 4) return "grid-cols-1 sm:grid-cols-2";
  if (count <= 6) return "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3";
  return "grid-cols-2 lg:grid-cols-4";
}

function VideoTile({ name, stream, live, self = false, mirror = false, compact = false }: {
  id: string;
  name: string;
  stream: MediaStream | null;
  live: boolean;
  self?: boolean;
  mirror?: boolean;
  compact?: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const hasVideo = useLiveVideo(stream);

  useEffect(() => {
    if (video.current) video.current.srcObject = stream;
  }, [stream]);

  return (
    <div
      className={cn(
        "bg-stage-elevated relative grid min-h-0 place-items-center overflow-hidden rounded-xl",
        compact && "aspect-video border border-white/15 shadow-lg",
      )}
    >
      <video
        ref={video}
        autoPlay
        playsInline
        muted={self}
        className={cn("size-full object-cover", mirror && "-scale-x-100", !hasVideo && "hidden")}
      />
      {!hasVideo && (
        <span className="grid size-[clamp(2.75rem,6vw,4.5rem)] place-items-center rounded-full bg-white/10 text-[clamp(0.9rem,1.6vw,1.5rem)] font-bold">
          {initials(name)}
        </span>
      )}
      <small className="absolute bottom-2 left-2 max-w-[calc(100%-1rem)] truncate rounded-md bg-black/60 px-2 py-1 text-[11px] text-white">
        {name}{!live && !self ? " · подключается" : ""}
      </small>
    </div>
  );
}

// Видео есть, только если трек живой и не заглушен отправителем — иначе показываем инициалы.
function useLiveVideo(stream: MediaStream | null) {
  const subscribe = useCallback((onChange: () => void) => {
    if (!stream) return () => undefined;
    const tracks = stream.getVideoTracks();
    const bind = (method: "addEventListener" | "removeEventListener") => {
      tracks.forEach((track) => {
        track[method]("mute", onChange);
        track[method]("unmute", onChange);
        track[method]("ended", onChange);
      });
      stream[method]("addtrack", onChange);
      stream[method]("removetrack", onChange);
    };
    bind("addEventListener");
    return () => bind("removeEventListener");
  }, [stream]);

  return useSyncExternalStore(
    subscribe,
    () => !!stream?.getVideoTracks().some((track) => track.enabled && track.readyState === "live" && !track.muted),
    () => false,
  );
}

function Logo({ dark = false }: { dark?: boolean }) {
  return (
    <div className="flex items-baseline gap-1 text-xl font-extrabold tracking-[-0.055em]">
      <span className={cn("mr-1 grid size-7 place-items-center rounded-full text-sm tracking-normal", dark ? "bg-primary text-primary-foreground" : "bg-white text-neutral-900")}>
        C
      </span>
      allHey
      <small className={cn("font-mono text-[10px] font-medium", dark ? "text-primary" : "text-primary")}>звонки</small>
    </div>
  );
}

function createRoomId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function initials(value: string) {
  return value.trim().slice(0, 2).toUpperCase();
}

function formatTime(total: number) {
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
