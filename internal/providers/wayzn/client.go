package wayzn

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	nonceDatabase = "https://wayzn-app-nonce.firebaseio.com"
	tokenDatabase = "https://wayzn-app-tokens.firebaseio.com"
)

var (
	ErrInvalidPairingCode = errors.New("invalid Wayzn pairing code")
	ErrAuthentication     = errors.New("Wayzn sign-in failed")
	ErrRemote             = errors.New("Wayzn service could not be reached")
)

func ValidFirebaseAPIKey(value string) bool {
	value = strings.TrimSpace(value)
	if len(value) != 39 || !strings.HasPrefix(value, "AI"+"za") {
		return false
	}
	for _, character := range value[4:] {
		if (character >= 'a' && character <= 'z') ||
			(character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') ||
			character == '_' || character == '-' {
			continue
		}
		return false
	}
	return true
}

type Credentials struct {
	DeviceID     string `json:"device_id"`
	KeySlot      int    `json:"key_slot"`
	KeyBase64    string `json:"key_base64"`
	RefreshToken string `json:"refresh_token"`
}

type Status struct {
	State       string `json:"state"`
	Online      *bool  `json:"online"`
	Open        *bool  `json:"open"`
	Moving      bool   `json:"moving"`
	SafeToClose *bool  `json:"safe_to_close"`
	CheckedAt   string `json:"checked_at"`
}

type Client struct {
	credentials    Credentials
	firebaseAPIKey string
	httpClient     *http.Client
	onRefresh      func(string)

	mu             sync.Mutex
	idToken        string
	tokenExpiresAt time.Time
	statusCursor   string
}

func ParsePairingCode(payload string) (Credentials, error) {
	parts := strings.Split(strings.TrimSpace(payload), ":")
	if len(parts) < 4 {
		return Credentials{}, ErrInvalidPairingCode
	}

	var keyBase64, slotText, deviceID string
	if parts[0] == "2" || parts[0] == "260" {
		// Stored .wkey: format:key:key-slot:device-id
		keyBase64, slotText, deviceID = parts[1], parts[2], parts[3]
	} else {
		// Add New User QR: key:key-slot:device-id:location
		keyBase64, slotText, deviceID = parts[0], parts[1], parts[2]
	}
	key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(keyBase64))
	if err != nil || len(key) == 0 {
		return Credentials{}, ErrInvalidPairingCode
	}
	keySlot, err := strconv.Atoi(strings.TrimSpace(slotText))
	if err != nil || keySlot < 2 {
		return Credentials{}, ErrInvalidPairingCode
	}
	deviceID = strings.TrimSpace(deviceID)
	if deviceID == "" || strings.ContainsAny(deviceID, ".#$[]/") || len(deviceID) > 256 {
		return Credentials{}, ErrInvalidPairingCode
	}
	return Credentials{DeviceID: deviceID, KeySlot: keySlot, KeyBase64: strings.TrimSpace(keyBase64)}, nil
}

// Pair signs in once, verifies that the door can be found, and returns a
// refresh token. The account password is never returned or persisted.
func Pair(ctx context.Context, client *http.Client, firebaseAPIKey, payload, email, password string) (Credentials, error) {
	credentials, err := ParsePairingCode(payload)
	if err != nil {
		return Credentials{}, err
	}
	if !ValidFirebaseAPIKey(firebaseAPIKey) {
		return Credentials{}, ErrAuthentication
	}
	if strings.TrimSpace(email) == "" || password == "" {
		return Credentials{}, ErrAuthentication
	}
	idToken, refreshToken, expiresIn, err := passwordLogin(ctx, client, firebaseAPIKey, strings.TrimSpace(email), password)
	if err != nil {
		return Credentials{}, err
	}
	credentials.RefreshToken = refreshToken
	wayznClient := NewClient(client, firebaseAPIKey, credentials, nil)
	wayznClient.idToken = idToken
	wayznClient.tokenExpiresAt = time.Now().Add(expiresIn - time.Minute)
	if _, _, err := wayznClient.nonce(ctx); err != nil {
		return Credentials{}, err
	}
	return credentials, nil
}

