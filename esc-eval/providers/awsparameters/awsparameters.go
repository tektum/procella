package awsparameters

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	ssmtypes "github.com/aws/aws-sdk-go-v2/service/ssm/types"
	"github.com/tektum/procella/esc-eval/providers/internal/awsutil"
	"github.com/tektum/procella/esc-eval/providers/internal/escutil"
	"github.com/pulumi/esc"
	"github.com/pulumi/esc/schema"
)

type ssmAPI interface {
	GetParameter(context.Context, *ssm.GetParameterInput, ...func(*ssm.Options)) (*ssm.GetParameterOutput, error)
}

type clientFactory func(aws.Config) ssmAPI

type provider struct {
	loadConfig awsutil.ConfigLoader
	newClient  clientFactory
}

type Option func(*provider)

func New(opts ...Option) esc.Provider {
	p := &provider{
		loadConfig: awsutil.DefaultConfigLoader,
		newClient: func(cfg aws.Config) ssmAPI {
			return ssm.NewFromConfig(cfg)
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
			"region":         {Type: "string"},
			"name":           {Type: "string"},
			"withDecryption": {Type: "boolean"},
			"login": {
				Type: "object",
				Properties: map[string]*schema.Schema{
					"accessKeyId":     {Type: "string", Secret: true},
					"secretAccessKey": {Type: "string", Secret: true},
					"sessionToken":    {Type: "string", Secret: true},
				},
			},
		},
		Required: []string{"region", "name"},
	}
	outputs := &schema.Schema{
		Type: "object",
		Properties: map[string]*schema.Schema{
			"value": {Type: "string"},
		},
		Required: []string{"value"},
	}
	return inputs, outputs
}

func (p *provider) Open(ctx context.Context, inputs map[string]esc.Value, _ esc.EnvExecContext) (esc.Value, error) {
	region, err := escutil.RequiredString(inputs, "region")
	if err != nil {
		return esc.Value{}, err
	}
	name, err := escutil.RequiredString(inputs, "name")
	if err != nil {
		return esc.Value{}, err
	}
	withDecryption, ok, err := escutil.OptionalBool(inputs, "withDecryption")
	if err != nil {
		return esc.Value{}, err
	}
	if !ok {
		if decrypt, ok, err := escutil.OptionalBool(inputs, "decrypt"); err != nil {
			return esc.Value{}, err
		} else if ok {
			withDecryption = decrypt
		}
	}
	login, err := awsutil.OptionalLogin(inputs)
	if err != nil {
		return esc.Value{}, err
	}

	cfg, err := p.loadConfig(ctx, region, login)
	if err != nil {
		return esc.Value{}, fmt.Errorf("load AWS config: %w", err)
	}
	result, err := p.newClient(cfg).GetParameter(ctx, &ssm.GetParameterInput{
		Name:           aws.String(name),
		WithDecryption: aws.Bool(withDecryption),
	})
	if err != nil {
		return esc.Value{}, fmt.Errorf("get parameter: %w", err)
	}
	if result.Parameter == nil || result.Parameter.Value == nil {
		return esc.Value{}, fmt.Errorf("get parameter: missing parameter value")
	}

	value := esc.NewValue(map[string]esc.Value{"value": esc.NewValue(*result.Parameter.Value)})
	if withDecryption || result.Parameter.Type == ssmtypes.ParameterTypeSecureString {
		return esc.NewSecret(value.Value.(map[string]esc.Value)), nil
	}
	return value, nil
}
