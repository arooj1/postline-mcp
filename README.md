# postline-mcp

An open-source MCP connector that lets Claude draft, publish, edit and delete posts on **your own** LinkedIn profile — using only LinkedIn's official API.

> **Status:** Phase 0 complete (API verified Nov 13, 2026). Phase 1 in progress. Not usable yet.
>
> Not affiliated with, endorsed by, or sponsored by LinkedIn Corporation. LinkedIn is a trademark of LinkedIn Corporation.

## Why this exists

Several LinkedIn MCP servers already exist. Some drive your logged-in browser session or use your password, which breaks LinkedIn's User Agreement and can get your account restricted. Others only run locally in Claude Desktop.

postline-mcp is built on three rules:

1. **Official API only.** No scraping, no browser automation, no stored passwords.
2. **Honest scope.** The table below states exactly what LinkedIn allows. If LinkedIn doesn't allow it, this tool doesn't pretend to do it.
3. **Nothing publishes without your OK.** Claude drafts, you preview, you confirm.

## What it can and can't do

| Capability | Status | Why |
|---|---|---|
| Publish a post (text, link, image) to your profile | ✅ Verified (text) | Self-serve `w_member_social` permission |
| Comment on / react to a post (by URL) | ✅ Planned | Same permission |
| Delete your own post | ✅ Verified | Same permission |
| Edit your own post's text (in place, keeps likes and comments) | ✅ Verified | Same permission; `PARTIAL_UPDATE` on `/rest/posts` |
| List posts you made **through this tool** | ✅ Planned | Kept in the connector's own post ledger |
| Import your post history | ✅ Planned | From LinkedIn's "Download your data" export |
| Read your feed, others' posts, comments, analytics | ❌ Not possible | `r_member_social` is closed by LinkedIn |
| Post as a Company Page | ❌ Not in v1 | Requires LinkedIn partner approval |
| Read your data via the DMA Portability API | ❌ EU/EEA/Swiss members only | LinkedIn restricts it by profile location |

## How it will work

```
Claude (web / desktop / mobile)
   │  MCP over HTTPS (custom connector)
   ▼
Your own Cloudflare Worker  ── OAuth ──▶  LinkedIn
   │
   └─ Cloudflare KV: your LinkedIn token + post ledger
```

You deploy your own copy on Cloudflare's free tier with your own LinkedIn developer app. Nobody else ever holds your token.

## Roadmap

- [x] **Phase 0** — Verify post / edit / delete against the live API (`spike/`) — all passed, LinkedIn-Version 202609
- [ ] **Phase 1** — Core tools: `get_me`, `draft_post`, `publish_post`, `edit_post`, `delete_post`, `list_my_posts`, `comment`, `react`
- [ ] **Phase 2** — Remote MCP connector on Cloudflare Workers with OAuth, per-user storage
- [ ] **Phase 3** — One-click "Deploy to Cloudflare", CI, release

## Phase 0: try the spike

Requires Node 20.6+ and a LinkedIn developer app with the **Share on LinkedIn** and **Sign In with LinkedIn using OpenID Connect** products added.

1. Generate a token in the LinkedIn Developer Portal → **Tools → OAuth Token Generator**, with scopes `openid profile w_member_social`.
2. `cp .env.example .env` and paste the token in.
3. `node --env-file=.env spike/linkedin-spike.mjs`

The script posts a short test post visible to your connections only, pauses so you can look at it, tries to edit it, then deletes it. It asks before each step.

## License

[MIT](LICENSE) © 2026 Arooj Qureshi
