package httpapi

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"html/template"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/k15z/betterpetdoor/internal/database"
)

const (
	oauthScope        = "mcp"
	oauthCodeTTL      = 5 * time.Minute
	oauthAccessTTL    = time.Hour
	oauthRefreshTTL   = 90 * 24 * time.Hour
	oauthClientPrefix = "bpd_"
)

type oauthClient struct {
	RedirectURIs []string `json:"redirect_uris"`
	Name         string   `json:"name"`
	CreatedAt    int64    `json:"created_at"`
}

type oauthAuthorizationRequest struct {
	ClientID      string `json:"client_id"`
	ClientName    string `json:"client_name"`
	ClientHost    string `json:"client_host"`
	RedirectURI   string `json:"redirect_uri"`
	State         string `json:"state"`
	CodeChallenge string `json:"code_challenge"`
	Scope         string `json:"scope"`
	Resource      string `json:"resource"`
	ExpiresAt     int64  `json:"expires_at"`
}

var oauthPage = template.Must(template.New("oauth").Parse(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Authorize Better Pet Door</title>
  <style>
    * { box-sizing: border-box; transition: none; animation: none; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; font: 16px ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: light-dark(#f7f7f7, #0c0c0c); color: light-dark(#111, #f1f1f1); }
    main { width: min(100%, 380px); border-top: 1px solid light-dark(#aaa, #666); padding-top: 24px; }
    h1 { margin: 0 0 10px; font-size: 1.25rem; }
    p { margin: 0 0 24px; color: light-dark(#666, #aaa); line-height: 1.5; }
    label { display: block; margin-bottom: 8px; font-size: .9rem; font-weight: 600; }
    input, button { width: 100%; min-height: 42px; border: 1px solid light-dark(#bbb, #555); border-radius: 4px; font: inherit; }
    input { padding: 8px 10px; background: light-dark(#fff, #141414); color: inherit; }
    button { margin-top: 16px; border-color: light-dark(#111, #f1f1f1); background: light-dark(#111, #f1f1f1); color: light-dark(#fff, #111); font-weight: 600; cursor: pointer; }
    .error { margin-bottom: 16px; color: inherit; }
  </style>
</head>
<body>
  <main>
    <h1>Authorize {{.ClientName}}</h1>
    <p>{{.ClientHost}} will be able to view and control your pet doors.</p>
    {{if .Error}}<div class="error" role="alert">{{.Error}}</div>{{end}}
    <form method="post" action="/oauth/authorize">
      <input type="hidden" name="request" value="{{.Request}}">
      <label for="password">Admin password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
      <button type="submit">Authorize</button>
    </form>
  </main>
</body>
</html>`))

func (s *Server) oauthProtectedResourceMetadata(w http.ResponseWriter, r *http.Request) {
	base := requestBaseURL(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"resource":              base + "/mcp",
		"authorization_servers": []string{base},
		"scopes_supported":      []string{oauthScope},
		"bearer_methods_supported": []string{
			"header",
		},
	})
}

func (s *Server) oauthAuthorizationServerMetadata(w http.ResponseWriter, r *http.Request) {
	base := requestBaseURL(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"issuer":                                         base,
		"authorization_endpoint":                         base + "/oauth/authorize",
		"token_endpoint":                                 base + "/oauth/token",
		"registration_endpoint":                          base + "/oauth/register",
		"scopes_supported":                               []string{oauthScope},
		"response_types_supported":                       []string{"code"},
		"grant_types_supported":                          []string{"authorization_code", "refresh_token"},
		"code_challenge_methods_supported":               []string{"S256"},
		"token_endpoint_auth_methods_supported":          []string{"none"},
		"authorization_response_iss_parameter_supported": false,
	})
}

func (s *Server) oauthRegister(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	var body struct {
		RedirectURIs            []string `json:"redirect_uris"`
		ClientName              string   `json:"client_name"`
		GrantTypes              []string `json:"grant_types"`
		ResponseTypes           []string `json:"response_types"`
		TokenEndpointAuthMethod string   `json:"token_endpoint_auth_method"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeOAuthError(w, http.StatusBadRequest, "invalid_client_metadata", "Invalid registration request.")
		return
	}
	if len(body.RedirectURIs) == 0 || len(body.RedirectURIs) > 10 {
		writeOAuthError(w, http.StatusBadRequest, "invalid_redirect_uri", "Provide between one and ten redirect URIs.")
		return
	}
	for _, redirectURI := range body.RedirectURIs {
		if !validRedirectURI(redirectURI) {
			writeOAuthError(w, http.StatusBadRequest, "invalid_redirect_uri", "A redirect URI is invalid.")
			return
		}
	}
	if body.TokenEndpointAuthMethod != "" && body.TokenEndpointAuthMethod != "none" {
		writeOAuthError(w, http.StatusBadRequest, "invalid_client_metadata", "Only public OAuth clients are supported.")
		return
	}
	if len(body.GrantTypes) > 0 && !contains(body.GrantTypes, "authorization_code") {
		writeOAuthError(w, http.StatusBadRequest, "invalid_client_metadata", "The authorization_code grant is required.")
		return
	}
	if len(body.ResponseTypes) > 0 && !contains(body.ResponseTypes, "code") {
		writeOAuthError(w, http.StatusBadRequest, "invalid_client_metadata", "The code response type is required.")
		return
	}
	name := strings.TrimSpace(body.ClientName)
	if name == "" {
		name = "MCP client"
	}
	if characters := []rune(name); len(characters) > 120 {
		name = string(characters[:120])
	}
	clientID, err := s.sealOAuthValue(oauthClient{
		RedirectURIs: body.RedirectURIs,
		Name:         name,
		CreatedAt:    time.Now().Unix(),
	})
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusCreated, map[string]any{
		"client_id":                  oauthClientPrefix + clientID,
		"client_id_issued_at":        time.Now().Unix(),
		"client_name":                name,
		"redirect_uris":              body.RedirectURIs,
		"grant_types":                []string{"authorization_code", "refresh_token"},
		"response_types":             []string{"code"},
		"token_endpoint_auth_method": "none",
	})
}

func (s *Server) oauthAuthorize(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		s.oauthAuthorizeGet(w, r)
		return
	}
	s.oauthAuthorizePost(w, r)
}

func (s *Server) oauthAuthorizeGet(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	if query.Get("response_type") != "code" {
		http.Error(w, "Only response_type=code is supported.", http.StatusBadRequest)
		return
	}
	clientID := query.Get("client_id")
	client, err := s.oauthClient(clientID)
	if err != nil {
		http.Error(w, "Unknown OAuth client.", http.StatusBadRequest)
		return
	}
	redirectURI := query.Get("redirect_uri")
	if !redirectAllowed(client.RedirectURIs, redirectURI) {
		http.Error(w, "Redirect URI is not registered.", http.StatusBadRequest)
		return
	}
	if query.Get("code_challenge_method") != "S256" || !validCodeChallenge(query.Get("code_challenge")) {
		http.Error(w, "PKCE with S256 is required.", http.StatusBadRequest)
		return
	}
	scope, ok := normalizeScope(query.Get("scope"))
	if !ok {
		http.Error(w, "Only the mcp scope is supported.", http.StatusBadRequest)
		return
	}
	resource := query.Get("resource")
	if resource != "" && strings.TrimSuffix(resource, "/") != requestBaseURL(r)+"/mcp" {
		http.Error(w, "The requested resource is invalid.", http.StatusBadRequest)
		return
	}
	requestValue, err := s.sealOAuthValue(oauthAuthorizationRequest{
		ClientID:      clientID,
		ClientName:    client.Name,
		ClientHost:    redirectLabel(redirectURI),
		RedirectURI:   redirectURI,
		State:         query.Get("state"),
		CodeChallenge: query.Get("code_challenge"),
		Scope:         scope,
		Resource:      resource,
		ExpiresAt:     time.Now().Add(oauthCodeTTL).Unix(),
	})
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.renderOAuthPage(w, http.StatusOK, client.Name, redirectLabel(redirectURI), requestValue, "")
}

func (s *Server) oauthAuthorizePost(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := r.ParseForm(); err != nil {
		http.Error(w, "Invalid authorization request.", http.StatusBadRequest)
		return
	}
	requestValue := r.PostForm.Get("request")
	var request oauthAuthorizationRequest
	if err := s.openOAuthValue(requestValue, &request); err != nil || request.ExpiresAt < time.Now().Unix() {
		http.Error(w, "Authorization request expired. Start again from your MCP client.", http.StatusBadRequest)
		return
	}
	client, err := s.oauthClient(request.ClientID)
	if err != nil || !redirectAllowed(client.RedirectURIs, request.RedirectURI) {
		http.Error(w, "Invalid authorization request.", http.StatusBadRequest)
		return
	}
	valid, err := s.auth.Authenticate(r.Context(), r.PostForm.Get("password"))
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if !valid {
		s.renderOAuthPage(w, http.StatusUnauthorized, request.ClientName, request.ClientHost, requestValue, "Incorrect password.")
		return
	}
	code, err := randomOAuthToken()
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if err := s.db.CreateOAuthCode(r.Context(), oauthTokenHash(code), database.OAuthCode{
		ClientID:      request.ClientID,
		RedirectURI:   request.RedirectURI,
		CodeChallenge: request.CodeChallenge,
		Scope:         request.Scope,
		Resource:      request.Resource,
		ExpiresAt:     time.Now().Add(oauthCodeTTL),
	}); err != nil {
		s.internalError(w, r, err)
		return
	}
	redirect, _ := url.Parse(request.RedirectURI)
	values := redirect.Query()
	values.Set("code", code)
	if request.State != "" {
		values.Set("state", request.State)
	}
	redirect.RawQuery = values.Encode()
	http.Redirect(w, r, redirect.String(), http.StatusFound)
}

func (s *Server) oauthToken(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := r.ParseForm(); err != nil {
		writeOAuthError(w, http.StatusBadRequest, "invalid_request", "Invalid token request.")
		return
	}
	switch r.PostForm.Get("grant_type") {
	case "authorization_code":
		s.oauthExchangeCode(w, r)
	case "refresh_token":
		s.oauthRefreshToken(w, r)
	default:
		writeOAuthError(w, http.StatusBadRequest, "unsupported_grant_type", "Unsupported grant type.")
	}
}

func (s *Server) oauthExchangeCode(w http.ResponseWriter, r *http.Request) {
	clientID := r.PostForm.Get("client_id")
	if _, err := s.oauthClient(clientID); err != nil {
		writeOAuthError(w, http.StatusUnauthorized, "invalid_client", "Unknown OAuth client.")
		return
	}
	code, err := s.db.ConsumeOAuthCode(r.Context(), oauthTokenHash(r.PostForm.Get("code")))
	if errors.Is(err, database.ErrNotFound) {
		writeOAuthError(w, http.StatusBadRequest, "invalid_grant", "Authorization code is invalid.")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if code.ExpiresAt.Before(time.Now()) || code.ClientID != clientID || code.RedirectURI != r.PostForm.Get("redirect_uri") {
		writeOAuthError(w, http.StatusBadRequest, "invalid_grant", "Authorization code is invalid.")
		return
	}
	verifier := r.PostForm.Get("code_verifier")
	if !validCodeVerifier(verifier) || !pkceMatches(verifier, code.CodeChallenge) {
		writeOAuthError(w, http.StatusBadRequest, "invalid_grant", "PKCE verification failed.")
		return
	}
	s.issueOAuthTokens(w, r, clientID, code.Scope)
}

func (s *Server) oauthRefreshToken(w http.ResponseWriter, r *http.Request) {
	clientID := r.PostForm.Get("client_id")
	if _, err := s.oauthClient(clientID); err != nil {
		writeOAuthError(w, http.StatusUnauthorized, "invalid_client", "Unknown OAuth client.")
		return
	}
	token, err := s.db.ConsumeOAuthToken(r.Context(), oauthTokenHash(r.PostForm.Get("refresh_token")), "refresh", time.Now())
	if errors.Is(err, database.ErrNotFound) || (err == nil && token.ClientID != clientID) {
		writeOAuthError(w, http.StatusBadRequest, "invalid_grant", "Refresh token is invalid.")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if scope := r.PostForm.Get("scope"); scope != "" && scope != token.Scope {
		writeOAuthError(w, http.StatusBadRequest, "invalid_scope", "Only the original scope can be refreshed.")
		return
	}
	s.issueOAuthTokens(w, r, clientID, token.Scope)
}

func (s *Server) issueOAuthTokens(w http.ResponseWriter, r *http.Request, clientID, scope string) {
	access, err := randomOAuthToken()
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	refresh, err := randomOAuthToken()
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if err := s.db.CreateOAuthToken(r.Context(), oauthTokenHash(access), "access", database.OAuthToken{
		ClientID: clientID, Scope: scope, ExpiresAt: time.Now().Add(oauthAccessTTL),
	}); err != nil {
		s.internalError(w, r, err)
		return
	}
	if err := s.db.CreateOAuthToken(r.Context(), oauthTokenHash(refresh), "refresh", database.OAuthToken{
		ClientID: clientID, Scope: scope, ExpiresAt: time.Now().Add(oauthRefreshTTL),
	}); err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"access_token":  access,
		"token_type":    "Bearer",
		"expires_in":    int(oauthAccessTTL.Seconds()),
		"refresh_token": refresh,
		"scope":         scope,
	})
}

func (s *Server) requireMCPAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		prefix, token, ok := strings.Cut(r.Header.Get("Authorization"), " ")
		if !ok || !strings.EqualFold(prefix, "Bearer") || token == "" {
			s.writeMCPUnauthorized(w, r)
			return
		}
		stored, err := s.db.OAuthToken(r.Context(), oauthTokenHash(token), "access", time.Now())
		if errors.Is(err, database.ErrNotFound) || (err == nil && stored.Scope != oauthScope) {
			s.writeMCPUnauthorized(w, r)
			return
		}
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) writeMCPUnauthorized(w http.ResponseWriter, r *http.Request) {
	metadata := requestBaseURL(r) + "/.well-known/oauth-protected-resource/mcp"
	w.Header().Set("WWW-Authenticate", `Bearer resource_metadata="`+metadata+`", scope="`+oauthScope+`"`)
	writeError(w, http.StatusUnauthorized, "OAuth authentication required.")
}

func (s *Server) oauthClient(clientID string) (oauthClient, error) {
	if !strings.HasPrefix(clientID, oauthClientPrefix) {
		return oauthClient{}, errors.New("invalid client id")
	}
	var client oauthClient
	if err := s.openOAuthValue(strings.TrimPrefix(clientID, oauthClientPrefix), &client); err != nil {
		return oauthClient{}, err
	}
	if len(client.RedirectURIs) == 0 {
		return oauthClient{}, errors.New("invalid client id")
	}
	return client, nil
}

func (s *Server) sealOAuthValue(value any) (string, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	sealed, err := s.box.Seal(encoded)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(sealed), nil
}

func (s *Server) openOAuthValue(value string, target any) error {
	if len(value) == 0 || len(value) > 16<<10 {
		return errors.New("invalid sealed value")
	}
	sealed, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return err
	}
	plaintext, err := s.box.Open(sealed)
	if err != nil {
		return err
	}
	return json.Unmarshal(plaintext, target)
}

func (s *Server) renderOAuthPage(w http.ResponseWriter, status int, clientName, clientHost, requestValue, message string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = oauthPage.Execute(w, map[string]string{
		"ClientName": clientName,
		"ClientHost": clientHost,
		"Request":    requestValue,
		"Error":      message,
	})
}

func redirectLabel(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "This client"
	}
	if parsed.Host != "" {
		return parsed.Host
	}
	return parsed.Scheme
}

func requestBaseURL(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if forwarded := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0]); forwarded == "http" || forwarded == "https" {
		scheme = forwarded
	}
	return scheme + "://" + r.Host
}

func validRedirectURI(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || parsed.Fragment != "" || parsed.User != nil {
		return false
	}
	if parsed.Scheme == "https" {
		return true
	}
	return parsed.Scheme == "http" && isLoopbackHost(parsed.Hostname())
}

func redirectAllowed(registered []string, requested string) bool {
	if !validRedirectURI(requested) {
		return false
	}
	requestURL, _ := url.Parse(requested)
	for _, candidate := range registered {
		if candidate == requested {
			return true
		}
		registeredURL, _ := url.Parse(candidate)
		if requestURL.Scheme == "http" && registeredURL.Scheme == "http" &&
			isLoopbackHost(requestURL.Hostname()) && requestURL.Hostname() == registeredURL.Hostname() &&
			requestURL.Path == registeredURL.Path && requestURL.RawQuery == registeredURL.RawQuery {
			return true
		}
	}
	return false
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func normalizeScope(value string) (string, bool) {
	fields := strings.Fields(value)
	if len(fields) == 0 {
		return oauthScope, true
	}
	return oauthScope, len(fields) == 1 && fields[0] == oauthScope
}

func validCodeChallenge(value string) bool {
	if len(value) != 43 {
		return false
	}
	_, err := base64.RawURLEncoding.DecodeString(value)
	return err == nil
}

func validCodeVerifier(value string) bool {
	if len(value) < 43 || len(value) > 128 {
		return false
	}
	for _, character := range value {
		if (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') || strings.ContainsRune("-._~", character) {
			continue
		}
		return false
	}
	return true
}

func pkceMatches(verifier, challenge string) bool {
	digest := sha256.Sum256([]byte(verifier))
	expected := base64.RawURLEncoding.EncodeToString(digest[:])
	return subtle.ConstantTimeCompare([]byte(expected), []byte(challenge)) == 1
}

func randomOAuthToken() (string, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func oauthTokenHash(token string) string {
	digest := sha256.Sum256([]byte(token))
	return hex.EncodeToString(digest[:])
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func writeOAuthError(w http.ResponseWriter, status int, code, description string) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, status, map[string]string{
		"error":             code,
		"error_description": description,
	})
}
