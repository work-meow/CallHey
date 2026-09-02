/**
 * Формат сообщений в RTCDataChannel. Идут напрямую между участниками:
 * сигналинг их не видит, нагрузки на сервер нет.
 */
export type QualityLevel = "high" | "low";

export type WireMessage =
  | { kind: "chat"; text: string; at: number }
  | { kind: "state"; muted: boolean; cameraOff: boolean; sharing: boolean }
  /** Просьба к отправителю: столько качества нам сейчас достаточно. */
  | { kind: "quality"; level: QualityLevel };

export type ChatMessage = {
  id: string;
  author: string;
  text: string;
  at: number;
  own: boolean;
};

export type PeerState = {
  muted: boolean;
  cameraOff: boolean;
  sharing: boolean;
};

export const MAX_MESSAGE_LENGTH = 800;

/** Отбрасывает мусор из канала: данные приходят от другого клиента, доверять им нельзя. */
export function parseWire(raw: unknown): WireMessage | null {
  if (typeof raw !== "string" || raw.length > MAX_MESSAGE_LENGTH * 4) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;

  if (message.kind === "chat") {
    const text = typeof message.text === "string" ? message.text.trim().slice(0, MAX_MESSAGE_LENGTH) : "";
    if (!text) return null;
    return { kind: "chat", text, at: typeof message.at === "number" ? message.at : Date.now() };
  }
  if (message.kind === "state") {
    return {
      kind: "state",
      muted: message.muted === true,
      cameraOff: message.cameraOff === true,
      sharing: message.sharing === true,
    };
  }
  if (message.kind === "quality") {
    // Только "low" понижает качество: неизвестное значение не должно глушить картинку.
    return { kind: "quality", level: message.level === "low" ? "low" : "high" };
  }
  return null;
}
