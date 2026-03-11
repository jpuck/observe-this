# Observability Stack: Prometheus · Loki · Grafana · OpenTelemetry · Tempo

A hands-on learning environment covering the three pillars of observability:
**metrics**, **logs**, and **traces** — all unified in Grafana.

---

## The Three Signals

| Signal | Question it answers | Tool |
|--------|-------------------|------|
| **Metrics** | Is the system healthy? How fast? How many? | Prometheus |
| **Logs** | What exactly happened? What were the details? | Loki |
| **Traces** | Where did this request spend its time? | Tempo |

Metrics alert you. Logs explain what happened. Traces show where time was spent.
You need all three to debug production problems effectively.

---

## Architecture

```
  Browser
    │
    ▼
nginx:80 ──────────────────────────────────────────┐
    │                                              │
    ▼                                         JSON access logs
app:3000 (Express)                                 │
    │                                              ▼
    │ OTLP/gRPC                              alloy
    ▼                                              │
otel-collector:4317                                ▼
    │                                         loki:3100
    ├── metrics ──► prometheus exporter :8889      │
    │                    │                         │
    │                    ▼                         │
    │              prometheus:9090                 │
    │                    │                         │
    └── traces ──► tempo:4317                      │
                         │                         │
                         ▼                         │
                   grafana:3001 ◄──────────────────┘
                         │
                   (also queries prometheus + loki)

node-exporter:9100 ──► prometheus:9090
nginx-exporter:9113 ──► prometheus:9090
```

**Key insight:** the OTel Collector is the routing hub. Your app sends one signal
(OTLP) to one destination (the Collector), and the Collector fans it out to
multiple backends. Switching from Prometheus to Datadog means changing the
Collector config, not the application code.

---

## Services

| Service | URL | Purpose |
|---------|-----|---------|
| App | http://localhost:3000 | Hello World |
| nginx | http://localhost | Reverse proxy |
| OTel Collector | :4317 (gRPC), :4318 (HTTP), :8889 (prom) | Telemetry hub |
| Prometheus | http://localhost:9090 | Metrics storage |
| Tempo | http://localhost:3200 | Trace storage |
| Loki | http://localhost:3100 | Log storage |
| Alloy | — | Log collector (replaced EOL Promtail) |
| Grafana | http://localhost:3001 | Dashboards (admin/admin) |
| node-exporter | http://localhost:9100 | Host metrics |
| nginx-exporter | http://localhost:9113 | nginx metrics |

---

## Quick Start

```bash
docker compose up -d --build
docker compose ps   # all services should be "running"
```

Grafana has Prometheus, Loki, and Tempo pre-configured as data sources.

---

## Lesson 1: Generating Traffic

The app only records data when it receives requests. Run this before the other lessons.

```bash
# 100 successful requests
for i in $(seq 1 100); do curl -s http://localhost > /dev/null; done

# 20 requests to a nonexistent route (generates 404s in logs)
for i in $(seq 1 20); do curl -s http://localhost/not-found > /dev/null; done

# Continuous trickle in a background terminal (keeps metrics fresh)
watch -n 2 'curl -s http://localhost > /dev/null'
```

**Why this matters:** prom-client (old) and OTel (new) both only emit a metric
series after the first observation. If no requests have been made since the last
container restart, `app_requests_total` simply won't exist in Prometheus yet.

---

## Lesson 2: OpenTelemetry — The Instrumentation Layer

OTel is the *how* of observability — it's the SDK that collects and ships data.
Prometheus, Loki, and Tempo are the *where* it ends up.

### 2.1 The SDK vs the API

There are two layers in your app:

- **API** (`@opentelemetry/api`) — the interface your code calls: `meter.createCounter(...)`, `tracer.startSpan(...)`. Stable, rarely changes.
- **SDK** (`@opentelemetry/sdk-node`) — the implementation wired up in `tracing.js`. Configures exporters, providers, and instrumentation.

This separation means library authors can add OTel instrumentation using only the API,
without depending on any specific backend. App owners configure the SDK to decide where data goes.

### 2.2 Auto vs Manual instrumentation

**Auto-instrumentation** (zero code changes):

`tracing.js` is loaded by Node.js itself before `index.js` runs, via the `--require`
flag in the Dockerfile:

```dockerfile
CMD ["node", "--require", "./tracing.js", "index.js"]
```

`--require` is a Node.js built-in that executes a file before the main entry point.
This is critical for auto-instrumentation: OTel needs to patch modules like `express`
and `http` before they are first `require()`'d by `index.js`. Using `--require`
enforces that ordering at the process level rather than relying on import order in code.

