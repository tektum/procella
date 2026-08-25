package awsparameters

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	ssmtypes "github.com/aws/aws-sdk-go-v2/service/ssm/types"
	"github.com/tektum/procella/esc-eval/providers/internal/awsutil"
	"github.com/pulumi/esc"
)

type fakeSSMClient struct {
	output *ssm.GetParameterOutput
	err    error
	input  *ssm.GetParameterInput
}

func (f *fakeSSMClient) GetParameter(_ context.Context, input *ssm.GetParameterInput, _ ...func(*ssm.Options)) (*ssm.GetParameterOutput, error) {
	f.input = input
	if f.err != nil {
		return nil, f.err
	}
	return f.output, nil
}

func TestOpenReturnsPlainParameter(t *testing.T) {
	client := &fakeSSMClient{output: &ssm.GetParameterOutput{Parameter: &ssmtypes.Parameter{Value: aws.String("hello"), Type: ssmtypes.ParameterTypeString}}}
	p := New(
		WithConfigLoader(func(_ context.Context, region string, _ *awsutil.Credentials) (aws.Config, error) {
			return aws.Config{Region: region}, nil
		}),
		WithClientFactory(func(aws.Config) ssmAPI { return client }),
	).(*provider)

	v, err := p.Open(context.Background(), map[string]esc.Value{
		"region": esc.NewValue("us-east-1"),
		"name":   esc.NewValue("/procella/plain"),
	}, nil)
	if err != nil {
		t.Fatalf("Open returned error: %v", err)
	}
	value := v.Value.(map[string]esc.Value)["value"]
	if value.Secret || value.Value != "hello" {
		t.Fatalf("value = %#v", value)
	}
}

func TestOpenMarksSecureStringAsSecret(t *testing.T) {
	client := &fakeSSMClient{output: &ssm.GetParameterOutput{Parameter: &ssmtypes.Parameter{Value: aws.String("secret"), Type: ssmtypes.ParameterTypeSecureString}}}
	p := New(
		WithConfigLoader(func(_ context.Context, region string, _ *awsutil.Credentials) (aws.Config, error) {
			return aws.Config{Region: region}, nil
		}),
		WithClientFactory(func(aws.Config) ssmAPI { return client }),
	).(*provider)

	v, err := p.Open(context.Background(), map[string]esc.Value{
		"region":         esc.NewValue("us-east-1"),
		"name":           esc.NewValue("/procella/secret"),
		"withDecryption": esc.NewValue(true),
	}, nil)
	if err != nil {
		t.Fatalf("Open returned error: %v", err)
	}
	value := v.Value.(map[string]esc.Value)["value"]
	if !value.Secret || value.Value != "secret" {
		t.Fatalf("value = %#v", value)
	}
	if !aws.ToBool(client.input.WithDecryption) {
		t.Fatal("expected WithDecryption=true")
	}
}

func TestOpenRejectsMissingName(t *testing.T) {
	_, err := New().Open(context.Background(), map[string]esc.Value{"region": esc.NewValue("us-east-1")}, nil)
	if err == nil || !strings.Contains(err.Error(), "name") {
		t.Fatalf("expected name error, got %v", err)
	}
}

func TestOpenPropagatesSDKError(t *testing.T) {
	want := errors.New("boom")
	p := New(
		WithConfigLoader(func(_ context.Context, region string, _ *awsutil.Credentials) (aws.Config, error) {
			return aws.Config{Region: region}, nil
		}),
		WithClientFactory(func(aws.Config) ssmAPI { return &fakeSSMClient{err: want} }),
	).(*provider)

	_, err := p.Open(context.Background(), map[string]esc.Value{
		"region": esc.NewValue("us-east-1"),
		"name":   esc.NewValue("/procella/plain"),
	}, nil)
	if !errors.Is(err, want) {
		t.Fatalf("expected sdk error, got %v", err)
	}
}
