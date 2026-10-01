package httpapi

import "net/http"

func (s *Server) openAPISpec(w http.ResponseWriter, r *http.Request) {
	spec := map[string]any{
		"openapi": "3.1.0",
		"info": map[string]any{
			"title":       "Better Pet Door API",
			"version":     "0.1.0",
			"description": "Control the pet doors connected to a self-hosted Better Pet Door instance. Use the instance admin password as the bearer token.",
		},
		"servers":  []map[string]string{{"url": requestBaseURL(r)}},
		"security": []map[string][]string{{"adminPasswordBearer": {}}},
		"paths": map[string]any{
			"/api/doors": map[string]any{
				"get": map[string]any{
					"operationId": "listDoors",
					"summary":     "List pet doors",
					"responses": map[string]any{
						"200": response("Connected pet doors", schemaRef("DoorsResponse")),
						"401": response("Authentication required", schemaRef("Error")),
					},
				},
				"post": map[string]any{
					"operationId": "connectDoor",
					"summary":     "Connect a pet door",
					"requestBody": map[string]any{
						"required": true,
						"content": map[string]any{
							"application/json": map[string]any{"schema": schemaRef("ConnectDoorRequest")},
						},
					},
					"responses": map[string]any{
						"201": response("Connected pet door", schemaRef("Door")),
						"400": response("Invalid pairing details", schemaRef("Error")),
						"401": response("Authentication required", schemaRef("Error")),
					},
				},
			},
			"/api/doors/{doorId}": map[string]any{
				"delete": map[string]any{
					"operationId": "removeDoor",
					"summary":     "Remove a pet door",
					"parameters":  []any{doorIDParameter()},
					"responses": map[string]any{
						"204": map[string]string{"description": "Pet door removed"},
						"401": response("Authentication required", schemaRef("Error")),
						"404": response("Pet door not found", schemaRef("Error")),
					},
				},
			},
			"/api/doors/{doorId}/status": map[string]any{
				"get": map[string]any{
					"operationId": "getDoorStatus",
					"summary":     "Get a pet door's current status",
					"parameters":  []any{doorIDParameter()},
					"responses": map[string]any{
						"200": response("Current pet door status", schemaRef("DoorStatus")),
						"401": response("Authentication required", schemaRef("Error")),
						"404": response("Pet door not found", schemaRef("Error")),
					},
				},
			},
			"/api/doors/{doorId}/commands/open":           commandOperation("openDoor", "Open a pet door"),
			"/api/doors/{doorId}/commands/close":          commandOperation("closeDoor", "Close a pet door"),
			"/api/doors/{doorId}/commands/open-and-close": commandOperation("openAndCloseDoor", "Open a pet door, then close it after its configured interval"),
		},
		"components": map[string]any{
			"securitySchemes": map[string]any{
				"adminPasswordBearer": map[string]string{
					"type":         "http",
					"scheme":       "bearer",
					"bearerFormat": "Better Pet Door admin password",
				},
			},
			"schemas": map[string]any{
				"Door": map[string]any{
					"type":     "object",
					"required": []string{"id", "name", "provider", "created_at"},
					"properties": map[string]any{
						"id":         map[string]string{"type": "string"},
						"name":       map[string]string{"type": "string"},
						"provider":   map[string]string{"type": "string"},
						"created_at": map[string]string{"type": "string", "format": "date-time"},
					},
				},
				"DoorsResponse": map[string]any{
					"type":     "object",
					"required": []string{"doors"},
					"properties": map[string]any{
						"doors": map[string]any{"type": "array", "items": schemaRef("Door")},
					},
				},
				"ConnectDoorRequest": map[string]any{
					"type":     "object",
					"required": []string{"name", "provider", "qr_payload", "email", "password"},
					"properties": map[string]any{
						"name":       map[string]string{"type": "string", "description": "Human-readable name"},
						"provider":   map[string]any{"type": "string", "enum": []string{"wayzn"}},
						"qr_payload": map[string]string{"type": "string", "description": "Contents of the provider's Add New User QR code"},
						"email":      map[string]string{"type": "string", "format": "email"},
						"password":   map[string]string{"type": "string", "format": "password", "description": "Used once and never stored"},
					},
				},
				"DoorStatus": map[string]any{
					"type":     "object",
					"required": []string{"state", "moving"},
					"properties": map[string]any{
						"state":         map[string]string{"type": "string"},
						"online":        nullableBoolean(),
						"open":          nullableBoolean(),
						"moving":        map[string]string{"type": "boolean"},
						"safe_to_close": nullableBoolean(),
						"checked_at":    map[string]string{"type": "string"},
					},
				},
				"CommandResponse": map[string]any{
					"type":     "object",
					"required": []string{"ok", "command"},
					"properties": map[string]any{
						"ok":      map[string]string{"type": "boolean"},
						"command": map[string]string{"type": "string"},
					},
				},
				"Error": map[string]any{
					"type":     "object",
					"required": []string{"error"},
					"properties": map[string]any{
						"error": map[string]string{"type": "string"},
					},
				},
			},
		},
	}
	writeJSON(w, http.StatusOK, spec)
}

func schemaRef(name string) map[string]string {
	return map[string]string{"$ref": "#/components/schemas/" + name}
}

func response(description string, schema any) map[string]any {
	return map[string]any{
		"description": description,
		"content": map[string]any{
			"application/json": map[string]any{"schema": schema},
		},
	}
}

func doorIDParameter() map[string]any {
	return map[string]any{
		"name": "doorId", "in": "path", "required": true,
		"description": "Door ID returned by listDoors",
		"schema":      map[string]string{"type": "string"},
	}
}

func commandOperation(operationID, summary string) map[string]any {
	return map[string]any{
		"post": map[string]any{
			"operationId": operationID,
			"summary":     summary,
			"parameters":  []any{doorIDParameter()},
			"responses": map[string]any{
				"200": response("Command accepted", schemaRef("CommandResponse")),
				"401": response("Authentication required", schemaRef("Error")),
				"404": response("Pet door or command not found", schemaRef("Error")),
			},
		},
	}
}

func nullableBoolean() map[string]any {
	return map[string]any{"type": []string{"boolean", "null"}}
}
