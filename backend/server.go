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
	maxRooms       = 10_000
	participantTTL = 30 * time.Second
)

var roomPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{8,32}$`)

type signalServer struct {
	mu      sync.Mutex
	rooms   map[string]map[string]*participant
	origins map[string]bool
	handler http.Handler
}

type participant struct {
	name     string
	events   chan event
	active   bool
	lastSeen time.Time
}

type event struct {
	Type      string          `json:"type"`
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

	token, err := randomToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Не удалось создать звонок.")
		return
	}
	p := &participant{name: body.Name, events: make(chan event, 32), lastSeen: time.Now()}

	s.mu.Lock()
	participants := s.rooms[room]
	if participants == nil {
		if len(s.rooms) >= maxRooms {
			s.mu.Unlock()
			writeError(w, http.StatusServiceUnavailable, "Сервис временно занят.")
			return
		}
		participants = make(map[string]*participant, 2)
		s.rooms[room] = participants
	}
	if len(participants) >= 2 {
		s.mu.Unlock()
		writeError(w, http.StatusConflict, "В звонке уже два участника.")
		return
	}
	var peer *participant
	for _, current := range participants {
		peer = current
	}
	participants[token] = p
	s.mu.Unlock()

	peerName := ""
	if peer != nil {
		peerName = peer.name
		s.emit(peer, event{Type: "peer-joined", Name: p.name})
	}
	writeJSON(w, http.StatusCreated, map[string]string{"token": token, "peer": peerName})
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

	s.mu.Lock()
	if p.active {
		s.mu.Unlock()
		writeError(w, http.StatusConflict, "Сессия уже открыта.")
		return
	}
	p.active = true
	p.lastSeen = time.Now()
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		p.active = false
		p.lastSeen = time.Now()
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
		select {
		case <-r.Context().Done():
			return
		case message := <-p.events:
			payload, _ := json.Marshal(message)
			if _, err := fmt.Fprintf(w, "data: %s\n\n", payload); err != nil {
				return
			}
			flusher.Flush()
		case <-ticker.C:
			if _, err := io.WriteString(w, ": keepalive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (s *signalServer) signal(w http.ResponseWriter, r *http.Request) {
	p := s.participant(r.PathValue("room"), r.URL.Query().Get("token"))
	if p == nil {
		writeError(w, http.StatusNotFound, "Сессия звонка завершена.")
		return
	}
	var message event
	if err := readJSON(w, r, &message, 64<<10); err != nil || (message.Type != "offer" && message.Type != "answer" && message.Type != "ice") {
		writeError(w, http.StatusBadRequest, "Некорректный сигнал соединения.")
		return
	}
	peer := s.peer(r.PathValue("room"), r.URL.Query().Get("token"))
	if peer == nil {
		writeError(w, http.StatusConflict, "Собеседник еще не подключился.")
		return
	}
	if !s.emit(peer, message) {
		writeError(w, http.StatusServiceUnavailable, "Слишком много сигналов соединения.")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *signalServer) leave(w http.ResponseWriter, r *http.Request) {
	if !s.remove(r.PathValue("room"), r.URL.Query().Get("token")) {
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

func (s *signalServer) peer(room, token string) *participant {
	s.mu.Lock()
	defer s.mu.Unlock()
	for currentToken, p := range s.rooms[room] {
		if currentToken != token {
			return p
		}
	}
	return nil
}

func (s *signalServer) emit(p *participant, message event) bool {
	select {
	case p.events <- message:
		return true
	default:
		return false
	}
}

func (s *signalServer) remove(room, token string) bool {
	s.mu.Lock()
	participants := s.rooms[room]
	if participants == nil || participants[token] == nil {
		s.mu.Unlock()
		return false
	}
	delete(participants, token)
	var peer *participant
	for _, current := range participants {
		peer = current
	}
	if len(participants) == 0 {
		delete(s.rooms, room)
	}
	s.mu.Unlock()
	if peer != nil {
		s.emit(peer, event{Type: "peer-left"})
	}
	return true
}

func (s *signalServer) prune(ctx context.Context) {
	ticker := time.NewTicker(10 * time.Second)
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
				s.removeIfStale(entry[0], entry[1], now)
			}
		}
	}
}

func (s *signalServer) removeIfStale(room, token string, now time.Time) {
	s.mu.Lock()
	participants := s.rooms[room]
	p := participants[token]
	if p == nil || p.active || now.Sub(p.lastSeen) <= participantTTL {
		s.mu.Unlock()
		return
	}
	delete(participants, token)
	var peer *participant
	for _, current := range participants {
		peer = current
	}
	if len(participants) == 0 {
		delete(s.rooms, room)
	}
	s.mu.Unlock()
	if peer != nil {
		s.emit(peer, event{Type: "peer-left"})
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

func randomToken() (string, error) {
	value := make([]byte, 24)
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
