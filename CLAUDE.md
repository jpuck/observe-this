# CLAUDE.md — Observability Learning Lab

## What this project is

A hands-on, growing knowledge base for learning modern observability tooling.
It is not a production template. It is a working stack where every config choice,
every debugging session, and every "why does this work that way?" question is
intentionally documented so the learning compounds over time.

The README is the primary artifact. The stack exists to make the README's lessons
real and runnable. When in doubt, prioritize clarity of explanation over cleverness
of implementation.

---

## Learning philosophy

**Explain the why, not just the what.**
A config change without an explanation of why it exists is just noise. Every
non-obvious decision in the stack should have a comment in the config file and,
where appropriate, a lesson or note in the README.

**Treat debugging as curriculum.**
When something breaks during this project — wrong metric names, deprecated tools,
misconfigured services — that debugging process is worth documenting. Real problems
and their resolutions are often more instructive than clean examples.

**Keep the path linear.**
The README lessons build on each other. New lessons should fit naturally into the
existing progression: OTel → Prometheus → Loki → Tempo → Grafana → Correlation.
Avoid forward references to concepts that haven't been introduced yet.

**Prefer working examples over theoretical completeness.**
A query the reader can paste into Prometheus right now is worth more than a
comprehensive taxonomy of PromQL functions.

---

## Instructions for Claude

### When making stack changes
- Update the README to reflect the change — services table, architecture diagram,
  affected lesson sections, and cheat sheet.
- If the change was prompted by a bug or deprecation, note that context in the README
  (e.g. "Promtail was replaced because it reached EOL on March 2, 2026").
- Update config file comments to explain intent, not just mechanics.

### Question → answer → README workflow
The primary way this knowledge base grows is through conversation:
1. The user asks a question ("why does duration steadily increase?")
2. Claude answers it in the chat
3. The user gives feedback on their understanding ("that makes sense" / "I'm still
   confused about X" / asks a follow-up)
4. Once the concept has landed, Claude updates the README with the answer summarized
   at the level the user actually understood it — not a generic docs excerpt

Do not update the README after step 2 alone. Wait for the user to confirm their
understanding or give feedback before writing the lesson. The README should reflect
what was actually understood, not just what was explained.

### When adding new lessons
- Follow the existing lesson format: concept explanation first, then practical queries
  or commands, then gotchas or caveats.
- Include the actual metric/log/trace names as they appear in this specific stack —
  not generic documentation examples.
- Preserve the original question as framing where possible. "Why does duration
  steadily increase?" is a better lesson title than "Understanding histogram counters."
- Write at the level the user demonstrated in the conversation — not beginner
  hand-holding, not expert assumed knowledge.

### When debugging issues
- Diagnose before fixing. Propose the likely cause and the diagnostic command before
  writing a fix.
- If the root cause reveals something worth knowing (e.g. OTel histogram buckets are
  counters under the hood), add it to the relevant README section.

### General
- Keep configs minimal. Only add complexity when there is a concrete learning reason.
- Prefer comments in config files over long prose explanations in the README.
- When a concept has a canonical name (W3C TraceContext, OpenMetrics, OTLP), use it —
  this helps the reader search for more on their own.

---

## Current stack

| Service | Role | Config |
|---------|------|--------|
| app (Node.js/Express) | Example instrumented service | `app/` |
| nginx | Reverse proxy with JSON access logs | `nginx/nginx.conf` |
| OTel Collector | Telemetry routing hub (OTLP → Prometheus + Tempo) | `otel-collector/` |
| Prometheus | Metrics storage and query | `prometheus.yml` |
| Tempo | Distributed trace storage | `tempo/` |
| Loki | Log aggregation | `loki/` |
| Alloy | Log collector (replaced EOL Promtail, Mar 2026) | `alloy/` |
| Grafana | Unified dashboard and exploration UI | `grafana/` |
| node-exporter | Host metrics (direct Prometheus scrape, no OTel) | — |
| nginx-exporter | nginx metrics (direct Prometheus scrape, no OTel) | — |

## Key architectural decisions worth preserving

- **App metrics flow through the OTel Collector**, not via a `/metrics` endpoint.
  Prometheus scrapes the Collector's Prometheus exporter at `:8889`, not the app.
- **node-exporter and nginx-exporter bypass OTel** — they speak native Prometheus
  format and are scraped directly. This is intentional and idiomatic.
- **nginx forwards W3C TraceContext headers** (`traceparent`, `tracestate`) to the
  app so upstream trace IDs are preserved. nginx does not generate its own spans
  without the OTel nginx module.
- **Alloy replaces Promtail** for log collection. Promtail reached EOL March 2, 2026.
  The Alloy config is in `alloy/config.alloy` (River syntax, not YAML).

---

## Open threads / things to explore next

- Add structured logging to the Node app and correlate log trace IDs with Tempo spans
- Explore the OTel nginx module to give nginx first-class trace participation
- Set up a Grafana alerting rule against a Prometheus metric
- Add a second downstream service to demonstrate true distributed tracing across
  multiple hops
- Explore Grafana Alloy as a replacement for the OTel Collector (it can do both)
