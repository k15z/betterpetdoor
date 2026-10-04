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

func TestCameraStatePersistsAndCascades(t *testing.T) {
	path := filepath.Join(t.TempDir(), "camera.db")
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := db.CreateDoor(ctx, Door{ID: "camera-door", Name: "Test", Provider: "wayzn", EncryptedCredentials: []byte("fake"), CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	if state, err := db.CameraState(ctx, "camera-door"); err != nil || state != nil {
		t.Fatalf("new state %s %v", state, err)
	}
	want := []byte(`{"close_due_at":"2026-10-03T20:05:00Z","armed":false}`)
	if err := db.SaveCameraState(ctx, "camera-door", want); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	got, err := db.CameraState(ctx, "camera-door")
	if err != nil || string(got) != string(want) {
		t.Fatalf("%s %v", got, err)
	}
	if err := db.DeleteDoor(ctx, "camera-door"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.CameraState(ctx, "camera-door"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing door %v", err)
	}
}
