package database

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func TestDoorLifecycle(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	door := Door{
		ID: "door-1", Name: "Kitchen", Provider: "wayzn",
		EncryptedCredentials: []byte("ciphertext"), CreatedAt: time.Unix(1234, 0),
	}
	if err := db.CreateDoor(context.Background(), door); err != nil {
		t.Fatal(err)
	}
	got, err := db.Door(context.Background(), door.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != door.Name || got.Provider != door.Provider {
		t.Fatalf("got %#v", got)
	}
	if err := db.DeleteDoor(context.Background(), door.ID); err != nil {
		t.Fatal(err)
	}
	_, err = db.Door(context.Background(), door.ID)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("got %v, want ErrNotFound", err)
	}
}
