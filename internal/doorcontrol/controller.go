// Package doorcontrol serializes all provider operations per door and owns the
// durable camera-triggered close intent. Run exactly one server per database.
package doorcontrol

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/k15z/betterpetdoor/internal/providers/wayzn"
)

const DefaultCloseSeconds = 300
const LeaseDuration = 45 * time.Second
const Cooldown = 30 * time.Second

var (
	ErrConflict = errors.New("camera session is not the active owner")
	ErrInvalid  = errors.New("invalid camera request")
	ErrProvider = errors.New("provider operation failed")
	ErrUnsafe   = errors.New("manual close held: door safety could not be confirmed")
)

type Store interface {
	CameraState(context.Context, string) ([]byte, error)
	SaveCameraState(context.Context, string, []byte) error
}
type Provider interface {
	ReadStatus(context.Context) (wayzn.Status, error)
	Command(context.Context, string) error
}
type Factory func(context.Context, string) (Provider, error)

type State struct {
	DoorID           string     `json:"door_id"`
	Armed            bool       `json:"armed"`
	SessionID        string     `json:"session_id"`
	LeaseExpiresAt   *time.Time `json:"lease_expires_at"`
	AutoCloseSeconds int        `json:"auto_close_seconds"`
	CloseDueAt       *time.Time `json:"close_due_at"`
	Status           string     `json:"status"`
	Message          string     `json:"message"`
	UpdatedAt        time.Time  `json:"updated_at"`
	CooldownUntil    *time.Time `json:"cooldown_until"`
}
type record struct {
	State
	CloseAttempted bool     `json:"close_attempted,omitempty"`
	EventIDs       []string `json:"event_ids,omitempty"`
}
type Controller struct {
	store    Store
	provider Factory
	now      func() time.Time
	locks    sync.Map
}

func New(store Store, provider Factory, now func() time.Time) *Controller {
	if now == nil {
		now = time.Now
	}
	return &Controller{store: store, provider: provider, now: now}
}
func (c *Controller) lock(id string) func() {
	value, _ := c.locks.LoadOrStore(id, &sync.Mutex{})
	m := value.(*sync.Mutex)
	m.Lock()
	return m.Unlock
}
func (c *Controller) load(ctx context.Context, id string) (record, error) {
	b, err := c.store.CameraState(ctx, id)
	if err != nil {
		return record{}, err
	}
	r := record{State: State{DoorID: id, AutoCloseSeconds: DefaultCloseSeconds, Status: "disarmed", Message: "Camera mode is off.", UpdatedAt: c.now().UTC()}}
	if len(b) > 0 {
		if err := json.Unmarshal(b, &r); err != nil {
			return record{}, fmt.Errorf("read camera state: %w", err)
		}
	}
	if r.Armed && (r.LeaseExpiresAt == nil || !c.now().Before(*r.LeaseExpiresAt)) {
		disarm(&r)
		if r.CloseDueAt == nil {
			r.Status = "disarmed"
			r.Message = "Camera session expired. Arm again to enable detection."
		}
	}
	return r, nil
}
func (c *Controller) save(ctx context.Context, r *record) error {
	r.UpdatedAt = c.now().UTC()
	b, err := json.Marshal(r)
	if err != nil {
		return err
	}
	return c.store.SaveCameraState(ctx, r.DoorID, b)
}
func disarm(r *record) { r.Armed = false; r.SessionID = ""; r.LeaseExpiresAt = nil }
func validID(id string) bool {
	if len(id) < 8 || len(id) > 128 {
		return false
	}
	for _, ch := range id {
		if !(ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9' || ch == '-' || ch == '_') {
			return false
		}
	}
	return true
}
func owner(r record, session string) bool { return r.Armed && session != "" && r.SessionID == session }
func (c *Controller) State(ctx context.Context, id string) (State, error) {
	defer c.lock(id)()
	r, err := c.load(ctx, id)
	return r.State, err
}
func (c *Controller) Arm(ctx context.Context, id, session string, seconds int) (State, error) {
	defer c.lock(id)()
	if seconds == 0 {
		seconds = DefaultCloseSeconds
	}
	if !validID(session) || seconds < 60 || seconds > 3600 {
		return State{}, ErrInvalid
	}
	r, err := c.load(ctx, id)
	if err != nil {
		return State{}, err
	}
	if r.Armed && r.SessionID != session {
		return r.State, ErrConflict
	}
	if r.SessionID != session {
		r.EventIDs = nil
	}
	r.Armed = true
	r.SessionID = session
	expiry := c.now().UTC().Add(LeaseDuration)
	r.LeaseExpiresAt = &expiry
	r.AutoCloseSeconds = seconds
	if r.CloseDueAt == nil {
		r.Status = "armed"
		r.Message = "Waiting for a dog in an approach zone."
	}
	return c.saveState(ctx, &r)
}
func (c *Controller) Heartbeat(ctx context.Context, id, session string) (State, error) {
	defer c.lock(id)()
	r, err := c.load(ctx, id)
	if err != nil {
		return State{}, err
	}
	if !owner(r, session) {
		return r.State, ErrConflict
	}
	expiry := c.now().UTC().Add(LeaseDuration)
	r.LeaseExpiresAt = &expiry
	return c.saveState(ctx, &r)
}

