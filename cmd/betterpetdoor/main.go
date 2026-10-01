package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/k15z/betterpetdoor/internal/auth"
	"github.com/k15z/betterpetdoor/internal/cryptobox"
	"github.com/k15z/betterpetdoor/internal/database"
	"github.com/k15z/betterpetdoor/internal/httpapi"
	"github.com/k15z/betterpetdoor/internal/providers/wayzn"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(logger); err != nil {
		logger.Error("server stopped", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	adminPassword := os.Getenv("BETTERPETDOOR_ADMIN_PASSWORD")
	secretKey := os.Getenv("BETTERPETDOOR_SECRET_KEY")
	wayznFirebaseAPIKey := strings.TrimSpace(os.Getenv("BETTERPETDOOR_WAYZN_FIREBASE_API_KEY"))
	if adminPassword == "" {
		return errors.New("BETTERPETDOOR_ADMIN_PASSWORD is required")
	}
	if !wayzn.ValidFirebaseAPIKey(wayznFirebaseAPIKey) {
		return errors.New("BETTERPETDOOR_WAYZN_FIREBASE_API_KEY is required and must be a valid Firebase API key")
	}
	box, err := cryptobox.New(secretKey)
	if err != nil {
		return err
	}

	dbPath := envOr("BETTERPETDOOR_DB_PATH", "./data/betterpetdoor.db")
	db, err := database.Open(dbPath)
	if err != nil {
		return err
	}
	defer db.Close()

	authService := auth.New(db)
	if err := authService.SetPassword(context.Background(), adminPassword); err != nil {
		return err
	}
	if err := db.DeleteExpiredSessions(context.Background(), time.Now()); err != nil {
		logger.Warn("could not remove expired sessions", "error", err)
	}

	handler := httpapi.New(httpapi.Config{
		Database:            db,
		Auth:                authService,
		Box:                 box,
		WayznFirebaseAPIKey: wayznFirebaseAPIKey,
		WebDirectory:        envOr("BETTERPETDOOR_WEB_DIR", "./web/dist"),
		SecureCookie:        strings.EqualFold(os.Getenv("BETTERPETDOOR_SECURE_COOKIE"), "true"),
		Logger:              logger,
	}).Handler()

	server := &http.Server{
		Addr:              envOr("BETTERPETDOOR_ADDR", ":8080"),
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      20 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()

	logger.Info("Better Pet Door is ready", "address", server.Addr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}
