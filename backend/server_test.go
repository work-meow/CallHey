package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestTwoParticipantsExchangeSignalAndRoomCloses(t *testing.T) {
	server := httptest.NewServer(newSignalServer(""))
	defer server.Close()
	room := "testRoom123"
	alice := joinParticipant(t, server.URL, room, "Алиса")
	bob := joinParticipant(t, server.URL, room, "Боб")

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/rooms/"+room+"/events?token="+bob.Token, nil)
	events, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer events.Body.Close()

	offer := []byte(`{"type":"offer","sdp":{"type":"offer","sdp":"v=0"}}`)
	response, err := http.Post(server.URL+"/rooms/"+room+"/signals?token="+alice.Token, "application/json", bytes.NewReader(offer))
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("signal failed: status=%d", response.StatusCode)
	}
	response.Body.Close()

	scanner := bufio.NewScanner(events.Body)
	found := false
	for scanner.Scan() {
		if strings.Contains(scanner.Text(), `"type":"offer"`) {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("offer was not relayed")
	}

	deleteParticipant(t, server.URL, room, alice.Token)
	deleteParticipant(t, server.URL, room, bob.Token)
	health, err := http.Get(server.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	defer health.Body.Close()
	var status struct {
		Rooms int `json:"rooms"`
	}
	_ = json.NewDecoder(health.Body).Decode(&status)
	if status.Rooms != 0 {
		t.Fatalf("room leaked: %d", status.Rooms)
	}
}

func TestRoomRejectsThirdParticipant(t *testing.T) {
	server := httptest.NewServer(newSignalServer(""))
	defer server.Close()
	room := "fullRoom123"
	joinParticipant(t, server.URL, room, "Первый")
	joinParticipant(t, server.URL, room, "Второй")
	response, err := http.Post(server.URL+"/rooms/"+room+"/participants", "application/json", strings.NewReader(`{"name":"Третий"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusConflict {
		t.Fatalf("unexpected status: %d", response.StatusCode)
	}
}

type joinedParticipant struct {
	Token string `json:"token"`
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

func deleteParticipant(t *testing.T, baseURL, room, token string) {
	t.Helper()
	request, _ := http.NewRequest(http.MethodDelete, baseURL+"/rooms/"+room+"/participants?token="+token, nil)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
}
