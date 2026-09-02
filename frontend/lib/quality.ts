"use client";

/**
 * Настройки кодирования исходящего видео.
 *
 * Все меняется через `setParameters` на отправителе и `applyConstraints` на
 * треке — то есть на живом соединении, без переговоров и без разрыва звонка.
 *
 * Главная развилка не в битрейте, а в том, чем жертвовать, когда канала не
 * хватает: разрешением или частотой кадров. Для текста на экране правильный
 * ответ — держать разрешение, для видео — держать кадры. Одним значением
 * «качества» это не описывается, поэтому демонстрация настраивается отдельно.
 */

export type VideoQuality = "auto" | "low" | "medium" | "high";
export type ShareMode = "detail" | "motion";

type Degradation = "balanced" | "maintain-framerate" | "maintain-resolution";

export const VIDEO_PRESETS: Record<VideoQuality, {
  label: string;
  hint: string;
  width?: number;
  height?: number;
  bitrate?: number;
}> = {
  auto: {
    label: "Автоматически",
    hint: "Браузер сам подстраивается под канал. Подходит почти всем.",
  },
  low: {
    label: "Экономный · 360p",
    hint: "До 400 кбит/с. Мобильный интернет, слабый Wi-Fi, дорогой трафик.",
    width: 640, height: 360, bitrate: 400_000,
  },
  medium: {
    label: "Обычный · 720p",
    hint: "До 1,5 Мбит/с. Разумный баланс для разговора вдвоем-втроем.",
    width: 1280, height: 720, bitrate: 1_500_000,
  },
  high: {
    label: "Максимум · 1080p",
    hint: "До 3 Мбит/с. Нужны и камера, и канал, которые это потянут.",
    width: 1920, height: 1080, bitrate: 3_000_000,
  },
};

export const SHARE_MODES: Record<ShareMode, {
  label: string;
  hint: string;
  frameRate: number;
  bitrate: number;
  contentHint: "text" | "motion";
  degradation: Degradation;
}> = {
  detail: {
    label: "Четкость",
    hint: "Текст и код остаются читаемыми. Кадров меньше — для документов и IDE.",
    frameRate: 15, bitrate: 1_500_000, contentHint: "text", degradation: "maintain-resolution",
  },
  motion: {
    label: "Плавность",
    hint: "Видео и анимация идут гладко. Мелкий текст при этом мылит.",
    frameRate: 30, bitrate: 2_500_000, contentHint: "motion", degradation: "maintain-framerate",
  },
};

/**
 * Для тех, кто у собеседника показан миниатюрой в ленте. В mesh это точнее
 * simulcast: поток и так индивидуальный для каждого, поэтому лишние слои
 * кодировать и отправлять не нужно — достаточно спросить, что человеку нужно.
 */
export const THUMBNAIL = { bitrate: 250_000, frameRate: 20, scale: 3 };

/**
 * Сколько битрейта отдать одному собеседнику в режиме «Автоматически».
 *
 * В full mesh каждый кодирует и отправляет отдельный поток каждому: аплинк
 * расходуется как N-1 потоков сразу. Само по себе это не страшно, но
 * контроль перегрузки в WebRTC живет внутри одного соединения и про соседние
 * не знает. Семь соединений независимо решают, что канал свободен, дружно
 * разгоняются и забивают один и тот же аплинк — растут задержка и потери,
 * причем у всех сразу. Поэтому общий потолок делим сами.
 *
 * ponytail: бюджет задан константой. Честнее брать availableOutgoingBitrate
 * из getStats — это оценка самого браузера; менять, если упремся.
 */
const UPLINK_BUDGET = 3_000_000;

export function autoBitrate(peers: number) {
  // Ниже 200 кбит/с видео превращается в слайд-шоу — тогда уж лучше без него.
  return Math.max(200_000, Math.round(UPLINK_BUDGET / Math.max(1, peers)));
}

/**
 * Ограничения на отправителя. Пустой encodings означает, что переговоры еще
 * не прошли и настраивать нечего — так бывает сразу после addTrack.
 */
export async function tuneSender(sender: RTCRtpSender, options: {
  bitrate?: number;
  frameRate?: number;
  /** Во сколько раз уменьшить кадр перед кодированием. 1 — не уменьшать. */
  scale?: number;
  degradation: Degradation;
}) {
  const params = sender.getParameters() as RTCRtpSendParameters & { degradationPreference?: Degradation };
  if (!params.encodings?.length) return;
  // undefined снимает ограничение — так работает режим «Автоматически».
  params.encodings[0].maxBitrate = options.bitrate;
  params.encodings[0].maxFramerate = options.frameRate;
  // Значение обязательно задавать всегда: иначе прошлое уменьшение так и останется.
  params.encodings[0].scaleResolutionDownBy = options.scale ?? 1;
  params.degradationPreference = options.degradation;
  await sender.setParameters(params);
}
