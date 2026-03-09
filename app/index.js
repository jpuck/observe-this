const express = require("express");
const { metrics } = require("@opentelemetry/api");

const app = express();

// Get a Meter from the global MeterProvider initialized in tracing.js.
// This is the OTel equivalent of `new prom-client.Counter(...)`.
const meter = metrics.getMeter("node-app", "1.0.0");

// Manual counter — supplements the auto-instrumented http.server.request.duration histogram.
// Useful for business-level counting with custom attributes.
const requestCounter = meter.createCounter("app.requests", {
  description: "Total number of HTTP requests handled",
});

// Manual histogram — tracks request duration with our own bucket boundaries.
const requestDuration = meter.createHistogram("app.request.duration", {
  description: "HTTP request duration in seconds",
  unit: "s",
  advice: {
    explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  },
});

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const attrs = {
      "http.method": req.method,
      "http.route": req.route ? req.route.path : req.path,
      "http.status_code": String(res.statusCode),
    };
    requestCounter.add(1, attrs);
    requestDuration.record((Date.now() - start) / 1000, attrs);
  });
  next();
});

app.get("/", (req, res) => {
  res.send("Hello World");
});

// No /metrics endpoint — metrics are pushed to the OTel Collector via OTLP,
// not scraped directly. Prometheus scrapes the Collector at port 8889 instead.

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`App listening on port ${PORT}`);
});