func NewClient(client *http.Client, firebaseAPIKey string, credentials Credentials, onRefresh func(string)) *Client {
	if client == nil {
		client = &http.Client{Timeout: 12 * time.Second}
	}
	return &Client{
		credentials:    credentials,
		firebaseAPIKey: strings.TrimSpace(firebaseAPIKey),
		httpClient:     client,
		onRefresh:      onRefresh,
		statusCursor:   "first",
	}
}

func (c *Client) Command(ctx context.Context, command string) error {
	switch command {
	case "open", "close", "open_and_close":
	default:
		return errors.New("unsupported command")
	}
	response, err := c.signedPost(ctx, command)
	if err != nil {
		return err
	}
	return commandResponseError(response)
}

func (c *Client) ReadStatus(ctx context.Context) (Status, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	response, err := c.signedPostLocked(ctx, "token:"+c.statusCursor)
	if err != nil {
		return Status{}, err
	}
	if response == "Device is offline." {
		value := false
		return Status{State: "offline", Online: &value, Moving: false, CheckedAt: time.Now().UTC().Format(time.RFC3339)}, nil
	}
	// A rejected status request must never fall through to an older cached
	// snapshot that might still claim the door is safe to close.
	if err := commandResponseError(response); err != nil {
		return Status{}, err
	}

	legacyKey := len(response) == 16 && allHex(response)
	candidates := make([]string, 0, 3)
	if (legacyKey || strings.Count(response, ":") >= 2) && validStatusKey(response) {
		candidates = append(candidates, response)
	}
	if validStatusKey(c.statusCursor) {
		candidates = append(candidates, c.statusCursor)
	}
	if !contains(candidates, "first") {
		candidates = append(candidates, "first")
	}

	token, err := c.idTokenLocked(ctx)
	if err != nil {
		return Status{}, err
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		for _, candidate := range unique(candidates) {
			var snapshot map[string]any
			endpoint := tokenDatabase + "/" + url.PathEscape(candidate) + ".json?auth=" + url.QueryEscape(token)
			found, err := c.getJSON(ctx, endpoint, &snapshot)
			if err != nil {
				return Status{}, err
			}
			if !found || snapshot == nil {
				continue
			}
			if next, ok := snapshot["token"].(string); ok && validStatusKey(next) {
				c.statusCursor = next
			} else if legacyKey {
				c.statusCursor = "first"
			}
			return normalizeStatus(snapshot), nil
		}
		if time.Now().After(deadline) {
			return normalizeStatus(nil), nil
		}
		select {
		case <-ctx.Done():
			return Status{}, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func passwordLogin(ctx context.Context, client *http.Client, firebaseAPIKey, email, password string) (string, string, time.Duration, error) {
	endpoint := "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + url.QueryEscape(firebaseAPIKey)
	body := map[string]any{"email": email, "password": password, "returnSecureToken": true}
	var result struct {
		IDToken      string `json:"idToken"`
		RefreshToken string `json:"refreshToken"`
		ExpiresIn    string `json:"expiresIn"`
	}
	if err := doJSON(ctx, client, http.MethodPost, endpoint, body, &result); err != nil {
		return "", "", 0, ErrAuthentication
	}
	seconds, err := strconv.Atoi(result.ExpiresIn)
	if err != nil || result.IDToken == "" || result.RefreshToken == "" {
		return "", "", 0, ErrAuthentication
	}
	return result.IDToken, result.RefreshToken, time.Duration(seconds) * time.Second, nil
}

func (c *Client) idTokenLocked(ctx context.Context) (string, error) {
	if c.idToken != "" && time.Now().Before(c.tokenExpiresAt) {
		return c.idToken, nil
	}
	form := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {c.credentials.RefreshToken}}
	endpoint := "https://securetoken.googleapis.com/v1/token?key=" + url.QueryEscape(c.firebaseAPIKey)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return "", ErrRemote
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", ErrRemote
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return "", ErrAuthentication
	}
	var result struct {
		IDToken      string `json:"id_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    string `json:"expires_in"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&result); err != nil {
		return "", ErrRemote
	}
	seconds, err := strconv.Atoi(result.ExpiresIn)
	if err != nil || result.IDToken == "" || result.RefreshToken == "" {
		return "", ErrAuthentication
	}
	c.idToken = result.IDToken
	c.tokenExpiresAt = time.Now().Add(time.Duration(seconds)*time.Second - time.Minute)
	if result.RefreshToken != c.credentials.RefreshToken {
		c.credentials.RefreshToken = result.RefreshToken
		if c.onRefresh != nil {
			c.onRefresh(result.RefreshToken)
		}
	}
	return c.idToken, nil
}

func (c *Client) nonce(ctx context.Context) (string, string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.nonceLocked(ctx)
}

func (c *Client) nonceLocked(ctx context.Context) (string, string, error) {
	token, err := c.idTokenLocked(ctx)
	if err != nil {
		return "", "", err
	}
	endpoint := nonceDatabase + "/" + url.PathEscape(c.credentials.DeviceID) + ".json?auth=" + url.QueryEscape(token)
	var result struct {
		Nonce    string `json:"nonce"`
		AgentURL string `json:"agenturl"`
	}
	found, err := c.getJSON(ctx, endpoint, &result)
	if err != nil || !found || result.Nonce == "" || result.AgentURL == "" {
		return "", "", ErrRemote
	}
	validated, err := validateAgentURL(ctx, result.AgentURL)
	if err != nil {
		return "", "", err
	}
	return result.Nonce, validated, nil
}

func (c *Client) signedPost(ctx context.Context, payload string) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.signedPostLocked(ctx, payload)
}