`tracing.js` loads `getNodeAutoInstrumentations()`, which patches Node.js modules
at startup. For every incoming HTTP request, the OTel HTTP and Express
instrumentations automatically create a span with timing, status code, route, etc.
These appear in Tempo without any changes to `index.js`.

**Manual instrumentation** (in `index.js`):

```js
const meter = metrics.getMeter('node-app');
const requestCounter = meter.createCounter('app.requests', { ... });
// called in middleware per request
requestCounter.add(1, { 'http.method': 'GET', 'http.route': '/', ... });
```

Use manual instrumentation for business-specific metrics that auto-instrumentation
doesn't know about — e.g., orders processed, cache hit rate, queue depth.

### 2.3 The Collector pipeline

Look at `otel-collector/otel-collector-config.yml`. It defines:

```
receivers → processors → exporters
```

- **receivers**: accept OTLP on gRPC (4317) and HTTP (4318)
- **processors**: batch spans/metrics before export (efficiency)
- **exporters**: Prometheus format on port 8889; OTLP to Tempo on port 4317

The `service.pipelines` section wires them together separately for metrics and traces.
You could add a `logs` pipeline here to receive OTel logs too (we use Alloy instead).

### 2.4 Environment-based configuration

The app has no hardcoded collector address. In `docker-compose.yml`:

```yaml
environment:
  - OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317
  - OTEL_SERVICE_NAME=node-app
```

The OTel SDK reads these standard env vars automatically. In production you'd
point these at your actual collector or cloud vendor endpoint.

---

## Lesson 3: Prometheus — Metrics

Open http://localhost:9090 → Query → Graph tab.

### 3.1 Metric types

| Type | Behaviour | Example |
|------|-----------|---------|
| **Counter** | Only goes up, resets on restart | `app_requests_total` |
| **Gauge** | Can go up or down | `node_memory_MemAvailable_bytes` |
| **Histogram** | Samples bucketed by value | `app_request_duration_seconds_bucket` (histograms have no base metric — only `_bucket`, `_count`, `_sum`) |

### 3.2 Two sources of app metrics

With OTel you get metrics from two places:

**Auto-instrumented** (from the OTel HTTP instrumentation):
```promql
# Request duration histogram — created automatically, no code required.
# Named http_server_duration_milliseconds in OTel instrumentation v0.52 (older semconv).
# Newer versions use http_server_request_duration_seconds — check yours at localhost:8889/metrics.
rate(http_server_duration_milliseconds_count[5m])
```

**Manual** (from the middleware in `index.js`):
```promql
# Counter we created with meter.createCounter('app.requests')
rate(app_requests_total[5m])
```

Both flow through the OTel Collector to Prometheus. The difference: auto-instrumented
metrics follow OTel semantic conventions (`http.server.*`), manual metrics use whatever
names you choose.

### 3.3 Always use rate() for counters

Raw counter values are cumulative and reset on restart — useless for graphs.

```promql
# Wrong: raw counter
app_requests_total

# Right: requests per second over 5 minutes
rate(app_requests_total[5m])

# Broken out by HTTP status code
sum(rate(app_requests_total[5m])) by (http_status_code)

# Only errors
rate(app_requests_total{http_status_code=~"4.."}[5m])
```

Use `[5m]` as your default lookback window. `[1m]` can produce blank graphs when
the window is too narrow to capture enough scrape samples.

### 3.4 Histograms: percentile latency

```promql
# 95th percentile request duration (manual histogram)
histogram_quantile(0.95,
  sum(rate(app_request_duration_seconds_bucket[5m])) by (le)
)

# Auto-instrumented histogram (milliseconds — result is in ms, not seconds)
histogram_quantile(0.95,
  sum(rate(http_server_duration_milliseconds_bucket[5m])) by (le)
)

# Also note: auto-instrumentation misattributes unmatched routes to "/" —
# manual instrumentation (above) correctly captures the actual path (e.g. "/not-found")

# Per-route p99
histogram_quantile(0.99,
  sum(rate(app_request_duration_seconds_bucket[5m])) by (le, http_route)
)
```

`le` ("less than or equal") is the bucket boundary label. The `by (le)` is required.

### 3.5 Nginx and host metrics

Notice that memory is queried raw without `rate()`. This is because
`node_memory_MemAvailable_bytes` is a **gauge** — it represents the current value
of something that can go up or down, so the raw value is already meaningful.
`rate()` only applies to counters (cumulative totals) and histogram buckets (which
are counters under the hood). Applying `rate()` to a gauge would give you
"how fast is available memory changing per second" — not useful.

