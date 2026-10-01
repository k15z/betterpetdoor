package cryptobox

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
)

var ErrInvalidCiphertext = errors.New("invalid encrypted data")

// Box encrypts provider credentials before they are written to SQLite.
type Box struct {
	aead cipher.AEAD
}

func New(secret string) (*Box, error) {
	if len(secret) < 32 {
		return nil, errors.New("BETTERPETDOOR_SECRET_KEY must be at least 32 characters")
	}
	key := sha256.Sum256([]byte(secret))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, fmt.Errorf("create cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create GCM: %w", err)
	}
	return &Box{aead: aead}, nil
}

func (b *Box) Seal(plaintext []byte) ([]byte, error) {
	nonce := make([]byte, b.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("create nonce: %w", err)
	}
	// Version byte, nonce, then authenticated ciphertext.
	result := make([]byte, 1, 1+len(nonce)+len(plaintext)+b.aead.Overhead())
	result[0] = 1
	result = append(result, nonce...)
	result = b.aead.Seal(result, nonce, plaintext, nil)
	return result, nil
}

func (b *Box) Open(ciphertext []byte) ([]byte, error) {
	if len(ciphertext) < 1+b.aead.NonceSize()+b.aead.Overhead() || ciphertext[0] != 1 {
		return nil, ErrInvalidCiphertext
	}
	nonce := ciphertext[1 : 1+b.aead.NonceSize()]
	plaintext, err := b.aead.Open(nil, nonce, ciphertext[1+b.aead.NonceSize():], nil)
	if err != nil {
		return nil, ErrInvalidCiphertext
	}
	return plaintext, nil
}