func (c *Client) signedPostLocked(ctx context.Context, payload string) (string, error) {
	nonce, agentURL, err := c.nonceLocked(ctx)
	if err != nil {
		return "", err
	}
	key, err := base64.StdEncoding.DecodeString(c.credentials.KeyBase64)
	if err != nil || len(key) == 0 {
		return "", ErrInvalidPairingCode
	}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(payload + "," + nonce))
	signature := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, agentURL, strings.NewReader(payload))
	if err != nil {
		return "", ErrRemote
	}
	req.Header.Set("Authorization", signature)
	req.Header.Set("Content-Type", "text/plain; charset=utf-8")
	req.Header.Set("x-WayznKNum", strconv.Itoa(c.credentials.KeySlot))

	noRedirect := *c.httpClient
	noRedirect.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := noRedirect.Do(req)
	if err != nil {
		return "", ErrRemote
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return "", fmt.Errorf("%w: agent returned HTTP %d", ErrRemote, resp.StatusCode)
	}
	result, err := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if err != nil {
		return "", ErrRemote
	}
	return strings.TrimSpace(string(result)), nil
}

func (c *Client) getJSON(ctx context.Context, endpoint string, target any) (bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return false, ErrRemote
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return false, ErrRemote
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return false, fmt.Errorf("%w: Firebase returned HTTP %d", ErrRemote, resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return false, ErrRemote
	}
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return false, nil
	}
	if err := json.Unmarshal(data, target); err != nil {
		return false, ErrRemote
	}
	return true, nil
}

func doJSON(ctx context.Context, client *http.Client, method, endpoint string, body, target any) error {
	encoded, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(encoded))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(target)
}

