package cryptobox

import (
	"bytes"
	"testing"
)

func TestRoundTrip(t *testing.T) {
	box, err := New("a-secret-that-is-at-least-thirty-two-characters")
	if err != nil {
		t.Fatal(err)
	}
	want := []byte(`{"refresh_token":"private"}`)
	sealed, err := box.Seal(want)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(sealed, []byte("private")) {
		t.Fatal("ciphertext contains plaintext")
	}
	got, err := box.Open(sealed)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestRejectsChangedCiphertext(t *testing.T) {
	box, _ := New("a-secret-that-is-at-least-thirty-two-characters")
	sealed, _ := box.Seal([]byte("private"))
	sealed[len(sealed)-1] ^= 1
	if _, err := box.Open(sealed); err == nil {
		t.Fatal("expected authentication failure")
	}
}
