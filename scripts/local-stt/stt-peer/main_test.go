package main

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/pion/webrtc/v4"
)

func TestKeygenAndLoad(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "k", "worker.key")
	pub, err := Keygen(p)
	if err != nil {
		t.Fatal(err)
	}
	if len(pub) != 43 {
		t.Fatalf("public key %q is not 32 bytes base64url", pub)
	}
	if _, err := Keygen(p); err == nil {
		t.Fatal("keygen overwrote an existing key")
	}
	k, err := LoadKey(p)
	if err != nil || PublicKey(k) != pub {
		t.Fatalf("load: %v", err)
	}
	st, _ := os.Stat(p)
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", st.Mode().Perm())
	}
	_ = os.Chmod(p, 0o644)
	if _, err := LoadKey(p); err == nil || !strings.Contains(err.Error(), "readable") {
		t.Fatalf("a loose key was loaded: %v", err)
	}
	link := filepath.Join(dir, "link")
	_ = os.Chmod(p, 0o600)
	_ = os.Symlink(p, link)
	if _, err := LoadKey(link); err == nil || !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("a symlinked key was loaded: %v", err)
	}
}

func TestSignMatchesTheRegistry(t *testing.T) {
	_, k, _ := ed25519.GenerateKey(nil)
	sig, _ := b64.DecodeString(Sign(k, "n1"))
	if !ed25519.Verify(k.Public().(ed25519.PublicKey), []byte("lianki-stt-worker\nn1"), sig) {
		t.Fatal("signature does not verify over the registry's message")
	}
}

func TestFinalAudioMs(t *testing.T) {
	for in, want := range map[string]float64{
		`{"t":"final","audioMs":1234,"text":"x"}`: 1234,
		`{"t":"partial","audioMs":400}`:           0,
		`{"t":"final","audioMs":-1}`:              0,
		`nope`:                                    0,
	} {
		if got := finalAudioMs([]byte(in)); got != want {
			t.Errorf("%s: %v, want %v", in, got, want)
		}
	}
}

// A fake speech server: checks the subprotocol, the ticket beside it and the
// Origin, says ready, and answers each end with a final of 1500 ms.
func speechServer(t *testing.T, ticket string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		protos := r.Header.Get("Sec-WebSocket-Protocol")
		if r.Header.Get("Origin") != Origin || !strings.Contains(protos, ticket) {
			http.Error(w, "no", http.StatusUnauthorized)
			return
		}
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			Subprotocols:       []string{Subprotocol},
			InsecureSkipVerify: true,
		})
		if err != nil {
			return
		}
		ctx := r.Context()
		_ = c.Write(ctx, websocket.MessageText, []byte(`{"t":"ready","engine":"fake"}`))
		frames := 0
		for {
			typ, b, err := c.Read(ctx)
			if err != nil {
				return
			}
			if typ == websocket.MessageBinary {
				frames++
				continue
			}
			var m msg
			_ = json.Unmarshal(b, &m)
			if m.str("t") == "end" {
				out, _ := json.Marshal(msg{"t": "final", "id": m["id"], "text": "ok", "audioMs": 1500, "frames": frames})
				_ = c.Write(ctx, websocket.MessageText, out)
			}
		}
	}))
}

// A fake registry: the challenge and its check, then hands offers to the
// worker and its answers and candidates back to the test's page.
type fakeRegistry struct {
	t        *testing.T
	pub      ed25519.PublicKey
	mu       sync.Mutex
	conn     *websocket.Conn
	fromPeer chan msg
	authed   chan struct{}
}

func (f *fakeRegistry) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	ctx := r.Context()
	_ = c.Write(ctx, websocket.MessageText, []byte(`{"t":"challenge","nonce":"abc"}`))
	_, b, err := c.Read(ctx)
	if err != nil {
		return
	}
	var m msg
	_ = json.Unmarshal(b, &m)
	sig, _ := b64.DecodeString(m.str("sig"))
	if m.str("t") != "auth" || !ed25519.Verify(f.pub, []byte(AuthPrefix+"abc"), sig) {
		c.Close(4401, "bad")
		return
	}
	_ = c.Write(ctx, websocket.MessageText, []byte(`{"t":"registered","id":"test"}`))
	f.mu.Lock()
	f.conn = c
	f.mu.Unlock()
	close(f.authed)
	for {
		_, b, err := c.Read(ctx)
		if err != nil {
			return
		}
		var m msg
		if json.Unmarshal(b, &m) == nil {
			f.fromPeer <- m
		}
	}
}

