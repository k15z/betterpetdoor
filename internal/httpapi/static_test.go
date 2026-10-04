package httpapi

import (
	"bytes"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCameraAssetsUseProductionHeadersAndCorrectTypes(t *testing.T) {
	s, _ := cameraServer(t)
	s.webDirectory = t.TempDir()
	files := map[string][]byte{
		"index.html":                           []byte("<!doctype html><title>Camera app</title>"),
		"models/coco-ssd-v2/model.json":        []byte(`{"modelTopology":{},"weightsManifest":[]}`),
		"models/coco-ssd-v2/group1-shard1of17": {0, 1, 2, 3, 255},
		"assets/app.js":                        []byte("export const localOnly = true;"),
		"assets/test.wasm":                     {0, 97, 115, 109, 1, 0, 0, 0},
	}
	for name, body := range files {
		path := filepath.Join(s.webDirectory, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, body, 0600); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct{ path, mime string }{{"/models/coco-ssd-v2/model.json", "application/json"}, {"/models/coco-ssd-v2/group1-shard1of17", "application/octet-stream"}, {"/assets/app.js", "javascript"}, {"/assets/test.wasm", "application/wasm"}} {
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, httptest.NewRequest("GET", tc.path, nil))
		if w.Code != 200 || !strings.Contains(w.Header().Get("Content-Type"), tc.mime) {
			t.Fatalf("%s %d %s", tc.path, w.Code, w.Header().Get("Content-Type"))
		}
		if !bytes.Equal(w.Body.Bytes(), files[strings.TrimPrefix(tc.path, "/")]) {
			t.Fatalf("asset content changed: %s", tc.path)
		}
		csp := w.Header().Get("Content-Security-Policy")
		for _, directive := range []string{"script-src 'self';", "connect-src 'self';", "object-src 'none';"} {
			if !strings.Contains(csp, directive) {
				t.Fatalf("missing CSP %s: %s", directive, csp)
			}
		}
		if strings.Contains(csp, "unsafe-eval") || w.Header().Get("Permissions-Policy") != "camera=(self)" || w.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Fatalf("unexpected headers: %v", w.Header())
		}
	}
	for _, path := range []string{"/models/missing/model.json", "/models/coco-ssd-v2/missing-shard", "/assets/missing.js"} {
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 404 || bytes.Contains(w.Body.Bytes(), []byte("Camera app")) {
			t.Fatalf("missing asset got SPA: %s %d %s", path, w.Code, w.Body.String())
		}
	}
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, httptest.NewRequest("GET", "/dashboard", nil))
	if w.Code != 200 || !bytes.Contains(w.Body.Bytes(), []byte("Camera app")) {
		t.Fatal("ordinary SPA route no longer works")
	}
}
