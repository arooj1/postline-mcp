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
