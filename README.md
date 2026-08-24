# Uptime Monitor

A self-hosted, open-source uptime monitoring web app. Monitor your websites and
APIs, track uptime, response times, and outages over time, and see every status
change live in your browser.

It is designed to be simple to run, simple to understand, and simple to extend.
No third-party services, no external database, no SaaS subscription. You run it
on your own machine (or a small VPS), point it at the endpoints you care about,
and it watches them for you.

---

## Table of contents

- [Purpose](#purpose)
- [Who can benefit](#who-can-benefit)
- [Features](#features)
- [Stack](#stack)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Docker](#docker)
- [Configuration](#configuration)
- [How to use the app](#how-to-use-the-app)
- [Understanding the data](#understanding-the-data)
- [REST API](#rest-api)
- [WebSocket](#websocket)
- [Security](#security)
- [Project structure](#project-structure)
- [Open source & contributing](#open-source--contributing)
- [Crediting](#crediting)
- [License](#license)

---

## Purpose

Uptime Monitor answers three questions about every service you depend on:

1. **Is it up right now?** The dashboard shows the current status of every
   monitored endpoint and updates it live.
2. **Has it been reliable?** Uptime bars and statistics show how each service
   has behaved over the last 24 hours, 7 days, or 30 days.
3. **When did it break?** Incidents record exactly when an outage started, how
   long it lasted, and what error was seen — automatically resolved when the
   service recovers.

Monitoring is **server-side**: a background worker performs the HTTP checks, so
your services are watched even when nobody has the dashboard open. The app is
self-contained — one Node.js process and one SQLite file — with no external
dependencies at runtime.

## Who can benefit

| Audience | Why this is useful |
| --- | --- |
| **Individual developers** | Keep an eye on personal projects, side projects, and portfolio sites without paying for a monitoring service. |
| **Startups & small teams** | Watch production APIs, web apps, and staging environments on a budget. Data stays on your own infrastructure. |
| **Homelab & self-hosting enthusiasts** | Monitor your own services — Nextcloud, Grafana, Docker containers, NAS tools — including private/internal networks. |
| **Freelancers & agencies** | Track the uptime of client sites and report reliability. The incidents log gives you concrete evidence. |
| **API providers** | Verify availability and response latency of public endpoints, and detect regressions before users do. |
| **Anyone learning to code** | The codebase is small, dependency-light, and heavily tested — a great project to read, fork, and learn from. |

You are not limited to websites: any HTTP(S) endpoint (REST APIs, health checks,
static hosts, status pages) can be monitored. With
`ALLOW_PRIVATE_NETWORKS=true` you can also watch internal services on your LAN.

## Features

- **Server-side checks** — monitoring runs in the Node.js worker and continues
  even when no dashboard is open.
- **Uptime bars** — 24h / 7d / 30d views with colored segments
  (green = operational, yellow = degraded, red = outage, dark = no data).
  Click any segment to see the details for that period.
- **Response-time graph** — a live canvas line chart with a hover crosshair and
  tooltip, so you can spot slowdowns that never became outages.
- **Incidents** — consecutive failures are grouped into incidents. A
  configurable confirmation threshold means a single blip does not create a
  false alarm. Incidents auto-resolve on recovery.
- **Real-time updates** — a WebSocket connection pushes new checks, status
  changes, and incident events to the dashboard instantly.
- **Degradation detection** — optional response-time threshold marks a service
  as "degraded" when it is slow but not down.
- **Flexible checks** — choose the HTTP method, expected status codes, interval,
  timeout, and failure confirmation count per service.
- **Data retention** — old check history is pruned automatically so the database
  stays small.
- **REST API** — a full JSON API for services, checks, incidents, and uptime
  data, so you can build your own integrations.
- **Optional authentication** — enable HTTP Basic Auth with two environment
  variables.
- **SSRF protection** — target URLs are validated against private and
  loopback networks before every request (including redirects).
- **Zero build step** — the frontend is vanilla HTML/CSS/JS. No bundler, no
  framework, no `node_modules` bloat on the client.

## Stack

- Node.js (>= 20.6) + Express
- SQLite via better-sqlite3 (WAL mode, no external database server)
- Vanilla HTML/CSS/JS frontend, `ws` for WebSockets
- No frontend framework, no build step

## Requirements

- Node.js 20.6 or newer (Node 22 LTS recommended)
- npm 10 or newer
- ~50 MB disk space for the app plus your check history

There are no OS-specific requirements; it runs anywhere Node runs (Linux, macOS,
Windows). Docker images are based on Debian slim.

## Quick start

```bash
# Install dependencies
npm install

# Start the server
npm start
```

Open http://localhost:3000 in your browser.

Development mode with automatic restarts on file changes:

```bash
npm run dev
```

Run the test suite (unit, API, and frontend smoke tests):

```bash
npm test
```

The first time you run the app it creates a `data/` directory containing the
SQLite database (`data/uptime.db`). Everything is stored there; back it up and
you back up your whole setup.

## Docker

```bash
# Build and start in the background
docker compose up -d

# Follow the logs
docker compose logs -f

# Stop
docker compose down
```

The SQLite database lives in a named volume (`uptime-data`), so it survives
container restarts and rebuilds. Configuration is read from the environment; see
`docker-compose.yml` and `.env.example`.

## Configuration

All settings are environment variables.

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `DATA_DIR` | `./data` | Directory for the SQLite database |
| `DB_FILE` | *(empty)* | Full path to the database file (overrides `DATA_DIR`) |
| `ADMIN_USER` | *(empty)* | Enable Basic Auth when set together with `ADMIN_PASSWORD` |
| `ADMIN_PASSWORD` | *(empty)* | Enable Basic Auth when set together with `ADMIN_USER` |
| `ALLOW_PRIVATE_NETWORKS` | `false` | Allow monitoring private/internal networks |
| `CHECK_RETENTION_DAYS` | `90` | Keep check history for N days, then prune |
| `CHECK_RETENTION_INTERVAL_MINUTES` | `60` | How often the retention pruner runs |

For a plain Node install you can set these inline:

```bash
# Example: run on port 8080 with auth enabled
PORT=8080 ADMIN_USER=admin ADMIN_PASSWORD=changeme npm start
```

For Docker, copy `.env.example` to `.env` and edit it, then:

```bash
docker compose up -d
```

### Authentication

When both `ADMIN_USER` and `ADMIN_PASSWORD` are set, the web UI and API require
HTTP Basic auth. When either is empty, authentication is disabled (intended for
local or trusted environments). The WebSocket connection authenticates with a
short-lived token obtained from `/api/session`.

### Monitoring private networks

By default the monitor refuses to check addresses that resolve to private or
loopback networks (SSRF protection) — the right choice for a publicly reachable
instance. To monitor internal services such as `http://10.0.0.5/health`, set
`ALLOW_PRIVATE_NETWORKS=true`.

## How to use the app

### First steps

1. **Start the app** (`npm start` or `docker compose up -d`) and open
   http://localhost:3000.
2. Click **Add service** in the sidebar (or the **+ Add service** button on the
   dashboard).
3. Fill in the form:
   - **Service name** — anything you want, e.g. "Production API".
   - **URL** — the HTTP(S) endpoint to check, e.g. `https://example.com/health`.
   - **Method** — the HTTP method to use for the check.
   - **Expected status codes** — which HTTP codes count as healthy. The default
     is `200`; use `200, 201, 204` for APIs that return other success codes.
   - **Check interval (seconds)** — how often to check. Minimum 5.
   - **Timeout (ms)** — how long to wait before counting the check as failed.
   - **Degraded threshold (ms)** — optional. Slower responses mark the service
     "degraded" instead of "up".
   - **Failures to confirm outage** — consecutive failures before an incident is
     opened. Use `2`-`3` if your service has occasional blips.
4. Click **Add service**. The first check runs right away.

### Navigating the app

The app has three views, reachable from the sidebar:

- **Dashboard** (`#/`) — the default view.
  - Summary cards at the top: total services, operational, degraded, outages,
    and open incidents.
  - One card per service showing its name, URL, current status pill, 30-day
    uptime, last response time, time of last check, and incident count.
  - A **time range toggle** (24H / 7D / 30D) switches the uptime bars on all
    cards at once.
  - Click a service card to open its detail page.
- **Service detail** (`#/services/1`) — everything about one service.
  - Stat cards: current and average response, min/max response, uptime
    percentage, checks, incidents, and check interval.
  - A **Response time** line chart for the selected range.
  - An **Uptime history** bar (same colors as the dashboard).
  - An **Incidents** table with each outage and its duration.
  - A **Recent checks** table showing the last 50 checks.
  - Action buttons: **Check now**, **Pause/Resume**, **Edit**, and **Delete**.
- **Incidents** (`#/incidents`) — a global outage history across all services,
  with status, service, start, end, duration, check count, and error message.

### Reading the uptime bars

Each segment is one time bucket (1 hour in the 24h view, 3 hours in the 7d
view, 6 hours in the 30d view). The color is the dominant status in that bucket:
outage wins over degraded, degraded wins over operational. Click a segment to
see the exact counts of up/degraded/failed checks in that period.

### Live updates

While the dashboard is open, the page updates in real time: new checks refresh
the last-check time and response, status changes repaint the card and bar, and
incidents open/resolve without a page reload. The **Live** indicator in the
sidebar bottom shows the WebSocket connection state. If the connection drops it
reconnects automatically with backoff.

## Understanding the data

- **Uptime percentage** is the share of checks that were `up` or `degraded`
  out of all checks in the selected period (degraded counts as operational for
  availability, since the service responded).
- **Segments** (24h → 24 x 1h, 7d → 56 x 3h, 30d → 120 x 6h). The final segment
  is the current, still-running period, so its "end" is always now.
- **Incidents** open after `confirm_failures` consecutive failures and resolve
  on the first successful check. `check_count` is the number of failed checks
  that contributed.
- **Check history** older than `CHECK_RETENTION_DAYS` is pruned automatically.
  Incidents are kept forever; only raw checks are pruned.

## REST API

All endpoints return JSON. Errors use `{ "error": { "message", "code" } }`.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Health check |
| `GET` | `/api/session` | Auth status + WebSocket token |
| `GET` | `/api/summary` | Aggregate counts |
| `GET` | `/api/services` | List services (with last check + 30d uptime) |
| `POST` | `/api/services` | Create a service |
| `GET` | `/api/services/:id` | Get a service |
| `PUT` | `/api/services/:id` | Partial update |
| `DELETE` | `/api/services/:id` | Delete a service and its data |
| `POST` | `/api/services/:id/check` | Run a check now |
| `GET` | `/api/services/:id/checks` | Recent checks (`limit`, `before`) |
| `GET` | `/api/services/:id/incidents` | Incidents for a service |
| `GET` | `/api/services/:id/uptime?range=24h\|7d\|30d` | Segments, timeseries, stats |
| `GET` | `/api/incidents` | Recent incidents across all services |

### Create a service

```bash
curl -X POST http://localhost:3000/api/services \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Example API",
    "url": "https://example.com/health",
    "interval_seconds": 60,
    "timeout_ms": 5000,
    "degraded_threshold_ms": 1000,
    "confirm_failures": 2
  }'
```

## WebSocket

Connect to `/ws?token=<ws_token>` (get the token from `/api/session`). The
server pushes JSON messages:

- `{ type: "check", serviceId, check }` — a check completed
- `{ type: "status-change", serviceId, from, to, check }` — a service changed state
- `{ type: "incident-opened", ...incident }` / `{ type: "incident-resolved", ...incident }`
- `{ type: "service-changed" }` / `{ type: "service-deleted", serviceId }`

## Security

- **SSRF protection** — target URLs are validated (http/https only, no embedded
  credentials), resolved, and blocked if they point at private, loopback, or
  link-local addresses. Redirects are followed manually so every hop is
  re-validated.
- **Strict CSP and security headers** — no inline scripts, `frame-ancestors
  'none'`, `nosniff`, COOP/CORP, no referrer.
- **No shell execution** — checks use a bounded HTTP fetch with a timeout and
  never invoke the shell.
- **No hardcoded secrets** — authentication credentials come only from the
  environment.
- **Rate limiting is not built in** — put the app behind a reverse proxy (nginx,
  Caddy, Traefik) if you expose it to the internet.

## Project structure

```
src/
  config.js        Environment configuration
  db.js            SQLite schema + connection (WAL)
  services.js      Service CRUD
  checks.js        Check log repository
  incidents.js     Incident repository
  validation.js    Input validation (create + partial update)
  security.js      SSRF guard + security headers
  uptime.js        Segment / timeseries / stats aggregation
  worker.js        Monitoring loop, check execution, incident detection
  ws.js            WebSocket hub (auth + broadcast)
  api.js           REST API routes
  server.js        App assembly + entry point
public/
  index.html       SPA shell
  css/styles.css   Dark theme
  js/              Frontend modules (no build step)
test/              node:test suite (unit + API + frontend smoke)
Dockerfile         Container image (node:22-bookworm-slim)
docker-compose.yml One-command local deployment
```

## Open source & contributing

Uptime Monitor is free and open-source software. You are free to use it, modify
it, and redistribute it — under the terms of the MIT license. The code is meant
to be read: small modules, plain JavaScript, no build step, and a test suite
that runs with a single command.

**Ways to contribute**

- Report bugs by opening an issue with the exact steps to reproduce.
- Suggest features or improvements.
- Submit pull requests. Small, focused changes are easier to review and merge.
- Improve documentation, examples, or this README.
- Add test coverage for edge cases.

**Development workflow**

```bash
# Fork or clone the repository, then install dependencies
npm install

# Make your changes, then run the full test suite
npm test

# Lint by running the syntax check on all source files
node --check src/server.js
```

Before submitting a pull request, make sure:

1. All tests pass (`npm test`).
2. Your changes follow the existing style (the codebase uses plain CommonJS
   modules, no semicolon-free style, and no comments unless they explain "why").
3. You have not introduced new dependencies unless strictly necessary — the
   project deliberately keeps a tiny dependency footprint.
4. You have not added secrets, tokens, or credentials.

The test suite (`npm test`) uses Node's built-in test runner and covers the
database layer, validation, SSRF/security logic, the monitoring worker, uptime
aggregation, the REST API, and a jsdom-based frontend smoke test.

## Crediting

If you use Uptime Monitor in a project, fork it, build on it, or deploy it for
clients, please give credit where it is due. The MIT license requires you to
retain the copyright notice and permission notice (they are already in the
`LICENSE` file — keep them in any copies or substantial portions).

Examples of good attribution:

- Keep the "TC. Uptime Monitor" name and the license header in any forks or
  redistributed copies.
- Mention "Powered by TC. Uptime Monitor" in your project, status page, or
  documentation.
- Link back to the original repository when you publish something based on it.

That is all the MIT license asks. There are no usage fees and no strings
attached beyond keeping the copyright notice.

## License

This project is licensed under the MIT License. See the `LICENSE` file for the
full text.

Copyright (c) 2026 Uptime Monitor contributors.
