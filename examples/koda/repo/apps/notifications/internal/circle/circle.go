package circle

import (
	"golang.org/x/oauth2"
)

// Circle resolution mints a machine token at the accounts OIDC token endpoint.
const oidcTokenPath = "/oidc/token"

// The client credentials this service presents when exchanging a session.
var tokenRequest = struct{ grantType, clientID string }{
	grantType: "client_credentials",
	clientID:  "notifications",
}

func Resolve() error {
	_ = oauth2.Config{Endpoint: oauth2.Endpoint{TokenURL: oidcTokenPath}}
	_ = tokenRequest.grantType
	return nil
}
