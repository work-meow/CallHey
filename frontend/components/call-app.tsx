"use client";

import { FormEvent, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowRight, Camera, Link2, Lock, Maximize, Mic, MicOff, MonitorUp, MonitorX,
  MessageSquare, PhoneOff, PictureInPicture2, Pin, PinOff, ShieldCheck, SignalHigh,
  SlidersHorizontal, Sparkles, TriangleAlert, Users, Video, VideoOff, Volume2, VolumeX,
} from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { AspectRatio } from "@/components/ui/aspect-ratio";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel,
  ContextMenuSeparator, ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CallChat } from "@/components/call-chat";
import { CallDevices } from "@/components/call-devices";
import { CallSettings } from "@/components/call-settings";
import { useDevices } from "@/hooks/use-devices";
import { PeerStats, rttQuality, usePeerStats } from "@/hooks/use-peer-stats";
import { useSpeaking } from "@/hooks/use-speaking";
import { StunProvider, getDefaultProvider, getProvider, iceServers, setProvider, subscribeProvider } from "@/lib/ice";
import { AudioMode, MicChain, createMicChain } from "@/lib/mic";
import { idleAudio } from "@/lib/audio";
import { SHARE_MODES, ShareMode, THUMBNAIL, VIDEO_PRESETS, VideoQuality, autoBitrate, tuneSender } from "@/lib/quality";
import { ChatMessage, PeerState, QualityLevel, WireMessage, parseWire } from "@/lib/wire";
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
  /** ICE не сошелся за отведенное время — почти всегда это NAT, который не пробить без TURN. */
  stalled?: boolean;
  /** Когда участник появился в комнате: по этому времени понимаем, что связь не встает. */
  since: number;
  state?: PeerState;
};

