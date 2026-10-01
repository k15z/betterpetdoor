# Contributing

Issues and pull requests are welcome.

## Local setup

You need Go 1.26 or newer and Node.js 24.

```sh
cp .env.example .env
cd web && npm install
```

Export the values from `.env`, then run these in separate terminals:

```sh
go run ./cmd/betterpetdoor
```

```sh
cd web && npm run dev
```

Before opening a pull request, run:

```sh
make test
```

Never include a QR payload, device ID, device key, refresh token, nonce, agent URL, signature, database, or `.env` file in an issue or commit.
