# postline-mcp

A public, MIT-licensed remote MCP connector that lets Claude draft, publish, schedule, edit
and delete posts on the owner's own LinkedIn profile using **LinkedIn's official API only**.
Runs as a Cloudflare Worker and is connected as a custom connector in Claude (web, phone,
desktop). Version 1.3.0; copyright Arooj Qureshi. Not affiliated with LinkedIn.

This repo is public: keep private business details and anything confidential out of it,
including this file.

## Rules that are never broken (also in CONTRIBUTING.md)

1. **Official LinkedIn API only.** No scraping, browser automation, cookies or stored
   passwords.
2. **Honest scope.** If LinkedIn's self-serve API does not allow it, say so in the README
   instead of working around it. Reading the feed, others' posts or analytics, posting as a
   Company Page, polls and articles are out of scope.
3. **Nothing publishes without the user's OK.** Claude drafts, the user previews and
   confirms; scheduling approval happens at scheduling time with the exact preview. Tools
   that change LinkedIn must be annotated as such.
4. **Claude never sees the LinkedIn token.** Claude holds only a key to the Worker. Every KV
   key starts with the member ID; the token copy a scheduled post carries is encrypted
   (AES-256-GCM via `src/crypto.ts`).

## Layout

`src/index.ts` (routing, the 18 tools, cron publisher), `src/linkedin.ts` (the only file that
talks to LinkedIn; fix API changes here), `src/tools.ts` (tool logic, no Cloudflare
dependencies so it is unit-testable), `src/store.ts` (KV), `src/linkedin-handler.ts` (sign-in
pages), `src/importer.ts` + `src/import-page.ts` (history import), `src/crypto.ts`, `src/feed.ts` (optional public website feed at `/feed.json`),
`test/` (fake LinkedIn and fake KV; never call the real API from tests),
`docs/ARCHITECTURE.md`, `docs/phase-0-results.md`, `CHANGELOG.md`.

## Commands

- `npm install`, then `npm run check` (type-check + unit tests; CI runs the same).
- `npm run dev` (port 8788), `npm run deploy` or `scripts/deploy.mjs`.
- When tools are added or removed, update the tool count in the README and
  `docs/ARCHITECTURE.md`, and add a CHANGELOG entry (Keep a Changelog, SemVer).

## Config and secrets

- Worker secrets: `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `COOKIE_ENCRYPTION_KEY`,
  `ALLOWED_MEMBER_IDS` (optional at first) and `PUBLIC_FEED_MEMBER_ID` (optional; turns on
  `/feed.json` for that one member). Never put them in `wrangler.jsonc` or the repo.
- `MCP_RESOURCE` (the deployed `/mcp` URL) is a repository **variable**; deploys only run in
  a repo that sets it, so forks never deploy. `LINKEDIN_VERSION` (YYYYMM) must be bumped
  before LinkedIn retires the version (about a year).
- CI/CD (`.github/workflows/ci.yml`): check on every push (type-check, tests, dry-run build);
  deploy from `main` after checks pass. Uses `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID` repository secrets.
- The scheduled-post cron runs every 5 minutes; stay inside Cloudflare free-plan KV limits.

## Status (as of 2026-11-15)

Verified live through Claude on 2026-11-14: text, link, image, image upload, carousel (PDF),
multi-image, scheduling, edit, delete, list, comment and reaction. History import is
unit-tested and awaiting its first live run. Image upload (v1.2.0) was awaiting a live check
at the last update.

## Public website feed (v1.3.0, 2026-11-27)

`/feed.json` lists the feed member's newest 3 **Public** postline posts and up to 6 LinkedIn
articles (hand-added with `add_website_article`, linked from a public post, or in the imported
history). It is rebuilt on every change and stored as one KV value, so serving it never uses
KV list calls. Never put connections-only posts, or edited posts of unknown visibility, in it.
LinkedIn articles still can't be published through the API; the feed only lists their links.

## Keeping this file current

When a rule, layout or status changes, update this CLAUDE.md in the same change.