func validateAgentURL(ctx context.Context, raw string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil {
		return "", ErrRemote
	}
	if port := parsed.Port(); port != "" && port != "443" {
		return "", ErrRemote
	}
	addresses, err := net.DefaultResolver.LookupIPAddr(ctx, parsed.Hostname())
	if err != nil || len(addresses) == 0 {
		return "", ErrRemote
	}
	for _, address := range addresses {
		ip := address.IP
		if ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsMulticast() {
			return "", ErrRemote
		}
	}
	return parsed.String(), nil
}

func normalizeStatus(snapshot map[string]any) Status {
	status := Status{State: "unknown", Moving: false, CheckedAt: time.Now().UTC().Format(time.RFC3339)}
	if snapshot == nil {
		return status
	}
	connected, hasConnected := snapshot["Connected"].(bool)
	if hasConnected {
		status.Online = &connected
	}
	if !connected && hasConnected {
		status.State = "offline"
		return status
	}
	state, ok := integer(snapshot["ControlState"])
	lastState, _ := integer(snapshot["LastControlState"])
	switch {
	case state == 38 || lastState == 38:
		status.State = "heat_detected"
	case in(state, 7, 15):
		status.State = "open"
		value := true
		status.Open = &value
	case in(state, 14, 30):
		status.State = "closed"
		value := false
		status.Open = &value
	case in(state, 12, 37):
		status.State, status.Moving = "opening", true
	case state == 13:
		status.State, status.Moving = "closing", true
	case in(state, 5, 18, 22, 33, 34, 35, 36):
		status.State = "obstructed"
	case in(state, 26, 27, 28, 29):
		status.State = "disengaged"
	case state == 25:
		status.State = "paused"
	case state == 39:
		status.State = "locked"
	case !ok:
		status.State = "unknown"
	}
	if safe, ok := snapshot["SafeToClose"].(bool); ok {
		status.SafeToClose = &safe
	}
	return status
}

func integer(value any) (int, bool) {
	number, ok := value.(float64)
	if !ok || number != float64(int(number)) {
		return 0, false
	}
	return int(number), true
}

func in(value int, values ...int) bool {
	for _, candidate := range values {
		if value == candidate {
			return true
		}
	}
	return false
}

func allHex(value string) bool {
	for _, char := range value {
		if !strings.ContainsRune("0123456789abcdefABCDEF", char) {
			return false
		}
	}
	return true
}

func validStatusKey(value string) bool {
	if value == "" || len([]byte(value)) > 768 || strings.ContainsAny(value, ".#$[]/") {
		return false
	}
	for _, char := range value {
		if char < 32 {
			return false
		}
	}
	return true
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func unique(values []string) []string {
	seen := make(map[string]bool, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		if !seen[value] {
			seen[value] = true
			result = append(result, value)
		}
	}
	return result
}

// Some provider failures arrive with HTTP 200. Do not report these as accepted
// commands. The protocol's remaining successful payloads are left compatible.
func commandResponseError(response string) error {
	value := strings.ToLower(strings.TrimSpace(response))
	var body map[string]any
	if json.Unmarshal([]byte(response), &body) == nil && body != nil {
		for _, key := range []string{"success", "ok"} {
			if flag, exists := body[key].(bool); exists && !flag {
				return ErrRemote
			}
		}
		if failure, exists := body["error"]; exists && failure != nil && failure != false && failure != "" {
			return ErrRemote
		}
		// Look at values rather than key names: {"error":null,"ok":true}
		// is not itself a rejected command or status request.
		for _, key := range []string{"status", "message", "reason"} {
			if text, ok := body[key].(string); ok && failureText(strings.ToLower(text)) {
				return ErrRemote
			}
		}
		return nil
	}
	if failureText(value) || value == "false" || value == "null" {
		return ErrRemote
	}
	return nil
}
func failureText(value string) bool {
	for _, failure := range []string{"offline", "error", "fail", "denied", "invalid", "unauthor", "not authorized", "reject", "obstruct", "busy", "not safe", "unsafe"} {
		if strings.Contains(value, failure) {
			return true
		}
	}
	return false
}