// Disarm stops new openings. It deliberately retains an already scheduled close.
func (c *Controller) Disarm(ctx context.Context, id, session string) (State, error) {
	defer c.lock(id)()
	r, err := c.load(ctx, id)
	if err != nil {
		return State{}, err
	}
	if r.Armed && !owner(r, session) {
		return r.State, ErrConflict
	}
	disarm(&r)
	if r.CloseDueAt == nil {
		r.Status = "disarmed"
		r.Message = "Camera mode is off."
	}
	return c.saveState(ctx, &r)
}
func (c *Controller) CancelClose(ctx context.Context, id string) (State, error) {
	defer c.lock(id)()
	r, err := c.load(ctx, id)
	if err != nil {
		return State{}, err
	}
	disarm(&r)
	r.CloseDueAt = nil
	r.CloseAttempted = false
	r.Status = "cancelled"
	r.Message = "Automatic close cancelled. Check and control the door manually."
	return c.saveState(ctx, &r)
}
func (c *Controller) Detect(ctx context.Context, id, session, event string) (State, error) {
	defer c.lock(id)()
	if !validID(event) {
		return State{}, ErrInvalid
	}
	r, err := c.load(ctx, id)
	if err != nil {
		return State{}, err
	}
	if !owner(r, session) {
		return r.State, ErrConflict
	}
	for _, seen := range r.EventIDs {
		if seen == event {
			return r.State, nil
		}
	}
	// The recent-event window survives retries and process restarts. Pending close
	// and cooldown also deduplicate distinct events from a continuous visit.
	r.EventIDs = append(r.EventIDs, event)
	if len(r.EventIDs) > 512 {
		r.EventIDs = r.EventIDs[len(r.EventIDs)-512:]
	}
	if r.CloseDueAt != nil || r.CooldownUntil != nil && c.now().Before(*r.CooldownUntil) {
		return c.saveState(ctx, &r)
	}
	p, err := c.provider(ctx, id)
	if err != nil {
		return r.State, err
	}
	status, err := p.ReadStatus(ctx)
	if err != nil {
		r.Status = "open_held"
		r.Message = "Could not verify the door status. No open command sent."
		if e := c.save(context.WithoutCancel(ctx), &r); e != nil {
			return r.State, e
		}
		return r.State, ErrProvider
	}
	if status.Online == nil || !*status.Online || status.Moving || status.State != "closed" || status.Open == nil || *status.Open {
		r.Status = "open_held"
		r.Message = "Automatic open held: door must be confirmed online, stationary and closed."
		return c.saveState(ctx, &r)
	}
	// Commit intent before transmitting any physical command. Even an ambiguous
	// timeout retains a close deadline; provider status determines what happens.
	due := c.now().UTC().Add(time.Duration(r.AutoCloseSeconds) * time.Second)
	r.CloseDueAt = &due
	r.CloseAttempted = false
	r.Status = "opening"
	r.Message = "Open requested. Automatic close is scheduled, subject to the door safety check."
	if err := c.save(ctx, &r); err != nil {
		return r.State, err
	}
	if err := p.Command(ctx, "open"); err != nil {
		r.Status = "open_unconfirmed"
		r.Message = "Open was not confirmed. Check the door; the safety-checked close deadline is retained."
		if e := c.save(context.WithoutCancel(ctx), &r); e != nil {
			return r.State, e
		}
		return r.State, ErrProvider
	}
	r.Status = "close_scheduled"
	r.Message = "Open command accepted. Automatic close is scheduled, subject to the door safety check."
	return c.saveState(context.WithoutCancel(ctx), &r)
}

