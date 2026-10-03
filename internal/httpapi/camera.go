package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/k15z/betterpetdoor/internal/database"
	"github.com/k15z/betterpetdoor/internal/doorcontrol"
)

// RunCameraWorker must run for the lifetime of the single server process. A
// persisted deadline cannot wake a suspended/auto-stopped hosting machine.
func (s *Server) RunCameraWorker(ctx context.Context) {
	s.control.Run(ctx, func(err error) { s.logger.Error("camera close worker failed", "error", err) })
}
func (s *Server) cameraRoute(w http.ResponseWriter, r *http.Request, id, action string) {
	var state doorcontrol.State
	var err error
	if action == "" && r.Method == http.MethodGet {
		state, err = s.control.State(r.Context(), id)
	} else if r.Method == http.MethodPost {
		switch action {
		case "arm":
			var body struct {
				SessionID        string `json:"session_id"`
				AutoCloseSeconds int    `json:"auto_close_seconds"`
			}
			if decodeJSON(w, r, &body) != nil {
				return
			}
			state, err = s.control.Arm(r.Context(), id, body.SessionID, body.AutoCloseSeconds)
		case "heartbeat", "disarm":
			var body struct {
				SessionID string `json:"session_id"`
			}
			if decodeJSON(w, r, &body) != nil {
				return
			}
			if action == "heartbeat" {
				state, err = s.control.Heartbeat(r.Context(), id, body.SessionID)
			} else {
				state, err = s.control.Disarm(r.Context(), id, body.SessionID)
			}
		case "detections":
			var body struct {
				SessionID string `json:"session_id"`
				EventID   string `json:"event_id"`
			}
			if decodeJSON(w, r, &body) != nil {
				return
			}
			state, err = s.control.Detect(r.Context(), id, body.SessionID, body.EventID)
		case "cancel-close":
			var body struct{}
			if decodeJSON(w, r, &body) != nil {
				return
			}
			state, err = s.control.CancelClose(r.Context(), id)
		default:
			writeError(w, http.StatusNotFound, "Not found.")
			return
		}
	} else {
		writeError(w, http.StatusNotFound, "Not found.")
		return
	}
	switch {
	case errors.Is(err, database.ErrNotFound):
		writeError(w, http.StatusNotFound, "Door not found.")
	case errors.Is(err, doorcontrol.ErrInvalid):
		writeError(w, http.StatusBadRequest, "Use a valid session/event ID and an auto-close interval from 60 to 3600 seconds.")
	case errors.Is(err, doorcontrol.ErrConflict):
		writeJSON(w, http.StatusConflict, map[string]any{"error": "Another camera owns this door, or your session expired. Stop it or wait for its lease to expire, then arm again.", "camera": state})
	case errors.Is(err, doorcontrol.ErrProvider):
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": state.Message, "camera": state})
	case err != nil:
		s.internalError(w, r, err)
	default:
		writeJSON(w, http.StatusOK, state)
	}
}
