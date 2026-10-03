package wayzn

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"strings"
	"testing"
)

func TestValidFirebaseAPIKey(t *testing.T) {
	valid := "AI" + "za" + strings.Repeat("a", 35)
	if !ValidFirebaseAPIKey(valid) {
		t.Fatal("expected valid key")
	}
	for _, value := range []string{"", valid + "a", "not-a-key"} {
		if ValidFirebaseAPIKey(value) {
			t.Fatalf("expected %q to be invalid", value)
		}
	}
}

func TestParsePairingCode(t *testing.T) {
	key := base64.StdEncoding.EncodeToString([]byte("test-key-material"))
	got, err := ParsePairingCode(key + ":7:device-123:Kitchen")
	if err != nil {
		t.Fatal(err)
	}
	if got.DeviceID != "device-123" || got.KeySlot != 7 || got.KeyBase64 != key {
		t.Fatalf("got %#v", got)
	}
}

func TestParseStoredKey(t *testing.T) {
	key := base64.StdEncoding.EncodeToString([]byte("test-key-material"))
	got, err := ParsePairingCode("260:" + key + ":4:device-123")
	if err != nil {
		t.Fatal(err)
	}
	if got.KeySlot != 4 {
		t.Fatalf("got slot %d", got.KeySlot)
	}
}

func TestSigningCompatibility(t *testing.T) {
	mac := hmac.New(sha256.New, []byte("secret"))
	mac.Write([]byte("open,nonce-123"))
	got := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	const want = "lNYGKj9+azGU2m+hdHF8L+3RoicOoh4pMBAKe2B5tps="
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestNormalizeStatus(t *testing.T) {
	closed := normalizeStatus(map[string]any{"Connected": true, "ControlState": float64(14), "SafeToClose": true})
	if closed.State != "closed" || closed.Open == nil || *closed.Open || closed.SafeToClose == nil || !*closed.SafeToClose {
		t.Fatalf("got %#v", closed)
	}
	obstructed := normalizeStatus(map[string]any{"Connected": true, "ControlState": float64(22)})
	if obstructed.State != "obstructed" {
		t.Fatalf("got %#v", obstructed)
	}
}

func TestNormalizeStatusDoesNotInferOnline(t *testing.T) {
	status := normalizeStatus(map[string]any{"ControlState": float64(7), "SafeToClose": true})
	if status.Online != nil {
		t.Fatalf("missing connectivity must remain unknown: %+v", status)
	}
}
func TestCommandRejectsHTTP200FailureBodies(t *testing.T) {
	for _, body := range []string{"Device is offline.", "Invalid signature", "ERROR", `{"success":false,"error":"denied"}`, "false", "Door busy", "not safe", `{"success":false}`, `{"ok":false}`} {
		if err := commandResponseError(body); err == nil {
			t.Fatalf("accepted failure %q", body)
		}
	}
	for _, body := range []string{"OK", "Success", "Command sent.", `{"ok":true,"error":null}`} {
		if err := commandResponseError(body); err != nil {
			t.Fatalf("rejected compatibility response %q", body)
		}
	}
}
