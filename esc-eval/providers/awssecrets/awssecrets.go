package awssecrets

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/secretsmanager"
	"github.com/tektum/procella/esc-eval/providers/internal/awsutil"
	"github.com/tektum/procella/esc-eval/providers/internal/escutil"
	"github.com/pulumi/esc"
	"github.com/pulumi/esc/schema"
)

type secretsAPI interface {
	GetSecretValue(context.Context, *secretsmanager.GetSecretValueInput, ...func(*secretsmanager.Options)) (*secretsmanager.GetSecretValueOutput, error)
}

type clientFactory func(aws.Config) secretsAPI

type provider struct {
	loadConfig awsutil.ConfigLoader
	newClient  clientFactory
}

type Option func(*provider)

func New(opts ...Option) esc.Provider {
	p := &provider{
		loadConfig: awsutil.DefaultConfigLoader,
		newClient: func(cfg aws.Config) secretsAPI {
			return secretsmanager.NewFromConfig(cfg)
		},
	}
	for _, opt := range opts {
		opt(p)
	}
	return p
}

func WithConfigLoader(loader awsutil.ConfigLoader) Option {
	return func(p *provider) { p.loadConfig = loader }
}

func WithClientFactory(factory clientFactory) Option {
	return func(p *provider) { p.newClient = factory }
}

func (*provider) Schema() (*schema.Schema, *schema.Schema) {
	inputs := &schema.Schema{
		Type: "object",
		Properties: map[string]*schema.Schema{
			"region":       {Type: "string"},
			"secretId":     {Type: "string"},
			"versionId":    {Type: "string"},
			"versionStage": {Type: "string"},
			"login": {
				Type: "object",
				Properties: map[string]*schema.Schema{
					"accessKeyId":     {Type: "string", Secret: true},
					"secretAccessKey": {Type: "string", Secret: true},
					"sessionToken":    {Type: "string", Secret: true},
				},
			},
		},
		Required: []string{"region", "secretId"},
	}
	outputs := schema.OneOf(
		&schema.Schema{Type: "object", Properties: map[string]*schema.Schema{"plaintext": {Type: "string", Secret: true}}, Required: []string{"plaintext"}},
		&schema.Schema{Type: "object", Properties: map[string]*schema.Schema{"binary": {Type: "array", Items: &schema.Schema{Type: "integer", Secret: true}, Secret: true}}, Required: []string{"binary"}},
	)
	return inputs, outputs
}

func (p *provider) Open(ctx context.Context, inputs map[string]esc.Value, _ esc.EnvExecContext) (esc.Value, error) {
	region, err := escutil.RequiredString(inputs, "region")
	if err != nil {
		return esc.Value{}, err
	}
	secretID, err := escutil.RequiredString(inputs, "secretId")
	if err != nil {
		return esc.Value{}, err
	}
	versionID, _, err := escutil.OptionalString(inputs, "versionId")
	if err != nil {
		return esc.Value{}, err
	}
	versionStage, _, err := escutil.OptionalString(inputs, "versionStage")
	if err != nil {
		return esc.Value{}, err
	}
	login, err := awsutil.OptionalLogin(inputs)
	if err != nil {
		return esc.Value{}, err
	}

	cfg, err := p.loadConfig(ctx, region, login)
	if err != nil {
		return esc.Value{}, fmt.Errorf("load AWS config: %w", err)
	}
	result, err := p.newClient(cfg).GetSecretValue(ctx, &secretsmanager.GetSecretValueInput{
		SecretId:     aws.String(secretID),
		VersionId:    optionalStringPtr(versionID),
		VersionStage: optionalStringPtr(versionStage),
	})
	if err != nil {
		return esc.Value{}, fmt.Errorf("get secret value: %w", err)
	}

	if result.SecretString != nil {
		return esc.NewSecret(
			map[string]esc.Value{"plaintext": esc.NewSecret(*result.SecretString)},
		), nil
	}
	if len(result.SecretBinary) > 0 {
		return esc.NewSecret(
			map[string]esc.Value{"binary": bytesToSecretValue(result.SecretBinary)},
		), nil
	}
	return esc.Value{}, fmt.Errorf("get secret value: secret %q had neither string nor binary payload", secretID)
}

func optionalStringPtr(v string) *string {
	if v == "" {
		return nil
	}
	return aws.String(v)
}

// bytesToSecretValue marks each byte element as Secret so the evaluator's
// secret-path collector reports each leaf (binary[i]) as sensitive. Without
// this, only the outer wrapper is flagged and TS-side masking misses the
// individual bytes.
func bytesToSecretValue(b []byte) esc.Value {
	values := make([]esc.Value, len(b))
	for i, bb := range b {
		values[i] = esc.NewSecret(json.Number(fmt.Sprintf("%d", bb)))
	}
	return esc.NewSecret(values)
}
