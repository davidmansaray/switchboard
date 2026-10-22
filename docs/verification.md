# Verification

Checked locally on 22 October 2026 using Node 22.23.1, pnpm 10.30.3, PostgreSQL 17.6 and the committed dependency lock. GitHub CI runs these checks on both signal backends; the current result is available in [Actions](https://github.com/davidmansaray/switchboard/actions).

| Check | Result |
|---|---|
| Frozen dependency install | Passed |
| ESLint and TypeScript across the workspace | Passed |
| Dedicated local databases and extensions | Created and seeded successfully |
| Production Mastra and Next.js builds | Passed |
| Unit and integration tests after the lifecycle correction | 16 files, 100 tests passed, no unhandled errors |
| Alternate app-backend test run | 16 files, 100 tests passed, no unhandled errors |
| Advisory-lock regression test | 3 tests passed, no unhandled errors |
| Scripted evaluations: harness and app | Each: 3 tests passed, 1 replay-only test skipped |
| Strict harness replay | 4 tests passed, no scripted fallback misses |
| Browser story and mobile approval view | 2 tests passed on each signal backend; 4 total |
| Setup helper repeat run | Preserved existing configuration, with random secrets and file mode 0600 |

The first full test run passed 100 assertions but reported two unhandled database errors at teardown. The app-owned loop reported idle before its final desk-state writes completed. This application corrects that lifecycle boundary and awaits the second delivery in its regression test. See [provenance](provenance.md).

The first strict replay check found 23 missing responses because the original fixtures came from the CLI story driver. Recordings from the exact eval driver were generated with `RECORD_SOURCE=scripted`, reviewed and added. Strict replay then passed against the final combined fixture set.

## Simulator reset regression

GitHub browser traces exposed a refresh overlapping reset: the old reset committed its table truncation before reseeding, so the page could render without a current staff member. Reset now truncates and seeds in one transaction. An injected seed failure reproduced empty staff data on the previous implementation; the same regression passes with rollback preserving the existing staff and hires. The seed explicitly preserves its three historical revisions inside the outer reset transaction. All eight focused database/scenario reset and recovery tests pass locally on both backends, as do lint and workspace type checks.

The browser runner verifies backend identity, fully stops each stack before starting the next, and retains separate logs and traces for diagnosing failures.

## Publication checks

Gitleaks 8.30.1 scanned the staged release files without credential findings. The 73 replay cache request checksums are the only allowlisted values; no recording file is excluded. A canary placed in a recording detected both synthetic test credentials while ignoring its known checksum. The private source-history findings were those same request checksums.

Manual tracked-content checks found no local user paths or server-specific deployment wiring. The committed screenshots and recordings contain fictional demo data.

All deterministic tests and replay fixtures use the scripted model. They do not establish live-provider quality. Email remains in the simulated in-app outbox; demo role selection is not production authentication.
