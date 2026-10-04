package wayzn

import (
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type transportFunc func(*http.Request) (*http.Response, error)

func (f transportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// Every HTTP call is intercepted. The public literal IP only satisfies agent URL
// validation without a DNS lookup; this test never contacts a service or device.
func TestRejectedStatusDoesNotReadCachedSafeSnapshot(t *testing.T) {
	for _, rejection := range []string{"Invalid signature", "ERROR", `{"success":false}`, `{"error":"denied"}`} {
		t.Run(rejection, func(t *testing.T) {
			cachedReads := 0
			client := &http.Client{Transport: transportFunc(func(r *http.Request) (*http.Response, error) {
				var body string
				switch r.URL.Host {
				case "wayzn-app-nonce.firebaseio.com":
					body = `{"nonce":"nonce","agenturl":"https://8.8.8.8"}`
				case "8.8.8.8":
					body = rejection
				case "wayzn-app-tokens.firebaseio.com":
					cachedReads++
					body = `{"Connected":true,"ControlState":7,"SafeToClose":true}`
				default:
					t.Fatalf("unexpected request host %s", r.URL.Host)
				}
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
			})}
			c := NewClient(client, "", Credentials{DeviceID: "fake-device", KeyBase64: base64.StdEncoding.EncodeToString([]byte("fake-key"))}, nil)
			c.idToken = "fake-token"
			c.tokenExpiresAt = time.Now().Add(time.Hour)
			status, err := c.ReadStatus(context.Background())
			if err == nil || cachedReads != 0 {
				t.Fatalf("rejected status accepted fallback: %+v err=%v cachedReads=%d", status, err, cachedReads)
			}
		})
	}
}
