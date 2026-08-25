package awslogin

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sts"
	ststypes "github.com/aws/aws-sdk-go-v2/service/sts/types"
	"github.com/tektum/procella/esc-eval/providers/internal/escutil"
	"github.com/pulumi/esc"
	"github.com/pulumi/esc/schema"
)

type stsAPI interface {
	AssumeRoleWithWebIdentity(context.Context, *sts.AssumeRoleWithWebIdentityInput, ...func(*sts.Options)) (*sts.AssumeRoleWithWebIdentityOutput, error)
}

type configLoader func(context.Context, string) (aws.Config, error)
type stsClientFactory func(aws.Config) stsAPI
type fileReader func(string) ([]byte, error)

type provider struct {
	loadConfig configLoader
	newClient  stsClientFactory
	readFile   fileReader
	clock      func() time.Time
}

type Option func(*provider)

func New(opts ...Option) esc.Provider {
	p := &provider{
		loadConfig: defaultConfigLoader,
		newClient: func(cfg aws.Config) stsAPI {
			return sts.NewFromConfig(cfg)
		},
		readFile: os.ReadFile,
		clock:    time.Now,
	}
	for _, opt := range opts {
		opt(p)
	}
	return p
}

func WithConfigLoader(loader configLoader) Option {
	return func(p *provider) { p.loadConfig = loader }
}

func WithSTSClientFactory(factory stsClientFactory) Option {
	return func(p *provider) { p.newClient = factory }
}

func WithFileReader(reader fileReader) Option {
	return func(p *provider) { p.readFile = reader }
}

func WithClock(clock func() time.Time) Option {
	return func(p *provider) { p.clock = clock }
}

func (*provider) Schema() (*schema.Schema, *schema.Schema) {
	inputs := &schema.Schema{
		Type: "object",
		Properties: map[string]*schema.Schema{
			"region": {Type: "string"},
			"oidc": {
				Type: "object",
				Properties: map[string]*schema.Schema{
					"roleArn":     {Type: "string"},
					"sessionName": {Type: "string"},
					"duration":    schema.OneOf(&schema.Schema{Type: "integer"}, &schema.Schema{Type: "string"}),
					"policyArns":  {Type: "array", Items: &schema.Schema{Type: "string"}},
				},
				Required: []string{"roleArn", "sessionName"},
			},
			"static": {
				Type: "object",
				Properties: map[string]*schema.Schema{
					"accessKeyId":     {Type: "string", Secret: true},
					"secretAccessKey": {Type: "string", Secret: true},
					"sessionToken":    {Type: "string", Secret: true},
				},
				Required: []string{"accessKeyId", "secretAccessKey"},
			},
		},
	}
	outputs := &schema.Schema{
		Type: "object",
		Properties: map[string]*schema.Schema{
			"accessKeyId":     {Type: "string", Secret: true},
			"secretAccessKey": {Type: "string", Secret: true},
			"sessionToken":    {Type: "string", Secret: true},
			"expiration":      {Type: "string", Secret: true},
			"region":          {Type: "string"},
		},
	}
	return inputs, outputs
}

func (p *provider) Open(ctx context.Context, inputs map[string]esc.Value, _ esc.EnvExecContext) (esc.Value, error) {
	region, _, err := escutil.OptionalString(inputs, "region")
	if err != nil {
		return esc.Value{}, err
	}
	oidc, hasOIDC, err := escutil.OptionalObject(inputs, "oidc")
	if err != nil {
		return esc.Value{}, err
	}
	static, hasStatic, err := escutil.OptionalObject(inputs, "static")
	if err != nil {
		return esc.Value{}, err
	}
	if hasOIDC == hasStatic {
		return esc.Value{}, fmt.Errorf("exactly one of oidc or static must be provided")
	}

	if hasStatic {
		return p.openStatic(static, region)
	}
	return p.openOIDC(ctx, oidc, region)
}

