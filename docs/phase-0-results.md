# Phase 0 results — November 13, 2026

Run with `spike/linkedin-spike.mjs` against a self-serve app (Share on LinkedIn + Sign In with LinkedIn using OpenID Connect), scopes `openid profile w_member_social`, `LinkedIn-Version: 202609`.

| Step | Endpoint | Result |
|---|---|---|
| Read profile | `GET /v2/userinfo` | PASS |
| Publish (CONNECTIONS visibility) | `POST /rest/posts` | PASS, post URN returned in `x-restli-id` |
| Edit text in place | `POST /rest/posts/{urn}` with `X-RestLi-Method: PARTIAL_UPDATE`, `{"patch":{"$set":{"commentary":…}}}` | PASS |
| Delete | `DELETE /rest/posts/{urn}` | PASS |

Conclusions:
- `w_member_social` alone covers create, edit and delete. No partner approval needed.
- Edit is a true in-place update, so `edit_post` never uses delete-and-repost.
- Access token lifetime shown in the portal: 2 months. No refresh token on the self-serve tier.

# Live connector test — November 14, 2026

Deployed via GitHub Actions to Cloudflare Workers and added to Claude as a custom connector. Sign-in, allowlist and every step below ran through Claude's tool calls.

| Tool | Result |
|---|---|
| `get_me` | PASS: correct account; LinkedIn sign-in valid for ~60 days |
| `draft_post` | PASS: preview returned, nothing posted |
| `publish_post` (connections only) | PASS: brackets, `[ ]`, `*`, `_` and line breaks rendered verbatim; `#OpenSource` rendered as a real hashtag |
| `list_my_posts` | PASS: new post listed |
| `edit_post` | PASS: same post and link, text replaced, formatting intact |
| `delete_post` | PASS: removed from LinkedIn and from the post record |

Not yet verified live: link cards, image posts, `comment_on_post`, `react_to_post`.
