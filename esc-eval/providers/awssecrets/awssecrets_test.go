package awssecrets

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/secretsmanager"
	"github.com/tektum/procella/esc-eval/providers/internal/awsutil"
	"github.com/pulumi/esc"
)

type fakeSecretsClient struct {
	output *secretsmanager.GetSecretValueOutput
	err    error
	input  *secretsmanager.GetSecretValueInput
}

func (f *fakeSecretsClient) GetSecretValue(_ context.Context, input *secretsmanager.GetSecretValueInput, _ ...func(*secretsmanager.Options)) (*secretsmanager.GetSecretValueOutput, error) {
	f.input = input
	if f.err != nil {
		return nil, f.err
	}
	return f.output, nil
}

func TestOpenReturnsPlaintextSecret(t *testing.T) {
	client := &fakeSecretsClient{output: &secretsmanager.GetSecretValueOutput{SecretString: aws.String("super-secret")}}
	p := New(
		WithConfigLoader(func(_ context.Context, region string, _ *awsutil.Credentials) (aws.Config, error) {
			return aws.Config{Region: region}, nil
		}),
		WithClientFactory(func(aws.Config) secretsAPI { return client }),
	).(*provider)

	v, err := p.Open(context.Background(), map[string]esc.Value{
		"region":   esc.NewValue("us-east-1"),
		"secretId": esc.NewValue("procella/demo"),
	}, nil)
	if err != nil {
		t.Fatalf("Open returned error: %v", err)
	}
	plaintext := v.Value.(map[string]esc.Value)["plaintext"]
	if !plaintext.Secret || plaintext.Value != "super-secret" {
		t.Fatalf("plaintext = %#v", plaintext)
	}
	if got := aws.ToString(client.input.SecretId); got != "procella/demo" {
		t.Fatalf("secret id = %q", got)
	}
}

func TestOpenReturnsBinarySecret(t *testing.T) {
	client := &fakeSecretsClient{output: &secretsmanager.GetSecretValueOutput{SecretBinary: []byte{1, 2, 3}}}
	p := New(
		WithConfigLoader(func(_ context.Context, region string, _ *awsutil.Credentials) (aws.Config, error) {
			return aws.Config{Region: region}, nil
		}),
		WithClientFactory(func(aws.Config) secretsAPI { return client }),
	).(*provider)

	v, err := p.Open(context.Background(), map[string]esc.Value{
		"region":   esc.NewValue("us-east-1"),
		"secretId": esc.NewValue("procella/demo"),
	}, nil)
	if err != nil {
		t.Fatalf("Open returned error: %v", err)
	}
	binary := v.Value.(map[string]esc.Value)["binary"]
	items := binary.Value.([]esc.Value)
	if !binary.Secret || len(items) != 3 || items[0].ToJSON(false) != json.Number("1") {
		t.Fatalf("binary = %#v", binary)
	}
	for i, item := range items {
		if !item.Secret {
			t.Fatalf("binary[%d] is not marked Secret — leaks individual byte values to TS-side secret-path collector", i)
		}
	}
}

func TestOpenMarksPlaintextLeafAsSecret(t *testing.T) {
	client := &fakeSecretsClient{output: &secretsmanager.GetSecretValueOutput{SecretString: aws.String("hunter2")}}
	p := New(
		WithConfigLoader(func(_ context.Context, region string, _ *awsutil.Credentials) (aws.Config, error) {
			return aws.Config{Region: region}, nil
		}),
		WithClientFactory(func(aws.Config) secretsAPI { return client }),
	).(*provider)

	v, err := p.Open(context.Background(), map[string]esc.Value{
		"region":   esc.NewValue("us-east-1"),
		"secretId": esc.NewValue("procella/demo"),
	}, nil)
	if err != nil {
		t.Fatalf("Open returned error: %v", err)
	}
	plaintext := v.Value.(map[string]esc.Value)["plaintext"]
	if !plaintext.Secret {
		t.Fatal("plaintext leaf is not marked Secret — collectSecretPaths would miss the path")
	}
}

func TestOpenRejectsMissingSecretID(t *testing.T) {
	_, err := New().Open(context.Background(), map[string]esc.Value{"region": esc.NewValue("us-east-1")}, nil)
	if err == nil || !strings.Contains(err.Error(), "secretId") {
		t.Fatalf("expected secretId error, got %v", err)
	}
}

func TestOpenPropagatesSDKError(t *testing.T) {
	want := errors.New("boom")
	p := New(
		WithConfigLoader(func(_ context.Context, region string, _ *awsutil.Credentials) (aws.Config, error) {
			return aws.Config{Region: region}, nil
		}),
		WithClientFactory(func(aws.Config) secretsAPI { return &fakeSecretsClient{err: want} }),
	).(*provider)

	_, err := p.Open(context.Background(), map[string]esc.Value{
		"region":   esc.NewValue("us-east-1"),
		"secretId": esc.NewValue("procella/demo"),
	}, nil)
	if !errors.Is(err, want) {
		t.Fatalf("expected sdk error, got %v", err)
	}
}
