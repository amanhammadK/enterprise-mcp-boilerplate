# Enterprise MCP Boilerplate

A production-oriented Model Context Protocol server that ships with the infrastructure most internal MCP deployments actually need: a circuit breaker, token-bucket rate limiting, health checks, config management, and an audit log — all working out of the box.

## Why this exists

MCP servers are easy to prototype and painful to run in production. Most examples stop at "hello world" tool registration. This repo is the next step: it bundles the reliability layer teams usually have to build themselves, so you can drop your tools into an already-hardened shell.

## What's included

- **Circuit breaker** — trips to `open` / `half_open` after a configurable failure threshold, with a monitoring window and automatic reset.
- **Rate limiter** — token-bucket limiting per key (client, IP, or custom), with burst allowance.
- **Health checks** — uptime, memory usage, and per-service status surfaced through an MCP tool.
- **Config management** — get/set configuration at runtime through MCP tools.
- **Audit logging** — structured audit events with resource, action, and details; queryable via the audit log tool.
- **Service registry** — list registered services and their current state.

## Install

```bash
npm install
```

## Configure

```env
PORT=8080
```

## Run

```bash
npm run build
npm start
```

SSE endpoint: `http://localhost:8080/sse`.

## Tools

| Tool | Purpose |
|------|---------|
| `health_check` | Server health, uptime, and memory usage |
| `get_config` | Read a configuration value by key |
| `set_config` | Write a configuration value |
| `log_audit` | Record an audit event |
| `list_services` | List registered services and status |
| `get_audit_log` | Retrieve recent audit log entries |

## Test

```bash
npm test
```

## License

Free-Use License. See LICENSE file.