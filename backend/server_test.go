package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSignalIsRoutedToAddressedPeerAndRoomCloses(t *testing.T) {
	server := httptest.NewServer(newSignalServer(""))
	defer server.Close()
	room := "testRoom123"
	alice := joinParticipant(t, server.URL, room, "Алиса")
	bob := joinParticipant(t, server.URL, room, "Боб")
	carol := joinParticipant(t, server.URL, room, "Кэрол")

	if len(bob.Peers) != 1 || bob.Peers[0].ID != alice.ID {
		t.Fatalf("новый участник не увидел уже вошедших: %+v", bob.Peers)
	}

	events, stop := openEvents(t, server.URL, room, bob.Token)
	defer stop()

	// Кэрол шлет оффер Бобу, Алиса — тоже Бобу: оба должны дойти, и только Бобу.
	postSignal(t, server.URL, room, carol.Token, fmt.Sprintf(`{"type":"offer","to":%q,"sdp":{"type":"offer","sdp":"v=0"}}`, bob.ID), http.StatusNoContent)
	postSignal(t, server.URL, room, alice.Token, fmt.Sprintf(`{"type":"ice","to":%q,"candidate":{"candidate":"x"}}`, bob.ID), http.StatusNoContent)

	if from := readEvent(t, events, `"type":"offer"`); from != carol.ID {
		t.Fatalf("оффер пришел не от Кэрол: %q", from)
	}
	if from := readEvent(t, events, `"type":"ice"`); from != alice.ID {
		t.Fatalf("кандидат пришел не от Алисы: %q", from)
	}

	// Ушедший участник больше не адресуем.
	deleteParticipant(t, server.URL, room, carol.Token)
	postSignal(t, server.URL, room, alice.Token, fmt.Sprintf(`{"type":"offer","to":%q,"sdp":{"type":"offer","sdp":"v=0"}}`, carol.ID), http.StatusConflict)
	if from := readEvent(t, events, `"type":"peer-left"`); from != carol.ID {
		t.Fatalf("peer-left пришел не про Кэрол: %q", from)
	}

	stop()
	deleteParticipant(t, server.URL, room, alice.Token)
	deleteParticipant(t, server.URL, room, bob.Token)
	if rooms := healthRooms(t, server.URL); rooms != 0 {
		t.Fatalf("комната утекла: %d", rooms)
	}
}

func TestRoomRejectsParticipantOverLimit(t *testing.T) {
	server := httptest.NewServer(newSignalServer(""))
	defer server.Close()
	room := "fullRoom123"
	for i := 0; i < maxParticipants; i++ {
		joinParticipant(t, server.URL, room, fmt.Sprintf("Гость %d", i))
	}
	response, err := http.Post(server.URL+"/rooms/"+room+"/participants", "application/json", strings.NewReader(`{"name":"Лишний"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusConflict {
		t.Fatalf("неожиданный статус: %d", response.StatusCode)
	}
}

// Переподключение SSE должно вытеснять прошлый поток, а не получать отказ:
// иначе EventSource в браузере закрывается навсегда после любого обрыва.
func TestReconnectedEventStreamReplacesPrevious(t *testing.T) {
	server := httptest.NewServer(newSignalServer(""))
	defer server.Close()
	room := "retryRoom12"
	alice := joinParticipant(t, server.URL, room, "Алиса")
	bob := joinParticipant(t, server.URL, room, "Боб")

	_, stopFirst := openEvents(t, server.URL, room, bob.Token)
	defer stopFirst()
	second, stopSecond := openEvents(t, server.URL, room, bob.Token)
	defer stopSecond()

	postSignal(t, server.URL, room, alice.Token, fmt.Sprintf(`{"type":"ice","to":%q,"candidate":{"candidate":"x"}}`, bob.ID), http.StatusNoContent)
	if from := readEvent(t, second, `"type":"ice"`); from != alice.ID {
		t.Fatalf("новый поток не получил событие: %q", from)
	}
}

type joinedParticipant struct {
	Token string     `json:"token"`
	ID    string     `json:"id"`
	Peers []peerInfo `json:"peers"`
}

func joinParticipant(t *testing.T, baseURL, room, name string) joinedParticipant {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"name": name})
	response, err := http.Post(baseURL+"/rooms/"+room+"/participants", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("join failed: %d", response.StatusCode)
	}
	var joined joinedParticipant
	_ = json.NewDecoder(response.Body).Decode(&joined)
	return joined
}

func openEvents(t *testing.T, baseURL, room, token string) (*bufio.Scanner, func()) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/rooms/"+room+"/events?token="+token, nil)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		cancel()
		t.Fatalf("поток событий не открылся: %d", response.StatusCode)
	}
	return bufio.NewScanner(response.Body), func() {
		cancel()
		response.Body.Close()
	}
}

func readEvent(t *testing.T, events *bufio.Scanner, marker string) string {
	t.Helper()
	for events.Scan() {
		line := events.Text()
		if !strings.Contains(line, marker) {
			continue
		}
		var message event
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &message); err != nil {
			t.Fatalf("нечитаемое событие %q: %v", line, err)
		}
		return message.From
	}
	t.Fatalf("событие %s не пришло", marker)
	return ""
}

func postSignal(t *testing.T, baseURL, room, token, body string, want int) {
	t.Helper()
	response, err := http.Post(baseURL+"/rooms/"+room+"/signals?token="+token, "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != want {
		t.Fatalf("сигнал %s: статус %d, ожидался %d", body, response.StatusCode, want)
	}
}

func deleteParticipant(t *testing.T, baseURL, room, token string) {
	t.Helper()
	request, _ := http.NewRequest(http.MethodDelete, baseURL+"/rooms/"+room+"/participants?token="+token, nil)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
}

func healthRooms(t *testing.T, baseURL string) int {
	t.Helper()
	response, err := http.Get(baseURL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var status struct {
		Rooms int `json:"rooms"`
	}
	_ = json.NewDecoder(response.Body).Decode(&status)
	return status.Rooms
}
