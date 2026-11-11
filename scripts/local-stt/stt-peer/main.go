// stt-peer: one of Lianki's speech servers reaching the pages that want it
// (docs/local-stt.md, "Lianki's speech servers for everyone").
//
// It dials OUT to the SttRegistry (wss://lianki.com/api/version/stt/worker;
// no inbound port on this machine), proves itself with its Ed25519 worker key,
// and waits. For each page the registry sends an offer: it answers over
// WebRTC (STUN; TURN when the page's servers include it), and bridges the
// page's DataChannel "stt" to the speech server's peer listener
// (server.py --peer-port, 127.0.0.1 only) one-to-one: text to text, binary to
// binary, the same protocol as the WebSocket routes. The page's v2 ticket goes
// along in Sec-WebSocket-Protocol, and server.py checks it itself
// (ticket.py): this bridge decides nothing about who may speak.
//
// Each final's audio length goes back to the registry ({t:"usage"}), which
// books it to the ticket's account. Never logs text, audio or tickets.
//
// Routes that come and go (docs/local-stt.md): it pings the registry ("ping",
// answered "pong" by the runtime) every PingEvery and redials when nothing came
// back for PingTimeout; a registry connection that drops does not end the
// sessions (they are peer to peer); and a second offer for a session it already
// has is the page's ICE restart (a new network): answered on the same peer
// connection, so the DataChannel and the speech server's socket go on.
//
//	stt-peer keygen [--key ~/.config/lianki-stt/worker.key]   prints the public key
//	stt-peer [--registry wss://lianki.com/api/version/stt/worker] [--key …]
//	         [--server ws://127.0.0.1:5189] [--stun stun:stun.cloudflare.com:3478] [--capacity 3]
package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/coder/websocket"
	"github.com/pion/webrtc/v4"
)

const (
	// AuthPrefix is what the worker signs before the registry's nonce (stt-registry.ts WORKER_AUTH_PREFIX).
	AuthPrefix = "lianki-stt-worker\n"
	// Subprotocol is the peer listener's (ticket.py V2_AUD's sockets).
	Subprotocol = "lianki-stt2"
	// Origin is what the bridge presents to server.py: the page it speaks for is a lianki.com page.
	Origin = "https://lianki.com"
	// Channel is the DataChannel label the page opens.
	Channel    = "stt"
	backoffMin = time.Second
	backoffMax = 30 * time.Second
	// maxQueued frames held while the speech server's socket opens (~2 min of 32 ms frames).
	maxQueued = 4096
	// PingEvery is how often the worker pings the registry (stt-registry.ts WORKER_SILENT_MS is 45 s).
	PingEvery = 15 * time.Second
	// PingTimeout: nothing from the registry for this long, and the connection is redialled.
	PingTimeout = 35 * time.Second
)

var b64 = base64.RawURLEncoding

// Config is the command line.
type Config struct {
	Registry string
	KeyPath  string
	Server   string
	Stun     []string
	Capacity int
}

func defaultKeyPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "lianki-stt", "worker.key")
}

// keyProblem is why this key file must not be used, or "" (as ticket.py file_problem).
func keyProblem(path string) string {
	st, err := os.Lstat(path)
	if err != nil {
		return "cannot read"
	}
	if st.Mode()&os.ModeSymlink != 0 {
		return "is a symlink"
	}
	if !st.Mode().IsRegular() {
		return "is not a regular file"
	}
	if st.Mode().Perm()&0o077 != 0 {
		return "is readable or writable by others"
	}
	if sys, ok := st.Sys().(*syscall.Stat_t); ok && int(sys.Uid) != os.Getuid() {
		return "is not owned by this user"
	}
	return ""
}

