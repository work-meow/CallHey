"use client";

import { useEffect, useState } from "react";

/**
 * Список устройств ввода-вывода. Названия браузер отдает только после того,
 * как доступ к микрофону уже выдан, поэтому читаем список во время звонка,
 * а не на лобби — иначе в выпадающих списках будут пустые строки.
 */
export function useDevices(active: boolean) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    if (!active || !navigator.mediaDevices?.enumerateDevices) return;
    let stopped = false;
    const read = () => {
      void navigator.mediaDevices.enumerateDevices()
        .then((list) => { if (!stopped) setDevices(list); })
        .catch(() => undefined);
    };
    read();
    // Наушники втыкают прямо посреди разговора — список должен успевать за этим.
    navigator.mediaDevices.addEventListener("devicechange", read);
    return () => {
      stopped = true;
      navigator.mediaDevices.removeEventListener("devicechange", read);
    };
  }, [active]);

  return devices;
}

/** Вывод звука можно переключать не везде: в Firefox и Safari setSinkId нет. */
export function supportsOutputChoice() {
  return typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
}
