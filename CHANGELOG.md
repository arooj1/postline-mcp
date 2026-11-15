# Changelog

All notable changes to postline-mcp. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.2.0] — 2026-11-15

### Added
- **Image upload link:** `create_image_upload_link` issues a 15-minute page for uploading 1–20 post images (JPEG, PNG or GIF, ≤ 8 MB each, typed by file signature). Each image gets an `upload_id`; images are kept in KV until the post is published or scheduled, at most 60 days.
- `draft_post`: `image` and each entry of `images` take `upload_id` as an alternative to `url`, and uploaded and URL images can be mixed. Previews name uploaded images by file name.

### Changed
- Scheduling an uploaded image saves it with the scheduled post, then deletes the upload.
- README: 16 tools; new capability row marked "awaiting live check". SECURITY.md and PRIVACY.md cover image uploads.

## [1.1.0] — 2026-11-15

### Added
- **Carousels:** `draft_post` takes `document: { upload_id | url, title }` and publishes it as a LinkedIn document post through `/rest/documents` (self-serve `w_member_social`). Document posts retry while LinkedIn processes the PDF.
- **PDF upload link:** `create_pdf_upload_link` issues a one-time, 15-minute page for uploading a carousel PDF (≤ 20 MB, signature-checked). PDFs are kept in KV until used or cancelled, at most 60 days.
- **Multi-image posts:** `draft_post` takes `images` (2–20), published as `multiImage` content.
- **Scheduling:** `schedule_post`, `list_scheduled_posts`, `cancel_scheduled_post`, and a cron trigger (every 5 minutes) that publishes due posts. Approval happens at scheduling time with the exact preview; images and PDFs are frozen then. Times need a UTC offset, 10 minutes to 90 days ahead, and before the sign-in expires. Transient failures retry twice; others are marked failed with the reason.
- `src/crypto.ts`: AES-256-GCM encryption (HKDF from `COOKIE_ENCRYPTION_KEY`) for the token copy a scheduled post needs.

### Changed
- `draft_post` now allows one attachment of any kind; the error message says so.
- README: corrected tool count (15), new capability rows marked "awaiting live check", scheduling and carousel docs. SECURITY.md and PRIVACY.md describe the scheduled-post token copy and uploads.

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

[1.1.0]: https://github.com/arooj1/postline-mcp/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/arooj1/postline-mcp/releases/tag/v1.0.0
