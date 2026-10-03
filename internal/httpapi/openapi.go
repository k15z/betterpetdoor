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
			"/api/doors/{doorId}/commands/open":           commandOperation("openDoor", "Open a pet door; disarm camera mode and cancel its pending close"),
			"/api/doors/{doorId}/commands/close":          commandOperation("closeDoor", "Close a pet door; disarm camera mode and cancel its pending close"),
			"/api/doors/{doorId}/commands/open-and-close": commandOperation("openAndCloseDoor", "Open a pet door, then close after its vendor-configured interval; supersede camera automation"),
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
	addCameraOpenAPI(spec)
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
				"200": response("Command accepted or door already confirmed closed", schemaRef("CommandResponse")),
				"409": response("Close held by fresh provider safety check; no close command sent", schemaRef("Error")),
				"502": response("Provider operation not confirmed", schemaRef("Error")),
				"401": response("Authentication required", schemaRef("Error")),
				"404": response("Pet door or command not found", schemaRef("Error")),
			},
		},
	}
}

func nullableBoolean() map[string]any {
	return map[string]any{"type": []string{"boolean", "null"}}
}

func addCameraOpenAPI(spec map[string]any) {
	paths := spec["paths"].(map[string]any)
	schemas := spec["components"].(map[string]any)["schemas"].(map[string]any)
	nullableTime := map[string]any{"type": []string{"string", "null"}, "format": "date-time"}
	schemas["CameraState"] = map[string]any{"type": "object", "properties": map[string]any{
		"door_id": map[string]string{"type": "string"}, "armed": map[string]string{"type": "boolean"},
		"session_id": map[string]string{"type": "string"}, "lease_expires_at": nullableTime,
		"auto_close_seconds": map[string]any{"type": "integer", "minimum": 60, "maximum": 3600, "default": 300},
		"close_due_at":       nullableTime, "cooldown_until": nullableTime, "updated_at": map[string]string{"type": "string", "format": "date-time"},
		"status": map[string]string{"type": "string"}, "message": map[string]string{"type": "string"},
	}}
	responses := map[string]any{"200": response("Current camera state; a physical command is not proof of movement", schemaRef("CameraState")), "400": response("Invalid request", schemaRef("Error")), "401": response("Authentication required", schemaRef("Error")), "404": response("Door not found", schemaRef("Error")), "409": response("Camera ownership conflict or expired lease", schemaRef("Error")), "502": response("Provider command or status not confirmed; inspect camera state", schemaRef("Error"))}
	paths["/api/doors/{doorId}/camera"] = map[string]any{"get": map[string]any{"operationId": "getCameraState", "summary": "Read camera ownership, close deadline and safety holds", "parameters": []any{doorIDParameter()}, "responses": responses}}
	for _, action := range []struct {
		name, summary string
		fields        []string
	}{
		{"arm", "Arm a per-door camera lease; default close interval is 300 seconds", []string{"session_id"}},
		{"heartbeat", "Renew an owned camera lease for 45 seconds", []string{"session_id"}},
		{"disarm", "Stop new openings; retain any pending automatic close", []string{"session_id"}},
		{"detections", "Submit a local dog detection event; never send images", []string{"session_id", "event_id"}},
		{"cancel-close", "Cancel automatic close and disarm; physically inspect the door", nil},
	} {
		properties := map[string]any{}
		for _, key := range action.fields {
			properties[key] = map[string]any{"type": "string", "minLength": 8, "maxLength": 128, "pattern": "^[A-Za-z0-9_-]+$"}
		}
		if action.name == "arm" {
			properties["auto_close_seconds"] = map[string]any{"type": "integer", "minimum": 60, "maximum": 3600, "default": 300}
		}
		body := map[string]any{"type": "object", "additionalProperties": false, "properties": properties}
		if len(action.fields) > 0 {
			body["required"] = action.fields
		}
		paths["/api/doors/{doorId}/camera/"+action.name] = map[string]any{"post": map[string]any{"summary": action.summary, "parameters": []any{doorIDParameter()}, "requestBody": map[string]any{"required": true, "content": map[string]any{"application/json": map[string]any{"schema": body}}}, "responses": responses}}
	}
}
