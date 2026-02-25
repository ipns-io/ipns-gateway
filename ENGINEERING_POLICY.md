# Engineering Policy

This policy keeps `ipns-gateway` stable for routing and content resolution behavior.

## Commit and Push Rules

- Test execution alone never creates commits.
- Only intentional commit/push publishes changes.
- Keep commits narrowly scoped to routing, gateway, or ops concerns.
- Never commit secrets or `.env` files.

## Branching Rules

- `main` should remain deployable.
- Use feature branches for behavior changes.
- PR review required for routing logic changes.

## Test Policy (3 Layers)

1. Unit:
- Resolver/routing utility behavior.

2. Integration:
- Worker/server route matching and upstream fetch behavior.

3. E2E Smoke:
- Gateway route checks for representative hostnames.
- Confirm expected headers and status codes on critical paths.

## Operational Safety

- Validate fallbacks for missing/invalid records.
- Keep deterministic behavior for canonical hostnames.
- Document any caching or timeout changes with risk notes.

## Pre-Merge Checklist

- 3-layer validation completed (or exception documented)
- No secrets in diff
- Production smoke command list included
- Rollback path documented for risky changes
