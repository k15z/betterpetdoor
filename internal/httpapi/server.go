package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/k15z/betterpetdoor/internal/auth"
	"github.com/k15z/betterpetdoor/internal/cryptobox"
	"github.com/k15z/betterpetdoor/internal/database"
	"github.com/k15z/betterpetdoor/internal/providers/wayzn"
)

const sessionCookie = "betterpetdoor_session"

type Config struct {
	Database            *database.DB
	Auth                *auth.Service
	Box                 *cryptobox.Box
	WayznFirebaseAPIKey string
	WebDirectory        string
	SecureCookie        bool
	Logger              *slog.Logger
	HTTPClient          *http.Client
}

type Server struct {
	db                  *database.DB
	auth                *auth.Service
	box                 *cryptobox.Box
	wayznFirebaseAPIKey string
	webDirectory        string
	secureCookie        bool
	logger              *slog.Logger
	httpClient          *http.Client
	mux                 *http.ServeMux
}

type publicDoor struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Provider  string    `json:"provider"`
	CreatedAt time.Time `json:"created_at"`
}

func New(config Config) *Server {
	logger := config.Logger
	if logger == nil {
		logger = slog.Default()
	}
	client := config.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 12 * time.Second}
	}
	s := &Server{
		db: config.Database, auth: config.Auth, box: config.Box,
		wayznFirebaseAPIKey: strings.TrimSpace(config.WayznFirebaseAPIKey),
		webDirectory:        config.WebDirectory, secureCookie: config.SecureCookie,
		logger: logger, httpClient: client, mux: http.NewServeMux(),
	}
	s.routes()
	return s
}

func (s *Server) Handler() http.Handler {
	return securityHeaders(s.logRequests(s.mux))
}

func (s *Server) routes() {
	s.mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	s.mux.HandleFunc("POST /api/auth/login", s.login)
	s.mux.Handle("POST /api/auth/logout", s.requireAuth(http.HandlerFunc(s.logout)))
	s.mux.Handle("GET /api/session", s.requireAuth(http.HandlerFunc(s.session)))
	s.mux.Handle("GET /api/doors", s.requireAuth(http.HandlerFunc(s.listDoors)))
	s.mux.Handle("POST /api/doors", s.requireAuth(http.HandlerFunc(s.createDoor)))
	s.mux.Handle("/api/doors/", s.requireAuth(http.HandlerFunc(s.doorRoute)))
	s.mux.HandleFunc("/api/", func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusNotFound, "Not found.")
	})
	s.mux.HandleFunc("/", s.serveWeb)
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Password string `json:"password"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		return
	}
	valid, err := s.auth.Authenticate(r.Context(), body.Password)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if !valid {
		writeError(w, http.StatusUnauthorized, "Incorrect password.")
		return
	}
	token, expiresAt, err := s.auth.CreateSession(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: token, Path: "/", Expires: expiresAt,
		MaxAge: int(time.Until(expiresAt).Seconds()), HttpOnly: true,
		Secure: s.secureCookie, SameSite: http.SameSiteStrictMode,
	})
	writeJSON(w, http.StatusOK, map[string]bool{"authenticated": true})
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(sessionCookie); err == nil {
		if err := s.auth.DeleteSession(r.Context(), cookie.Value); err != nil {
			s.internalError(w, r, err)
			return
		}
	}
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, Secure: s.secureCookie, SameSite: http.SameSiteStrictMode,
	})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) session(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"authenticated": true})
}

func (s *Server) listDoors(w http.ResponseWriter, r *http.Request) {
	doors, err := s.db.Doors(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	result := make([]publicDoor, 0, len(doors))
	for _, door := range doors {
		result = append(result, publicDoor{ID: door.ID, Name: door.Name, Provider: door.Provider, CreatedAt: door.CreatedAt})
	}
	writeJSON(w, http.StatusOK, map[string]any{"doors": result})
}

func (s *Server) createDoor(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name      string `json:"name"`
		Provider  string `json:"provider"`
		QRPayload string `json:"qr_payload"`
		Email     string `json:"email"`
		Password  string `json:"password"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	body.Provider = strings.ToLower(strings.TrimSpace(body.Provider))
	if body.Name == "" || len(body.Name) > 80 {
		writeError(w, http.StatusBadRequest, "Enter a door name of 80 characters or fewer.")
		return
	}
	if body.Provider != "wayzn" {
		writeError(w, http.StatusBadRequest, "Wayzn is the only supported provider right now.")
		return
	}
	credentials, err := wayzn.Pair(r.Context(), s.httpClient, s.wayznFirebaseAPIKey, body.QRPayload, body.Email, body.Password)
	if err != nil {
		s.logger.Warn("door pairing failed", "provider", body.Provider, "error", err)
		if errors.Is(err, wayzn.ErrInvalidPairingCode) {
			writeError(w, http.StatusBadRequest, "That Wayzn QR code is not valid.")
		} else if errors.Is(err, wayzn.ErrAuthentication) {
			writeError(w, http.StatusBadRequest, "Wayzn sign-in failed. Check the email and password.")
		} else {
			writeError(w, http.StatusBadGateway, "Could not connect to that Wayzn door.")
		}
		return
	}
	encrypted, err := s.encryptCredentials(credentials)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	id, err := randomID()
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	door := database.Door{
		ID: id, Name: body.Name, Provider: body.Provider,
		EncryptedCredentials: encrypted, CreatedAt: time.Now().UTC(),
	}
	if err := s.db.CreateDoor(r.Context(), door); err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, publicDoor{ID: door.ID, Name: door.Name, Provider: door.Provider, CreatedAt: door.CreatedAt})
}

