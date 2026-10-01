package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"html"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestOAuthDiscovery(t *testing.T) {
	handler := testHandler(t)
	request := httptest.NewRequest(http.MethodGet, "/.well-known/oauth-protected-resource/mcp", nil)
	request.Host = "doors.example"
	request.Header.Set("X-Forwarded-Proto", "https")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("got %d: %s", response.Code, response.Body.String())
	}
	var metadata struct {
		Resource             string   `json:"resource"`
		AuthorizationServers []string `json:"authorization_servers"`
		Scopes               []string `json:"scopes_supported"`
	}
	if err := json.NewDecoder(response.Body).Decode(&metadata); err != nil {
		t.Fatal(err)
	}
	if metadata.Resource != "https://doors.example/mcp" || !slices.Equal(metadata.AuthorizationServers, []string{"https://doors.example"}) || !slices.Equal(metadata.Scopes, []string{"mcp"}) {
		t.Fatalf("unexpected metadata: %#v", metadata)
	}
}

func TestMCPRequiresOAuth(t *testing.T) {
	handler := testHandler(t)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{}`)))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("got %d, want %d", response.Code, http.StatusUnauthorized)
	}
	if challenge := response.Header().Get("WWW-Authenticate"); !strings.Contains(challenge, "oauth-protected-resource/mcp") || !strings.Contains(challenge, `scope="mcp"`) {
		t.Fatalf("unexpected challenge: %q", challenge)
	}
}

func TestOAuthFlowConnectsMCPClient(t *testing.T) {
	server := httptest.NewServer(testHandler(t))
	t.Cleanup(server.Close)

	clientID := registerTestOAuthClient(t, server.URL, "http://127.0.0.1/callback")
	verifier := strings.Repeat("v", 43)
	digest := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(digest[:])

	authorizeURL, _ := url.Parse(server.URL + "/oauth/authorize")
	query := authorizeURL.Query()
	query.Set("response_type", "code")
	query.Set("client_id", clientID)
	query.Set("redirect_uri", "http://127.0.0.1:54321/callback")
	query.Set("scope", "mcp")
	query.Set("state", "test-state")
	query.Set("code_challenge", challenge)
	query.Set("code_challenge_method", "S256")
	query.Set("resource", server.URL+"/mcp")
	authorizeURL.RawQuery = query.Encode()

	authorizeResponse, err := http.Get(authorizeURL.String())
	if err != nil {
		t.Fatal(err)
	}
	authorizePage, _ := io.ReadAll(authorizeResponse.Body)
	_ = authorizeResponse.Body.Close()
	if authorizeResponse.StatusCode != http.StatusOK {
		t.Fatalf("authorize got %d: %s", authorizeResponse.StatusCode, authorizePage)
	}
	match := regexp.MustCompile(`name="request" value="([^"]+)"`).FindSubmatch(authorizePage)
	if len(match) != 2 {
		t.Fatalf("authorization request field missing: %s", authorizePage)
	}

	form := url.Values{
		"request":  {html.UnescapeString(string(match[1]))},
		"password": {testPassword},
	}
	postRequest, _ := http.NewRequest(http.MethodPost, server.URL+"/oauth/authorize", strings.NewReader(form.Encode()))
	postRequest.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	noRedirect := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	postResponse, err := noRedirect.Do(postRequest)
	if err != nil {
		t.Fatal(err)
	}
	_ = postResponse.Body.Close()
	if postResponse.StatusCode != http.StatusFound {
		t.Fatalf("authorize submit got %d", postResponse.StatusCode)
	}
	callback, err := url.Parse(postResponse.Header.Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if callback.Query().Get("state") != "test-state" || callback.Query().Get("code") == "" {
		t.Fatalf("unexpected callback: %s", callback)
	}

	tokenForm := url.Values{
		"grant_type":    {"authorization_code"},
		"client_id":     {clientID},
		"code":          {callback.Query().Get("code")},
		"redirect_uri":  {"http://127.0.0.1:54321/callback"},
		"code_verifier": {verifier},
	}
	tokenResponse, err := http.PostForm(server.URL+"/oauth/token", tokenForm)
	if err != nil {
		t.Fatal(err)
	}
	defer tokenResponse.Body.Close()
	var tokens struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		Scope        string `json:"scope"`
	}
	if err := json.NewDecoder(tokenResponse.Body).Decode(&tokens); err != nil {
		t.Fatal(err)
	}
	if tokenResponse.StatusCode != http.StatusOK || tokens.AccessToken == "" || tokens.RefreshToken == "" || tokens.Scope != "mcp" {
		t.Fatalf("unexpected token response: status=%d body=%#v", tokenResponse.StatusCode, tokens)
	}

	httpClient := &http.Client{Transport: bearerTransport{token: tokens.AccessToken}}
	client := mcp.NewClient(&mcp.Implementation{Name: "betterpetdoor-test", Version: "1.0.0"}, nil)
	session, err := client.Connect(context.Background(), &mcp.StreamableClientTransport{
		Endpoint:             server.URL + "/mcp",
		HTTPClient:           httpClient,
		DisableStandaloneSSE: true,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()

	tools, err := session.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(tools.Tools) != 5 {
		t.Fatalf("got %d tools, want 5", len(tools.Tools))
	}
	result, err := session.CallTool(context.Background(), &mcp.CallToolParams{Name: "list_pet_doors", Arguments: map[string]any{}})
	if err != nil {
		t.Fatal(err)
	}
	if result.IsError {
		t.Fatalf("list_pet_doors returned an error: %#v", result.Content)
	}
}

func TestOpenAPISpec(t *testing.T) {
	handler := testHandler(t)
	request := httptest.NewRequest(http.MethodGet, "/openapi.json", nil)
	request.Host = "doors.example"
	request.Header.Set("X-Forwarded-Proto", "https")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("got %d: %s", response.Code, response.Body.String())
	}
	var spec struct {
		OpenAPI string                     `json:"openapi"`
		Servers []map[string]string        `json:"servers"`
		Paths   map[string]json.RawMessage `json:"paths"`
	}
	if err := json.NewDecoder(response.Body).Decode(&spec); err != nil {
		t.Fatal(err)
	}
	if spec.OpenAPI != "3.1.0" || spec.Servers[0]["url"] != "https://doors.example" || spec.Paths["/api/doors/{doorId}/commands/open"] == nil {
		t.Fatalf("unexpected OpenAPI document: %#v", spec)
	}
}

func registerTestOAuthClient(t *testing.T, serverURL, redirectURI string) string {
	t.Helper()
	body, _ := json.Marshal(map[string]any{
		"client_name":                "Test agent",
		"redirect_uris":              []string{redirectURI},
		"grant_types":                []string{"authorization_code", "refresh_token"},
		"response_types":             []string{"code"},
		"token_endpoint_auth_method": "none",
	})
	response, err := http.Post(serverURL+"/oauth/register", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var registration struct {
		ClientID string `json:"client_id"`
	}
	if err := json.NewDecoder(response.Body).Decode(&registration); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusCreated || registration.ClientID == "" {
		t.Fatalf("unexpected registration: status=%d body=%#v", response.StatusCode, registration)
	}
	return registration.ClientID
}

type bearerTransport struct {
	token string
}

func (transport bearerTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	clone := request.Clone(request.Context())
	clone.Header.Set("Authorization", "Bearer "+transport.token)
	return http.DefaultTransport.RoundTrip(clone)
}
