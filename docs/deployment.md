# Deployment boundary

This is a synthetic engineering demonstration. Its role picker and signed demo cookie are not a production identity system. Email is written to the in-app outbox; no external email transport is configured.

`.env.example` leaves secrets blank and crash/reset controls off. `pnpm setup:local` generates random secrets and enables those controls in a disposable local fixture configuration. Tests and scenario reset rebuild application and Mastra schemas; use only dedicated demo/test databases.

For a deployment, configure PostgreSQL with `vector`, `pg_trgm` and `pgcrypto`, then run separate web and agent services under a supervisor. Set `SESSION_SECRET` and `INTERNAL_API_TOKEN`, restrict access to the agent, and provide an appropriate authentication boundary. Leave crash/reset controls off outside an isolated demo.

The harness backend assumes one agent replica. Its queued-message FIFO is process-local; the app retains source events for recovery. The alternate app backend uses a PostgreSQL advisory lock per desk. This is not an unrestricted horizontal-scaling claim.

Live model use requires provider credentials and `LLM_MODE=live`. The local story and CI default to scripted/offline. No production host wiring or automatic deployment workflow is included.