| Type | Query pattern |
|------|--------------|
| Counter | `rate(metric[5m])` — raw value is a useless ever-growing total |
| Gauge | `metric` raw — current value is already the meaningful state |
| Histogram | `histogram_quantile(...rate(..._bucket[5m])...)` — buckets are counters |

```promql
# nginx request rate (counter — needs rate())
rate(nginx_http_requests_total[5m])

# Host memory available (gauge — query raw)
node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes * 100

# CPU usage (counter — needs rate())
100 - (avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)
```

---

## Lesson 4: Loki — Logs

Open http://localhost:3001 → Explore → select **Loki** as the data source.

**Grafana Alloy** (the successor to the now-EOL Promtail) collects stdout from all containers via the Docker socket and attaches labels:
- `service` — docker-compose service name (`nginx`, `app`, `prometheus`, ...)
- `container` — container name
- `stream` — `stdout` or `stderr`

### 4.1 Stream selectors (always required)

Loki only indexes labels, not content. Every query must start with a label selector.

```logql
{service="nginx"}
{service="app"}
{stream="stderr"}
```

### 4.2 Filter expressions

```logql
# Contains string
{service="nginx"} |= "GET"

# Does not contain
{service="nginx"} != "/nginx_status"

# Regex match
{service="nginx"} |~ `"status":(4|5)\d\d`
```

### 4.3 JSON parsing pipeline

nginx is configured to emit structured JSON logs. Parse fields to filter on values:

```logql
# All 4xx and 5xx responses
{service="nginx"} | json | status >= 400

# Slow requests
{service="nginx"} | json | request_time > 0.5

# Just show the URI of 404s
{service="nginx"} | json | status = 404 | line_format "{{.uri}}"

# All fields for a specific route
{service="nginx"} | json | uri = "/"
```

`| json` extracts all JSON fields as labels automatically.
`| line_format` reformats the displayed log line using Go template syntax.

### 4.4 Metric queries from logs

LogQL can compute rates from log lines — useful for data that only exists in logs:

```logql
# Error rate from nginx logs (not from app instrumentation)
sum(rate({service="nginx"} | json | status >= 400 [1m]))

# Request rate by status code, derived from logs
sum(rate({service="nginx"} | json [1m])) by (status)

# Log volume per service
sum(rate({service=~".+"}[1m])) by (service)
```

---

## Lesson 5: Tempo — Distributed Traces

Open http://localhost:3001 → Explore → select **Tempo** as the data source.

### 5.1 What a trace is

A **trace** is a directed tree of **spans**. Each span represents one unit of work:

```
[HTTP GET /]  ←── root span (entire request: 42ms)
  └── [router]  (Express route matching: 1ms)
       └── [GET /]  (route handler: 0.3ms)
```

Every span has:
- A **trace ID** (shared by all spans in one request)
- A **span ID** (unique to this span)
- A **parent span ID** (except the root)
- Start time, duration, status, and attributes

### 5.2 Finding traces

In Grafana Explore with Tempo selected:

1. Click **Search** (not query editor)
2. Set **Service Name** = `node-app`
3. Set a time range and click **Run query**
4. Click any trace to open the waterfall view

You can filter by:
- **Operation name** — e.g., `GET /`
- **Duration** — find slow requests (`>100ms`)
- **Status** — find errored spans

### 5.3 Reading the waterfall

The waterfall view shows each span as a horizontal bar. Width = duration. Indentation = nesting.

```
▶ GET /               42ms   ← root span (the full HTTP request)
  ▶ middleware chain   1ms   ← Express middleware
  ▶ router             0ms   ← route matching
    ▶ GET /            0ms   ← your handler
```

Click a span to see its attributes: HTTP method, status code, route, host, etc.
These come from the OTel HTTP and Express auto-instrumentation — zero app code.

### 5.4 What auto-instrumentation captures automatically

When a request hits `app:3000`, OTel creates spans with:

| Attribute | Value | Source |
|-----------|-------|--------|
| `http.method` | `GET` | HTTP instrumentation |
| `http.target` | `/` | HTTP instrumentation |
| `http.status_code` | `200` | HTTP instrumentation |
| `http.route` | `/` | Express instrumentation |
| `net.host.name` | `app` | HTTP instrumentation |

No `console.log` required. No manual span creation needed.

---

## Lesson 6: Grafana — Unified Dashboards

Open http://localhost:3001 (admin / admin).

### 6.1 Explore mode

