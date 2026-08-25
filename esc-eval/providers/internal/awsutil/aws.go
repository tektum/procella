package awsutil

import (
	"context"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/tektum/procella/esc-eval/providers/internal/escutil"
	"github.com/pulumi/esc"
)

type Credentials struct {
	AccessKeyID     string
	SecretAccessKey string
	SessionToken    string
}

type ConfigLoader func(ctx context.Context, region string, creds *Credentials) (aws.Config, error)

func DefaultConfigLoader(ctx context.Context, region string, creds *Credentials) (aws.Config, error) {
	options := []func(*config.LoadOptions) error{}
	if region != "" {
		options = append(options, config.WithRegion(region))
	}
	if creds != nil {
		provider := credentials.NewStaticCredentialsProvider(creds.AccessKeyID, creds.SecretAccessKey, creds.SessionToken)
		options = append(options, config.WithCredentialsProvider(provider))
	}
	return config.LoadDefaultConfig(ctx, options...)
}

func OptionalLogin(inputs map[string]esc.Value) (*Credentials, error) {
	login, ok, err := escutil.OptionalObject(inputs, "login")
	if err != nil || !ok {
		return nil, err
	}

	accessKeyID, err := escutil.RequiredString(login, "accessKeyId")
	if err != nil {
		return nil, err
	}
	secretAccessKey, err := escutil.RequiredString(login, "secretAccessKey")
	if err != nil {
		return nil, err
	}
	sessionToken, _, err := escutil.OptionalString(login, "sessionToken")
	if err != nil {
		return nil, err
	}

	return &Credentials{
		AccessKeyID:     accessKeyID,
		SecretAccessKey: secretAccessKey,
		SessionToken:    sessionToken,
	}, nil
}
