# Security Policy

postline-mcp handles LinkedIn access tokens, which can publish to someone's profile. Please treat security issues seriously.

## Reporting a vulnerability

Do **not** open a public issue. Use GitHub's **Report a vulnerability** button (Security tab → Advisories) so the report stays private. You'll get a response within 7 days.

## Design rules

- Tokens are never logged, never returned to the model, and never committed. `.env` is git-ignored.
- Each deployment uses its owner's own LinkedIn app and Cloudflare account. There is no shared hosted service.
- Every stored record is keyed per user.
- The connector requests only `openid`, `profile` and `w_member_social`.
- Publishing, editing and deleting always require explicit confirmation.

## If your token leaks

Revoke it right away: LinkedIn → Settings → Data privacy → Permitted services, remove the app. Then rotate the app's client secret in the LinkedIn Developer Portal.
