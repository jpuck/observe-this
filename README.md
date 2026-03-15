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

### 5.5 Trace context propagation

When a request arrives at nginx from an external caller that already has a trace ID
(e.g. a browser with OTel instrumentation, or another service), nginx forwards those
IDs to the app via the **W3C TraceContext** headers:

```
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
                  └─────── trace ID ──────────────┘ └─ span ID ─┘
tracestate:  vendor-specific additional state (optional)
```

This is configured in `nginx/nginx.conf`:

```nginx
proxy_set_header traceparent $http_traceparent;
proxy_set_header tracestate  $http_tracestate;
```

Without these headers, a trace originating upstream would appear as two disconnected
traces in Tempo — one for the upstream caller and one starting fresh at the app.
With them, the app's OTel SDK reads the incoming `traceparent`, continues the same
trace, and its spans appear as children of the upstream span in a single waterfall.

For requests that originate at nginx itself (e.g. a browser with no existing trace),
there is no incoming `traceparent`, so the app starts a new root trace as normal.
To have nginx generate its own spans and participate as a full trace node, you would
need the [OpenTelemetry nginx module](https://github.com/open-telemetry/opentelemetry-cpp-contrib/tree/main/instrumentation/nginx),
which is a separate installation step beyond this learning setup.

---

## Lesson 6: Grafana — Unified Dashboards

Open http://localhost:3001 (admin / admin).

### 6.0 Grafana vs the Prometheus UI

Once Grafana is running, you'll rarely need the Prometheus UI at http://localhost:9090
for day-to-day work. Everything you actually care about — graphs, dashboards, alerts,
and cross-signal correlation — lives in Grafana. The Prometheus UI is an
operator/debugging tool, not a monitoring tool. The cases where it's still useful:

| Task | Why Prometheus UI, not Grafana |
|------|-------------------------------|
| `http://localhost:9090/targets` | Shows scrape health — which targets are UP/DOWN, last scrape time, error messages |
| `http://localhost:9090/config` | Inspect the live running config to verify a reload took effect |
| Metric name hunting | Autocomplete and raw metric browsing when you don't know the exact name yet |
| Query debugging | The **Explain** tab breaks down a PromQL expression step by step |

### 6.1 Explore mode

Explore (compass icon in left sidebar) is for ad-hoc investigation — no saved dashboards needed.
Switch data sources in the top-left dropdown to move between Prometheus, Loki, and Tempo.

### 6.2 Building a dashboard

Grafana's query editor has two modes — **Builder** (a form-based visual editor) and
**Code** (plain PromQL text input). Builder wraps free-form expressions as metric name
literals, which causes parse errors. Always switch to **Code** mode before pasting
PromQL. Look for the Code/Builder toggle in the top-right corner of the query row.

1. Dashboards → New → New dashboard → Add visualization
2. Select **Prometheus**, switch to **Code** mode, enter:
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

### 6.3 Backing up and versioning dashboards

The `grafana_data` Docker volume stores Grafana's internal SQLite database — user
accounts, settings, and any dashboards created via the UI. It is runtime state, not
a backup. If the volume is lost, everything built in the UI is gone.

**The right approach: provisioned dashboards.**
Grafana can load dashboards from JSON files on disk at startup, using the same
provisioning mechanism as data sources. This stack is already wired up for it —
drop a dashboard JSON file into `grafana/provisioning/dashboards/` and it will
appear in Grafana automatically on next restart. The dashboard lives in git
alongside the rest of the stack, making the volume disposable.

**To save a dashboard to the repo:**
1. Build and save the dashboard in the Grafana UI
2. Open it → Dashboard Settings (gear icon) → JSON Model
3. Copy the JSON and save it as a `.json` file in `grafana/provisioning/dashboards/`
4. Commit it to git

**To restore on a new system or after volume loss:**
```bash
docker compose up -d   # provisioned dashboards load automatically on first boot
```

**Trade-off:** provisioned dashboards are read-only in the UI by default. To edit
one, modify the JSON file and restart Grafana — the file is the source of truth,
not whatever was last clicked. This is the right constraint for a reproducible setup.

### 6.4 Variables for dynamic dashboards

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

## Lesson 8: Building a Host Metrics Dashboard

node-exporter collects metrics from the **host machine**, not the Docker container.
This is worth understanding before building dashboards around it.

Look at the volume mounts in `docker-compose.yml`:

```yaml
volumes:
  - /proc:/host/proc:ro
  - /sys:/host/sys:ro
  - /:/rootfs:ro
```

On Linux, `/proc` is where the kernel exposes everything about the running system —
CPU usage, memory, network stats, disk I/O. node-exporter mounts the host's `/proc`
directly into the container (hence `--path.procfs=/host/proc`) rather than reading
its own container's `/proc`, which would only show the container's isolated view.

So `node_memory_MemAvailable_bytes` tells you how much RAM your actual server has
free — not how much the node-exporter container has been allocated.

### 8.1 Memory

Memory is a **gauge** — query it raw, no `rate()` needed.

```promql
# % used — this is the right panel for a "memory pressure" dashboard
(node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes) / node_memory_MemTotal_bytes * 100
```

**`MemAvailable` vs `MemFree`:** these are different things and the distinction matters.
`MemFree` is RAM with literally nothing in it. `MemAvailable` is the kernel's estimate
of how much memory could be reclaimed for a new application — it includes memory
currently used for disk cache and buffers that can be freed on demand. Linux
aggressively uses spare RAM for caching, so `MemFree` is almost always near zero and
looks alarming without being a real problem. Always use `MemAvailable`.

**Reading the query:** if Prometheus shows ~80 for the available-based query
(`node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes * 100`), that means
80% is *free* — not 80% used. The used query above inverts this, giving you the
number that matches what htop shows in the `Mem` bar.

**What to watch for:** memory used % trending upward over hours or days is a slow
memory leak. A sudden spike is usually a new process starting or a traffic burst.

### 8.2 CPU

CPU time is broken into modes by the kernel. `node_cpu_seconds_total` is a counter
(time spent in each mode), so use `rate()`.

```promql
# Overall usage across all cores — inverse of idle time
100 - (avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)

# Broken out by mode to see where time is going
avg by (mode) (rate(node_cpu_seconds_total[5m])) * 100
```

**CPU modes worth knowing:**

| Mode | Meaning | High value means... |
|------|---------|-------------------|
| `user` | Running application code | App is CPU-bound |
| `system` | Running kernel code | Lots of syscalls (I/O, networking) |
| `iowait` | CPU idle, waiting on disk | Disk is the bottleneck |
| `steal` | Time stolen by hypervisor | You're on a noisy cloud neighbour |
| `idle` | Doing nothing | System has headroom |

`iowait` is particularly diagnostic — high iowait means your CPU isn't busy
computing, it's just waiting for disk reads/writes to complete.

### 8.3 Disk space and I/O

```promql
# Disk space used as a percentage (gauge — query raw)
(node_filesystem_size_bytes - node_filesystem_free_bytes)
  / node_filesystem_size_bytes * 100

# Read/write throughput in bytes per second (counter — needs rate())
rate(node_disk_read_bytes_total[5m])
rate(node_disk_written_bytes_total[5m])
```

**What to watch for:** disk space is a slow-moving gauge that tends to be ignored
until it hits 100% and takes down the system. Alert at 80%. Disk I/O rate spikes
that correlate with high `iowait` CPU confirm a disk bottleneck.

**Docker volume mounts don't propagate submounts.** If node-exporter is running in
a container, mounting `/:/rootfs:ro` only exposes the root filesystem device —
separate block devices mounted *on top of* directories (e.g. `/storage`, `/boot/efi`)
don't come along. node-exporter reads `/proc/mounts` and knows those filesystems
exist, but it can't `statvfs()` them because the paths aren't accessible in the
container's mount namespace. The result: only the root filesystem shows up in
disk space metrics, everything else is silently missing.

The fix is `rslave` bind propagation on the rootfs volume:

```yaml
# docker-compose.yml
volumes:
  - type: bind
    source: /
    target: /rootfs
    read_only: true
    bind:
      propagation: rslave  # mirrors host submounts into the container
command:
  - "--path.rootfs=/rootfs"
```

`rslave` tells the kernel to mirror any mounts under `/` into the container's
`/rootfs` as they appear on the host. With `--path.rootfs=/rootfs`, node-exporter
prefixes all filesystem paths with `/rootfs` before calling `statvfs()`, so it
can reach `/rootfs/storage`, `/rootfs/boot/efi`, etc.

**Filtering out RAM-backed and virtual filesystems.** Once rslave propagation is
enabled, node-exporter will report every mounted filesystem — including ones you
don't care about. Two categories to filter:

- **`tmpfs`** — RAM-backed, ephemeral. Used by the kernel for `/run`, `/dev/shm`,
  `/run/lock`, and per-user `/run/user/<uid>` directories. No physical disk involved;
  data is gone on reboot. Not useful to monitor for disk pressure.

- **`ramfs`** — also RAM-backed, like tmpfs but without a size limit. Used by
  systemd's **credentials** feature: when a sandboxed service needs a secret (API
  key, password), systemd mounts it as ramfs at
  `/run/credentials/<service-name>/`. These mounts live in the **service's private
  mount namespace**, so they don't appear in `df -h` run from your shell (which
  sees your own mount namespace), but node-exporter reads from PID 1's mount
  namespace via `/proc/mounts` and sees them. Filtering `ramfs` removes them.

