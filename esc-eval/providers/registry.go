package providers

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/tektum/procella/esc-eval/providers/awslogin"
	"github.com/tektum/procella/esc-eval/providers/awsparameters"
	"github.com/tektum/procella/esc-eval/providers/awssecrets"
	"github.com/tektum/procella/esc-eval/providers/vaultsecrets"
	"github.com/pulumi/esc"
	"github.com/pulumi/esc/eval"
)

var ErrUnknownProvider = errors.New("unknown provider")

type registry struct {
	providers map[string]func() esc.Provider
}

func NewRegistry() eval.ProviderLoader {
	return &registry{
		providers: map[string]func() esc.Provider{
			"aws-login": func() esc.Provider {
				return awslogin.New()
			},
			"aws-secrets": func() esc.Provider {
				return awssecrets.New()
			},
			"aws-parameter-store": func() esc.Provider {
				return awsparameters.New()
			},
			"vault-secrets": func() esc.Provider {
				return vaultsecrets.New()
			},
		},
	}
}

func (r *registry) LoadProvider(_ context.Context, name string) (esc.Provider, error) {
	normalized := strings.TrimPrefix(name, "fn::open::")
	constructor, ok := r.providers[normalized]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrUnknownProvider, name)
	}
	return constructor(), nil
}

func (*registry) LoadRotator(_ context.Context, name string) (esc.Rotator, error) {
	return nil, fmt.Errorf("unknown rotator %q", name)
}
