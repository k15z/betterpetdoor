package httpapi

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/k15z/betterpetdoor/internal/auth"
	"github.com/k15z/betterpetdoor/internal/database"
	"github.com/k15z/betterpetdoor/internal/doorcontrol"
	"github.com/k15z/betterpetdoor/internal/providers/wayzn"
)

type cameraTestProvider struct {
	commands []string
	open     bool
	unsafe   bool
}

func (p *cameraTestProvider) ReadStatus(context.Context) (wayzn.Status, error) {
	online, safe, open := true, !p.unsafe, p.open
	state := "closed"
	if open {
		state = "open"
	}
	return wayzn.Status{State: state, Online: &online, Open: &open, SafeToClose: &safe}, nil
}
func (p *cameraTestProvider) Command(_ context.Context, cmd string) error {
	p.commands = append(p.commands, cmd)
	p.open = cmd == "open"
	return nil
}
func cameraServer(t *testing.T) (*Server, *cameraTestProvider) {
	t.Helper()
	db, err := database.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := db.CreateDoor(context.Background(), database.Door{ID: "door", Name: "Test", Provider: "wayzn", EncryptedCredentials: []byte("fake"), CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	a := auth.New(db)
	if err := a.SetPassword(context.Background(), testPassword); err != nil {
		t.Fatal(err)
	}
	p := &cameraTestProvider{}
	return New(Config{Database: db, Auth: a, ProviderFactory: func(context.Context, string) (doorcontrol.Provider, error) { return p, nil }}), p
}
func cameraRequest(s *Server, method, path, body string, auth bool) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	if auth {
		r.Header.Set("Authorization", "Bearer "+testPassword)
	}
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	return w
}
func TestCameraRoutesAuthenticationAndValidation(t *testing.T) {
	s, _ := cameraServer(t)
	for _, path := range []string{"/api/doors/door/camera", "/api/doors/door/camera/arm", "/api/doors/door/camera/detections", "/api/doors/door/camera/cancel-close"} {
		w := cameraRequest(s, "POST", path, `{}`, false)
		if w.Code != 401 {
			t.Fatalf("%s %d", path, w.Code)
		}
	}
	for _, tc := range []struct {
		method, path, body string
		code               int
	}{{"GET", "/api/doors/missing/camera", "", 404}, {"POST", "/api/doors/door/camera/arm", `{"session_id":"valid-session","auto_close_seconds":1}`, 400}, {"POST", "/api/doors/door/camera/arm", `{"session_id":"valid-session","frames":"private"}`, 400}, {"POST", "/api/doors/door/camera/heartbeat", `{"session_id":"valid-session"}`, 409}, {"POST", "/api/doors/door/camera/nope", `{}`, 404}} {
		w := cameraRequest(s, tc.method, tc.path, tc.body, true)
		if w.Code != tc.code {
			t.Fatalf("%s got %d: %s", tc.path, w.Code, w.Body.String())
		}
	}
}
func TestRESTAndMCPManualCommandsShareCameraCoordinator(t *testing.T) {
	for _, useMCP := range []bool{false, true} {
		t.Run(map[bool]string{false: "REST", true: "MCP"}[useMCP], func(t *testing.T) {
			s, p := cameraServer(t)
			for _, tc := range []struct{ path, body string }{{"arm", `{"session_id":"valid-session"}`}, {"detections", `{"session_id":"valid-session","event_id":"event-one"}`}} {
				w := cameraRequest(s, "POST", "/api/doors/door/camera/"+tc.path, tc.body, true)
				if w.Code != 200 {
					t.Fatal(w.Body.String())
				}
			}
			if useMCP {
				_, _, err := s.mcpDoorCommand(context.Background(), mcpDoorInput{DoorID: "door"}, "close")
				if err != nil {
					t.Fatal(err)
				}
			} else {
				w := cameraRequest(s, "POST", "/api/doors/door/commands/close", "", true)
				if w.Code != 200 {
					t.Fatal(w.Body.String())
				}
			}
			w := cameraRequest(s, "GET", "/api/doors/door/camera", "", true)
			var state doorcontrol.State
			if err := json.Unmarshal(w.Body.Bytes(), &state); err != nil {
				t.Fatal(err)
			}
			if state.Armed || state.CloseDueAt != nil || len(p.commands) != 2 {
				t.Fatalf("%+v %v", state, p.commands)
			}
		})
	}
}
func TestDeleteDoorCascadesCameraState(t *testing.T) {
	s, _ := cameraServer(t)
	w := cameraRequest(s, "POST", "/api/doors/door/camera/arm", `{"session_id":"valid-session"}`, true)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	w = cameraRequest(s, "DELETE", "/api/doors/door", "", true)
	if w.Code != 204 {
		t.Fatal(w.Body.String())
	}
	ids, err := s.db.CameraDoorIDs(context.Background())
	if err != nil || len(ids) != 0 {
		t.Fatalf("%v %v", ids, err)
	}
}
func TestCameraHTTPStopPreservesClose(t *testing.T) {
	s, _ := cameraServer(t)
	for _, tc := range []struct{ action, body string }{{"arm", `{"session_id":"valid-session","auto_close_seconds":120}`}, {"detections", `{"session_id":"valid-session","event_id":"event-one"}`}, {"disarm", `{"session_id":"valid-session"}`}} {
		w := cameraRequest(s, "POST", "/api/doors/door/camera/"+tc.action, tc.body, true)
		if w.Code != 200 {
			t.Fatal(w.Body.String())
		}
	}
	state, _ := s.control.State(context.Background(), "door")
	if state.Armed || state.CloseDueAt == nil || state.AutoCloseSeconds != 120 {
		t.Fatalf("%+v", state)
	}
	w := cameraRequest(s, "POST", "/api/doors/door/camera/cancel-close", `{}`, true)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	state, _ = s.control.State(context.Background(), "door")
	if state.CloseDueAt != nil {
		t.Fatal("close not cancelled")
	}
}

func TestManualCloseRejectsSafetyChangeAfterUIPoll(t *testing.T) {
	s, p := cameraServer(t)
	for _, tc := range []struct{ action, body string }{{"arm", `{"session_id":"valid-session"}`}, {"detections", `{"session_id":"valid-session","event_id":"event-one"}`}} {
		w := cameraRequest(s, "POST", "/api/doors/door/camera/"+tc.action, tc.body, true)
		if w.Code != 200 {
			t.Fatal(w.Body.String())
		}
	}
	w := cameraRequest(s, "GET", "/api/doors/door/status", "", true)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"safe_to_close":true`) {
		t.Fatal(w.Body.String())
	}
	p.unsafe = true
	w = cameraRequest(s, "POST", "/api/doors/door/commands/close", "", true)
	if w.Code != 409 || !strings.Contains(w.Body.String(), "No close command was sent") {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	state, _ := s.control.State(context.Background(), "door")
	if len(p.commands) != 1 || state.Armed || state.CloseDueAt != nil {
		t.Fatalf("%v %+v", p.commands, state)
	}
}