// LoadKey reads the worker key: the 32-byte Ed25519 seed, base64url, one line, 0600.
func LoadKey(path string) (ed25519.PrivateKey, error) {
	if why := keyProblem(path); why != "" {
		return nil, fmt.Errorf("the worker key %s", why)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	seed, err := b64.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil || len(seed) != ed25519.SeedSize {
		return nil, errors.New("the worker key is not an Ed25519 seed")
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

// Keygen writes a new key (never over an existing file) and returns its public half.
func Keygen(path string) (string, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", err
	}
	seed := make([]byte, ed25519.SeedSize)
	if _, err := rand.Read(seed); err != nil {
		return "", err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return "", fmt.Errorf("not writing %s: %w", path, err)
	}
	defer f.Close()
	if _, err := f.WriteString(b64.EncodeToString(seed) + "\n"); err != nil {
		return "", err
	}
	return PublicKey(ed25519.NewKeyFromSeed(seed)), nil
}

// PublicKey is the raw public key, base64url: what the stt_worker row holds.
func PublicKey(k ed25519.PrivateKey) string {
	return b64.EncodeToString(k.Public().(ed25519.PublicKey))
}

// Sign answers the registry's challenge.
func Sign(k ed25519.PrivateKey, nonce string) string {
	return b64.EncodeToString(ed25519.Sign(k, []byte(AuthPrefix+nonce)))
}

// msg is one registry message (either way).
type msg map[string]any

func (m msg) str(k string) string {
	s, _ := m[k].(string)
	return s
}

// Worker is one connection to the registry and the sessions it carries.
type Worker struct {
	cfg  Config
	key  ed25519.PrivateKey
	mu   sync.Mutex
	conn *websocket.Conn
	sess map[string]*session
	// newPC makes a peer connection (tests swap the ICE settings).
	newPC func(webrtc.Configuration) (*webrtc.PeerConnection, error)
	// pingEvery and pingTimeout (PingEvery, PingTimeout; tests shorten them).
	pingEvery, pingTimeout time.Duration
}

type session struct {
	sid    string
	pc     *webrtc.PeerConnection
	cancel context.CancelFunc
	once   sync.Once
}

// NewWorker is a worker with no connection yet.
func NewWorker(cfg Config, key ed25519.PrivateKey) *Worker {
	return &Worker{
		cfg: cfg, key: key, sess: map[string]*session{}, newPC: webrtc.NewPeerConnection,
		pingEvery: PingEvery, pingTimeout: PingTimeout,
	}
}

func (w *Worker) send(ctx context.Context, m msg) {
	b, _ := json.Marshal(m)
	w.mu.Lock()
	c := w.conn
	w.mu.Unlock()
	if c == nil {
		return
	}
	wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	_ = c.Write(wctx, websocket.MessageText, b)
}

// Run keeps one registry connection up until ctx ends: after a drop it dials
// again, waiting 1 s doubling to 30 s (reset once a connection was registered).
func (w *Worker) Run(ctx context.Context) {
	wait := backoffMin
	for ctx.Err() == nil {
		registered, err := w.once(ctx)
		if ctx.Err() != nil {
			return
		}
		log.Printf("registry: %v", err)
		if registered {
			wait = backoffMin
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		if wait *= 2; wait > backoffMax {
			wait = backoffMax
		}
	}
}

// once is one connection: dial, prove, serve until it closes.
func (w *Worker) once(ctx context.Context) (bool, error) {
	c, _, err := websocket.Dial(ctx, w.cfg.Registry, nil)
	if err != nil {
		return false, fmt.Errorf("dial: %w", err)
	}
	c.SetReadLimit(256 * 1024)
	defer c.CloseNow()
	w.mu.Lock()
	w.conn = c
	w.mu.Unlock()
	// The sessions stay: they are peer to peer, and the next connection carries their
	// signalling (an ICE restart) again. A session ends on its own peer connection.
	defer func() {
		w.mu.Lock()
		if w.conn == c {
			w.conn = nil
		}
		w.mu.Unlock()
	}()
	// Ping; a registry that says nothing for pingTimeout is gone without a close: redial.
	var mu sync.Mutex
	seen := time.Now()
	pctx, stopPing := context.WithCancel(ctx)
	defer stopPing()
	go func() {
		t := time.NewTicker(w.pingEvery)
		defer t.Stop()
		for {
			select {
			case <-pctx.Done():
				return
			case <-t.C:
				mu.Lock()
				quiet := time.Since(seen)
				mu.Unlock()
				if quiet > w.pingTimeout {
					log.Printf("registry: silent for %s, redialling", quiet.Round(time.Second))
					c.CloseNow()
					return
				}
				wctx, cancel := context.WithTimeout(pctx, 5*time.Second)
				_ = c.Write(wctx, websocket.MessageText, []byte("ping"))
				cancel()
			}
		}
	}()
	registered := false
	for {
		_, b, err := c.Read(ctx)
		if err != nil {
			return registered, err
		}
		mu.Lock()
		seen = time.Now()
		mu.Unlock()
		var m msg
		if json.Unmarshal(b, &m) != nil {
			continue
		}
		switch m.str("t") {
		case "challenge":
			w.send(ctx, msg{"t": "auth", "key": PublicKey(w.key), "sig": Sign(w.key, m.str("nonce"))})
		case "registered":
			registered = true
			log.Printf("registry: registered as %s", m.str("id"))
		case "offer":
			// In line, not a goroutine: the page's ICE right behind it needs the remote description.
			w.offer(ctx, m.str("sid"), m.str("sdp"), m.str("ticket"))
		case "ice":
			w.remoteICE(m.str("sid"), m["candidate"])
		case "close":
			w.end(m.str("sid"))
		}
	}
}

func (s *session) close() {
	s.once.Do(func() {
		s.cancel()
		if s.pc != nil {
			_ = s.pc.Close()
		}
	})
}

func (w *Worker) end(sid string) {
	w.mu.Lock()
	s := w.sess[sid]
	delete(w.sess, sid)
	w.mu.Unlock()
	if s != nil {
		s.close()
	}
}

func (w *Worker) remoteICE(sid string, raw any) {
	w.mu.Lock()
	s := w.sess[sid]
	w.mu.Unlock()
	if s == nil || s.pc == nil || raw == nil {
		return
	}
	b, _ := json.Marshal(raw)
	var c webrtc.ICECandidateInit
	if json.Unmarshal(b, &c) != nil || c.Candidate == "" {
		return
	}
	_ = s.pc.AddICECandidate(c)
}

// offer answers one page: a peer connection, its answer, and the bridge once the channel opens.
func (w *Worker) offer(ctx context.Context, sid, sdp, ticket string) {
	if sid == "" || sdp == "" || ticket == "" {
		return
	}
	w.mu.Lock()
	old := w.sess[sid]
	busy := len(w.sess) >= w.cfg.Capacity
	w.mu.Unlock()
	if old != nil && old.pc != nil {
		w.restart(ctx, old, sdp)
		return
	}
	if busy {
		w.send(ctx, msg{"t": "end", "sid": sid, "reason": "busy"})
		return
	}
	sctx, cancel := context.WithCancel(ctx)
	s := &session{sid: sid, cancel: cancel}
	var ice []webrtc.ICEServer
	if len(w.cfg.Stun) > 0 {
		ice = append(ice, webrtc.ICEServer{URLs: w.cfg.Stun})
	}
	pc, err := w.newPC(webrtc.Configuration{ICEServers: ice})
	if err != nil {
		cancel()
		w.send(ctx, msg{"t": "end", "sid": sid, "reason": "peer"})
		return
	}
	s.pc = pc
	w.mu.Lock()
	w.sess[sid] = s
	w.mu.Unlock()
	fail := func(reason string) {
		w.send(ctx, msg{"t": "end", "sid": sid, "reason": reason})
		go w.end(sid) // not inside a pion callback: Close waits for them
	}
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c != nil {
			w.send(ctx, msg{"t": "ice", "sid": sid, "candidate": c.ToJSON()})
		}
	})
	pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		if st == webrtc.PeerConnectionStateFailed || st == webrtc.PeerConnectionStateClosed {
			fail(st.String())
		}
	})
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		if dc.Label() != Channel {
			_ = dc.Close()
			return
		}
		w.bridge(sctx, sid, ticket, dc)
	})
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: sdp}); err != nil {
		fail("bad offer")
		return
	}
	answer, err := pc.CreateAnswer(nil)
	if err == nil {
		err = pc.SetLocalDescription(answer)
	}
	if err != nil {
		fail("answer")
		return
	}
	w.send(ctx, msg{"t": "answer", "sid": sid, "sdp": answer.SDP})
}