/** Сколько ждем ICE, прежде чем признать, что прямое соединение не собирается. */
const ICE_TIMEOUT_MS = 15_000;

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
  // Личные настройки: слышно и видно их только здесь, участникам ничего не уходит.
  const [micGain, setMicGain] = useState(1);
  const [audioMode, setAudioMode] = useState<AudioMode>("standard");
  const [micId, setMicId] = useState("");
  const [cameraId, setCameraId] = useState("");
  const [outputId, setOutputId] = useState("");
  const [volumes, setVolumes] = useState<Record<string, number>>({});
  const [pinned, setPinned] = useState<string | null>(null);
  const [videoQuality, setVideoQuality] = useState<VideoQuality>("auto");
  const [shareMode, setShareMode] = useState<ShareMode>("detail");
  // Настройки кодирования читаются из обработчиков соединения, созданных один
  // раз при входе в комнату, — через state там было бы видно только начальное значение.
  const quality = useRef<VideoQuality>("auto");
  const share = useRef<ShareMode>("detail");
  // Что собеседники попросили у нас и что мы попросили у них.
  const requested = useRef(new Map<string, QualityLevel>());
  const wanted = useRef(new Map<string, QualityLevel>());
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const mic = useRef<MicChain | null>(null);
  const cameraTrack = useRef<MediaStreamTrack | null>(null);
  // Все исходящие треки живут в одном MediaStream: его id уходит в msid, и по
  // нему собеседник собирает звук с картинкой в одну плитку.
  const outgoing = useRef<MediaStream | null>(null);
  // Демонстрацию закрепляем один раз: иначе снятый пин вернется на первом же мьюте.
  const autoPinned = useRef(new Set<string>());
  const screenTrack = useRef<MediaStreamTrack | null>(null);
  const connections = useRef(new Map<string, RTCPeerConnection>());
  const channels = useRef(new Map<string, RTCDataChannel>());
  // Имена и состояние панели читаются из обработчиков канала, поэтому живут в ref.
  const names = useRef(new Map<string, string>());
  const chatOpenRef = useRef(false);
  const startedAt = useRef(0);
  const cleanup = useRef<(resetUrl?: boolean) => void>(() => undefined);
  const canShare = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia;
  const hasTurn = !!turn?.urls;
  const stats = usePeerStats(connections, screen === "call");
  const devices = useDevices(screen === "call");
  // Свой уровень берем с выхода микрофонного тракта: он переживает смену
  // устройства и уже учитывает громкость, поэтому подсветка совпадает с тем,
  // что реально слышат остальные.
  const speaking = useSpeaking(
    [{ id: "self", stream: micStream }, ...peers.map((peer) => ({ id: peer.id, stream: peer.stream }))],
    screen === "call",
  );

  /** Уровень читаем через ref, чтобы полоска в настройках не пересоздавала эффект. */
  const micLevel = useCallback(() => mic.current?.level() ?? 0, []);

  /**
   * Раздает ограничения кодирования — каждому свои. Тот, кто показывает нас
   * миниатюрой, попросил экономный поток, и незачем кодировать ему полный кадр.
   */
  const tuneVideoSenders = useCallback(async () => {
    const mode = SHARE_MODES[share.current];
    const preset = VIDEO_PRESETS[quality.current];
    // В «Автоматически» потолок зависит от того, скольким мы сейчас отправляем.
    const bitrate = quality.current === "auto" ? autoBitrate(connections.current.size) : preset.bitrate;
    await Promise.all([...connections.current.entries()].map(async ([id, peer]) => {
      const sender = peer.getSenders().find((item) => item.track?.kind === "video");
      if (!sender) return;
      // Демонстрацию не ужимаем никогда: уменьшенный втрое экран нечитаем, а
      // смотрят в звонке обычно именно на нее. Проверяем на стороне отправителя,
      // потому что здесь про свою демонстрацию известно точно.
      const options = requested.current.get(id) === "low" && !screenTrack.current
        ? { ...THUMBNAIL, degradation: "balanced" as const }
        : screenTrack.current
          ? { bitrate: mode.bitrate, frameRate: mode.frameRate, degradation: mode.degradation }
          : { bitrate, degradation: "balanced" as const };
      await tuneSender(sender, options).catch(() => undefined);
    }));
  }, []);

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

  // Доля аплинка на каждого зависит от числа собеседников, поэтому при смене
  // состава потолки пересчитываем: иначе ушедший так и держит свою долю занятой.
  useEffect(() => {
    if (screen === "call") void tuneVideoSenders();
  }, [screen, peers.length, tuneVideoSenders]);

  // Просим у каждого ровно то качество, в котором показываем его сами: крупный
  // план — полное, лента внизу и мелкая сетка — экономное. Освободившийся канал
  // достается тому, на кого человек действительно смотрит.
  useEffect(() => {
    if (screen !== "call") return;
    peers.forEach((peer) => {
      // У того, кто показывает экран, экономию не просим ни при каких раскладах.
      const level: QualityLevel = peer.state?.sharing ? "high"
        : pinned ? pinned === peer.id ? "high" : "low"
        : peers.length + 1 <= 4 ? "high" : "low";
      if (wanted.current.get(peer.id) === level) return;
      const channel = channels.current.get(peer.id);
      // Канал мог еще не открыться — повторим на следующем обновлении состава.
      if (channel?.readyState !== "open") return;
      channel.send(JSON.stringify({ kind: "quality", level }));
      wanted.current.set(peer.id, level);
    });
  }, [screen, peers, pinned]);

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
  const stalled = peers.filter((peer) => peer.stalled && !peer.live);
  const status = peers.length === 0
    ? "Ждем участников"
    : stalled.length ? "Сеть не пропускает соединение"
    : live === peers.length ? "Все на связи" : `Соединяемся · ${live} из ${peers.length}`;

  // Помечаем зависших по времени появления, а не по таймеру внутри соединения:
  // участник может вообще не прислать offer, и тогда соединения просто нет.
  useEffect(() => {
    if (screen !== "call" || peers.every((peer) => peer.live || peer.stalled)) return;
    const timer = window.setInterval(() => {
      const deadline = Date.now() - ICE_TIMEOUT_MS;
      setPeers((current) => {
        let changed = false;
        const next = current.map((peer) => {
          if (peer.live || peer.stalled || peer.since > deadline) return peer;
          changed = true;
          return { ...peer, stalled: true };
        });
        return changed ? next : current;
      });
    }, 2000);
    return () => window.clearInterval(timer);
  }, [screen, peers]);

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

    // Микрофонный тракт поднимаем до входа в комнату: собеседникам с самого
    // первого оффера уходит именно его выход. Тогда смена микрофона позже
    // не потребует переговоров — трек в senders остается прежним.
    const chain = createMicChain(stream.getAudioTracks()[0]);
    outgoing.current = new MediaStream([chain.track]);
    mic.current = chain;
    chain.setGain(micGain);
    void chain.setMode(audioMode);
    cameraTrack.current = stream.getVideoTracks()[0] ?? null;
    // Для камеры важнее плавность: при узком канале кодек уронит разрешение, а не кадры.
    if (cameraTrack.current) cameraTrack.current.contentHint = "motion";
    setMicStream(chain.stream);
    setMicId(stream.getAudioTracks()[0].getSettings().deviceId ?? "");
    setCameraId(cameraTrack.current?.getSettings().deviceId ?? "");

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
      setPeers((body.peers ?? []).map((peer) => ({ id: peer.id, name: peer.name, stream: null, live: false, since: Date.now() })));
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
            // Показ экрана сам выходит на большой план — так же ведут себя переговорки.
            if (message.sharing && !autoPinned.current.has(peerId)) {
              autoPinned.current.add(peerId);
              setPinned(peerId);
            } else if (!message.sharing && autoPinned.current.delete(peerId)) {
              setPinned((current) => (current === peerId ? null : current));
            }
            return;
          }
          if (message.kind === "quality") {
            requested.current.set(peerId, message.level);
            void tuneVideoSenders();
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
        // Оба трека кладем в один MediaStream: иначе ontrack на той стороне
        // отдаст два разных потока и в плитке окажется либо звук, либо картинка.
        peer.addTrack(chain.track, outgoing.current!);
        const video = screenTrack.current ?? cameraTrack.current;
        if (video) peer.addTrack(video, outgoing.current!);
        else peer.addTransceiver("video", { direction: "recvonly" });

        peer.onicecandidate = ({ candidate }) => {
          if (candidate) void send({ type: "ice", to: peerId, candidate: candidate.toJSON() }).catch(reportProblem);
        };
        peer.ontrack = ({ streams, receiver }) => {
          // Слышимая задержка = сеть + буфер джиттера. Хром по умолчанию держит
          // в буфере запас в несколько десятков мс, и в статистике RTT он не виден.
          // Просим минимальный: это единственная часть задержки, на которую мы влияем.
          // ponytail: при 0 на рваной сети возможны щелчки, тогда поднять до 0.05.
          Object.assign(receiver, { playoutDelayHint: 0 });
          patchPeer(peerId, { stream: streams[0] });
        };
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
          const connected = peer.connectionState === "connected";
          patchPeer(peerId, { live: connected, ...(connected && { stalled: false }) });
          // Ограничения кодирования ставим только после переговоров: до них
          // у отправителя еще нет encodings, и настраивать нечего.
          if (connected) void tuneVideoSenders();
          if (peer.connectionState === "failed" && !closed) {
            patchPeer(peerId, { stalled: true });
            peer.restartIce();
          }
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
        autoPinned.current.delete(peerId);
        requested.current.delete(peerId);
        wanted.current.delete(peerId);
        setPinned((current) => (current === peerId ? null : current));
        // Личная громкость ушедшего больше ни к чему: id новые при каждом входе.
        setVolumes((current) => {
          if (!(peerId in current)) return current;
          const next = { ...current };
          delete next[peerId];
          return next;
        });
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
            : [...current, { id: from, name: peerName, stream: null, live: false, since: Date.now() }]);
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
        outgoing.current = null;
        mic.current?.close();
        mic.current = null;
        // Общий AudioContext не закрываем, но между звонками ему нечего делать.
        idleAudio();
        autoPinned.current.clear();
        requested.current.clear();
        wanted.current.clear();
        // Камеру могли переключить по ходу звонка — тогда живой трек уже не из stream.
        cameraTrack.current?.stop();
        cameraTrack.current = null;
        stream.getTracks().forEach((track) => track.stop());
        // sendBeacon переживает закрытие вкладки; fetch — запасной путь.
        const leave = `${api}/rooms/${roomId}/leave?token=${encodeURIComponent(token)}`;
        if (!navigator.sendBeacon?.(leave)) {
          void fetch(leave, { method: "POST", keepalive: true }).catch(() => undefined);
        }
        setLocalStream(null);
        setMicStream(null);
        cleanup.current = () => undefined;
        if (resetUrl) window.history.replaceState(null, "", window.location.pathname);
      };

      setScreen("call");
    } catch (reason) {
      mic.current?.close();
      mic.current = null;
      setMicStream(null);
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
    setPinned(null);
    setVolumes({});
  }

  // Микрофон глушим на входе тракта: тогда молчит и то, что уходит участникам,
  // и наша собственная подсветка «говорит».
  function toggleTrack(kind: "audio" | "video") {
    const track = kind === "audio" ? mic.current?.input() : localStream?.getVideoTracks()[0];
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
    const mode = SHARE_MODES[share.current];
    let display: MediaStream;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { max: mode.frameRate } }, audio: false });
    } catch {
      return; // пользователь отменил выбор окна
    }
    const track = display.getVideoTracks()[0];
    if (!track) return;
    // Подсказка кодеку, чем жертвовать при нехватке канала. С "text" он держит
    // разрешение, и надписи на экране остаются читаемыми, а не расплываются.
    track.contentHint = mode.contentHint;
    screenTrack.current = track;
    setPreview(new MediaStream([track]));
    track.addEventListener("ended", stopShare);
    connections.current.forEach((peer) => {
      const sender = peer.getSenders().find((item) => item.track?.kind === "video");
      if (sender) void sender.replaceTrack(track);
      else if (outgoing.current) peer.addTrack(track, outgoing.current);
    });
    setSharing(true);
    void tuneVideoSenders();
  }

  function stopShare() {
    const track = screenTrack.current;
    if (!track) return;
    screenTrack.current = null;
    setPreview(null);
    track.removeEventListener("ended", stopShare);
    track.stop();
    const camera = cameraTrack.current;
    connections.current.forEach((peer) => {
      const sender = peer.getSenders().find((item) => item.track === track || item.track?.kind === "video");
      if (sender) void sender.replaceTrack(camera);
    });
    setSharing(false);
    // Возвращаем камере ее собственные ограничения вместо экранных.
    void tuneVideoSenders();
  }

  function changeGain(value: number) {
    setMicGain(value);
    mic.current?.setGain(value);
  }

  function changeMode(next: AudioMode) {
    setAudioMode(next);
    void mic.current?.setMode(next).catch(() =>
      toast.error("Режим обработки не применился", { description: "Микрофон не поддерживает эти настройки.", id: "audio-mode" }));
  }

  async function changeMic(deviceId: string) {
    try {
      await mic.current?.useDevice(deviceId, audioMode);
      setMicId(deviceId);
    } catch {
      toast.error("Не удалось переключить микрофон", { description: "Устройство занято другой программой.", id: "mic" });
    }
  }

  // Камера меняется через replaceTrack — переговоров не требует, звонок не прерывается.
  async function changeCamera(deviceId: string) {
    // Новую камеру сразу берем в том разрешении, которое выбрано в настройках качества.
    const preset = VIDEO_PRESETS[quality.current];
    let next: MediaStream;
    try {
      next = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: deviceId },
          width: { ideal: preset.width ?? 1280 },
          height: { ideal: preset.height ?? 720 },
          frameRate: { ideal: 30, max: 30 },
        },
      });
    } catch {
      toast.error("Не удалось переключить камеру", { description: "Устройство занято другой программой.", id: "camera" });
      return;
    }
    const track = next.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !cameraOff;
    track.contentHint = "motion";
    const previous = cameraTrack.current;
    cameraTrack.current = track;
    setCameraId(deviceId);
    setHasCamera(true);
    setLocalStream(new MediaStream([track]));
    // Во время демонстрации исходящий трек не трогаем: новая камера вернется, когда показ закончится.
    if (!screenTrack.current) {
      connections.current.forEach((peer) => {
        const sender = peer.getSenders().find((item) => item.track?.kind === "video");
        if (sender) void sender.replaceTrack(track);
        else if (outgoing.current) peer.addTrack(track, outgoing.current);
      });
      void tuneVideoSenders();
    }
    previous?.stop();
  }

  function changeVolume(id: string, value: number) {
    setVolumes((current) => ({ ...current, [id]: value }));
  }

  async function changeQuality(next: VideoQuality) {
    setVideoQuality(next);
    quality.current = next;
    const preset = VIDEO_PRESETS[next];
    // Разрешение меняем на самом треке: ideal не уронит камеру, которая столько не умеет.
    if (cameraTrack.current && preset.width) {
      await cameraTrack.current
        .applyConstraints({ width: { ideal: preset.width }, height: { ideal: preset.height } })
        .catch(() => undefined);
    }
    await tuneVideoSenders();
  }

  async function changeShareMode(next: ShareMode) {
    setShareMode(next);
    share.current = next;
    const track = screenTrack.current;
    if (track) {
      track.contentHint = SHARE_MODES[next].contentHint;
      await track.applyConstraints({ frameRate: { max: SHARE_MODES[next].frameRate } }).catch(() => undefined);
    }
    await tuneVideoSenders();
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
    const renderTile = (tile: (typeof tiles)[number]) => (
      <VideoTile
        key={tile.id}
        {...tile}
        stats={stats[tile.id]}
        speaking={speaking[tile.id]}
        volume={volumes[tile.id] ?? 1}
        sinkId={outputId}
        pinned={pinned === tile.id}
        onPin={() => setPinned((current) => (current === tile.id ? null : tile.id))}
        onVolumeChange={(value) => changeVolume(tile.id, value)}
      />
    );
    // Закрепленный участник занимает всю сцену, остальные уезжают в ленту снизу.
    const spotlight = pinned ? tiles.find((tile) => tile.id === pinned) : undefined;
    const strip = spotlight ? tiles.filter((tile) => tile.id !== spotlight.id) : [];
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
            <CallDevices
              devices={devices}
              micId={micId}
              onMicChange={(id) => void changeMic(id)}
              cameraId={cameraId}
              onCameraChange={(id) => void changeCamera(id)}
              hasCamera={hasCamera}
              outputId={outputId}
              onOutputChange={setOutputId}
              gain={micGain}
              onGainChange={changeGain}
              mode={audioMode}
              onModeChange={changeMode}
              videoQuality={videoQuality}
              onVideoQualityChange={(value) => void changeQuality(value)}
              shareMode={shareMode}
              onShareModeChange={(value) => void changeShareMode(value)}
              level={micLevel}
              participants={peers}
              volumes={volumes}
              onVolumeChange={changeVolume}
              trigger={
                <Button variant="ghost" size="sm" aria-label="Звук и видео">
                  <SlidersHorizontal />
                  <span className="hidden sm:inline">Звук</span>
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
          {stalled.length > 0 && (
            <Alert variant="destructive" className="absolute inset-x-3 top-3 z-10 w-auto bg-black/85 backdrop-blur-sm">
              <TriangleAlert />
              <AlertDescription>
                Не удалось построить прямое соединение с {listNames(stalled)}. Обычно так себя ведет мобильный интернет
                или рабочая сеть — попробуйте другой Wi-Fi. {hasTurn ? "Резервный сервер тоже не помог." : "Для таких сетей нужен TURN-сервер."}
              </AlertDescription>
            </Alert>
          )}
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
          ) : spotlight ? (
            <div className="flex h-full flex-col gap-2.5 p-2.5 pb-24">
              <div className="min-h-0 flex-1">{renderTile(spotlight)}</div>
              {strip.length > 0 && (
                <div className="flex h-20 shrink-0 gap-2.5 overflow-x-auto sm:h-24">
                  {strip.map((tile) => (
                    <div key={tile.id} className="aspect-video h-full shrink-0">{renderTile(tile)}</div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className={cn("grid h-full auto-rows-[minmax(0,1fr)] gap-2.5 p-2.5 pb-24", gridColumns(tiles.length))}>
              {tiles.map(renderTile)}
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

function VideoTile({ name, stream, live, self = false, mirror = false, stats, speaking, state, volume = 1, sinkId, pinned, onPin, onVolumeChange }: {
  id: string;
  name: string;
  stream: MediaStream | null;
  live: boolean;
  self?: boolean;
  mirror?: boolean;
  stats?: PeerStats;
  speaking?: boolean;
  state?: PeerState;
  /** Личная громкость участника: ноль глушит его только у нас. */
  volume?: number;
  sinkId?: string;
  pinned?: boolean;
  onPin?: () => void;
  onVolumeChange?: (value: number) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const hasVideo = useLiveVideo(stream);

  useEffect(() => {
    if (video.current) video.current.srcObject = stream;
  }, [stream]);

  // Громкость и устройство вывода живут на самом элементе: ни то, ни другое
  // не уходит в сеть, поэтому собеседник о них не узнает.
  useEffect(() => {
    if (video.current) video.current.volume = volume;
  }, [volume, stream]);

  useEffect(() => {
    const element = video.current as (HTMLVideoElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (sinkId && element?.setSinkId) void element.setSinkId(sinkId).catch(() => undefined);
  }, [sinkId, stream]);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void frame.current?.requestFullscreen().catch(() => undefined);
  };
  const canPip = typeof document !== "undefined" && document.pictureInPictureEnabled;
  const openPip = () => void video.current?.requestPictureInPicture().catch(() => undefined);
  const canControlVolume = !self && !!onVolumeChange;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={frame}
          onDoubleClick={toggleFullscreen}
          className={cn(
            "bg-stage-elevated group relative grid size-full min-h-0 place-items-center overflow-hidden rounded-xl",
            "ring-primary ring-offset-stage transition-shadow duration-200",
            // Во весь экран картинку уже не обрезаем: там важна вся сцена целиком.
            "[&:fullscreen>video]:object-contain",
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
            {canControlVolume && volume === 0 && <VolumeX className="text-destructive size-3 shrink-0" />}
            <span className="truncate">{name}</span>
            {!live && !self && <span className="text-muted-foreground shrink-0">· подключается</span>}
          </Badge>

          {/* Управление плиткой держим скрытым до наведения: в сетке из восьми
              человек постоянные кнопки превращают сцену в панель приборов. */}
          <div className="absolute top-2 left-2 flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            {onPin && (
              <TileAction label={pinned ? "Открепить" : "Закрепить"} onClick={onPin}>
                {pinned ? <PinOff /> : <Pin />}
              </TileAction>
            )}
            {hasVideo && canPip && (
              <TileAction label="Отдельным окном" onClick={openPip}>
                <PictureInPicture2 />
              </TileAction>
            )}
            {hasVideo && (
              <TileAction label="На весь экран" onClick={toggleFullscreen}>
                <Maximize />
              </TileAction>
            )}
          </div>

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
      </ContextMenuTrigger>

      <ContextMenuContent>
        <ContextMenuLabel>
          <span className="truncate">{name}</span>
          {stats?.route && (
            <span className="text-muted-foreground ml-auto text-[11px] font-normal">
              {ROUTE_SHORT[stats.route]}
            </span>
          )}
        </ContextMenuLabel>

        {canControlVolume && (
          <>
            <ContextMenuSeparator />
            {/* Ползунок — не пункт меню: перехватываем указатель, иначе Radix
                примет перетаскивание за выбор и закроет меню на первом же движении. */}
            <div className="px-2 py-1.5" onPointerDown={(event) => event.stopPropagation()}>
              <div className="mb-2 flex items-baseline justify-between text-xs">
                <span className="text-muted-foreground">Громкость</span>
                <span className="font-mono font-semibold tabular-nums">{Math.round(volume * 100)}%</span>
              </div>
              <Slider
                value={[volume]}
                max={1}
                step={0.01}
                aria-label={`Громкость: ${name}`}
                onValueChange={([next]) => onVolumeChange!(next)}
              />
            </div>
            <ContextMenuItem
              // preventDefault оставляет меню открытым: громкость часто правят несколькими нажатиями.
              onSelect={(event) => { event.preventDefault(); onVolumeChange!(volume > 0 ? 0 : 1); }}
            >
              {volume > 0 ? <VolumeX /> : <Volume2 />}
              {volume > 0 ? "Заглушить для себя" : "Включить звук"}
            </ContextMenuItem>
          </>
        )}

        <ContextMenuSeparator />
        {onPin && (
          <ContextMenuItem onSelect={onPin}>
            {pinned ? <PinOff /> : <Pin />}
            {pinned ? "Открепить" : "Закрепить на всю сцену"}
          </ContextMenuItem>
        )}
        <ContextMenuItem disabled={!hasVideo} onSelect={toggleFullscreen}>
          <Maximize />На весь экран
        </ContextMenuItem>
        {canPip && (
          <ContextMenuItem disabled={!hasVideo} onSelect={openPip}>
            <PictureInPicture2 />В отдельном окне
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

const ROUTE_SHORT: Record<NonNullable<PeerStats["route"]>, string> = {
  local: "локальная сеть",
  direct: "напрямую",
  relay: "через релей",
};

function TileAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="secondary"
          size="icon-sm"
          aria-label={label}
          // Двойной клик по плитке уже разворачивает ее — с кнопки событие не пускаем дальше.
          onClick={(event) => { event.stopPropagation(); onClick(); }}
          onDoubleClick={(event) => event.stopPropagation()}
          className="bg-black/60 text-white backdrop-blur-sm hover:bg-black/80"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
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

function listNames(peers: Peer[]) {
  const names = peers.map((peer) => peer.name);
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} и ${names.at(-1)}`;
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
