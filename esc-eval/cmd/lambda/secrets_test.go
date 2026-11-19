package main

import (
	"context"
	"strings"
	"testing"
)

// Produced by encryptEscSecret in packages/esc/src/secrets.ts with crossLanguageKey, tenant
// "tenant-a" and plaintext "hunter2". Keeps the TS and Go halves of the format in sync.
const (
	crossLanguageKey        = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
	crossLanguageCiphertext = "ZXNjeAAAAAEBDkSFQcFpJC0KX6bjgxjuUgxirqDwt6Gpg8TYE81gtMjHbdaBpdzI"
)

func secretDefinition() string {
	return "values:\n  password:\n    fn::secret:\n      ciphertext: " + crossLanguageCiphertext + "\n"
}

func TestHandleDecryptsTenantSecret(t *testing.T) {
	resp, err := handle(context.Background(), EvaluateRequest{
		Definition:       secretDefinition(),
		Imports:          map[string]string{},
		EncryptionKeyHex: crossLanguageKey,
		TenantID:         "tenant-a",
	})
	if err != nil {
		t.Fatalf("handle: %v", err)
	}
	if len(resp.Diagnostics) != 0 {
		t.Fatalf("unexpected diagnostics: %+v", resp.Diagnostics)
	}
	if got := resp.Values["password"]; got != "hunter2" {
		t.Fatalf("password = %#v, want %q", got, "hunter2")
	}
	if len(resp.Secrets) != 1 || resp.Secrets[0] != "password" {
		t.Fatalf("secrets = %v, want [password]", resp.Secrets)
	}
}

func TestHandleRejectsSecretFromAnotherTenant(t *testing.T) {
	resp, err := handle(context.Background(), EvaluateRequest{
		Definition:       secretDefinition(),
		Imports:          map[string]string{},
		EncryptionKeyHex: crossLanguageKey,
		TenantID:         "tenant-b",
	})
	if err != nil {
		t.Fatalf("handle: %v", err)
	}
	if resp.Values["password"] == "hunter2" {
		t.Fatal("decrypted another tenant's secret")
	}
	found := false
	for _, d := range resp.Diagnostics {
		if d.Severity == "error" && strings.Contains(d.Summary, "decrypt") {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a decryption error diagnostic, got %+v", resp.Diagnostics)
	}
}

func TestTenantSecretDecrypterRejectsMalformedInput(t *testing.T) {
	dec, err := newTenantSecretDecrypter(make([]byte, 32), "tenant-a")
	if err != nil {
		t.Fatal(err)
	}
	for name, value := range map[string][]byte{
		"empty":       {},
		"short":       {0x01, 0x02},
		"bad version": append([]byte{0x02}, make([]byte, 40)...),
		"bad tag":     append([]byte{0x01}, make([]byte, 40)...),
	} {
		if _, err := dec.Decrypt(context.Background(), value); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
	if _, err := newTenantSecretDecrypter(make([]byte, 32), ""); err == nil {
		t.Error("expected error for empty tenant")
	}
}