// restart answers a page's new offer on a session it already has: an ICE restart
// (the page changed networks). The peer connection, its DataChannel and the
// speech server's socket go on; only the ICE path is new.
func (w *Worker) restart(ctx context.Context, s *session, sdp string) {
	err := s.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: sdp})
	var answer webrtc.SessionDescription
	if err == nil {
		answer, err = s.pc.CreateAnswer(nil)
	}
	if err == nil {
		err = s.pc.SetLocalDescription(answer)
	}
	if err != nil {
		w.send(ctx, msg{"t": "end", "sid": s.sid, "reason": "restart"})
		go w.end(s.sid)
		return
	}
	log.Printf("session %s…: ICE restart", s.sid[:4])
	w.send(ctx, msg{"t": "answer", "sid": s.sid, "sdp": answer.SDP})
}

type frame struct {
	text bool
	data []byte
}

// bridge joins the page's channel to a fresh socket on the speech server's peer listener.
func (w *Worker) bridge(ctx context.Context, sid, ticket string, dc *webrtc.DataChannel) {
	q := make(chan frame, maxQueued)
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		select {
		case q <- frame{text: m.IsString, data: m.Data}:
		default: // the server never came up and the page keeps talking: drop, it falls back
		}
	})
	dc.OnClose(func() { go w.end(sid) })
	dc.OnOpen(func() {
		go func() {
			dctx, cancel := context.WithTimeout(ctx, 5*time.Second)
			ws, _, err := websocket.Dial(dctx, w.cfg.Server, &websocket.DialOptions{
				Subprotocols: []string{Subprotocol, ticket},
				HTTPHeader:   map[string][]string{"Origin": {Origin}},
			})
			cancel()
			if err != nil {
				_ = dc.SendText(`{"t":"error","error":"speech server unreachable"}`)
				w.end(sid)
				return
			}
			ws.SetReadLimit(4 * 1024 * 1024)
			go func() {
				<-ctx.Done()
				ws.CloseNow()
			}()
			// Page → server, in order, the frames held while connecting first.
			go func() {
				for {
					select {
					case <-ctx.Done():
						return
					case f := <-q:
						t := websocket.MessageBinary
						if f.text {
							t = websocket.MessageText
						}
						if ws.Write(ctx, t, f.data) != nil {
							w.end(sid)
							return
						}
					}
				}
			}()
			// Server → page; each final's audio length is booked.
			for {
				t, b, err := ws.Read(ctx)
				if err != nil {
					w.end(sid)
					return
				}
				if t == websocket.MessageText {
					if ms := finalAudioMs(b); ms > 0 {
						w.send(ctx, msg{"t": "usage", "sid": sid, "audioMs": ms})
					}
					_ = dc.SendText(string(b))
				} else {
					_ = dc.Send(b)
				}
			}
		}()
	})
}

