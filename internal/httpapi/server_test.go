package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/k15z/betterpetdoor/internal/auth"
	"github.com/k15z/betterpetdoor/internal/cryptobox"
	"github.com/k15z/betterpetdoor/internal/database"
)

const testPassword = "a-good-test-password"

var testFirebaseAPIKey = "AI" + "za" + strings.Repeat("a", 35)

func testHandler(t *testing.T) http.Handler {
	t.Helper()
	db, err := database.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	authService := auth.New(db)
	if err := authService.SetPassword(context.Background(), testPassword); err != nil {
		t.Fatal(err)
	}
	box, err := cryptobox.New("a-test-encryption-secret-that-is-long-enough")
	if err != nil {
		t.Fatal(err)
	}
	return New(Config{
		Database: db, Auth: authService, Box: box,
		WayznFirebaseAPIKey: testFirebaseAPIKey,
		WebDirectory:        t.TempDir(),
	}).Handler()
}

func TestBearerAuthentication(t *testing.T) {
	handler := testHandler(t)
	request := httptest.NewRequest(http.MethodGet, "/api/doors", nil)
	request.Header.Set("Authorization", "Bearer "+testPassword)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("got %d: %s", response.Code, response.Body.String())
	}
}

func TestLoginCreatesWorkingSession(t *testing.T) {
	handler := testHandler(t)
	body, _ := json.Marshal(map[string]string{"password": testPassword})
	login := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewReader(body))
	loginResponse := httptest.NewRecorder()
	handler.ServeHTTP(loginResponse, login)
	if loginResponse.Code != http.StatusOK {
		t.Fatalf("login got %d: %s", loginResponse.Code, loginResponse.Body.String())
	}
	cookies := loginResponse.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly {
		t.Fatalf("unexpected cookies: %#v", cookies)
	}

	request := httptest.NewRequest(http.MethodGet, "/api/doors", nil)
	request.AddCookie(cookies[0])
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("got %d: %s", response.Code, response.Body.String())
	}
}

func TestDoorsRequireAuthentication(t *testing.T) {
	handler := testHandler(t)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/doors", nil))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("got %d, want %d", response.Code, http.StatusUnauthorized)
	}
}
