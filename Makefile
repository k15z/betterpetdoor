.PHONY: build dev test

build:
	cd web && npm ci && npm run model:download && npm run build
	go build -o bin/betterpetdoor ./cmd/betterpetdoor

dev:
	@echo "Run the API and Vite dev server in separate terminals:"
	@echo "  go run ./cmd/betterpetdoor"
	@echo "  cd web && npm run dev"

test:
	go test ./...
	cd web && npm test && npm run lint && npm run build
