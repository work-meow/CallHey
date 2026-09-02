export type StunProvider = {
  id: string;
  label: string;
  hint: string;
  urls: string[];
};

// Замеры с реальной сети: Cloudflare ~31 мс, Twilio ~69 мс, Google ~46 мс.
// Cloudflare и Twilio слушают стандартный 3478 — его реже режут файрволы.
export const STUN_PROVIDERS: StunProvider[] = [
  {
    id: "auto",
    label: "Автоматически",
    hint: "Все три сразу — соединение соберется, даже если один недоступен",
    urls: [
      "stun:stun.cloudflare.com:3478",
      "stun:global.stun.twilio.com:3478",
      "stun:stun.l.google.com:19302",
    ],
  },
  { id: "cloudflare", label: "Cloudflare", hint: "Обычно самый быстрый, порт 3478", urls: ["stun:stun.cloudflare.com:3478"] },
  { id: "twilio", label: "Twilio", hint: "Телеком-оператор, порт 3478", urls: ["stun:global.stun.twilio.com:3478"] },
  { id: "google", label: "Google", hint: "Нестандартный порт 19302, чаще режется", urls: ["stun:stun.l.google.com:19302"] },
];

export const DEFAULT_PROVIDER = STUN_PROVIDERS[0];
const STORAGE_KEY = "callhey:stun";

// Выбор хранится в localStorage — это внешнее хранилище, поэтому компоненты
// подписываются на него через useSyncExternalStore, а не через useState + useEffect.
let current: StunProvider | null = null;
const listeners = new Set<() => void>();

export function getProvider(): StunProvider {
  if (current) return current;
  if (typeof localStorage === "undefined") return DEFAULT_PROVIDER;
  const saved = localStorage.getItem(STORAGE_KEY);
  current = STUN_PROVIDERS.find((provider) => provider.id === saved) ?? DEFAULT_PROVIDER;
  return current;
}

/** Снимок для сервера и первого рендера: сохраненный выбор виден только браузеру. */
export function getDefaultProvider() {
  return DEFAULT_PROVIDER;
}

export function setProvider(provider: StunProvider) {
  current = provider;
  try {
    localStorage.setItem(STORAGE_KEY, provider.id);
  } catch {
    // приватный режим — выбор просто не переживет перезагрузку
  }
  listeners.forEach((listener) => listener());
}

export function subscribeProvider(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function iceServers(provider: StunProvider, turn?: RTCIceServer): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: provider.urls }];
  if (turn?.urls) servers.push(turn);
  return servers;
}

/**
 * Шкала для замера STUN. Она мягче, чем для задержки до участника: в это время
 * входят DNS и запуск ICE-агента, поэтому 150 мс здесь — нормальный результат.
 */
export function stunQuality(ms: number | null) {
  if (ms === null) return "unknown" as const;
  if (ms <= 250) return "good" as const;
  if (ms <= 600) return "fair" as const;
  return "poor" as const;
}

/**
 * Замеряет, за сколько STUN вернет наш внешний адрес: поднимает временное
 * соединение и ждет первый srflx-кандидат.
 */
export function measureStun(urls: string[], timeout = 4000): Promise<number | null> {
  return new Promise((resolve) => {
    let peer: RTCPeerConnection;
    try {
      peer = new RTCPeerConnection({ iceServers: [{ urls }] });
    } catch {
      return resolve(null);
    }
    const started = performance.now();
    const finish = (value: number | null) => {
      window.clearTimeout(timer);
      peer.close();
      resolve(value);
    };
    const timer = window.setTimeout(() => finish(null), timeout);

    peer.onicecandidate = ({ candidate }) => {
      if (!candidate) return finish(null); // сбор закончился без srflx
      if (candidate.type === "srflx") finish(Math.round(performance.now() - started));
    };
    peer.createDataChannel("probe");
    peer.createOffer()
      .then((offer) => peer.setLocalDescription(offer))
      .catch(() => finish(null));
  });
}
