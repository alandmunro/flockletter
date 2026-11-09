# Test-send security and accounting evidence

Applicable requirements: FL-CAM-002/003/004/005/006/007/010, FL-USG-001/002/005, FL-BIL-001/007, FL-API-001/002/003 and FL-OPS-001/005/006/007; acceptance case FL-AT-039. These checks exercise the approved one-recipient/five-approved-requests policy; they do not enable production sending or establish provider delivery.

The independent suite uses real disposable PostgreSQL and canonical session commands plus an actual in-memory MCP client/server. Its 20 cases cover:

- Cross-brand concurrent daily admissions, zero campaign-slot consumption, accepted email accounting, exhausted shared email allowance and nonrefundable daily admissions.
- Read-only session/MCP preflight with DB-UTC budget facts and unchanged delivery, usage and operation rows.
- Exact recipient/version/reviewer binding, current owner/grant rechecks, changed address/consent/sender, and no contact directory in generic reports.
- Pending, paused and unknown replacement protection, including cancellation and a changed draft revision.
- Unknown outcomes retained and reconciled against their original operation and billing period across UTC/month changes; no fresh old-day submission.
- Legacy approval rollback including an accidental campaign-slot debit; direct SQL dispatch denial without completed approval, correct one-email/zero-slot reservation, fresh day and protocol marker. The marker is version correlation, not identity or send authority.
- Immutable parent/recipient snapshots, strict forged admission/second-recipient INSERT refusal, restricted-role trigger-disable denial, and startup rejection of a disabled trigger or altered function body.

Historical-row tests use only the disposable fixture administrator to age synthetic records, restoring and verifying the exact ALWAYS trigger before restricted-runtime assertions. This is test setup, not a supported restore or privileged product bypass.

Focused verification passed all 20 tests, lint, type checking and self-host drill syntax checking. The integrated local check passed 105 test files and 722 tests, with two explicitly gated engine tests skipped, plus the production build. The supported full logical restore drill seeds captured accepted and injected unknown test history, compares restored snapshots/usage, checks runtime boundaries and rejects legacy SQL dispatch afterward. Its Docker image copies the additional startup-boundary module. The full Linux Docker restore passed [CI for source `73ca99d`](https://github.com/alandmunro/flockletter/actions/runs/42563702073); it was not completed locally in this workstream. Later release heads must pass their own CI. No live provider was called and no production data or settings changed.

Local Qwen extracted the reusable fixture from the existing delivery test factory (61.12 seconds; 3,572 output characters). Chat removed unwanted code fences/unused imports and reviewed the fixture. Chat handled security/accounting design review, adversarial assertions, integration corrections and the populated restore-drill extension. No token or cost percentage is inferred.
