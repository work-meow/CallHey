# ТыТут

Минимальный видеозвонок для двух человек по ссылке. Браузеры передают аудио и видео напрямую через WebRTC; Go-сервис хранит только участников комнаты и пересылает сигналы соединения через HTTP/SSE.

## Запуск

Требуются Go 1.24+ и Node.js 22+.

```powershell
cd backend
go run .
```

```powershell
cd frontend
npm ci
npm run dev
```

Откройте `http://localhost:3000`, создайте звонок и отправьте полученную ссылку второму участнику. Камера и микрофон работают на `localhost` или через HTTPS.

## Настройка

- `backend/ALLOWED_ORIGINS` — адреса frontend через запятую.
- `frontend/SIGNAL_URL` — публичный HTTPS-адрес signaling backend.
- `frontend/TURN_*` — необязательный TURN-сервер для сетей, где прямой WebRTC заблокирован.

Для развертывания соберите `backend/Dockerfile` и `frontend/Dockerfile`, выдайте обоим сервисам HTTPS и заполните переменные из `.env.example` в их каталогах.

## Проверка

```powershell
cd backend
go test ./...
go vet ./...

cd ../frontend
npm run check
```
