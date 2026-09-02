"use client";

import { FormEvent, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowRight, Camera, Link2, Lock, Mic, MicOff, MonitorUp, MonitorX,
  MessageSquare, PhoneOff, ShieldCheck, SignalHigh, Sparkles, Users, Video, VideoOff,
} from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { AspectRatio } from "@/components/ui/aspect-ratio";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CallChat } from "@/components/call-chat";
import { CallSettings } from "@/components/call-settings";
import { PeerStats, rttQuality, usePeerStats } from "@/hooks/use-peer-stats";
import { useSpeaking } from "@/hooks/use-speaking";
import { StunProvider, getDefaultProvider, getProvider, iceServers, setProvider, subscribeProvider } from "@/lib/ice";
import { ChatMessage, PeerState, WireMessage, parseWire } from "@/lib/wire";
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
  state?: PeerState;
};

export function CallApp({ initialRoom, signalUrl, turn }: Props) {
  const api = signalUrl.replace(/\/+$/, "");
  const [screen, setScreen] = useState<"lobby" | "joining" | "call">("lobby");
  const [name, setName] = useState("");
  const [inviteRoom, setInviteRoom] = useState(initialRoom);
  const [room, setRoom] = useState("");
  const [peers, setPeers] = useState<Peer[]>([]);
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [hasCamera, setHasCamera] = useState(true);
  const [seconds, setSeconds] = useState(0);
  const [sharing, setSharing] = useState(false);
  const [preview, setPreview] = useState<MediaStream | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const provider = useSyncExternalStore(subscribeProvider, getProvider, getDefaultProvider);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatOpen, setChatOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const screenTrack = useRef<MediaStreamTrack | null>(null);
  const connections = useRef(new Map<string, RTCPeerConnection>());
  const channels = useRef(new Map<string, RTCDataChannel>());
  // Имена и состояние панели читаются из обработчиков канала, поэтому живут в ref.
  const names = useRef(new Map<string, string>());
  const chatOpenRef = useRef(false);
  const startedAt = useRef(0);
  const cleanup = useRef<(resetUrl?: boolean) => void>(() => undefined);
  const canShare = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia;
  const stats = usePeerStats(connections, screen === "call");
  const speaking = useSpeaking(
    [{ id: "self", stream: localStream }, ...peers.map((peer) => ({ id: peer.id, stream: peer.stream }))],
    screen === "call",
  );

  /** Рассылает сообщение всем участникам по их каналам данных. */
  const broadcast = useCallback((message: WireMessage) => {
    const payload = JSON.stringify(message);
    channels.current.forEach((channel) => {
      if (channel.readyState === "open") channel.send(payload);
    });
  }, []);

  // Собеседники должны видеть, что микрофон выключен, даже когда человек молчит.
  // Ref нужен, чтобы канал, открывшийся позже, отправил актуальное состояние.
  const selfState = useRef<PeerState>({ muted: false, cameraOff: false, sharing: false });
  useEffect(() => {
    selfState.current = { muted, cameraOff, sharing };
    if (screen !== "call") return;
    broadcast({ kind: "state", muted, cameraOff, sharing });
  }, [screen, muted, cameraOff, sharing, broadcast]);

  function sendChat(text: string) {
    const at = Date.now();
    broadcast({ kind: "chat", text, at });
    setMessages((current) => [...current, { id: `${at}-self`, author: name, text, at, own: true }]);
  }

  function changeProvider(next: StunProvider) {
    setProvider(next);
    // Перенастраиваем живые соединения и пересобираем маршрут — звонок не рвется.
    connections.current.forEach((peer) => {
      peer.setConfiguration({ iceServers: iceServers(next, turn), bundlePolicy: "max-bundle" });
      peer.restartIce();
    });
    toast.success(`STUN: ${next.label}`, { description: "Маршрут пересобирается", id: "stun" });
  }

  const live = peers.filter((peer) => peer.live).length;
  const status = peers.length === 0
    ? "Ждем участников"
    : live === peers.length ? "Все на связи" : `Соединяемся · ${live} из ${peers.length}`;

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
      names.current.clear();
      (body.peers ?? []).forEach((peer) => names.current.set(peer.id, peer.name));
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

        const peer = new RTCPeerConnection({
          iceServers: iceServers(getProvider(), turn),
          bundlePolicy: "max-bundle",
        });
        connections.current.set(peerId, peer);

        // negotiated-канал с общим id: обе стороны открывают его сами, лишних
        // переговоров нет. Создаем до addTrack, чтобы попасть в первый же offer.
        const channel = peer.createDataChannel("mesh", { negotiated: true, id: 0 });
        channels.current.set(peerId, channel);
        channel.onopen = () => channel.send(JSON.stringify({ kind: "state", ...selfState.current }));
        channel.onmessage = ({ data }) => {
          const message = parseWire(data);
          if (!message) return;
          if (message.kind === "state") {
            patchPeer(peerId, { state: message });
            return;
          }
          const author = names.current.get(peerId) ?? "Гость";
          setMessages((history) => [
            ...history,
            { id: `${message.at}-${peerId}-${history.length}`, author, text: message.text, at: message.at, own: false },
          ]);
          setUnread((count) => (chatOpenRef.current ? 0 : count + 1));
        };

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
        channels.current.get(peerId)?.close();
        channels.current.delete(peerId);
        connections.current.get(peerId)?.close();
        connections.current.delete(peerId);
        names.current.delete(peerId);
        pending.delete(peerId);
        setPeers((current) => current.filter((peer) => peer.id !== peerId));
      };

      // Сигналы обрабатываем строго по очереди: параллельный setRemoteDescription ломает состояние.
      let queue = Promise.resolve();
      const handle = async (message: ServerEvent) => {
        const from = message.from ?? "";
        if (!from) return;

        if (message.type === "peer-joined") {
          const peerName = message.name || "Гость";
          names.current.set(from, peerName);
          setPeers((current) => current.some((peer) => peer.id === from)
            ? current
            : [...current, { id: from, name: peerName, stream: null, live: false }]);
          toast(`${peerName} присоединился`, { id: `join-${from}` });
          connect(from); // addTrack поднимет negotiationneeded, оффер уйдет сам
          return;
        }
        if (message.type === "peer-left") {
          const peerName = names.current.get(from);
          if (peerName) toast(`${peerName} вышел`, { id: `left-${from}` });
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
      events.onerror = () => {
        if (events.readyState === EventSource.CLOSED) {
          toast.error("Связь с сервером потеряна", { description: "Обновите страницу, чтобы вернуться в звонок.", id: "signal" });
        }
      };

      cleanup.current = (resetUrl = true) => {
        closed = true;
        events.close();
        channels.current.forEach((channel) => channel.close());
        channels.current.clear();
        names.current.clear();
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

  function toggleChat(open: boolean) {
    setChatOpen(open);
    chatOpenRef.current = open;
    if (open) setUnread(0);
  }

  // Горячие клавиши как в переговорках: работают, пока фокус не в поле ввода.
  useEffect(() => {
    if (screen !== "call") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable]")) return;
      const key = event.key.toLowerCase();
      // Раскладку не переключают ради горячей клавиши, поэтому ловим и кириллицу.
      if (key === "m" || key === "ь") toggleTrack("audio");
      else if (key === "v" || key === "м") toggleTrack("video");
      else if (key === "s" || key === "ы") void toggleShare();
      else if (key === "c" || key === "с") toggleChat(!chatOpenRef.current);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function endCall() {
    cleanup.current();
    startedAt.current = 0;
    setScreen("lobby");
    setInviteRoom("");
    setRoom("");
    setPeers([]);
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
      toast.success("Ссылка скопирована", { description: "Отправьте ее участникам звонка.", id: "invite" });
    } catch {
      toast.error("Не удалось скопировать ссылку", { description: link, id: "invite" });
    }
  }

  function reportProblem() {
    toast.error("Проблема с соединением", { description: "Пробуем восстановить связь.", id: "peer" });
  }

  if (screen === "call") {
    const tiles = [
      {
        id: "self",
        name: sharing ? `${name} · ваш экран` : `${name} · вы`,
        stream: preview ?? localStream,
        live: true,
        self: true,
        mirror: !sharing,
        state: { muted, cameraOff, sharing },
      },
      ...peers.map((peer) => ({ ...peer, self: false, mirror: false })),
    ];
    return (
      <main className="grid h-svh grid-rows-[auto_minmax(0,1fr)_auto] px-4 pb-5 sm:px-6 lg:px-10">
        <header className="flex h-[76px] items-center justify-between gap-4">
          <Logo />

          <div className="flex items-center gap-2">
            <Badge variant={live ? "default" : "secondary"} className="gap-1.5">
              <span className={cn("size-1.5 rounded-full", live ? "bg-primary-foreground" : "bg-amber-400")} />
              <span className="hidden sm:inline">{status}</span>
              <span className="sm:hidden">{live + 1}</span>
            </Badge>
            {live > 0 && (
              <>
                <Separator orientation="vertical" className="hidden h-4 sm:block" />
                <time className="text-muted-foreground hidden font-mono text-xs sm:block">{formatTime(seconds)}</time>
              </>
            )}
          </div>

          <div className="flex items-center gap-2">
            <CallChat
              messages={messages}
              onSend={sendChat}
              open={chatOpen}
              onOpenChange={toggleChat}
              trigger={
                <Button variant="ghost" size="sm" className="relative" aria-label="Чат звонка">
                  <MessageSquare />
                  <span className="hidden sm:inline">Чат</span>
                  {unread > 0 && (
                    <Badge className="absolute -top-1 -right-1 size-4 justify-center rounded-full p-0 text-[10px] tabular-nums">
                      {unread > 9 ? "9+" : unread}
                    </Badge>
                  )}
                </Button>
              }
            />
            <CallSettings
              provider={provider}
              onProviderChange={changeProvider}
              participants={peers}
              stats={stats}
              trigger={
                <Button variant="ghost" size="sm" aria-label="Соединение и качество связи">
                  <SignalHigh />
                  <span className="hidden sm:inline">Соединение</span>
                </Button>
              }
            />
            <Button variant="secondary" size="sm" onClick={copyInvite}>
              <Link2 />
              <span className="hidden sm:inline">Пригласить</span>
            </Button>
          </div>
        </header>

        <section className="border-border bg-stage relative min-h-0 overflow-hidden rounded-xl border shadow-2xl" aria-label="Видеозвонок">
          {peers.length === 0 ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center px-6 pb-24 text-center" role="status">
              <div className="relative mb-6">
                <span className="border-primary/15 absolute -inset-5 animate-[breathe_2.4s_ease-in-out_infinite] rounded-full border" />
                <span className="border-primary/10 absolute -inset-10 animate-[breathe_2.4s_ease-in-out_-0.8s_infinite] rounded-full border" />
                <Avatar className="border-primary/40 size-28 border">
                  <AvatarFallback className="bg-primary text-primary-foreground text-2xl font-bold">
                    {initials(name)}
                  </AvatarFallback>
                </Avatar>
              </div>
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Комната готова</h1>
              <p className="text-muted-foreground mt-2 mb-6 text-sm">Отправьте ссылку — участники подключатся сюда</p>
              <Button variant="secondary" onClick={copyInvite}>
                <Link2 />Скопировать ссылку
              </Button>
            </div>
          ) : (
            <div className={cn("grid h-full auto-rows-[minmax(0,1fr)] gap-2.5 p-2.5 pb-24", gridColumns(tiles.length))}>
              {tiles.map((tile) => (
                <VideoTile key={tile.id} {...tile} stats={stats[tile.id]} speaking={speaking[tile.id]} />
              ))}
            </div>
          )}

          {peers.length === 0 && (
            <div className="absolute top-4 right-4 w-36 overflow-hidden rounded-xl border border-white/15 shadow-lg sm:w-48 lg:w-60">
              <AspectRatio ratio={16 / 9}>
                <VideoTile id="self" name={name} stream={preview ?? localStream} live self mirror={!sharing} />
              </AspectRatio>
            </div>
          )}

          <nav
            className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-2xl border border-white/10 bg-black/70 p-1.5 backdrop-blur-md"
            aria-label="Управление звонком"
          >
            <ControlToggle
              pressed={muted}
              onPressedChange={() => toggleTrack("audio")}
              label={muted ? "Включить микрофон" : "Выключить микрофон"}
              hotkey="M"
            >
              {muted ? <MicOff /> : <Mic />}
            </ControlToggle>

            <ControlToggle
              pressed={cameraOff}
              disabled={!hasCamera}
              onPressedChange={() => toggleTrack("video")}
              label={!hasCamera ? "Камера не найдена" : cameraOff ? "Включить камеру" : "Выключить камеру"}
              hotkey="V"
            >
              {cameraOff ? <VideoOff /> : <Video />}
            </ControlToggle>

            {canShare && (
              <ControlToggle
                pressed={sharing}
                tone="accent"
                onPressedChange={toggleShare}
                label={sharing ? "Остановить демонстрацию" : "Показать экран"}
                hotkey="S"
              >
                {sharing ? <MonitorX /> : <MonitorUp />}
              </ControlToggle>
            )}

            <Separator orientation="vertical" className="mx-1 h-6 bg-white/15" />

            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="destructive" size="icon-lg" onClick={endCall} aria-label="Выйти из звонка">
                  <PhoneOff />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Выйти из звонка</TooltipContent>
            </Tooltip>
          </nav>
        </section>

        <div className="text-muted-foreground flex items-center justify-center gap-2 pt-3 text-xs">
          <Badge variant="outline" className="font-mono">{room.slice(0, 8)}</Badge>
          <Separator orientation="vertical" className="h-3" />
          <span className="inline-flex items-center gap-1.5">
            <Users className="size-3.5" />{tiles.length} из {MAX_PARTICIPANTS}
          </span>
        </div>
      </main>
    );
  }

  return (
    <main className="relative grid min-h-svh grid-rows-[auto_1fr_auto] overflow-hidden px-6 sm:px-10 lg:px-20">
      {/* Мягкое свечение вместо рамок — на темном фоне оно задает глубину. */}
      <div
        aria-hidden
        className="bg-primary/12 pointer-events-none absolute -top-[24vh] -right-[14vw] size-[min(70vw,900px)] rounded-full blur-[140px]"
      />
      <div
        aria-hidden
        className="border-border/60 pointer-events-none absolute top-[8vh] -right-[16vw] aspect-square w-[min(52vw,760px)] rounded-full border"
      />

      <header className="relative z-10 flex h-22 items-center justify-between">
        <Logo />
        <Badge variant="outline" className="gap-1.5 py-1">
          <ShieldCheck className="text-primary" />
          <span className="hidden sm:inline">Прямое соединение</span>
        </Badge>
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
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-7 gap-y-3 text-sm font-medium">
            {[
              { icon: Sparkles, label: "HD-видео" },
              { icon: MonitorUp, label: "Демонстрация экрана" },
              { icon: Users, label: `До ${MAX_PARTICIPANTS} человек` },
              { icon: Lock, label: "Приватно" },
            ].map(({ icon: Feature, label }) => (
              <span key={label} className="flex items-center gap-2">
                <Feature className="text-primary size-4" />
                {label}
              </span>
            ))}
          </div>
        </div>

        <Card className="bg-card/70 w-full max-w-lg justify-self-center rounded-2xl p-3 shadow-[0_32px_80px_-32px_rgb(0_0_0/0.7)] backdrop-blur-xl lg:justify-self-end">
          <form onSubmit={startCall} noValidate>
            <CardHeader className="gap-2">
              <Badge variant="outline" className="text-primary border-primary/25 bg-primary/5 mb-2 py-1">
                {inviteRoom ? "Вас пригласили" : "Новый разговор"}
              </Badge>
              <CardTitle className="text-3xl tracking-tight">{inviteRoom ? "Войти в звонок" : "Создать звонок"}</CardTitle>
              <CardDescription>
                {inviteRoom ? "Представьтесь участникам и подключайтесь." : "Назовите себя. Ссылку для друзей покажем сразу."}
              </CardDescription>
            </CardHeader>

            <CardContent className="mt-6 space-y-3">
              <div className="space-y-2">
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
                  className="h-12"
                  autoFocus
                />
              </div>

              {error && (
                <Alert variant="destructive" id="join-error">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <Button type="submit" size="lg" disabled={screen === "joining"} className="h-12 w-full justify-between text-base">
                {screen === "joining" ? "Подключаем…" : inviteRoom ? "Войти в звонок" : "Создать и войти"}
                <ArrowRight />
              </Button>

              {inviteRoom && (
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  className="w-full"
                  onClick={() => { setInviteRoom(""); setError(""); window.history.replaceState(null, "", window.location.pathname); }}
                >
                  Создать свою комнату
                </Button>
              )}

              <Separator className="my-4" />

              <p className="text-muted-foreground flex items-start gap-2 text-xs leading-snug">
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

// Нажатое состояние читается цветом: красный — что-то выключено, синий — идет демонстрация.
function ControlToggle({ label, hotkey, tone = "danger", children, ...props }: React.ComponentProps<typeof Toggle> & {
  label: string;
  hotkey?: string;
  tone?: "danger" | "accent";
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Toggle
          size="lg"
          aria-label={label}
          // TooltipTrigger asChild перезаписывает data-state своим, поэтому опираемся на aria-pressed.
          className={cn(
            "size-10 text-white/90 hover:bg-white/10 hover:text-white",
            tone === "danger"
              ? "aria-pressed:bg-destructive aria-pressed:text-white aria-pressed:hover:bg-destructive/90"
              : "aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary/90",
          )}
          {...props}
        >
          {children}
        </Toggle>
      </TooltipTrigger>
      <TooltipContent className="flex items-center gap-2">
        {label}
        {hotkey && (
          <kbd className="bg-background/20 rounded px-1 font-mono text-[10px] tracking-wide uppercase">{hotkey}</kbd>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

function gridColumns(count: number) {
  if (count <= 1) return "grid-cols-1";
  if (count <= 4) return "grid-cols-1 sm:grid-cols-2";
  if (count <= 6) return "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3";
  return "grid-cols-2 lg:grid-cols-4";
}

function VideoTile({ name, stream, live, self = false, mirror = false, stats, speaking, state }: {
  id: string;
  name: string;
  stream: MediaStream | null;
  live: boolean;
  self?: boolean;
  mirror?: boolean;
  stats?: PeerStats;
  speaking?: boolean;
  state?: PeerState;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const hasVideo = useLiveVideo(stream);

  useEffect(() => {
    if (video.current) video.current.srcObject = stream;
  }, [stream]);

  return (
    <div
      className={cn(
        "bg-stage-elevated relative grid size-full min-h-0 place-items-center overflow-hidden rounded-xl",
        "ring-primary ring-offset-stage transition-shadow duration-200",
        speaking && !state?.muted && "ring-2 ring-offset-2",
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
        <Avatar className="size-[clamp(2.75rem,6vw,4.5rem)]">
          <AvatarFallback className="bg-white/10 text-[clamp(0.9rem,1.6vw,1.5rem)] font-bold text-white">
            {initials(name)}
          </AvatarFallback>
        </Avatar>
      )}
      <Badge
        variant="secondary"
        className="absolute bottom-2 left-2 max-w-[calc(100%-1rem)] gap-1.5 bg-black/60 text-white backdrop-blur-sm"
      >
        {state?.muted && <MicOff className="text-destructive size-3 shrink-0" />}
        {state?.sharing && <MonitorUp className="text-primary size-3 shrink-0" />}
        <span className="truncate">{name}</span>
        {!live && !self && <span className="text-muted-foreground shrink-0">· подключается</span>}
      </Badge>

      {!self && live && stats?.rtt != null && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="secondary"
              className="absolute top-2 right-2 gap-1 bg-black/60 font-mono text-[10px] backdrop-blur-sm"
            >
              <span className={cn("size-1.5 rounded-full", SIGNAL_COLOR[rttQuality(stats.rtt)])} />
              {stats.rtt} мс
            </Badge>
          </TooltipTrigger>
          <TooltipContent side="left" className="font-mono text-xs">
            <div>задержка {stats.rtt} мс</div>
            {stats.loss != null && <div>потери {stats.loss}%</div>}
            {stats.kbps != null && <div>{stats.kbps} кбит/с</div>}
            {stats.width && <div>{stats.width}×{stats.height}{stats.fps ? ` · ${stats.fps} fps` : ""}</div>}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

const SIGNAL_COLOR: Record<ReturnType<typeof rttQuality>, string> = {
  good: "bg-emerald-400",
  fair: "bg-amber-400",
  poor: "bg-destructive",
  unknown: "bg-muted-foreground",
};

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

function Logo() {
  return (
    <div className="flex items-baseline gap-1 text-xl font-extrabold tracking-[-0.055em]">
      <Avatar className="mr-1 size-7 self-center">
        <AvatarFallback className="bg-primary text-primary-foreground text-sm font-bold">C</AvatarFallback>
      </Avatar>
      allHey
      <small className="text-primary font-mono text-[10px] font-medium">звонки</small>
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
