package vaultsecrets

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"

	"github.com/tektum/procella/esc-eval/providers/internal/escutil"
	"github.com/pulumi/esc"
	"github.com/pulumi/esc/schema"
)

type httpDoer interface {
	Do(*http.Request) (*http.Response, error)
}

type provider struct {
	client httpDoer
}

type Option func(*provider)

func New(opts ...Option) esc.Provider {
	p := &provider{client: http.DefaultClient}
	for _, opt := range opts {
		opt(p)
	}
	return p
}

func WithHTTPClient(client httpDoer) Option {
	return func(p *provider) { p.client = client }
}

func (*provider) Schema() (*schema.Schema, *schema.Schema) {
	inputs := &schema.Schema{
		Type: "object",
		Properties: map[string]*schema.Schema{
			"address":   {Type: "string"},
			"token":     {Type: "string", Secret: true},
			"mountPath": {Type: "string"},
			"path":      {Type: "string"},
			"namespace": {Type: "string"},
		},
		Required: []string{"address", "token", "mountPath", "path"},
	}
	outputs := &schema.Schema{Type: "object", AdditionalProperties: &schema.Schema{Secret: true}}
	return inputs, outputs
}

func (p *provider) Open(ctx context.Context, inputs map[string]esc.Value, _ esc.EnvExecContext) (esc.Value, error) {
	address, err := escutil.RequiredString(inputs, "address")
	if err != nil {
		return esc.Value{}, err
	}
	token, err := escutil.RequiredString(inputs, "token")
	if err != nil {
		return esc.Value{}, err
	}
	mountPath, err := escutil.RequiredString(inputs, "mountPath")
	if err != nil {
		return esc.Value{}, err
	}
	secretPath, err := escutil.RequiredString(inputs, "path")
	if err != nil {
		return esc.Value{}, err
	}
	namespace, _, err := escutil.OptionalString(inputs, "namespace")
	if err != nil {
		return esc.Value{}, err
	}

	requestURL, err := buildURL(address, mountPath, secretPath)
	if err != nil {
		return esc.Value{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return esc.Value{}, fmt.Errorf("build vault request: %w", err)
	}
	req.Header.Set("X-Vault-Token", token)
	if namespace != "" {
		req.Header.Set("X-Vault-Namespace", namespace)
	}

	resp, err := p.client.Do(req)
	if err != nil {
		return esc.Value{}, fmt.Errorf("vault request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return esc.Value{}, fmt.Errorf("read vault response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return esc.Value{}, fmt.Errorf("vault request failed: %s", bytes.TrimSpace(body))
	}

	var payload struct {
		Data struct {
			Data map[string]any `json:"data"`
		} `json:"data"`
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := decoder.Decode(&payload); err != nil {
		return esc.Value{}, fmt.Errorf("decode vault response: %w", err)
	}
	if payload.Data.Data == nil {
		return esc.Value{}, fmt.Errorf("vault response missing data.data")
	}

	value, err := escutil.ToEscValue(payload.Data.Data)
	if err != nil {
		return esc.Value{}, fmt.Errorf("convert vault response: %w", err)
	}
	return value.MakeSecret(), nil
}

func validateVaultPathSegment(name, value string) error {
	if value == "" {
		return fmt.Errorf("%s must not be empty", name)
	}
	if strings.HasPrefix(value, "/") {
		return fmt.Errorf("%s must be relative (no leading '/')", name)
	}
	for _, seg := range strings.Split(value, "/") {
		if seg == ".." {
			return fmt.Errorf("%s must not contain '..' segments (path traversal)", name)
		}
	}
	return nil
}

func buildURL(address, mountPath, secretPath string) (string, error) {
	parsed, err := url.Parse(address)
	if err != nil {
		return "", fmt.Errorf("address must be a valid URL: %w", err)
	}
	if parsed.Scheme == "" || parsed.Host == "" {
		return "", fmt.Errorf("address must include scheme and host")
	}
	if err := validateVaultPathSegment("mountPath", mountPath); err != nil {
		return "", err
	}
	if err := validateVaultPathSegment("path", secretPath); err != nil {
		return "", err
	}
	parsed.Path = path.Join(parsed.Path, "/v1", mountPath, "data", secretPath)
	return parsed.String(), nil
}
