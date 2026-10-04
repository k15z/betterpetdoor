package doorcontrol

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/k15z/betterpetdoor/internal/providers/wayzn"
)

type fakeStore struct {
	mu   sync.Mutex
	data map[string][]byte
	fail bool
}

func (s *fakeStore) CameraState(_ context.Context, id string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]byte(nil), s.data[id]...), nil
}
func (s *fakeStore) SaveCameraState(_ context.Context, id string, b []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fail {
		return errors.New("disk full")
	}
	s.data[id] = append([]byte(nil), b...)
	return nil
}

type fakeProvider struct {
	status                wayzn.Status
	commands              []string
	readErr, errorCommand error
	onCommand             func(string)
	onRead                func()
}

func (p *fakeProvider) ReadStatus(context.Context) (wayzn.Status, error) {
	if p.onRead != nil {
		p.onRead()
	}
	return p.status, p.readErr
}
func (p *fakeProvider) Command(_ context.Context, cmd string) error {
	p.commands = append(p.commands, cmd)
	if p.onCommand != nil {
		p.onCommand(cmd)
	}
	return p.errorCommand
}
func boolp(b bool) *bool { return &b }
func closedStatus() wayzn.Status {
	return wayzn.Status{State: "closed", Online: boolp(true), Open: boolp(false)}
}
func openStatus() wayzn.Status {
	return wayzn.Status{State: "open", Online: boolp(true), Open: boolp(true), SafeToClose: boolp(true)}
}
func setup(t *testing.T) (*Controller, *fakeStore, *fakeProvider, *time.Time) {
	t.Helper()
	now := time.Date(2026, 10, 3, 20, 0, 0, 0, time.UTC)
	store := &fakeStore{data: map[string][]byte{}}
	p := &fakeProvider{status: closedStatus()}
	c := New(store, func(context.Context, string) (Provider, error) { return p, nil }, func() time.Time { return now })
	return c, store, p, &now
}
func arm(t *testing.T, c *Controller) {
	t.Helper()
	s, err := c.Arm(context.Background(), "door", "session-one", 0)
	if err != nil || !s.Armed || s.AutoCloseSeconds != 300 {
		t.Fatalf("arm: %+v %v", s, err)
	}
}
func detect(t *testing.T, c *Controller, event string) State {
	t.Helper()
	s, err := c.Detect(context.Background(), "door", "session-one", event)
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func requestClose(t *testing.T, c *Controller) {
	t.Helper()
	if _, err := c.CheckClose(context.Background(), "door"); err != nil {
		t.Fatal(err)
	}
}
func TestDuplicateDetectionFixedDeadline(t *testing.T) {
	c, _, p, now := setup(t)
	arm(t, c)
	a := detect(t, c, "event-one")
	*now = now.Add(10 * time.Second)
	b := detect(t, c, "event-one")
	d := detect(t, c, "event-two")
	if len(p.commands) != 1 || p.commands[0] != "open" || !a.CloseDueAt.Equal(*b.CloseDueAt) || !a.CloseDueAt.Equal(*d.CloseDueAt) {
		t.Fatalf("duplicate changed command/deadline: %v %+v %+v", p.commands, a, d)
	}
}
func TestTwoClientsAndExpiredLease(t *testing.T) {
	c, _, p, now := setup(t)
	arm(t, c)
	if _, err := c.Arm(context.Background(), "door", "session-two", 300); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	if _, err := c.Detect(context.Background(), "door", "session-two", "event-two"); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	*now = now.Add(LeaseDuration)
	if _, err := c.Detect(context.Background(), "door", "session-one", "event-one"); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	if _, err := c.Heartbeat(context.Background(), "door", "session-one"); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	if _, err := c.Arm(context.Background(), "door", "session-two", 300); err != nil {
		t.Fatal(err)
	}
	if len(p.commands) != 0 {
		t.Fatal(p.commands)
	}
}
func TestHeartbeatKeepsLease(t *testing.T) {
	c, _, _, now := setup(t)
	arm(t, c)
	*now = now.Add(30 * time.Second)
	if _, err := c.Heartbeat(context.Background(), "door", "session-one"); err != nil {
		t.Fatal(err)
	}
	*now = now.Add(30 * time.Second)
	detect(t, c, "event-one")
}
func TestStopCameraRetainsCloseAndCancelRemovesIt(t *testing.T) {
	for _, cancel := range []bool{false, true} {
		t.Run(map[bool]string{false: "stop", true: "cancel"}[cancel], func(t *testing.T) {
			c, _, p, now := setup(t)
			arm(t, c)
			detect(t, c, "event-one")
			var s State
			var err error
			if cancel {
				s, err = c.CancelClose(context.Background(), "door")
			} else {
				s, err = c.Disarm(context.Background(), "door", "session-one")
			}
			if err != nil || s.Armed || ((s.CloseDueAt == nil) != cancel) {
				t.Fatalf("%+v %v", s, err)
			}
			p.status = openStatus()
			*now = now.Add(5 * time.Minute)
			requestClose(t, c)
			want := 2
			if cancel {
				want = 1
			}
			if len(p.commands) != want {
				t.Fatal(p.commands)
			}
		})
	}
}
func TestManualOverridesEvenFailure(t *testing.T) {
	for _, cmd := range []string{"open", "close", "open_and_close"} {
		for _, fail := range []bool{false, true} {
			t.Run(cmd+map[bool]string{false: "", true: " failure"}[fail], func(t *testing.T) {
				c, _, p, now := setup(t)
				arm(t, c)
				detect(t, c, "event-one")
				p.status = openStatus()
				if fail {
					p.errorCommand = errors.New("timeout")
				}
				err := c.Command(context.Background(), "door", cmd)
				if (err != nil) != fail {
					t.Fatal(err)
				}
				s, _ := c.State(context.Background(), "door")
				if s.Armed || s.CloseDueAt != nil {
					t.Fatalf("override %+v", s)
				}
				*now = now.Add(10 * time.Minute)
				requestClose(t, c)
				if len(p.commands) != 2 {
					t.Fatal(p.commands)
				}
				if _, err := c.Detect(context.Background(), "door", "session-one", "event-two"); !errors.Is(err, ErrConflict) {
					t.Fatal(err)
				}
			})
		}
	}
}
func TestRestartRecoveryVerifiesSafetyAndConfirmation(t *testing.T) {
	c, store, p, now := setup(t)
	arm(t, c)
	detect(t, c, "event-one")
	p.status = openStatus()
	*now = now.Add(10 * time.Minute)
	restarted := New(store, c.provider, c.now)
	requestClose(t, restarted)
	if len(p.commands) != 2 || p.commands[1] != "close" {
		t.Fatal(p.commands)
	}
	s, _ := restarted.State(context.Background(), "door")
	if s.CloseDueAt == nil || s.Status != "closing" {
		t.Fatalf("must await confirmation: %+v", s)
	}
	*now = now.Add(15 * time.Second)
	p.status = closedStatus()
	requestClose(t, restarted)
	s, _ = restarted.State(context.Background(), "door")
	if s.CloseDueAt != nil || s.Status != "closed" {
		t.Fatalf("%+v", s)
	}
}
func TestAutomaticCloseHoldsUnsafeUnknownOrMoving(t *testing.T) {
	cases := map[string]wayzn.Status{"unknown": {}, "online unknown": openStatus(), "offline": openStatus(), "moving": openStatus(), "safety unknown": openStatus(), "unsafe": openStatus(), "obstructed": openStatus()}
	v := cases["online unknown"]
	v.Online = nil
	cases["online unknown"] = v
	v = cases["offline"]
	v.Online = boolp(false)
	cases["offline"] = v
	v = cases["moving"]
	v.Moving = true
	cases["moving"] = v
	v = cases["safety unknown"]
	v.SafeToClose = nil
	cases["safety unknown"] = v
	v = cases["unsafe"]
	v.SafeToClose = boolp(false)
	cases["unsafe"] = v
	v = cases["obstructed"]
	v.State = "obstructed"
	cases["obstructed"] = v
	for name, status := range cases {
		t.Run(name, func(t *testing.T) {
			c, _, p, now := setup(t)
			arm(t, c)
			detect(t, c, "event-one")
			p.status = status
			*now = now.Add(5 * time.Minute)
			requestClose(t, c)
			s, _ := c.State(context.Background(), "door")
			if len(p.commands) != 1 || s.CloseDueAt == nil || s.Status != "close_held" {
				t.Fatalf("%v %+v", p.commands, s)
			}
			p.status = openStatus()
			*now = now.Add(15 * time.Second)
			requestClose(t, c)
			if len(p.commands) != 2 {
				t.Fatal(p.commands)
			}
		})
	}
}
func TestDoesNotClaimAlreadyOpenDoor(t *testing.T) {
	c, _, p, _ := setup(t)
	p.status = openStatus()
	arm(t, c)
	s := detect(t, c, "event-one")
	if len(p.commands) > 0 || s.CloseDueAt != nil || s.Status != "open_held" {
		t.Fatalf("%v %+v", p.commands, s)
	}
}
func TestPersistBeforeOpenAndDoNotOpenIfPersistenceFails(t *testing.T) {
	c, store, p, _ := setup(t)
	arm(t, c)
	p.onCommand = func(cmd string) {
		var r record
		b, _ := store.CameraState(context.Background(), "door")
		if jsonErr := json.Unmarshal(b, &r); jsonErr != nil || r.CloseDueAt == nil {
			t.Fatalf("command without intent: %v", jsonErr)
		}
	}
	detect(t, c, "event-one")
	c, store, p, _ = setup(t)
	arm(t, c)
	store.fail = true
	if _, err := c.Detect(context.Background(), "door", "session-one", "event-one"); err == nil {
		t.Fatal("want disk failure")
	}
	if len(p.commands) > 0 {
		t.Fatal(p.commands)
	}
}
func TestAmbiguousOpenAndCloseNotRetried(t *testing.T) {
	c, store, p, now := setup(t)
	arm(t, c)
	p.errorCommand = errors.New("timeout")
	s, err := c.Detect(context.Background(), "door", "session-one", "event-one")
	if !errors.Is(err, ErrProvider) || s.CloseDueAt == nil || s.Status != "open_unconfirmed" {
		t.Fatalf("%+v %v", s, err)
	}
	p.status = openStatus()
	*now = now.Add(5 * time.Minute)
	requestClose(t, c)
	restarted := New(store, c.provider, c.now)
	*now = now.Add(time.Minute)
	requestClose(t, restarted)
	s, _ = restarted.State(context.Background(), "door")
	if len(p.commands) != 2 || s.Status != "close_unconfirmed" || s.CloseDueAt == nil {
		t.Fatalf("%v %+v", p.commands, s)
	}
}
func TestConcurrentRequestsSerializedAcrossNewProviderClients(t *testing.T) {
	c, store, p, _ := setup(t)
	arm(t, c)
	started := make(chan struct{})
	release := make(chan struct{})
	p.onCommand = func(cmd string) {
		if cmd == "open" {
			p.status = openStatus()
			close(started)
			<-release
		}
	}
	detected := make(chan error, 1)
	go func() { _, err := c.Detect(context.Background(), "door", "session-one", "event-one"); detected <- err }()
	<-started
	manual := make(chan error, 1)
	go func() { manual <- c.Command(context.Background(), "door", "close") }()
	close(release)
	if err := <-detected; err != nil {
		t.Fatal(err)
	}
	if err := <-manual; err != nil {
		t.Fatal(err)
	}
	s, _ := c.State(context.Background(), "door")
	if s.CloseDueAt != nil || s.Armed || len(p.commands) != 2 {
		t.Fatalf("%+v %v", s, p.commands)
	}
	if len(store.data) == 0 {
		t.Fatal("missing persisted state")
	}
}
func TestValidation(t *testing.T) {
	c, _, _, _ := setup(t)
	for _, seconds := range []int{-1, 1, 59, 3601} {
		if _, err := c.Arm(context.Background(), "door", "session-one", seconds); !errors.Is(err, ErrInvalid) {
			t.Fatalf("%d: %v", seconds, err)
		}
	}
	if _, err := c.Arm(context.Background(), "door", "bad", 300); !errors.Is(err, ErrInvalid) {
		t.Fatal(err)
	}
}

func TestManualCloseRequiresFreshProviderSafety(t *testing.T) {
	cases := []struct {
		name   string
		modify func(*fakeProvider)
	}{
		{"unknown", func(p *fakeProvider) { p.status = wayzn.Status{} }},
		{"offline", func(p *fakeProvider) { p.status.Online = boolp(false) }},
		{"online unknown", func(p *fakeProvider) { p.status.Online = nil }},
		{"moving", func(p *fakeProvider) { p.status.Moving = true }},
		{"unsafe", func(p *fakeProvider) { p.status.SafeToClose = boolp(false) }},
		{"safety unknown", func(p *fakeProvider) { p.status.SafeToClose = nil }},
		{"state unknown", func(p *fakeProvider) { p.status.State = "unknown" }},
		{"failed read", func(p *fakeProvider) { p.readErr = errors.New("timeout") }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, _, p, _ := setup(t)
			arm(t, c)
			detect(t, c, "event-one")
			p.status = openStatus()
			tc.modify(p)
			err := c.Command(context.Background(), "door", "close")
			if !errors.Is(err, ErrUnsafe) {
				t.Fatalf("expected safety hold: %v", err)
			}
			state, _ := c.State(context.Background(), "door")
			if len(p.commands) != 1 || state.Armed || state.CloseDueAt != nil || state.Status != "manual_close_held" {
				t.Fatalf("%v %+v", p.commands, state)
			}
		})
	}
	t.Run("safe", func(t *testing.T) {
		c, _, p, _ := setup(t)
		p.status = openStatus()
		if err := c.Command(context.Background(), "door", "close"); err != nil {
			t.Fatal(err)
		}
		if len(p.commands) != 1 || p.commands[0] != "close" {
			t.Fatal(p.commands)
		}
	})
	t.Run("already closed", func(t *testing.T) {
		c, _, p, _ := setup(t)
		if err := c.Command(context.Background(), "door", "close"); err != nil {
			t.Fatal(err)
		}
		if len(p.commands) != 0 {
			t.Fatal(p.commands)
		}
	})
}
func TestPersistFailureBeforeAutoCloseSendsNoClose(t *testing.T) {
	c, store, p, now := setup(t)
	arm(t, c)
	detect(t, c, "event-one")
	p.status = openStatus()
	*now = now.Add(5 * time.Minute)
	store.fail = true
	if _, err := c.CheckClose(context.Background(), "door"); err == nil {
		t.Fatal("expected storage failure")
	}
	if len(p.commands) != 1 {
		t.Fatal(p.commands)
	}
}

func TestAutomaticOpenRequiresKnownClosedOnlineStationary(t *testing.T) {
	cases := []struct {
		name   string
		modify func(*fakeProvider)
	}{
		{"unknown", func(p *fakeProvider) { p.status = wayzn.Status{} }},
		{"offline", func(p *fakeProvider) { p.status.Online = boolp(false) }},
		{"online unknown", func(p *fakeProvider) { p.status.Online = nil }},
		{"moving", func(p *fakeProvider) { p.status.Moving = true }},
		{"position unknown", func(p *fakeProvider) { p.status.Open = nil }},
		{"state unknown", func(p *fakeProvider) { p.status.State = "unknown" }},
		{"already open", func(p *fakeProvider) { p.status = openStatus() }},
		{"failed read", func(p *fakeProvider) { p.readErr = errors.New("timeout") }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, _, p, _ := setup(t)
			arm(t, c)
			tc.modify(p)
			state, err := c.Detect(context.Background(), "door", "session-one", "event-one")
			if err != nil && !errors.Is(err, ErrProvider) {
				t.Fatal(err)
			}
			if len(p.commands) != 0 || state.CloseDueAt != nil || state.Status != "open_held" {
				t.Fatalf("%v %+v", p.commands, state)
			}
		})
	}
}
