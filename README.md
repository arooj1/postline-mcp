# postline-mcp

An open-source MCP connector that lets Claude draft, publish, edit and delete posts on **your own** LinkedIn profile — using only LinkedIn's official API.

> **Status:** v0.1 — built and tested locally; first live deployment in progress. Publish, edit and delete are verified against LinkedIn's live API; comment and react are not yet.
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
| Publish a post (text, link card, or one image) to your profile | ✅ Text verified live; link and image built | Self-serve `w_member_social` permission |
| Comment on / react to a post (by link) | 🔧 Built, not yet verified live | Same permission |
| Delete your own post | ✅ Verified | Same permission |
| Edit your own post's text (in place, keeps likes and comments) | ✅ Verified | Same permission; `PARTIAL_UPDATE` on `/rest/posts` |
| List posts you made **through this tool** | ✅ Built | Kept in the connector's own per-user record |
| Import your post history | ✅ Planned | From LinkedIn's "Download your data" export |
| Read your feed, others' posts, comments, analytics | ❌ Not possible | `r_member_social` is closed by LinkedIn |
| Post as a Company Page | ❌ Not in v1 | Requires LinkedIn partner approval |
| Read your data via the DMA Portability API | ❌ EU/EEA/Swiss members only | LinkedIn restricts it by profile location |

## How it works

```
Claude (web / desktop / mobile)
   │  MCP over HTTPS (custom connector)
   ▼
Your own Cloudflare Worker  ── OAuth ──▶  LinkedIn
   │
   └─ Cloudflare KV: encrypted sign-in grant + your post records (keyed by your member ID)
```

You deploy your own copy on Cloudflare's free tier with your own LinkedIn developer app. Nobody else ever holds your token.

## Tools

| Tool | What it does | Changes LinkedIn? |
|---|---|---|
| `get_me` | Which account is connected and when the sign-in expires | No |
| `draft_post` | Prepares a post and returns an exact preview and a `draft_id` | No |
| `publish_post` | Publishes a draft, only after you approve the preview | Yes |
| `edit_post` | Replaces a post's text in place (likes and comments kept) | Yes |
| `delete_post` | Deletes one of your posts | Yes |
| `list_my_posts` | Lists posts published or edited through postline | No |
| `comment_on_post` | Comments on a post as you | Yes |
| `react_to_post` | Like, celebrate, support, love, insightful or funny | Yes |

Text is escaped for LinkedIn's formatting rules, so brackets, asterisks and underscores publish exactly as written, and `#hashtags` become real hashtags.

## Deploy your own (about 20 minutes, free)

You need: Node 20+, a free Cloudflare account, and a LinkedIn developer app with **Share on LinkedIn** and **Sign In with LinkedIn using OpenID Connect** added (see [Phase 0 results](docs/phase-0-results.md)).

```bash
git clone https://github.com/arooj1/postline-mcp && cd postline-mcp
npm install
npx wrangler login
```

1. **First deploy** (creates the Worker and its KV store):
   ```bash
   npx wrangler deploy
   ```
   Note the URL it prints, e.g. `https://postline-mcp.<your-subdomain>.workers.dev`.
2. **Point the config at it.** In `wrangler.jsonc`, set `MCP_RESOURCE` to that URL plus `/mcp`.
3. **Tell LinkedIn where to send you back.** LinkedIn app → **Auth** → *Authorized redirect URLs* → add `https://postline-mcp.<your-subdomain>.workers.dev/callback`.
4. **Add secrets** (from the LinkedIn app's Auth tab):
   ```bash
   npx wrangler secret put LINKEDIN_CLIENT_ID
   npx wrangler secret put LINKEDIN_CLIENT_SECRET
   npx wrangler secret put COOKIE_ENCRYPTION_KEY   # paste the output of: openssl rand -hex 32
   npx wrangler deploy
   ```
5. **Connect Claude.** Claude → Settings → Connectors → **Add custom connector** → paste your `/mcp` URL → Connect, and sign in with LinkedIn.
6. **Allow yourself.** The first sign-in stops on a "Not allowed" page that shows your LinkedIn member ID. Run:
   ```bash
   npx wrangler secret put ALLOWED_MEMBER_IDS     # paste that member ID
   ```
   Then click Connect in Claude again. Only member IDs in this list can ever use your deployment.

LinkedIn sign-ins last about 60 days. When yours expires, Claude asks you to reconnect.

## Develop

```bash
cp .env.example .dev.vars   # then set LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET, COOKIE_ENCRYPTION_KEY
npm run dev                 # http://localhost:8788 (add http://localhost:8788/callback to your LinkedIn app)
npm run check               # type-check + unit tests
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the code fits together and how to debug it.

`spike/linkedin-spike.mjs` is the standalone script used to verify the API (see [Phase 0 results](docs/phase-0-results.md)).

## Roadmap

- [x] **Phase 0** — Verify publish / edit / delete against the live API — all passed
- [x] **Phase 1** — Core tools with draft → confirm flow, per-user storage, 35 unit tests
- [x] **Phase 2** — Remote MCP connector on Cloudflare Workers with LinkedIn OAuth and owner allowlist
- [ ] **Live verification** — First deployment; verify link, image, comment and react against the live API
- [ ] **Phase 3** — Import history from LinkedIn's data export, CI, "Deploy to Cloudflare" button, v1.0 release

## License

[MIT](LICENSE) © 2026 Arooj Qureshi
