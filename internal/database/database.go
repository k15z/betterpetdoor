package database

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

var ErrNotFound = errors.New("not found")

type DB struct {
	sql *sql.DB
}

type Door struct {
	ID                   string
	Name                 string
	Provider             string
	EncryptedCredentials []byte
	CreatedAt            time.Time
}

func Open(path string) (*DB, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("resolve database path: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o700); err != nil {
		return nil, fmt.Errorf("create database directory: %w", err)
	}
	file, err := os.OpenFile(abs, os.O_CREATE, 0o600)
	if err != nil {
		return nil, fmt.Errorf("create database file: %w", err)
	}
	if err := file.Close(); err != nil {
		return nil, fmt.Errorf("close database file: %w", err)
	}
	if err := os.Chmod(abs, 0o600); err != nil {
		return nil, fmt.Errorf("secure database file: %w", err)
	}
	dsn := "file:" + abs + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)"
	sqldb, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	sqldb.SetMaxOpenConns(1)
	db := &DB{sql: sqldb}
	if err := db.migrate(context.Background()); err != nil {
		sqldb.Close()
		return nil, err
	}
	return db, nil
}

func (db *DB) Close() error { return db.sql.Close() }

func (db *DB) migrate(ctx context.Context) error {
	const schema = `
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS doors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    encrypted_credentials BLOB NOT NULL,
    created_at INTEGER NOT NULL
);
`
	if _, err := db.sql.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("migrate database: %w", err)
	}
	return nil
}

func (db *DB) Setting(ctx context.Context, key string) ([]byte, error) {
	var value []byte
	err := db.sql.QueryRowContext(ctx, `SELECT value FROM settings WHERE key = ?`, key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return value, err
}

func (db *DB) SetSetting(ctx context.Context, key string, value []byte) error {
	_, err := db.sql.ExecContext(ctx, `
INSERT INTO settings(key, value) VALUES(?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}

func (db *DB) CreateSession(ctx context.Context, tokenHash string, expiresAt time.Time) error {
	_, err := db.sql.ExecContext(ctx,
		`INSERT INTO sessions(token_hash, expires_at) VALUES(?, ?)`,
		tokenHash, expiresAt.Unix(),
	)
	return err
}

func (db *DB) SessionValid(ctx context.Context, tokenHash string, now time.Time) (bool, error) {
	var exists int
	err := db.sql.QueryRowContext(ctx,
		`SELECT EXISTS(SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?)`,
		tokenHash, now.Unix(),
	).Scan(&exists)
	return exists == 1, err
}

func (db *DB) DeleteSession(ctx context.Context, tokenHash string) error {
	_, err := db.sql.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = ?`, tokenHash)
	return err
}

func (db *DB) DeleteExpiredSessions(ctx context.Context, now time.Time) error {
	_, err := db.sql.ExecContext(ctx, `DELETE FROM sessions WHERE expires_at <= ?`, now.Unix())
	return err
}

func (db *DB) DeleteAllSessions(ctx context.Context) error {
	_, err := db.sql.ExecContext(ctx, `DELETE FROM sessions`)
	return err
}

func (db *DB) CreateDoor(ctx context.Context, door Door) error {
	_, err := db.sql.ExecContext(ctx, `
INSERT INTO doors(id, name, provider, encrypted_credentials, created_at)
VALUES(?, ?, ?, ?, ?)`, door.ID, door.Name, door.Provider, door.EncryptedCredentials, door.CreatedAt.Unix())
	return err
}

func (db *DB) Doors(ctx context.Context) ([]Door, error) {
	rows, err := db.sql.QueryContext(ctx, `
SELECT id, name, provider, encrypted_credentials, created_at
FROM doors ORDER BY created_at, name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var doors []Door
	for rows.Next() {
		var door Door
		var createdAt int64
		if err := rows.Scan(&door.ID, &door.Name, &door.Provider, &door.EncryptedCredentials, &createdAt); err != nil {
			return nil, err
		}
		door.CreatedAt = time.Unix(createdAt, 0).UTC()
		doors = append(doors, door)
	}
	return doors, rows.Err()
}

func (db *DB) Door(ctx context.Context, id string) (Door, error) {
	var door Door
	var createdAt int64
	err := db.sql.QueryRowContext(ctx, `
SELECT id, name, provider, encrypted_credentials, created_at FROM doors WHERE id = ?`, id).
		Scan(&door.ID, &door.Name, &door.Provider, &door.EncryptedCredentials, &createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Door{}, ErrNotFound
	}
	if err != nil {
		return Door{}, err
	}
	door.CreatedAt = time.Unix(createdAt, 0).UTC()
	return door, nil
}

func (db *DB) UpdateDoorCredentials(ctx context.Context, id string, encrypted []byte) error {
	result, err := db.sql.ExecContext(ctx,
		`UPDATE doors SET encrypted_credentials = ? WHERE id = ?`, encrypted, id)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return ErrNotFound
	}
	return nil
}

func (db *DB) DeleteDoor(ctx context.Context, id string) error {
	result, err := db.sql.ExecContext(ctx, `DELETE FROM doors WHERE id = ?`, id)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return ErrNotFound
	}
	return nil
}