// finalAudioMs is a final's audio length (ms), or 0 for anything else. Reads no text.
func finalAudioMs(b []byte) float64 {
	var m struct {
		T       string  `json:"t"`
		AudioMs float64 `json:"audioMs"`
	}
	if json.Unmarshal(b, &m) != nil || m.T != "final" || m.AudioMs <= 0 {
		return 0
	}
	return m.AudioMs
}

func main() {
	log.SetFlags(log.Ltime)
	args := os.Args[1:]
	if len(args) > 0 && args[0] == "keygen" {
		fs := flag.NewFlagSet("keygen", flag.ExitOnError)
		path := fs.String("key", defaultKeyPath(), "where to write the worker key (0600, never overwritten)")
		_ = fs.Parse(args[1:])
		pub, err := Keygen(*path)
		if err != nil {
			log.Fatal(err)
		}
		fmt.Println(pub) // the public half only: what the stt_worker row holds
		return
	}
	fs := flag.NewFlagSet("stt-peer", flag.ExitOnError)
	reg := fs.String("registry", "wss://lianki.com/api/version/stt/worker", "the SttRegistry")
	keyPath := fs.String("key", defaultKeyPath(), "the worker key")
	server := fs.String("server", "ws://127.0.0.1:5189", "server.py's peer listener")
	stun := fs.String("stun", "stun:stun.cloudflare.com:3478", "STUN servers, comma separated")
	capacity := fs.Int("capacity", 3, "sessions at once (the registry also counts)")
	_ = fs.Parse(args)
	key, err := LoadKey(*keyPath)
	if err != nil {
		log.Fatal(err)
	}
	var stuns []string
	for _, s := range strings.Split(*stun, ",") {
		if s = strings.TrimSpace(s); s != "" {
			stuns = append(stuns, s)
		}
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	log.Printf("stt-peer: key %s, server %s, capacity %d", PublicKey(key), *server, *capacity)
	NewWorker(Config{Registry: *reg, KeyPath: *keyPath, Server: *server, Stun: stuns, Capacity: *capacity}, key).Run(ctx)
}
