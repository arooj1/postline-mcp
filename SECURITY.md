# Security Policy

postline-mcp handles LinkedIn access tokens, which can publish to someone's profile. Please treat security issues seriously.

## Reporting a vulnerability

Do **not** open a public issue. Use GitHub's **Report a vulnerability** button (Security tab → Advisories) so the report stays private. You'll get a response within 7 days.

## Design rules

- Tokens are never logged, never returned to the model, and never committed. `.env` and `.dev.vars` are git-ignored.
- In CI, secrets live in GitHub's encrypted Actions secrets. `scripts/deploy.mjs` passes them to Wrangler through a private temporary file that is deleted right after, and never prints them. Forks can't read them, and the deploy job only runs in a repo that has set `MCP_RESOURCE`.
- Each deployment uses its owner's own LinkedIn app and Cloudflare account. There is no shared hosted service.
- Only LinkedIn member IDs listed in the `ALLOWED_MEMBER_IDS` secret can connect; unset means nobody can.
- Every stored record is keyed per user. The LinkedIn token lives only inside the OAuth provider's encrypted grant.
- The Worker runs with `global_fetch_strictly_public`, so image URLs can't reach private networks.
- The connector requests only `openid`, `profile` and `w_member_social`.
- Publishing, editing and deleting always require explicit confirmation.

## If your token leaks

Revoke it right away: LinkedIn → Settings → Data privacy → Permitted services, remove the app. Then rotate the app's client secret in the LinkedIn Developer Portal.
