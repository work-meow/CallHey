package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	maxRooms = 10_000
	// ponytail: mesh — каждый шлет свое видео каждому, выше 8 участников нужен SFU
	maxParticipants = 8
	participantTTL  = 20 * time.Second
)

var roomPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{8,32}$`)

type signalServer struct {
	mu      sync.Mutex
	rooms   map[string]map[string]*participant
	origins map[string]bool
	handler http.Handler
}

type participant struct {
	id   string
	name string
	// Очередь, а не канал: сообщение удаляется только после успешной отправки,
	// поэтому обрыв SSE не съедает offer или ICE-кандидат.
	queue    []event
	wake     chan struct{}
	active   bool
	stream   context.CancelFunc
	gen      uint64
	lastSeen time.Time
}

type peerInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type event struct {
	Type      string          `json:"type"`
	From      string          `json:"from,omitempty"`
	To        string          `json:"to,omitempty"`
	Name      string          `json:"name,omitempty"`
	SDP       json.RawMessage `json:"sdp,omitempty"`
	Candidate json.RawMessage `json:"candidate,omitempty"`
}

func newSignalServer(allowedOrigins string) *signalServer {
	s := &signalServer{rooms: make(map[string]map[string]*participant), origins: make(map[string]bool)}
	for _, origin := range strings.Split(allowedOrigins, ",") {
		if origin = strings.TrimSpace(origin); origin != "" {
			s.origins[origin] = true
		}
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.health)
	mux.HandleFunc("POST /rooms/{room}/participants", s.join)
	mux.HandleFunc("GET /rooms/{room}/events", s.events)
	mux.HandleFunc("POST /rooms/{room}/signals", s.signal)
	mux.HandleFunc("DELETE /rooms/{room}/participants", s.leave)
	// sendBeacon умеет только POST, но именно он доезжает при закрытии вкладки.
	mux.HandleFunc("POST /rooms/{room}/leave", s.leave)
	s.handler = s.cors(mux)
	return s
}

func (s *signalServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.handler.ServeHTTP(w, r)
}

func (s *signalServer) join(w http.ResponseWriter, r *http.Request) {
	room := r.PathValue("room")
	if !roomPattern.MatchString(room) {
		writeError(w, http.StatusBadRequest, "Некорректная ссылка на звонок.")
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if err := readJSON(w, r, &body, 1024); err != nil {
		writeError(w, http.StatusBadRequest, "Введите имя короче 32 символов.")
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" || !utf8.ValidString(body.Name) || utf8.RuneCountInString(body.Name) > 32 {
		writeError(w, http.StatusBadRequest, "Введите имя короче 32 символов.")
		return
	}

	token, err := randomString(24)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Не удалось создать звонок.")
		return
	}
	id, err := randomString(9)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Не удалось создать звонок.")
		return
	}
	p := &participant{id: id, name: body.Name, wake: make(chan struct{}, 1), lastSeen: time.Now()}

	s.mu.Lock()
	participants := s.rooms[room]
	if participants == nil {
		if len(s.rooms) >= maxRooms {
			s.mu.Unlock()
			writeError(w, http.StatusServiceUnavailable, "Сервис временно занят.")
			return
		}
		participants = make(map[string]*participant, maxParticipants)
		s.rooms[room] = participants
	}
	if len(participants) >= maxParticipants {
		s.mu.Unlock()
		writeError(w, http.StatusConflict, fmt.Sprintf("В звонке уже %d участников — это максимум.", maxParticipants))
		return
	}
	peers := make([]peerInfo, 0, len(participants))
	others := make([]*participant, 0, len(participants))
	for _, current := range participants {
		peers = append(peers, peerInfo{ID: current.id, Name: current.name})
		others = append(others, current)
	}
	participants[token] = p
	s.mu.Unlock()

	for _, other := range others {
		s.emit(other, event{Type: "peer-joined", From: id, Name: body.Name})
	}
	writeJSON(w, http.StatusCreated, map[string]any{"token": token, "id": id, "peers": peers})
}

func (s *signalServer) events(w http.ResponseWriter, r *http.Request) {
	room, token := r.PathValue("room"), r.URL.Query().Get("token")
	p := s.participant(room, token)
	if p == nil {
		writeError(w, http.StatusNotFound, "Сессия звонка завершена.")
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "Поток событий недоступен.")
		return
	}
	// Поток живет весь звонок, поэтому снимаем таймауты сервера — иначе он умрет через ReadTimeout.
	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(time.Time{})
	_ = controller.SetWriteDeadline(time.Time{})

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	// Переподключение вытесняет прошлый поток вместо отказа: иначе EventSource,
	// получив не-200, закрывается навсегда. Поколение гарантирует, что очередь
	// читает ровно один поток.
	s.mu.Lock()
	previous := p.stream
	p.gen++
	generation := p.gen
	p.stream, p.active, p.lastSeen = cancel, true, time.Now()
	s.mu.Unlock()
	if previous != nil {
		previous()
	}
	defer func() {
		s.mu.Lock()
		if p.gen == generation {
			p.stream, p.active, p.lastSeen = nil, false, time.Now()
		}
		s.mu.Unlock()
	}()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("X-Accel-Buffering", "no")
	_, _ = io.WriteString(w, "retry: 2000\n\n")
	flusher.Flush()
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	for {
		if message, ok := s.take(p, generation); ok {
			payload, _ := json.Marshal(message)
			if _, err := fmt.Fprintf(w, "data: %s\n\n", payload); err != nil {
				return
			}
			flusher.Flush()
			s.drop(p, generation)
			continue
		}
		select {
		case <-ctx.Done():
			return
		case <-p.wake:
		case <-ticker.C:
			if _, err := io.WriteString(w, ": keepalive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (s *signalServer) signal(w http.ResponseWriter, r *http.Request) {
	room, token := r.PathValue("room"), r.URL.Query().Get("token")
	p := s.participant(room, token)
	if p == nil {
		writeError(w, http.StatusNotFound, "Сессия звонка завершена.")
		return
	}
	var message event
	if err := readJSON(w, r, &message, 64<<10); err != nil || message.To == "" ||
		(message.Type != "offer" && message.Type != "answer" && message.Type != "ice") {
		writeError(w, http.StatusBadRequest, "Некорректный сигнал соединения.")
		return
	}
	target := s.byID(room, message.To)
	if target == nil {
		writeError(w, http.StatusConflict, "Собеседник вышел из звонка.")
		return
	}
	message.From, message.To, message.Name = p.id, "", ""
	if !s.emit(target, message) {
		writeError(w, http.StatusServiceUnavailable, "Слишком много сигналов соединения.")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *signalServer) leave(w http.ResponseWriter, r *http.Request) {
	if !s.remove(r.PathValue("room"), r.URL.Query().Get("token"), time.Time{}) {
		writeError(w, http.StatusNotFound, "Сессия звонка уже завершена.")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *signalServer) health(w http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	rooms, participants := len(s.rooms), 0
	for _, room := range s.rooms {
		participants += len(room)
	}
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "rooms": rooms, "participants": participants})
}

func (s *signalServer) participant(room, token string) *participant {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.rooms[room][token]
}

func (s *signalServer) byID(room, id string) *participant {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.rooms[room] {
		if p.id == id {
			return p
		}
	}
	return nil
}

func (s *signalServer) emit(p *participant, message event) bool {
	s.mu.Lock()
	if len(p.queue) >= 256 {
		s.mu.Unlock()
		return false
	}
	p.queue = append(p.queue, message)
	s.mu.Unlock()
	select {
	case p.wake <- struct{}{}:
	default:
	}
	return true
}

func (s *signalServer) take(p *participant, generation uint64) (event, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p.gen != generation || len(p.queue) == 0 {
		return event{}, false
	}
	return p.queue[0], true
}

func (s *signalServer) drop(p *participant, generation uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p.gen == generation && len(p.queue) > 0 {
		p.queue = p.queue[1:]
	}
}

// remove выкидывает участника из комнаты. Ненулевой staleBefore удаляет только тех,
// кто отключился и не возвращался до этого момента.
func (s *signalServer) remove(room, token string, staleBefore time.Time) bool {
	s.mu.Lock()
	participants := s.rooms[room]
	p := participants[token]
	if p == nil || (!staleBefore.IsZero() && (p.active || p.lastSeen.After(staleBefore))) {
		s.mu.Unlock()
		return false
	}
	delete(participants, token)
	rest := make([]*participant, 0, len(participants))
	for _, current := range participants {
		rest = append(rest, current)
	}
	if len(participants) == 0 {
		delete(s.rooms, room)
	}
	if p.stream != nil {
		p.stream()
	}
	s.mu.Unlock()

	for _, current := range rest {
		s.emit(current, event{Type: "peer-left", From: p.id})
	}
	return true
}

func (s *signalServer) prune(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			var stale [][2]string
			s.mu.Lock()
			for room, participants := range s.rooms {
				for token, p := range participants {
					if !p.active && now.Sub(p.lastSeen) > participantTTL {
						stale = append(stale, [2]string{room, token})
					}
				}
			}
			s.mu.Unlock()
			for _, entry := range stale {
				s.remove(entry[0], entry[1], now.Add(-participantTTL))
			}
		}
	}
}

func (s *signalServer) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" {
			if !s.origins[origin] {
				writeError(w, http.StatusForbidden, "Источник запроса не разрешен.")
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.Header().Set("Access-Control-Max-Age", "86400")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func readJSON(w http.ResponseWriter, r *http.Request, target any, limit int64) error {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return errors.New("request body must contain one JSON value")
	}
	return nil
}

func randomString(size int) (string, error) {
	value := make([]byte, size)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
