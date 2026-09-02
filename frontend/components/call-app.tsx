"use client";

import { FormEvent, ReactNode, useEffect, useRef, useState } from "react";

type Props = {
  initialRoom: string;
  signalUrl: string;
  turn?: RTCIceServer;
};

type ServerEvent = {
  type: "peer-joined" | "peer-left" | "offer" | "answer" | "ice";
  name?: string;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};

export function CallApp({ initialRoom, signalUrl, turn }: Props) {
  const api = signalUrl.replace(/\/+$/, "");
  const [screen, setScreen] = useState<"lobby" | "joining" | "call">("lobby");
  const [name, setName] = useState("");
  const [inviteRoom, setInviteRoom] = useState(initialRoom);
  const [room, setRoom] = useState("");
  const [peerName, setPeerName] = useState("");
  const [status, setStatus] = useState("Ждем собеседника");
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [remoteActive, setRemoteActive] = useState(false);
  const [connected, setConnected] = useState(false);
  const [copied, setCopied] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const localVideo = useRef<HTMLVideoElement>(null);
  const remoteVideo = useRef<HTMLVideoElement>(null);
  const localStream = useRef<MediaStream | null>(null);
  const remoteStream = useRef<MediaStream | null>(null);
  const cleanup = useRef<(resetUrl?: boolean) => void>(() => undefined);

  useEffect(() => {
    if (localVideo.current) localVideo.current.srcObject = localStream.current;
    if (remoteVideo.current) remoteVideo.current.srcObject = remoteStream.current;
  }, [screen, remoteActive]);

  useEffect(() => {
    if (!connected) return;
    const started = Date.now();
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [connected]);

  useEffect(() => () => cleanup.current(false), []);

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
    setRoom(roomId);
    if (!inviteRoom) window.history.replaceState(null, "", `?room=${roomId}`);

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
        if (!inviteRoom) window.history.replaceState(null, "", window.location.pathname);
        return;
      }
    }
    const hasVideo = stream.getVideoTracks().length > 0;
    setCameraOff(!hasVideo);

    try {
      const join = await fetch(`${api}/rooms/${roomId}/participants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: cleanName }),
      });
      const body = await join.json() as { token?: string; peer?: string; error?: string };
      if (!join.ok || !body.token) throw new Error(body.error || "Не удалось войти в звонок.");

      const token = body.token;
      let pendingCandidates: RTCIceCandidateInit[] = [];
      localStream.current = stream;
      setPeerName(body.peer ?? "");
      setStatus(body.peer ? "Соединяемся…" : "Ждем собеседника");

      const sendSignal = async (message: object) => {
        const response = await fetch(`${api}/rooms/${roomId}/signals?token=${encodeURIComponent(token)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(message),
        });
        if (!response.ok && response.status !== 409) throw new Error("Сигналинг недоступен.");
      };

      const makePeer = () => {
        const iceServers: RTCIceServer[] = [
          { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
        ];
        if (turn?.urls) iceServers.push(turn);
        const peer = new RTCPeerConnection({ iceServers });
        stream.getTracks().forEach((track) => peer.addTrack(track, stream));
        if (!hasVideo) peer.addTransceiver("video", { direction: "recvonly" });
        peer.onicecandidate = ({ candidate }) => {
          if (candidate) void sendSignal({ type: "ice", candidate: candidate.toJSON() }).catch(showConnectionError);
        };
        peer.ontrack = ({ streams }) => {
          remoteStream.current = streams[0];
          setRemoteActive(true);
          if (remoteVideo.current) remoteVideo.current.srcObject = streams[0];
        };
        peer.onconnectionstatechange = () => {
          if (peer.connectionState === "connected") {
            setSeconds(0);
            setConnected(true);
            setStatus("На связи");
          } else if (peer.connectionState === "failed") {
            setConnected(false);
            setStatus("Не удалось соединиться");
          } else if (peer.connectionState === "disconnected") {
            setConnected(false);
            setStatus("Восстанавливаем связь…");
          }
        };
        return peer;
      };

      let peer = makePeer();
      const eventSource = new EventSource(`${api}/rooms/${roomId}/events?token=${encodeURIComponent(token)}`);
      eventSource.onmessage = ({ data }) => {
        void (async () => {
          const message = JSON.parse(data) as ServerEvent;
          if (message.type === "peer-joined") {
            setPeerName(message.name ?? "Собеседник");
            setStatus("Соединяемся…");
            const offer = await peer.createOffer();
            await peer.setLocalDescription(offer);
            await sendSignal({ type: "offer", sdp: offer });
          } else if (message.type === "offer" && message.sdp) {
            await peer.setRemoteDescription(message.sdp);
            await flushCandidates(peer, pendingCandidates);
            pendingCandidates = [];
            const answer = await peer.createAnswer();
            await peer.setLocalDescription(answer);
            await sendSignal({ type: "answer", sdp: answer });
          } else if (message.type === "answer" && message.sdp) {
            await peer.setRemoteDescription(message.sdp);
            await flushCandidates(peer, pendingCandidates);
            pendingCandidates = [];
          } else if (message.type === "ice" && message.candidate) {
            if (peer.remoteDescription) await peer.addIceCandidate(message.candidate);
            else pendingCandidates.push(message.candidate);
          } else if (message.type === "peer-left") {
            peer.close();
            pendingCandidates = [];
            peer = makePeer();
            remoteStream.current = null;
            setRemoteActive(false);
            setConnected(false);
            setPeerName("");
            setStatus("Собеседник вышел. Ждем снова");
          }
        })().catch(showConnectionError);
      };
      eventSource.onerror = () => {
        if (peer.connectionState !== "connected") setStatus("Восстанавливаем сигналинг…");
      };

      cleanup.current = (resetUrl = true) => {
        eventSource.close();
        peer.close();
        stream.getTracks().forEach((track) => track.stop());
        void fetch(`${api}/rooms/${roomId}/participants?token=${encodeURIComponent(token)}`, {
          method: "DELETE",
          keepalive: true,
        });
        localStream.current = null;
        remoteStream.current = null;
        if (resetUrl) window.history.replaceState(null, "", window.location.pathname);
      };

      setScreen("call");
    } catch (reason) {
      stream.getTracks().forEach((track) => track.stop());
      setScreen("lobby");
      setError(reason instanceof Error ? reason.message : "Не удалось войти в звонок.");
      if (!inviteRoom) window.history.replaceState(null, "", window.location.pathname);
    }
  }

  function endCall() {
    cleanup.current();
    setScreen("lobby");
    setInviteRoom("");
    setRoom("");
    setPeerName("");
    setConnected(false);
    setRemoteActive(false);
    setMuted(false);
    setCameraOff(false);
    cleanup.current = () => undefined;
  }

  function toggleTrack(kind: "audio" | "video") {
    const track = localStream.current?.getTracks().find((item) => item.kind === kind);
    if (!track) return;
    track.enabled = !track.enabled;
    if (kind === "audio") setMuted(!track.enabled);
    else setCameraOff(!track.enabled);
  }

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setStatus("Не удалось скопировать ссылку");
    }
  }

  function showConnectionError() {
    setStatus("Проблема с соединением");
  }

  if (screen === "call") {
    return (
      <main className="call-shell">
        <header className="call-header">
          <Logo inverse />
          <div className="call-meta">
            <span className={`status-dot ${connected ? "is-live" : ""}`} />
            <span>{status}</span>
            {connected && <time>{formatTime(seconds)}</time>}
          </div>
          <button className="invite-button" type="button" onClick={copyInvite}>
            <Icon name={copied ? "check" : "link"} />
            {copied ? "Ссылка скопирована" : "Пригласить"}
          </button>
        </header>

        <section className="call-stage" aria-label="Видеозвонок">
          <video ref={remoteVideo} className={`remote-video ${remoteActive ? "is-visible" : ""}`} autoPlay playsInline />
          {!remoteActive && (
            <div className="waiting-state" role="status">
              <div className="signal-orbit"><span>{initials(peerName || "S")}</span></div>
              <h1>{peerName ? `Подключаем ${peerName}` : "Здесь появится собеседник"}</h1>
              <p>{peerName ? "Настраиваем прямое соединение" : "Отправьте ссылку — комната уже готова"}</p>
              {!peerName && <button type="button" onClick={copyInvite}><Icon name="link" />{copied ? "Скопировано" : "Скопировать ссылку"}</button>}
            </div>
          )}

          <div className={`local-tile ${cameraOff ? "camera-off" : ""}`}>
            <video ref={localVideo} autoPlay playsInline muted />
            {cameraOff && <span>{initials(name)}</span>}
            <small>Вы</small>
          </div>

          <nav className="call-controls" aria-label="Управление звонком">
            <button className={muted ? "is-off" : ""} type="button" onClick={() => toggleTrack("audio")} aria-label={muted ? "Включить микрофон" : "Выключить микрофон"}>
              <Icon name={muted ? "mic-off" : "mic"} /><span>{muted ? "Включить" : "Микрофон"}</span>
            </button>
            <button className={cameraOff ? "is-off" : ""} type="button" onClick={() => toggleTrack("video")} aria-label={cameraOff ? "Включить камеру" : "Выключить камеру"}>
              <Icon name={cameraOff ? "video-off" : "video"} /><span>{cameraOff ? "Включить" : "Камера"}</span>
            </button>
            <button className="hangup" type="button" onClick={endCall} aria-label="Завершить звонок">
              <Icon name="phone" /><span>Завершить</span>
            </button>
          </nav>
        </section>
        <div className="room-code">Комната · {room.slice(0, 8)}</div>
      </main>
    );
  }

  return (
    <main className="lobby-shell">
      <header className="lobby-header">
        <Logo />
        <span className="private-note"><Icon name="shield" />Прямое соединение</span>
      </header>

      <section className="lobby-grid">
        <div className="intro">
          <div className="eyebrow"><span /> Звонок для двоих</div>
          <h1>Слышать.<br />Видеть.<br /><em>Быть рядом.</em></h1>
          <p>Одна ссылка — и вы на связи. Без регистрации, установки и лишних экранов.</p>
          <div className="trust-row">
            <span><Icon name="spark" /> HD-видео</span>
            <span><Icon name="bolt" /> WebRTC</span>
            <span><Icon name="lock" /> Приватно</span>
          </div>
        </div>

        <form className="join-card" onSubmit={startCall}>
          <div className="card-number">{inviteRoom ? "Вас пригласили" : "Новый разговор"}</div>
          <h2>{inviteRoom ? "Войти в звонок" : "Создать звонок"}</h2>
          <p>{inviteRoom ? "Представьтесь собеседнику и подключайтесь." : "Назовите себя. Ссылку для друга покажем сразу."}</p>
          <label htmlFor="name">Ваше имя</label>
          <input id="name" name="name" value={name} onChange={(event) => setName(event.target.value)} maxLength={32} autoComplete="name" placeholder="Например, Саша" autoFocus />
          {error && <div className="form-error" role="alert">{error}</div>}
          <button className="primary-action" type="submit" disabled={screen === "joining"}>
            {screen === "joining" ? "Подключаем…" : inviteRoom ? "Войти в звонок" : "Создать и войти"}
            <Icon name="arrow" />
          </button>
          <small><Icon name="camera" /> Браузер попросит доступ к камере и микрофону</small>
        </form>
      </section>

      <footer><span>CALLHEY / ЗВОНКИ</span><span>Разговор остается между вами</span></footer>
    </main>
  );
}

