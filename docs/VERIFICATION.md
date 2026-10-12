# Recovery verification

Verified on 2026-10-12 using Node.js 24.19.0, npm 11.9.0 and disposable local PostgreSQL17 fixtures. No live Worker deployment, database migration or LINE message send was part of this recovery verification.

## Reconstructed-source checks

- TypeScript check and ESLint: passed.
- Unit, DOM UI, Worker and demo tests: 2,336 passed across 96 files.
- Demo build and local-only runtime bundle build: passed.
- Runtime, LINE runtime, notification runtime/integration, bot-info, manual-approval and restricted-dispatch smoke checks: passed with synthetic dependencies.
- Independent review: no blocking reconstructed-source findings. 224 serialized notification payload comparisons match functions extracted from the exact deployed executable; all five synthetic golden payloads match.
- Readiness/runtime differential comparison: 25 runtime cases, 41 parser cases and 6 error cases match the deployed implementation.
- Exact 014–016 migrations independently verified on a fresh PostgreSQL17 cluster, including catalog fingerprints, RLS/ACL preservation and the required 015/016 commit boundary.
- New PostgreSQL tests: 57 targeted card version, identity, retry, bridge, security and concurrency cases passed. Complete sanitized-tree matrix results are recorded below after final execution.

## Explicit limits

Browser end-to-end verification is **not completed** in this environment. Chromium failed to create a required local process socket (`Operation not permitted`) before visiting the app. Both normal and supported escalated launches failed at that environment boundary; 96 browser cases were blocked before app interaction. DOM/UI tests are not a substitute for a real browser pass.

The exact recovered SQL supports two approved default-ACL baseline fingerprints. Disposable local execution covers the synthetic baseline. No hosted-default fixture is fabricated, and no live patient or operator records are included in tests.

This is a reconstructed source snapshot, not the original lost source tree. It is not certification for production patient use. Provider configuration, actual LINE delivery, deployment bindings, live policy/budget settings and production operations require separate validation.

## Final sanitized-tree results

- Clean `npm ci` from the official package registry: passed (370 packages installed).
- TypeScript check and ESLint: passed.
- Unit, DOM UI, Worker and demo tests: **2,332 passed across 96 files**. The difference from 2,336 is exactly four assertions about excluded private historical approval prose; executable security tests remain.
- Full fresh PostgreSQL17 matrix: **715 tests passed across 37 files** (483 current-generation and 232 legacy-generation tests). Both disposable clusters shut down cleanly.
- Demo build, runtime build and all seven runtime smoke checks: passed.
- Independent publication audit: no credentials, actual operator/event/booking identifiers, private notes/evidence, Git history or publishable symlinks found. Clinic business phone and approved branding/assets are retained; image metadata was checked.
- All 15 migration files retain frozen recovery bytes, including exact recovered 014–016.
- Browser E2E: environment-blocked as described above, not represented as passed.

No GitHub Actions workflow is included in this snapshot. The results above are local verification, not a claimed GitHub CI run.