The dashboard query uses `fstype!~"tmpfs|ramfs|overlay|squashfs"` to exclude all
of these, leaving only real persistent storage devices.

### 8.4 Network

```promql
# Bytes received/transmitted per second per interface (counter — needs rate())
rate(node_network_receive_bytes_total[5m])
rate(node_network_transmit_bytes_total[5m])
```

Filter out loopback and virtual interfaces if they're noisy:
```promql
rate(node_network_receive_bytes_total{device!~"lo|docker.*|veth.*"}[5m])
```

### 8.5 System load

```promql
# Load average normalized by number of CPU cores
# Above 1.0 means more work is queued than can be processed
node_load1 / count without (cpu, mode) (node_cpu_seconds_total{mode="idle"})
```

`node_load1` is the 1-minute load average — a measure of how many processes are
waiting to run. Dividing by core count gives you a ratio: above 1.0 means the
system is overloaded, below 1.0 means it has headroom.

There are also `node_load5` and `node_load15` for 5 and 15-minute averages. A spike
in `node_load1` that doesn't appear in `node_load15` is a short burst. All three
elevated together means sustained pressure.

### 8.6 Building the dashboard in Grafana

1. Dashboards → New → New dashboard
2. Add a panel for each category below — one stat or graph per row:

| Panel | Query | Visualization |
|-------|-------|--------------|
| Memory used % | `(node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes) / node_memory_MemTotal_bytes * 100` | Gauge (0–100, threshold at 85%) |
| CPU usage % | `100 - (avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)` | Time series |
| CPU by mode | `avg by (mode) (rate(node_cpu_seconds_total[5m])) * 100` | Time series stacked |
| Disk space % | `(node_filesystem_size_bytes - node_filesystem_free_bytes) / node_filesystem_size_bytes * 100` | Gauge (0–100) |
| Disk I/O | `rate(node_disk_read_bytes_total[5m])` + `rate(node_disk_written_bytes_total[5m])` | Time series |
| Network traffic | `rate(node_network_receive_bytes_total{device!~"lo|docker.*"}[5m])` | Time series |
| System load ratio | `node_load1 / count without(cpu,mode)(node_cpu_seconds_total{mode="idle"})` | Stat (threshold at 1.0) |

**Thresholds worth setting in Grafana:**
- Memory used > 85% → yellow, > 95% → red
- CPU usage > 80% sustained → yellow
- Disk space > 80% → yellow, > 90% → red
- Load ratio > 1.0 → yellow, > 2.0 → red

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
