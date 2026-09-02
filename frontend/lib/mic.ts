"use client";

/**
 * Микрофонный тракт. Сырой трек с устройства идет через регулятор громкости,
 * и собеседникам уходит уже выход этого регулятора.
 *
 * Ключевое здесь — выходной трек создается один раз и живет до конца звонка.
 * Поэтому смена микрофона на лету не трогает соединения: меняется только
 * источник в начале цепочки, а трек в senders остается тем же, и переговоры
 * с участниками не нужны.
 */

export type AudioMode = "off" | "standard" | "voice";

export const AUDIO_MODES: { id: AudioMode; label: string; hint: string }[] = [
  { id: "off", label: "Без обработки", hint: "Сырой звук с микрофона — для музыки и инструментов" },
  { id: "standard", label: "Стандартное", hint: "Эхоподавление, шумоподавление и автоуровень" },
  { id: "voice", label: "Максимальное", hint: "Плюс изоляция голоса: фон глушится агрессивнее" },
];

const CONSTRAINTS: Record<AudioMode, MediaTrackConstraints> = {
  off: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  standard: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  voice: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    voiceIsolation: true,
  } as MediaTrackConstraints,
};

/** Изоляция голоса есть не везде: без нее «Максимальное» совпадает со «Стандартным». */
export function supportsVoiceIsolation() {
  if (typeof navigator === "undefined") return false;
  return "voiceIsolation" in (navigator.mediaDevices?.getSupportedConstraints() ?? {});
}

export type MicChain = ReturnType<typeof createMicChain>;

export function createMicChain(initial: MediaStreamTrack) {
  const context = new AudioContext();
  const gain = context.createGain();
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  const destination = context.createMediaStreamDestination();
  const samples = new Float32Array(analyser.fftSize);

  let raw = initial;
  let source = context.createMediaStreamSource(new MediaStream([raw]));
  source.connect(gain);
  // Анализатор намеренно никуда не ведет дальше: подключи мы его к колонкам,
  // человек услышал бы сам себя. Ему достаточно входа, чтобы измерять уровень.
  gain.connect(analyser);
  gain.connect(destination);

  return {
    /** Трек для отправки участникам. Не меняется при смене устройства. */
    track: destination.stream.getAudioTracks()[0],
    /** Этот же поток идет в индикатор «говорит» — он уже учитывает громкость и мьют. */
    stream: destination.stream,
    /** Сырой трек: именно его enabled глушит микрофон. */
    input: () => raw,

    setGain(value: number) {
      gain.gain.value = value;
    },

    /** Текущий уровень 0..1 для полоски в настройках. */
    level() {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      // Множитель подобран по речи в обычной комнате: без него полоска почти не шевелится.
      return Math.min(1, Math.sqrt(sum / samples.length) * 4);
    },

    async setMode(mode: AudioMode) {
      try {
        await raw.applyConstraints(CONSTRAINTS[mode]);
      } catch {
        // Браузер не знает про часть ограничений — берем набор, который он точно поймет.
        await raw.applyConstraints(CONSTRAINTS[mode === "voice" ? "standard" : mode]);
      }
    },

    async useDevice(deviceId: string, mode: AudioMode) {
      const next = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId }, ...CONSTRAINTS[mode] },
      });
      const track = next.getAudioTracks()[0];
      if (!track) return;
      // Новый микрофон не должен включаться сам, если человек сидит с выключенным.
      track.enabled = raw.enabled;
      source.disconnect();
      raw.stop();
      raw = track;
      source = context.createMediaStreamSource(new MediaStream([raw]));
      source.connect(gain);
    },

    close() {
      raw.stop();
      void context.close();
    },
  };
}
