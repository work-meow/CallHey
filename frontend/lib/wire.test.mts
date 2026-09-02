import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_MESSAGE_LENGTH, parseWire } from "./wire.ts";

// Сообщения приходят из чужого браузера по каналу данных: сигналинг их не
// видит и не проверяет. Единственная защита — этот разбор, поэтому проверяем
// не «счастливый путь», а именно мусор.

test("отбрасывает все, что не похоже на сообщение", () => {
  for (const raw of [null, 42, {}, "", "не json", "[]", JSON.stringify(null)]) {
    assert.equal(parseWire(raw), null, `прошло: ${String(raw)}`);
  }
  assert.equal(parseWire(JSON.stringify({ kind: "drop-table" })), null);
});

test("режет чат по длине и не пропускает пустой", () => {
  const long = JSON.stringify({ kind: "chat", text: "я".repeat(MAX_MESSAGE_LENGTH + 50), at: 1 });
  const parsed = parseWire(long);
  assert.equal(parsed?.kind, "chat");
  assert.equal(parsed.kind === "chat" && parsed.text.length, MAX_MESSAGE_LENGTH);

  assert.equal(parseWire(JSON.stringify({ kind: "chat", text: "   ", at: 1 })), null);
  assert.equal(parseWire(JSON.stringify({ kind: "chat", text: 5, at: 1 })), null);
  // Заведомо огромная строка отсекается до разбора JSON.
  assert.equal(parseWire("x".repeat(MAX_MESSAGE_LENGTH * 4 + 1)), null);
});

test("состояние участника приводит к булеву строго", () => {
  const parsed = parseWire(JSON.stringify({ kind: "state", muted: "да", cameraOff: 1, sharing: true }));
  assert.deepEqual(parsed, { kind: "state", muted: false, cameraOff: false, sharing: true });
});

test("запрос качества понижает только по явному low", () => {
  const low = parseWire(JSON.stringify({ kind: "quality", level: "low" }));
  assert.deepEqual(low, { kind: "quality", level: "low" });

  // Что угодно другое — полное качество: чужой мусор не должен глушить нам картинку.
  for (const level of ["high", "LOW", "", null, undefined, 0]) {
    const parsed = parseWire(JSON.stringify({ kind: "quality", level }));
    assert.deepEqual(parsed, { kind: "quality", level: "high" }, `подвело: ${String(level)}`);
  }
});
