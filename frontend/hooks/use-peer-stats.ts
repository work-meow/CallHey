"use client";

import { RefObject, useEffect, useState } from "react";

export type PeerStats = {
  /** Круговая задержка до участника, мс. */
  rtt: number | null;
  /** Доля потерянных пакетов за последний интервал, %. */
  loss: number | null;
  /** Входящий поток от участника, кбит/с. */
  kbps: number | null;
  jitter: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  /** Как идет медиа: напрямую по локальной сети, через NAT или через TURN-релей. */
  route: "local" | "direct" | "relay" | null;
  codec: string | null;
};

type Sample = { bytes: number; lost: number; received: number; at: number };

const EMPTY: PeerStats = {
  rtt: null, loss: null, kbps: null, jitter: null,
  width: null, height: null, fps: null, route: null, codec: null,
};

/**
 * Раз в секунду снимает getStats() с каждого соединения. Битрейт и потери
 * считаются по дельте между снимками — счетчики в WebRTC накопительные.
 */
export function usePeerStats(connections: RefObject<Map<string, RTCPeerConnection>>, active: boolean) {
  const [stats, setStats] = useState<Record<string, PeerStats>>({});

  useEffect(() => {
    if (!active) return;
    const previous = new Map<string, Sample>();
    let stopped = false;

    const collect = async () => {
      const entries = await Promise.all(
        [...connections.current.entries()].map(async ([id, peer]) => {
          try {
            return [id, await readStats(peer, previous, id)] as const;
          } catch {
            return [id, EMPTY] as const;
          }
        }),
      );
      if (!stopped) setStats(Object.fromEntries(entries));
    };

    void collect();
    const timer = window.setInterval(() => void collect(), 1000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [connections, active]);

  // Вне звонка отдаем пустой снимок, не трогая state: сброс в эффекте вызвал бы лишний рендер.
  return active ? stats : NO_STATS;
}

const NO_STATS: Record<string, PeerStats> = {};

async function readStats(peer: RTCPeerConnection, previous: Map<string, Sample>, id: string): Promise<PeerStats> {
  const report = await peer.getStats();
  const result: PeerStats = { ...EMPTY };

  let pair: RTCIceCandidatePairStats | undefined;
  let video: RTCInboundRtpStreamStats | undefined;
  let audio: RTCInboundRtpStreamStats | undefined;
  const codecs = new Map<string, string>();

  report.forEach((entry) => {
    if (entry.type === "codec") {
      codecs.set(entry.id, String(entry.mimeType ?? "").split("/")[1] ?? "");
    } else if (entry.type === "candidate-pair" && entry.state === "succeeded") {
      // Браузеры помечают рабочую пару по-разному: берем номинированную, иначе любую succeeded.
      if (!pair || entry.nominated) pair = entry as RTCIceCandidatePairStats;
    } else if (entry.type === "inbound-rtp") {
      if (entry.kind === "video") video = entry as RTCInboundRtpStreamStats;
      if (entry.kind === "audio") audio = entry as RTCInboundRtpStreamStats;
    }
  });

  if (pair) {
    if (typeof pair.currentRoundTripTime === "number") result.rtt = Math.round(pair.currentRoundTripTime * 1000);
    const remote = pair.remoteCandidateId ? report.get(pair.remoteCandidateId) : undefined;
    const local = pair.localCandidateId ? report.get(pair.localCandidateId) : undefined;
    const kinds = [remote?.candidateType, local?.candidateType];
    result.route = kinds.includes("relay") ? "relay" : kinds.includes("host") && !kinds.includes("srflx") ? "local" : "direct";
  }

  const media = video ?? audio;
  if (media) {
    if (media.codecId) result.codec = codecs.get(media.codecId) ?? null;
    if (typeof media.jitter === "number") result.jitter = Math.round(media.jitter * 1000);
    result.width = video?.frameWidth ?? null;
    result.height = video?.frameHeight ?? null;
    result.fps = video?.framesPerSecond ? Math.round(video.framesPerSecond) : null;

    const bytes = Number(media.bytesReceived ?? 0);
    const lost = Number(media.packetsLost ?? 0);
    const received = Number(media.packetsReceived ?? 0);
    const now = performance.now();
    const last = previous.get(id);
    if (last) {
      const seconds = (now - last.at) / 1000;
      if (seconds > 0.2) result.kbps = Math.max(0, Math.round(((bytes - last.bytes) * 8) / seconds / 1000));
      const deltaLost = Math.max(0, lost - last.lost);
      const deltaTotal = deltaLost + Math.max(0, received - last.received);
      if (deltaTotal > 0) result.loss = Math.round((deltaLost / deltaTotal) * 1000) / 10;
    }
    previous.set(id, { bytes, lost, received, at: now });
  }

  return result;
}

/** Порог качества по задержке: до 100 мс — отлично, до 250 — терпимо. */
export function rttQuality(rtt: number | null) {
  if (rtt === null) return "unknown" as const;
  if (rtt <= 100) return "good" as const;
  if (rtt <= 250) return "fair" as const;
  return "poor" as const;
}