func (f *fakeRegistry) toPeer(m msg) {
	b, _ := json.Marshal(m)
	f.mu.Lock()
	c := f.conn
	f.mu.Unlock()
	_ = c.Write(context.Background(), websocket.MessageText, b)
}

func TestPageToSpeechServerOverWebRTC(t *testing.T) {
	const ticket = "payload.sig"
	speech := speechServer(t, ticket)
	defer speech.Close()
	_, key, _ := ed25519.GenerateKey(nil)
	reg := &fakeRegistry{t: t, pub: key.Public().(ed25519.PublicKey), fromPeer: make(chan msg, 64), authed: make(chan struct{})}
	regSrv := httptest.NewServer(reg)
	defer regSrv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	w := NewWorker(Config{
		Registry: "ws" + strings.TrimPrefix(regSrv.URL, "http"),
		Server:   "ws" + strings.TrimPrefix(speech.URL, "http"),
		Capacity: 1,
	}, key)
	go w.Run(ctx)
	select {
	case <-reg.authed:
	case <-ctx.Done():
		t.Fatal("never registered")
	}

	// The page: an offer with a DataChannel "stt", host candidates only (loopback).
	page, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer page.Close()
	dc, _ := page.CreateDataChannel(Channel, nil)
	got := make(chan string, 8)
	dc.OnMessage(func(m webrtc.DataChannelMessage) { got <- string(m.Data) })
	opened := make(chan struct{})
	dc.OnOpen(func() { close(opened) })
	page.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c != nil {
			reg.toPeer(msg{"t": "ice", "sid": "s1234567890abcdef", "candidate": c.ToJSON()})
		}
	})
	offer, _ := page.CreateOffer(nil)
	_ = page.SetLocalDescription(offer)
	reg.toPeer(msg{"t": "offer", "sid": "s1234567890abcdef", "sdp": offer.SDP, "ticket": ticket})

	// A second page while at capacity: refused, the first goes on.
	usage := make(chan float64, 1)
	go func() {
		for m := range reg.fromPeer {
			switch m.str("t") {
			case "answer":
				_ = page.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: m.str("sdp")})
			case "ice":
				b, _ := json.Marshal(m["candidate"])
				var c webrtc.ICECandidateInit
				_ = json.Unmarshal(b, &c)
				_ = page.AddICECandidate(c)
			case "usage":
				ms, _ := m["audioMs"].(float64)
				usage <- ms
			case "end":
				got <- "end:" + m.str("reason")
			}
		}
	}()
	select {
	case <-opened:
	case <-ctx.Done():
		t.Fatal("the channel never opened")
	}
	reg.toPeer(msg{"t": "offer", "sid": "s2234567890abcdef", "sdp": offer.SDP, "ticket": ticket})
	waitFor(t, ctx, got, "end:busy")

	waitFor(t, ctx, got, `{"t":"ready","engine":"fake"}`)
	_ = dc.SendText(`{"t":"begin","id":1}`)
	_ = dc.Send([]byte{1, 0, 0, 0, 0})
	_ = dc.Send([]byte{1, 0, 0, 0, 0})
	_ = dc.SendText(`{"t":"end","id":1}`)
	final := waitFor(t, ctx, got, `"t":"final"`)
	if !strings.Contains(final, `"frames":2`) {
		t.Fatalf("frames lost or reordered: %s", final)
	}
	select {
	case ms := <-usage:
		if ms != 1500 {
			t.Fatalf("usage %v", ms)
		}
	case <-ctx.Done():
		t.Fatal("no usage booked")
	}
}

func waitFor(t *testing.T, ctx context.Context, got chan string, want string) string {
	t.Helper()
	for {
		select {
		case s := <-got:
			if strings.Contains(s, want) {
				return s
			}
		case <-ctx.Done():
			t.Fatalf("never got %s", want)
		}
	}
}
