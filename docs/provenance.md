# Showcase provenance

Prepared from Switchboard commit `fe4579a08b884b1f4b39d055c7d3c9cf3768bd55` on 22 October 2026, with fresh publication history separate from private development.

The application, migrations, tests, synthetic story, replay fixtures and screenshots are retained. The brief, planning/build history, unshipped directions and server-specific deployment instructions are excluded. Local setup uses separate database names and ports, generates secrets and preserves existing configuration.

The source had no declared licence. That state is preserved; no new licence or reuse permission was introduced.

See [verification](verification.md) and [scenario provenance](../scenarios/README.md).

## Showcase correction

The app-owned signal loop now reports idle only after its final desk-state writes finish, and restarts draining if work arrives during that finalisation. Its advisory-lock regression test waits for the second delivery to finish before database teardown. This corrects a shutdown race found while checking this snapshot; the private source repository is unchanged.

The original CLI-story recordings were supplemented with deterministic recordings from the exact eval driver, which has different event ordering. Recording explicitly used `RECORD_SOURCE=scripted`; no live provider was contacted. The example now defaults recording to scripted mode too.
