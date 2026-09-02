"use client";

import { useEffect, useState } from "react";

import { audioContext } from "@/lib/audio";

type Source = { id: string; stream: MediaStream | null };

const SPEAKING_THRESHOLD = 0.045;
/** Держим подсветку чуть дольше самого звука, иначе она мигает между словами. */
const RELEASE_MS = 600;

/**
 * Определяет, кто сейчас говорит: считает громкость каждого потока через один
 * общий AudioContext. Анализ идет в аудио-графе, поэтому не грузит рендер.
 */
export function useSpeaking(sources: Source[], active: boolean) {
  const [speaking, setSpeaking] = useState<Record<string, boolean>>({});
  // Пересоздаем граф только когда меняется набор потоков, а не на каждый рендер.
  const key = sources.map((source) => `${source.id}:${source.stream?.id ?? "-"}`).join("|");

  useEffect(() => {
    if (!active) return;
    const withAudio = sources.filter((source) => source.stream?.getAudioTracks().length);
    if (!withAudio.length) return;

    const context = audioContext();
    const buffer = new Float32Array(1024);
    const nodes = withAudio.map(({ id, stream }) => {
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.5;
      const source = context.createMediaStreamSource(stream!);
      source.connect(analyser);
      return { id, source, analyser, lastLoud: 0 };
    });

    let frame = 0;
    const tick = () => {
      const now = performance.now();
      const next: Record<string, boolean> = {};
      for (const node of nodes) {
        node.analyser.getFloatTimeDomainData(buffer);
        let sum = 0;
        for (const sample of buffer) sum += sample * sample;
        if (Math.sqrt(sum / buffer.length) > SPEAKING_THRESHOLD) node.lastLoud = now;
        next[node.id] = now - node.lastLoud < RELEASE_MS;
      }
      setSpeaking((current) => {
        const changed = nodes.some((node) => current[node.id] !== next[node.id]);
        return changed ? next : current;
      });
      frame = window.setTimeout(tick, 150);
    };
    tick();

    return () => {
      window.clearTimeout(frame);
      // Контекст общий и переживает звонок, поэтому отсоединяем ровно свои узлы:
      // иначе граф растет с каждым вошедшим и не разбирается до перезагрузки.
      nodes.forEach((node) => {
        node.source.disconnect();
        node.analyser.disconnect();
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, active]);

  return active ? speaking : NOT_SPEAKING;
}

const NOT_SPEAKING: Record<string, boolean> = {};
