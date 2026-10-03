package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/k15z/betterpetdoor/internal/database"
	"github.com/k15z/betterpetdoor/internal/doorcontrol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type mcpDoor struct {
	ID       string `json:"id" jsonschema:"Stable door ID to use with the other tools"`
	Name     string `json:"name" jsonschema:"Human-readable door name"`
	Provider string `json:"provider" jsonschema:"Pet door provider"`
}

type mcpListDoorsOutput struct {
	Doors []mcpDoor `json:"doors" jsonschema:"Pet doors connected to this Better Pet Door instance"`
}

type mcpDoorInput struct {
	DoorID string `json:"door_id" jsonschema:"Door ID returned by list_pet_doors"`
}

type mcpDoorStatusOutput struct {
	State       string `json:"state"`
	Online      *bool  `json:"online,omitempty"`
	Open        *bool  `json:"open,omitempty"`
	Moving      bool   `json:"moving"`
	SafeToClose *bool  `json:"safe_to_close,omitempty"`
	CheckedAt   string `json:"checked_at,omitempty"`
}

type mcpCommandOutput struct {
	OK      bool   `json:"ok"`
	DoorID  string `json:"door_id"`
	Command string `json:"command"`
}

func (s *Server) newMCPHandler() http.Handler {
	server := mcp.NewServer(&mcp.Implementation{
		Name:    "betterpetdoor",
		Version: "0.1.0",
		Title:   "Better Pet Door",
	}, nil)

	readOnly := &mcp.ToolAnnotations{
		Title:           "List pet doors",
		ReadOnlyHint:    true,
		DestructiveHint: boolPointer(false),
		OpenWorldHint:   boolPointer(false),
	}
	mcp.AddTool(server, &mcp.Tool{
		Name:        "list_pet_doors",
		Description: "List the pet doors connected to this Better Pet Door instance.",
		Annotations: readOnly,
	}, s.mcpListDoors)

	mcp.AddTool(server, &mcp.Tool{
		Name:        "get_pet_door_status",
		Description: "Read the current status of one pet door, including whether it is open, moving, or safe to close.",
		Annotations: &mcp.ToolAnnotations{
			Title:           "Get pet door status",
			ReadOnlyHint:    true,
			DestructiveHint: boolPointer(false),
			OpenWorldHint:   boolPointer(false),
		},
	}, s.mcpDoorStatus)

	for _, command := range []struct {
		name        string
		title       string
		description string
		value       string
	}{
		{"open_pet_door", "Open pet door", "Open one pet door. Stops camera automation and cancels its pending automatic close.", "open"},
		{"close_pet_door", "Close pet door", "Close one pet door only after a fresh provider safety check. Stops camera automation and cancels its pending automatic close.", "close"},
		{"open_and_close_pet_door", "Open and close pet door", "Open one pet door, wait for its vendor-configured interval, then close it. Stops camera automation and cancels its pending automatic close.", "open_and_close"},
	} {
		command := command
		mcp.AddTool(server, &mcp.Tool{
			Name:        command.name,
			Description: command.description,
			Annotations: &mcp.ToolAnnotations{
				Title:           command.title,
				DestructiveHint: boolPointer(false),
				OpenWorldHint:   boolPointer(false),
			},
		}, func(ctx context.Context, _ *mcp.CallToolRequest, input mcpDoorInput) (*mcp.CallToolResult, mcpCommandOutput, error) {
			return s.mcpDoorCommand(ctx, input, command.value)
		})
	}

	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server {
		return server
	}, &mcp.StreamableHTTPOptions{
		Stateless:           true,
		JSONResponse:        true,
		Logger:              s.logger,
		MaxRequestBodyBytes: 1 << 20,
	})
	return s.requireMCPAuth(handler)
}

func (s *Server) mcpListDoors(ctx context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, mcpListDoorsOutput, error) {
	doors, err := s.db.Doors(ctx)
	if err != nil {
		s.logger.Error("MCP door list failed", "error", err)
		return nil, mcpListDoorsOutput{}, errors.New("could not list pet doors")
	}
	result := make([]mcpDoor, 0, len(doors))
	for _, door := range doors {
		result = append(result, mcpDoor{ID: door.ID, Name: door.Name, Provider: door.Provider})
	}
	return nil, mcpListDoorsOutput{Doors: result}, nil
}

func (s *Server) mcpDoorStatus(ctx context.Context, _ *mcp.CallToolRequest, input mcpDoorInput) (*mcp.CallToolResult, mcpDoorStatusOutput, error) {
	status, err := s.control.ReadStatus(ctx, strings.TrimSpace(input.DoorID))
	if errors.Is(err, database.ErrNotFound) {
		return nil, mcpDoorStatusOutput{}, errors.New("pet door not found")
	}
	if err != nil {
		s.logger.Warn("MCP status request failed", "door_id", input.DoorID, "error", err)
		return nil, mcpDoorStatusOutput{}, errors.New("could not read the pet door status")
	}
	return nil, mcpDoorStatusOutput{State: status.State, Online: status.Online, Open: status.Open, Moving: status.Moving, SafeToClose: status.SafeToClose, CheckedAt: status.CheckedAt}, nil
}
func (s *Server) mcpDoorCommand(ctx context.Context, input mcpDoorInput, command string) (*mcp.CallToolResult, mcpCommandOutput, error) {
	doorID := strings.TrimSpace(input.DoorID)
	err := s.control.Command(ctx, doorID, command)
	if errors.Is(err, database.ErrNotFound) {
		return nil, mcpCommandOutput{}, errors.New("pet door not found")
	}
	if errors.Is(err, doorcontrol.ErrUnsafe) {
		return nil, mcpCommandOutput{}, errors.New("close held: fresh provider status did not confirm safe closure; no close command sent. Camera automation and its pending close were cancelled")
	}
	if err != nil {
		s.logger.Warn("MCP door command failed", "door_id", doorID, "command", command, "error", err)
		return nil, mcpCommandOutput{}, errors.New("command not confirmed; check the door and camera status before retrying")
	}
	return nil, mcpCommandOutput{OK: true, DoorID: doorID, Command: strings.ReplaceAll(command, "_", "-")}, nil
}

func boolPointer(value bool) *bool { return &value }
