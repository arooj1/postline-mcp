# Changelog

All notable changes to postline-mcp. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-11-14

First stable release: a remote MCP connector for Claude that works with your own LinkedIn profile through LinkedIn's official, self-serve API only.

### Added
- **Posting tools:** `draft_post` (preview only), `publish_post` (text, link card or one image), `edit_post` (in place, keeps likes and comments), `delete_post`, `comment_on_post`, `react_to_post` (like, celebrate, support, love, insightful, funny), `get_me`, `list_my_posts`.
- **History import:** `create_import_link` issues a one-time, 15-minute upload link for LinkedIn's data export. Feed posts (`Shares.csv`) and long-form articles (`Articles/*.html`, title, link, publish date, clean text; empty drafts skipped) are parsed in the browser, and only those fields are uploaded. Stored as one KV value per member.
- **Writing in your voice:** `search_my_posts` returns the full text of past posts and articles (imported and published through postline) so Claude can match your style and avoid repeats. `delete_imported_history` removes it.
- **Sign-in:** LinkedIn OAuth (`openid profile w_member_social`) via Cloudflare's `workers-oauth-provider`; Claude's grant expires with the LinkedIn token; owner allowlist (`ALLOWED_MEMBER_IDS`).
- **Safety:** draft → explicit publish flow; destructive tools annotated; LinkedIn "little text" escaping so text publishes verbatim, with real hashtags.
- **CI/CD:** GitHub Actions runs type-check, tests and a dry-run build on every push; deploys from `main` once the `MCP_RESOURCE` variable is set. Secrets are uploaded with the deploy and never printed.
- **Docs:** architecture and debugging guide, Mermaid diagrams, privacy policy, security policy, live test log.

### Verified live (November 14, 2026)
- Publish (text, link card, image), edit, delete, list, comment and reaction, through Claude against LinkedIn's live API.
- Comments and reactions use LinkedIn's unversioned `/v2` endpoints; the versioned `/rest` ones return 403 (partner-only) for self-serve apps.

[1.0.0]: https://github.com/arooj1/postline-mcp/releases/tag/v1.0.0
