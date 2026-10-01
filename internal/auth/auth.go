package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/k15z/betterpetdoor/internal/database"
	"golang.org/x/crypto/bcrypt"
)

const passwordSetting = "admin_password_hash"

type Service struct {
	db         *database.DB
	sessionTTL time.Duration
}

func New(db *database.DB) *Service {
	return &Service{db: db, sessionTTL: 30 * 24 * time.Hour}
}

// SetPassword makes the environment-provided password authoritative on startup.
func (s *Service) SetPassword(ctx context.Context, password string) error {
	if len(password) < 12 {
		return errors.New("BETTERPETDOOR_ADMIN_PASSWORD must be at least 12 characters")
	}
	existing, err := s.db.Setting(ctx, passwordSetting)
	if err == nil && bcrypt.CompareHashAndPassword(existing, []byte(password)) == nil {
		return nil
	}
	if err != nil && !errors.Is(err, database.ErrNotFound) {
		return fmt.Errorf("read admin password: %w", err)
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("hash admin password: %w", err)
	}
	if err := s.db.SetSetting(ctx, passwordSetting, hash); err != nil {
		return fmt.Errorf("save admin password: %w", err)
	}
	if err := s.db.DeleteAllSessions(ctx); err != nil {
		return fmt.Errorf("invalidate old sessions: %w", err)
	}
	if err := s.db.DeleteAllOAuth(ctx); err != nil {
		return fmt.Errorf("invalidate old OAuth grants: %w", err)
	}
	return nil
}

func (s *Service) Authenticate(ctx context.Context, password string) (bool, error) {
	hash, err := s.db.Setting(ctx, passwordSetting)
	if err != nil {
		return false, err
	}
	return bcrypt.CompareHashAndPassword(hash, []byte(password)) == nil, nil
}

func (s *Service) CreateSession(ctx context.Context) (string, time.Time, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", time.Time{}, fmt.Errorf("create session: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	expiresAt := time.Now().Add(s.sessionTTL)
	if err := s.db.CreateSession(ctx, tokenHash(token), expiresAt); err != nil {
		return "", time.Time{}, fmt.Errorf("save session: %w", err)
	}
	return token, expiresAt, nil
}

func (s *Service) SessionValid(ctx context.Context, token string) (bool, error) {
	if token == "" {
		return false, nil
	}
	return s.db.SessionValid(ctx, tokenHash(token), time.Now())
}

func (s *Service) DeleteSession(ctx context.Context, token string) error {
	if token == "" {
		return nil
	}
	return s.db.DeleteSession(ctx, tokenHash(token))
}

func tokenHash(token string) string {
	hash := sha256.Sum256([]byte(token))
	return hex.EncodeToString(hash[:])
}