function Logo({ inverse = false }: { inverse?: boolean }) {
  return <div className={`logo ${inverse ? "inverse" : ""}`}><span>C</span>allHey<small>звонки</small></div>;
}

function Icon({ name }: { name: "arrow" | "bolt" | "camera" | "check" | "link" | "lock" | "mic" | "mic-off" | "phone" | "shield" | "spark" | "video" | "video-off" }) {
  const paths: Record<typeof name, ReactNode> = {
    arrow: <><path d="M5 12h14M14 7l5 5-5 5" /></>,
    bolt: <path d="m13 2-8 12h7l-1 8 8-12h-7l1-8Z" />,
    camera: <><path d="M14.5 6 13 4H7L5.5 6H3v12h18V6h-6.5Z" /><circle cx="12" cy="12" r="3.5" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    link: <><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.1 1.1" /><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.1-1.1" /></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
    mic: <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>,
    "mic-off": <><path d="m3 3 18 18M9 9v2a3 3 0 0 0 4.5 2.6M15 9V6a3 3 0 0 0-5.6-1.5M5 11a7 7 0 0 0 11.7 5.2M19 11a7 7 0 0 1-.5 2.6M12 18v3" /></>,
    phone: <path d="M5.6 15.2c4.3-3.1 8.5-3.1 12.8 0l-1.8 3.1-3.1-1.1h-3l-3.1 1.1-1.8-3.1Z" />,
    shield: <><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" /><path d="m9 12 2 2 4-5" /></>,
    spark: <><path d="m12 2 1.2 4.8L18 8l-4.8 1.2L12 14l-1.2-4.8L6 8l4.8-1.2L12 2Z" /><path d="m19 15 .7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7L19 15Z" /></>,
    video: <><rect x="3" y="6" width="13" height="12" rx="2" /><path d="m16 10 5-3v10l-5-3" /></>,
    "video-off": <><path d="m3 3 18 18M10 6h4a2 2 0 0 1 2 2v6M16 10l5-3v10l-3-1.8M13 18H5a2 2 0 0 1-2-2V8c0-.6.2-1 .5-1.4" /></>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function createRoomId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function flushCandidates(peer: RTCPeerConnection, candidates: RTCIceCandidateInit[]) {
  for (const candidate of candidates) await peer.addIceCandidate(candidate);
}

function initials(value: string) {
  return value.trim().slice(0, 2).toUpperCase();
}

function formatTime(total: number) {
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