func (s *Server) doorRoute(w http.ResponseWriter, r *http.Request) {
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/doors/"), "/")
	parts := strings.Split(path, "/")
	if len(parts) == 1 && parts[0] != "" && r.Method == http.MethodDelete {
		s.deleteDoor(w, r, parts[0])
		return
	}
	if len(parts) == 2 && parts[0] != "" && parts[1] == "status" && r.Method == http.MethodGet {
		s.doorStatus(w, r, parts[0])
		return
	}
	if len(parts) == 3 && parts[0] != "" && parts[1] == "commands" && r.Method == http.MethodPost {
		command := strings.ReplaceAll(parts[2], "-", "_")
		s.doorCommand(w, r, parts[0], command)
		return
	}
	writeError(w, http.StatusNotFound, "Not found.")
}

func (s *Server) deleteDoor(w http.ResponseWriter, r *http.Request, id string) {
	err := s.db.DeleteDoor(r.Context(), id)
	if errors.Is(err, database.ErrNotFound) {
		writeError(w, http.StatusNotFound, "Door not found.")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) doorStatus(w http.ResponseWriter, r *http.Request, id string) {
	door, client, err := s.wayznClient(r.Context(), id)
	if errors.Is(err, database.ErrNotFound) {
		writeError(w, http.StatusNotFound, "Door not found.")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	status, err := client.ReadStatus(r.Context())
	if err != nil {
		s.logger.Warn("status request failed", "door_id", door.ID, "provider", door.Provider, "error", err)
		writeError(w, http.StatusBadGateway, "Could not read the door status.")
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func (s *Server) doorCommand(w http.ResponseWriter, r *http.Request, id, command string) {
	if command != "open" && command != "close" && command != "open_and_close" {
		writeError(w, http.StatusNotFound, "Unknown command.")
		return
	}
	door, client, err := s.wayznClient(r.Context(), id)
	if errors.Is(err, database.ErrNotFound) {
		writeError(w, http.StatusNotFound, "Door not found.")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if err := client.Command(r.Context(), command); err != nil {
		s.logger.Warn("door command failed", "door_id", door.ID, "provider", door.Provider, "command", command, "error", err)
		writeError(w, http.StatusBadGateway, "The door did not accept the command.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "command": strings.ReplaceAll(command, "_", "-")})
}

func (s *Server) wayznClient(ctx context.Context, id string) (database.Door, *wayzn.Client, error) {
	door, err := s.db.Door(ctx, id)
	if err != nil {
		return database.Door{}, nil, err
	}
	if door.Provider != "wayzn" {
		return database.Door{}, nil, errors.New("unsupported stored provider")
	}
	plaintext, err := s.box.Open(door.EncryptedCredentials)
	if err != nil {
		return database.Door{}, nil, fmt.Errorf("decrypt door credentials: %w", err)
	}
	var credentials wayzn.Credentials
	if err := json.Unmarshal(plaintext, &credentials); err != nil {
		return database.Door{}, nil, errors.New("invalid stored credentials")
	}
	onRefresh := func(refreshToken string) {
		credentials.RefreshToken = refreshToken
		encrypted, encryptErr := s.encryptCredentials(credentials)
		if encryptErr != nil {
			s.logger.Error("could not encrypt rotated provider token", "door_id", id, "error", encryptErr)
			return
		}
		if updateErr := s.db.UpdateDoorCredentials(context.Background(), id, encrypted); updateErr != nil {
			s.logger.Error("could not save rotated provider token", "door_id", id, "error", updateErr)
		}
	}
	return door, wayzn.NewClient(s.httpClient, s.wayznFirebaseAPIKey, credentials, onRefresh), nil
}

func (s *Server) encryptCredentials(credentials wayzn.Credentials) ([]byte, error) {
	encoded, err := json.Marshal(credentials)
	if err != nil {
		return nil, err
	}
	return s.box.Seal(encoded)
}

func (s *Server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorized := false
		if header := r.Header.Get("Authorization"); header != "" {
			const prefix = "Bearer "
			if strings.HasPrefix(header, prefix) {
				valid, err := s.auth.Authenticate(r.Context(), strings.TrimPrefix(header, prefix))
				if err != nil {
					s.internalError(w, r, err)
					return
				}
				authorized = valid
			}
		} else if cookie, err := r.Cookie(sessionCookie); err == nil {
			valid, err := s.auth.SessionValid(r.Context(), cookie.Value)
			if err != nil {
				s.internalError(w, r, err)
				return
			}
			authorized = valid
		}
		if !authorized {
			writeError(w, http.StatusUnauthorized, "Authentication required.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) serveWeb(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeError(w, http.StatusMethodNotAllowed, "Method not allowed.")
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/")
	if path != "" && fs.ValidPath(path) {
		candidate := filepath.Join(s.webDirectory, filepath.FromSlash(path))
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			http.ServeFile(w, r, candidate)
			return
		}
	}
	index := filepath.Join(s.webDirectory, "index.html")
	if _, err := os.Stat(index); err != nil {
		http.Error(w, "Web app not built. Run npm run build in web/.", http.StatusServiceUnavailable)
		return
	}
	http.ServeFile(w, r, index)
}

func (s *Server) internalError(w http.ResponseWriter, r *http.Request, err error) {
	s.logger.Error("request failed", "method", r.Method, "path", r.URL.Path, "error", err)
	writeError(w, http.StatusInternalServerError, "Internal server error.")
}

func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		next.ServeHTTP(w, r)
		s.logger.Info("request", "method", r.Method, "path", r.URL.Path, "duration_ms", time.Since(started).Milliseconds())
	})
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Permissions-Policy", "camera=(self)")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
		next.ServeHTTP(w, r)
	})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, target any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON request.")
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "Send one JSON object.")
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return err
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func randomID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}