Explore (compass icon in left sidebar) is for ad-hoc investigation — no saved dashboards needed.
Switch data sources in the top-left dropdown to move between Prometheus, Loki, and Tempo.

### 6.2 Building a dashboard

1. Dashboards → New → New dashboard → Add visualization
2. Select **Prometheus**, enter:
   ```promql
   sum(rate(app_requests_total[5m])) by (http_status_code)
   ```
3. Set Legend to `{{http_status_code}}`, title to "Request Rate by Status"
4. Add another panel → select **Prometheus**:
   ```promql
   histogram_quantile(0.95, sum(rate(app_request_duration_seconds_bucket[5m])) by (le))
   ```
5. Add another panel → select **Loki**, change visualization to **Logs**:
   ```logql
   {service="nginx"} | json | status >= 400
   ```
6. Save the dashboard. Use the refresh interval dropdown (top right) to auto-refresh.

### 6.3 Variables for dynamic dashboards

In dashboard Settings → Variables → Add variable:
- Type: **Query**, Data source: **Prometheus**
- Query: `label_values(app_requests_total, http_route)`
- Name: `route`

Use `$route` in queries:
```promql
rate(app_requests_total{http_route="$route"}[5m])
```

A dropdown appears at the top of the dashboard. Add more variables for service, status code, etc.

---

## Lesson 7: Correlating All Three Signals

This is the core observability workflow. Metrics surface the problem, logs explain what happened, traces show where time went.

### The scenario

Generate a spike so there's something to investigate:

```bash
# Normal traffic
for i in $(seq 1 50); do curl -s http://localhost; done

# Burst of 404s
for i in $(seq 1 30); do curl -s http://localhost/missing-page; done

# A few more normal requests
for i in $(seq 1 20); do curl -s http://localhost; done
```

### Step 1 — Spot the anomaly in Prometheus

```promql
sum(rate(app_requests_total[1m])) by (http_status_code)
```

You'll see a spike in `http_status_code="404"`. Note the timestamp.

### Step 2 — Drill into logs in Loki

In Grafana Explore, switch to **Loki**, set the time range to match the spike:

```logql
{service="nginx"} | json | status >= 400
```

You see every failed request with its exact URI, timestamp, and client IP.
The metric told you *how many*. The log tells you *which specific URIs*.

### Step 3 — Find a trace for a specific request

In Grafana Explore, switch to **Tempo**, search for `node-app` service,
filter by operation `GET /missing-page`. Open a trace.

The waterfall shows Express routing tried to match the path, found no handler,
and returned a 404. The span attributes include the exact HTTP status and route.

### Step 4 — The key insight

All three signals are connected by **time** and **labels**:

```
Prometheus  app_requests_total{http_status_code="404"}  ← how many
Loki        {service="nginx"} | json | status = 404     ← which URIs
Tempo       service=node-app, http.status_code=404       ← time breakdown
```

In production, you'd add trace IDs to your log lines so Grafana can draw a
direct link from a log entry → its trace. That requires structured logging with
OTel's log bridge API, which is the natural next step once you've outgrown this setup.

---

## Cheat Sheet

### Prometheus

| Goal | Query |
|------|-------|
| Request rate | `rate(app_requests_total[5m])` |
| Error rate | `rate(app_requests_total{http_status_code=~"4.."}[5m])` |
| p95 latency | `histogram_quantile(0.95, sum(rate(app_request_duration_seconds_bucket[5m])) by (le))` |
| Auto-instrumented duration (ms) | `histogram_quantile(0.95, sum(rate(http_server_duration_milliseconds_bucket[5m])) by (le))` |
| nginx request rate | `rate(nginx_http_requests_total[5m])` |
| Host memory % free | `node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes * 100` |

### LogQL

| Goal | Query |
|------|-------|
| All nginx logs | `{service="nginx"}` |
| 4xx/5xx only | `{service="nginx"} \| json \| status >= 400` |
| Slow requests | `{service="nginx"} \| json \| request_time > 0.5` |
| Log rate by service | `sum(rate({service=~".+"}[1m])) by (service)` |
| Error rate from logs | `sum(rate({service="nginx"} \| json \| status >= 400 [1m]))` |

### Useful URLs

| URL | Purpose |
|-----|---------|
| http://localhost:9090/targets | Prometheus scrape health |
| http://localhost:9090/config | Active Prometheus config |
| http://localhost:3100/ready | Loki health |
| http://localhost:3200/ready | Tempo health |
| http://localhost:8889/metrics | Raw metrics from OTel Collector |
| http://localhost:3001/explore | Grafana Explore (ad-hoc queries) |
