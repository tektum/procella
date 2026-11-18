package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/sha256"
	"errors"
	"fmt"
)

// ESC secret ciphertexts written by packages/esc/src/secrets.ts. github.com/pulumi/esc/eval
// strips the "escx" envelope and passes the inner bytes to Decrypt:
//
//	0x01 || nonce(12) || AES-256-GCM ciphertext || tag(16)
//
// with key HKDF-SHA256(master key, salt "procella-esc-secrets", info "procella-esc-secret-v1:" + tenantId).
const (
	escSecretHKDFSalt       = "procella-esc-secrets"
	escSecretHKDFInfoPrefix = "procella-esc-secret-v1:"
	escSecretInnerVersion   = 0x01
	escSecretNonceLength    = 12
)

type tenantSecretDecrypter struct {
	aead cipher.AEAD
}

func newTenantSecretDecrypter(masterKey []byte, tenantID string) (*tenantSecretDecrypter, error) {
	if tenantID == "" {
		return nil, errors.New("tenantId is required to decrypt secrets")
	}
	key, err := hkdf.Key(sha256.New, masterKey, []byte(escSecretHKDFSalt), escSecretHKDFInfoPrefix+tenantID, 32)
	if err != nil {
		return nil, fmt.Errorf("derive secret key: %w", err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &tenantSecretDecrypter{aead: aead}, nil
}

func (d *tenantSecretDecrypter) Decrypt(_ context.Context, value []byte) ([]byte, error) {
	if len(value) < 1+escSecretNonceLength+d.aead.Overhead() {
		return nil, errors.New("secret ciphertext is too short")
	}
	if value[0] != escSecretInnerVersion {
		return nil, fmt.Errorf("unsupported secret ciphertext version %d", value[0])
	}
	nonce := value[1 : 1+escSecretNonceLength]
	plaintext, err := d.aead.Open(nil, nonce, value[1+escSecretNonceLength:], nil)
	if err != nil {
		return nil, errors.New("secret ciphertext could not be decrypted")
	}
	return plaintext, nil
}