// Manual commands always supersede the camera lease and close intent, including
// ambiguous failures. Rearming must be an explicit later user action.
func (c *Controller) Command(ctx context.Context, id, command string) error {
	defer c.lock(id)()
	if command != "open" && command != "close" && command != "open_and_close" {
		return ErrInvalid
	}
	r, err := c.load(ctx, id)
	if err != nil {
		return err
	}
	disarm(&r)
	r.CloseDueAt = nil
	r.CloseAttempted = false
	r.Status = "manual_override"
	r.Message = "Manual control stopped camera automation and cancelled its pending close."
	if err := c.save(ctx, &r); err != nil {
		return err
	}
	p, err := c.provider(ctx, id)
	if err != nil {
		return err
	}
	if command == "close" {
		// The UI status may be old. Read again while holding the same per-door
		// command lock, after persisting the user's cancellation of automation.
		status, readErr := p.ReadStatus(ctx)
		if readErr == nil && confirmedClosed(status) {
			return nil
		}
		if readErr != nil || !safeToClose(status) {
			r.Status = "manual_close_held"
			r.Message = "Manual close held: no close command sent because current door safety could not be confirmed. Camera automation and its pending close were cancelled."
			if err := c.save(context.WithoutCancel(ctx), &r); err != nil {
				return err
			}
			return ErrUnsafe
		}
	}
	if err := p.Command(ctx, command); err != nil {
		return fmt.Errorf("%w: %v", ErrProvider, err)
	}
	return nil
}
func (c *Controller) ReadStatus(ctx context.Context, id string) (wayzn.Status, error) {
	defer c.lock(id)()
	p, err := c.provider(ctx, id)
	if err != nil {
		return wayzn.Status{}, err
	}
	return p.ReadStatus(ctx)
}

// WithDoor serializes deletion with a command already in progress.
func (c *Controller) WithDoor(id string, fn func() error) error { defer c.lock(id)(); return fn() }
func (c *Controller) complete(r *record) {
	r.CloseDueAt = nil
	r.CloseAttempted = false
	cooldown := c.now().UTC().Add(Cooldown)
	r.CooldownUntil = &cooldown
	r.Status = "closed"
	r.Message = "Door confirmed closed. Camera openings have a 30-second cooldown."
}
func (c *Controller) check(ctx context.Context, id string) error {
	defer c.lock(id)()
	r, err := c.load(ctx, id)
	if err != nil {
		return err
	}
	if r.CloseDueAt == nil || c.now().Before(*r.CloseDueAt) {
		return nil
	}
	p, err := c.provider(ctx, id)
	if err != nil {
		r.Status = "close_held"
		r.Message = "Automatic close held: provider unavailable. Check the door."
		return c.save(context.WithoutCancel(ctx), &r)
	}
	status, err := p.ReadStatus(ctx)
	if err != nil {
		r.Status = "close_held"
		r.Message = "Automatic close held: cannot verify door safety. Will check again."
		return c.save(context.WithoutCancel(ctx), &r)
	}
	if confirmedClosed(status) {
		c.complete(&r)
		return c.save(ctx, &r)
	}
	if r.CloseAttempted {
		r.Status = "close_unconfirmed"
		r.Message = "Close was attempted but is not confirmed. Check the door and use manual controls; no automatic command retry."
		return c.save(ctx, &r)
	}
	if !safeToClose(status) {
		r.Status = "close_held"
		r.Message = "Automatic close held: door must report online, stationary, open and explicitly safe to close. Will check again."
		return c.save(ctx, &r)
	}
	r.CloseAttempted = true
	r.Status = "closing"
	r.Message = "Safety check passed. Close requested; waiting for confirmation."
	if err := c.save(ctx, &r); err != nil {
		return err
	}
	if err := p.Command(ctx, "close"); err != nil {
		r.Status = "close_unconfirmed"
		r.Message = "Close was not confirmed. Check the door and use manual controls; no automatic command retry."
		return c.save(context.WithoutCancel(ctx), &r)
	}
	return nil
}

// CheckClose is invoked by the mounted phone's timer. The stored deadline,
// cancellation and attempt state remain authoritative across clients/restarts.
func (c *Controller) CheckClose(ctx context.Context, id string) (State, error) {
	if err := c.check(ctx, id); err != nil {
		return State{}, err
	}
	return c.State(ctx, id)
}

func (c *Controller) saveState(ctx context.Context, r *record) (State, error) {
	err := c.save(ctx, r)
	return r.State, err
}

func confirmedClosed(status wayzn.Status) bool {
	return status.Online != nil && *status.Online && !status.Moving && status.State == "closed" && status.Open != nil && !*status.Open
}
func safeToClose(status wayzn.Status) bool {
	return status.Online != nil && *status.Online && !status.Moving && status.State == "open" && status.Open != nil && *status.Open && status.SafeToClose != nil && *status.SafeToClose
}