func (p *provider) openStatic(static map[string]esc.Value, region string) (esc.Value, error) {
	accessKeyID, err := escutil.RequiredString(static, "accessKeyId")
	if err != nil {
		return esc.Value{}, err
	}
	secretAccessKey, err := escutil.RequiredString(static, "secretAccessKey")
	if err != nil {
		return esc.Value{}, err
	}
	sessionToken, _, err := escutil.OptionalString(static, "sessionToken")
	if err != nil {
		return esc.Value{}, err
	}

	return esc.NewValue(map[string]esc.Value{
		"accessKeyId":     esc.NewSecret(accessKeyID),
		"secretAccessKey": esc.NewSecret(secretAccessKey),
		"sessionToken":    esc.NewSecret(sessionToken),
		"expiration":      esc.NewSecret(""),
		"region":          esc.NewValue(region),
	}), nil
}

func (p *provider) openOIDC(ctx context.Context, oidc map[string]esc.Value, region string) (esc.Value, error) {
	roleArn, err := escutil.RequiredString(oidc, "roleArn")
	if err != nil {
		return esc.Value{}, err
	}
	sessionName, err := escutil.RequiredString(oidc, "sessionName")
	if err != nil {
		return esc.Value{}, err
	}
	durationSeconds, err := parseDurationSeconds(oidc)
	if err != nil {
		return esc.Value{}, err
	}
	policyArns, _, err := escutil.OptionalStringSlice(oidc, "policyArns")
	if err != nil {
		return esc.Value{}, err
	}

	cfg, err := p.loadConfig(ctx, region)
	if err != nil {
		return esc.Value{}, fmt.Errorf("load AWS config: %w", err)
	}
	tokenPath := os.Getenv("AWS_WEB_IDENTITY_TOKEN_FILE")
	if tokenPath == "" {
		return esc.Value{}, fmt.Errorf("AWS_WEB_IDENTITY_TOKEN_FILE is not set")
	}
	tokenBytes, err := p.readFile(tokenPath)
	if err != nil {
		return esc.Value{}, fmt.Errorf("read web identity token: %w", err)
	}

	input := &sts.AssumeRoleWithWebIdentityInput{
		RoleArn:          aws.String(roleArn),
		RoleSessionName:  aws.String(sessionName),
		WebIdentityToken: aws.String(string(tokenBytes)),
	}
	if durationSeconds != 0 {
		input.DurationSeconds = aws.Int32(durationSeconds)
	}
	if len(policyArns) > 0 {
		input.PolicyArns = make([]ststypes.PolicyDescriptorType, len(policyArns))
		for i, arn := range policyArns {
			input.PolicyArns[i] = ststypes.PolicyDescriptorType{Arn: aws.String(arn)}
		}
	}

	out, err := p.newClient(cfg).AssumeRoleWithWebIdentity(ctx, input)
	if err != nil {
		return esc.Value{}, fmt.Errorf("assume role with web identity: %w", err)
	}
	if out.Credentials == nil {
		return esc.Value{}, fmt.Errorf("assume role with web identity: missing credentials")
	}
	resolvedRegion := region
	if resolvedRegion == "" {
		resolvedRegion = cfg.Region
	}

	return esc.NewValue(map[string]esc.Value{
		"accessKeyId":     esc.NewSecret(aws.ToString(out.Credentials.AccessKeyId)),
		"secretAccessKey": esc.NewSecret(aws.ToString(out.Credentials.SecretAccessKey)),
		"sessionToken":    esc.NewSecret(aws.ToString(out.Credentials.SessionToken)),
		"expiration":      esc.NewSecret(out.Credentials.Expiration.Format(time.RFC3339)),
		"region":          esc.NewValue(resolvedRegion),
	}), nil
}

func defaultConfigLoader(ctx context.Context, region string) (aws.Config, error) {
	options := []func(*awsconfig.LoadOptions) error{}
	if region != "" {
		options = append(options, awsconfig.WithRegion(region))
	}
	return awsconfig.LoadDefaultConfig(ctx, options...)
}

func parseDurationSeconds(oidc map[string]esc.Value) (int32, error) {
	if raw, ok := oidc["duration"]; ok {
		switch v := raw.Value.(type) {
		case string:
			d, err := time.ParseDuration(v)
			if err != nil {
				return 0, fmt.Errorf("duration must be a valid duration string or integer seconds: %w", err)
			}
			return int32(d.Seconds()), nil
		case json.Number:
			i, err := v.Int64()
			if err != nil {
				return 0, fmt.Errorf("duration must be an integer: %w", err)
			}
			return int32(i), nil
		default:
			return 0, fmt.Errorf("duration must be a string or integer")
		}
	}
	return 0, nil
}
