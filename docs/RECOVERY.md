# Source recovery provenance

This repository is a newly recovered source snapshot. It is **not** the original source tree or history of release `7fdc0436faaa4b5e9681f9a5b73d5f833dd90da9`.

## Inputs

- Preserved application source baseline: `76111bb`, already including combined-notification work from `c31c964`.
- Read-only extraction of the deployed Worker executable: SHA-256 `a6288ec184bb5fa1e599b9a2652d90c366d08643db1fb58aaf5787530a1b1ebb`. The original executable had no source map; its compiled behavior is comparison evidence, not proof that reconstructed TypeScript has identical source bytes.
- Original migration SQL recovered from database migration history. No patient tables were exported for source recovery.

## Exact recovered SQL

The following file bytes match the previously reviewed migration hashes:

| File | SHA-256 |
| --- | --- |
| `014_admin_invitations.sql` | `60bacfc3d46f9dc6e46816440807b31547bb544e26fa9de757182a5b1b216284` |
| `015_notification_card_versions.sql` | `afd501787a7189e5e6f12424eff036195bc1c98a1e157102145a8299e1ee3445` |
| `016_activate_notification_cards.sql` | `27e510126696ab821d6d2312e5d8d213f4563070e1e6ae2fd2faeda814b2974b` |

These SQL files retain their catalog fingerprints and security guards. They are not generic idempotent install scripts. Existing databases must be inspected before applying any migration.

## Reconstructed portions

Notification card version handling, phone input behavior, post-commit notification processing and readiness UI are reconstructed from the deployed executable and preserved contracts. Tests distinguish old-payload compatibility and new versions. Build hashes may differ because source/module layout and build inputs differ.

## Publication boundary

Only application source, assets, synthetic tests, migrations, build tooling and user-facing documentation are included. Historical operational evidence, credentials, private notes, database contents and original development history are intentionally not part of this snapshot.

Local test results and remaining limitations are documented with the published recovery verification summary. Publication of source does not deploy a Worker or apply database migrations.

## Deliberate public-snapshot differences

The publishable copy replaces historical one-shot operator/event/booking identifiers with fixed synthetic fixtures, removes account-specific deployment IDs, and uses example LINE identifiers. The historical manual approval lane remains disabled by default; its fixed identity, event, version, payload and origin checks are preserved. These fixture changes are not a continuation or reauthorization of any past message send.

Public staging origins that participate in notification security contracts are retained to avoid silently changing payload bytes, exact-origin fences or database catalog fingerprints. They are documented migration/deployment constraints, not portable self-host configuration.

Historical approval-document tests are removed only where they test private operational prose. Executable migration, access-control and payload security assertions remain. Local database bootstrap tooling is relocated into `scripts/`, so the public tests do not need the private evidence directory.
