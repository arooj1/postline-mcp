# How postline-mcp works

A guide to the code for anyone debugging or extending it. Line numbers refer to the version at commit `6d1606b`.

## The big picture

Three parties are involved:

```
 ┌──────────┐   1. MCP over HTTPS    ┌──────────────────────────┐   2. LinkedIn REST API   ┌──────────┐
 │  Claude  │ ─────────────────────▶ │  Your Cloudflare Worker  │ ───────────────────────▶ │ LinkedIn │
 │ (client) │ ◀───────────────────── │  (postline-mcp)          │ ◀─────────────────────── │          │
 └──────────┘   tool results         └────────────┬─────────────┘                          └──────────┘
                                                  │
                                       Cloudflare KV (OAUTH_KV)
                                       sign-in grants, drafts, post records
```

The Worker has two jobs:

1. **Sign-in.** Get you signed in to LinkedIn once, and give Claude its own key to the Worker. This is OAuth, done twice: the Worker is an OAuth *server* to Claude and an OAuth *client* to LinkedIn.
2. **Tool calls.** When Claude calls a tool (for example `draft_post`), check Claude's key, look up your LinkedIn token, and call LinkedIn.

Your LinkedIn token never goes to Claude. Claude only holds a key to your Worker, and the Worker holds the LinkedIn token.

## Files at a glance

| File | Role | Think of it as |
|---|---|---|
| `wrangler.jsonc` | Worker settings: name, entry file, variables, KV storage, required secrets | The deployment recipe |
| `src/index.ts` | Entry point. Routes every request, registers the 16 tools, and runs the scheduled publisher (cron) | The front door |
| `src/linkedin-handler.ts` | The sign-in pages: consent screen, redirect to LinkedIn, callback | The reception desk |
| `src/workers-oauth-utils.ts` | Security helpers from Cloudflare: CSRF tokens, cookies, state, consent HTML | The locks on the doors |
| `src/tools.ts` | What each tool does, plus input rules (schemas) | The job descriptions |
| `src/linkedin.ts` | Every call to LinkedIn's API, text escaping, link parsing, error messages | The phone line to LinkedIn |
| `src/store.ts` | Reading and writing drafts, post records, imported history, upload links, carousel PDFs and scheduled posts in KV | The filing cabinet |
| `src/crypto.ts` | Encrypts the token copy a scheduled post carries (AES-256-GCM, key from `COOKIE_ENCRYPTION_KEY`) | The safe |
| `src/importer.ts` | Reads LinkedIn's data export: ZIP, `Shares.csv` → posts, `Articles/*.html` → articles; validates uploads | The archivist |
| `src/import-page.ts` | The one-time upload page; runs the importer in your browser | The drop box |
| `src/env.d.ts`, `worker-configuration.d.ts` | TypeScript types for settings and the Workers runtime (the second is generated) | Labels for the drawers |
| `test/` | 35 unit tests with a fake LinkedIn and fake KV | The rehearsal |
| `spike/linkedin-spike.mjs` | Standalone Phase 0 script that proved the API works | The original experiment |
| `.github/workflows/ci.yml` | GitHub Actions: checks on every push, deploy from `main` | The assembly line |
| `scripts/deploy.mjs` | Deploys the Worker and uploads its secrets in one step | The shipping clerk |

## 1. `wrangler.jsonc`: the deployment recipe

- `"main": "src/index.ts"`: where the Worker starts.
- `compatibility_flags`:
  - `nodejs_compat` lets the libraries use Node features.
  - `global_fetch_strictly_public` stops the Worker reaching private networks, which matters because users supply image URLs.
- `vars` are public settings:
  - `MCP_RESOURCE` is the Worker's own `/mcp` URL. Every key given to Claude is bound to it.
  - `LINKEDIN_VERSION` is the API version.
- `kv_namespaces`: one storage bucket called `OAUTH_KV`. Wrangler creates it on first deploy.
- `secrets.required` lists three values that must exist before deploy: `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` and `COOKIE_ENCRYPTION_KEY`. A fourth secret, `ALLOWED_MEMBER_IDS`, is optional but needed to let anyone in.

**Debug tip:** if a deploy fails with a missing-secret error, run `npx wrangler secret list`.

## 2. `src/index.ts`: the front door

Read it bottom-up.

**`export default new OAuthProvider({...})` (line 146)** wraps the whole Worker. Cloudflare's `workers-oauth-provider` library handles every OAuth request for us:

| URL | Handled by | What happens |
|---|---|---|
| `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource` | the library | Claude discovers how to sign in |
| `/register` | the library | Claude registers itself as a client |
| `/authorize`, `/callback`, `/` | `defaultHandler` → `linkedin-handler.ts` | the sign-in pages (section 3) |
| `/token` | the library | Claude swaps a one-time code for its access key |
| `/mcp` | `apiHandler` → our MCP server | tool calls; rejected with 401 unless Claude's key is valid |

**`tokenExchangeCallback` (line 156)** runs every time Claude gets or refreshes its key. It checks how long the LinkedIn token has left:
- Under a minute left: refuse, so Claude asks you to reconnect.
- Otherwise: Claude's key expires when the LinkedIn token does, about 60 days.

**`createServer()` (line 36)** runs on each `/mcp` request:
1. It reads the signed-in member's **props**: `memberId`, `name`, `accessToken`, `expiresAt`. These were saved at sign-in and are decrypted by the library.
2. It builds a `ToolContext` holding those props, a `Store` for that member, and a `LinkedInClient` using that member's token.
3. It registers the 16 tools. Each registration has:
   - a **name** (`draft_post`)
   - a **description** Claude reads to decide when to use it, including rules like "only publish after explicit approval"
   - an **input schema** from `tools.ts`
   - **annotations** such as `destructiveHint`, which tell Claude the tool changes or deletes things
   - a **handler** that calls the function in `tools.ts`

**`run()` (line 27)** turns any error into a readable tool error, so Claude can tell you what went wrong instead of the connection failing.

## 3. `src/linkedin-handler.ts`: the sign-in pages

This is the most likely place for setup problems, so here is the whole flow:

```
Claude                 Worker                                   LinkedIn
  │  GET /authorize       │                                          │
  │──────────────────────▶│ 1. show consent page ("postline wants…") │
  │  you click Approve    │                                          │
  │  POST /authorize      │                                          │
  │──────────────────────▶│ 2. save state in KV, redirect ──────────▶│ 3. you sign in, click Allow
  │                       │◀───────── GET /callback?code=…&state=…   │
  │                       │ 4. check state                           │
  │                       │ 5. swap code for token ─────────────────▶│ /oauth/v2/accessToken
  │                       │ 6. read profile ────────────────────────▶│ /v2/userinfo
  │                       │ 7. allowlist check                       │
  │                       │ 8. save props, redirect back to Claude   │
  │◀──────────────────────│                                          │
  │  POST /token          │ 9. library issues Claude's key           │
```

| Step | Code | What can go wrong | What you'd see |
|---|---|---|---|
| 1 | `app.get("/authorize")` line 48 | Bad request from Claude | "Invalid request" |
| 2 | `app.post("/authorize")` line 74, `redirectToLinkedIn()` line 164 | CSRF or cookie mismatch, for example from opening the page in another browser | 400 error |
| 3 | LinkedIn's page | `/callback` URL not added in the LinkedIn app's Auth tab | LinkedIn shows "redirect_uri does not match" |
| 4 | `validateOAuthState` | State expired after 10 minutes, or a different browser | "Invalid or expired state" |
| 5 | `exchangeCode()` line 174 | Wrong client ID or secret | "Sign-in failed" page; `wrangler tail` shows "token exchange failed: HTTP 401" |
| 6 | `LinkedInClient.getUserInfo()` | `openid`/`profile` product missing | error page |
| 7 | `parseAllowlist()` line 35 | `ALLOWED_MEMBER_IDS` not set yet | "Not allowed" page **showing your member ID**. This is expected on first sign-in |
| 8 | `completeAuthorization` | — | — |

## 4. `src/tools.ts`: what each tool does

Two parts: **schemas** (line 55) describe and validate inputs (max 3000 characters, https only, and so on). **Handlers** do the work.

| Tool | Handler | Steps |
|---|---|---|
| `get_me` | `getMe` line 113 | Reads props; no LinkedIn call |
| `draft_post` | `draftPost` line 121 | Validates, saves a draft in KV for 24 hours, returns a preview and `draft_id`. **No LinkedIn call** |
| `publish_post` | `publishPost` line 151 | Checks token expiry → loads draft → (image: download, then upload to LinkedIn) → creates post → saves record → deletes draft |
| `edit_post` | `editPost` line 183 | Checks expiry → reads link → refuses activity links → updates text in place → updates record |
| `delete_post` | `deletePost` line 198 | Checks expiry → deletes on LinkedIn (already-gone is fine) → removes record |
| `list_my_posts` | `listMyPosts` line 212 | Reads records from KV only; LinkedIn doesn't allow reading history |
| `comment_on_post` | `commentOnPost` line 223 | Checks expiry → posts comment as you |
| `react_to_post` | `reactToPost` line 230 | Checks expiry → adds reaction |

Why **draft → publish** is two tools: Claude can't publish in one step. It has to show you the preview and come back with the `draft_id`, and Claude's own approval prompt appears before `publish_post` runs.

**Activity links** (`requirePostUrn`, line 243): links copied from the LinkedIn app often contain `urn:li:activity:…`. LinkedIn's edit and delete API needs `urn:li:share:…` instead, and the self-serve API can't convert between them. Edit and delete therefore ask for the link postline returned when it published.

## 5. `src/linkedin.ts`: the phone line to LinkedIn

- **`LinkedInClient`** (line 109): one method per LinkedIn action. Every request carries three headers: your token, `LinkedIn-Version`, and `X-Restli-Protocol-Version: 2.0.0`.

  | Method | LinkedIn endpoint |
  |---|---|
  | `getUserInfo` | `GET /v2/userinfo` |
  | `createPost` | `POST /rest/posts` (new post ID comes back in the `x-restli-id` header) |
  | `updatePostText` | `POST /rest/posts/{id}` with `X-RestLi-Method: PARTIAL_UPDATE` |
  | `deletePost` | `DELETE /rest/posts/{id}` |
  | `uploadImage` | `POST /rest/images?action=initializeUpload`, then `PUT` the bytes |
  | `comment` | `POST /v2/socialActions/{id}/comments` (no version header; `/rest` is partner-only for this) |
  | `react` | `POST /v2/reactions?actor=…` (same reason) |

- **`toLittleText()`** (line 67): LinkedIn treats `( ) [ ] * _ ~ @ # < > { } |` as formatting. Unescaped, posts get cut off or rejected. This function escapes them, and turns `#word` into a real hashtag.
- **`parsePostRef()`** (line 87): accepts a post link in any common format, or an ID, and returns the ID.
- **`describeFailure()`** (line 256): turns HTTP status codes into plain messages. For example, 401 means "sign-in expired, reconnect", and 429 means "daily limit reached".

## 6. `src/store.ts`: the filing cabinet

Every KV key starts with your LinkedIn member ID, so data for different people can never mix:

```
draft:<memberId>:<draftId>   → the draft (auto-deleted after 24 hours)
post:<memberId>:<postUrn>    → record of a post made or edited through postline
history:<memberId>           → imported post history (one value, so an import is one KV write)
import:<token>               → one-time upload link → member ID (auto-deleted after 15 minutes)
```

Why history is one value: Cloudflare's free plan allows a limited number of KV writes per day, and writing hundreds of old posts one by one could exhaust it in a single import.

The OAuth library also keeps its own keys in the same bucket: client registrations, grants and tokens, with props stored encrypted.

## 6b. History import (`src/importer.ts`, `src/import-page.ts`)

1. `create_import_link` stores `import:<random token>` → your member ID for 15 minutes and returns `https://<worker>/import/<token>`.
2. `GET /import/:token` serves the upload page with a strict Content-Security-Policy and no-referrer, so the token can't leak.
3. **In your browser**, the page unzips the export using the browser's built-in `DecompressionStream`, then parses `Shares.csv` (feed posts) and every `Articles/*.html` (articles: title from `<h1>`, link to `/pulse/…`, date from *Published on*, or *Created on* for drafts, and body converted to plain text; empty drafts are skipped). This happens client-side because a free-plan Worker gets about 10 ms of CPU per request; parsing 600 posts took about 50 ms with a simple parser. The page runs the *same* functions as the tests: `import-page.ts` serialises them with `toString()`.
4. `POST /import/:token` (same origin only) receives JSON. `sanitizeImportedPosts` drops malformed rows and non-https links and caps sizes. The posts are saved as one value, and the token is deleted.

`search_my_posts` returns full post text (capped at about 24k characters per call) so Claude can match your voice; `list_my_posts` merges history with posts made through postline.

## 7. Tests (`test/`)

- `helpers.ts` provides a fake KV (`memoryKV`) and a fake `fetch` (`mockFetch`) that records every call.
- `linkedin.test.ts` checks that each API call has the right URL, headers and body, plus escaping, link parsing and error messages.
- `importer.test.ts` covers CSV edge cases (quotes, commas and line breaks inside posts), real deflated and stored ZIPs, and upload validation.
- `scheduling.test.ts` covers carousels, multi-image posts, the processing retry, scheduling rules, the cron publisher (due, retry, failure, double-run guard), cancel, and token encryption.
- `tools.test.ts` covers the draft → publish flow, image upload, expiry, edit and delete rules, listing, and the token exchange.

Run `npm run check` (type-check plus tests) after any change.

## 8. CI/CD (`.github/workflows/ci.yml`, `scripts/deploy.mjs`)

Two jobs:

- **check** runs on every push and pull request: `npm ci`, type-check, unit tests, and `wrangler deploy --dry-run` to confirm the Worker builds. It needs no secrets, so it also runs on forks and contributors' pull requests.
- **deploy** runs only after `check` passes, and only for a push to `main` or a manual run. It is skipped unless the repository variable `MCP_RESOURCE` is set, which is how a fork opts in. It runs `scripts/deploy.mjs`, which:
  1. stops with a clear error if any required secret is missing, or if `MCP_RESOURCE` isn't an `https://…/mcp` URL;
  2. warns if `ALLOWED_MEMBER_IDS` isn't set yet;
  3. writes the secrets to a private temporary file, runs `wrangler deploy --secrets-file … --var MCP_RESOURCE:…`, and deletes the file. Secret values are never printed.

The KV store is created on the first deploy and reused after that, because Wrangler looks up the existing binding on the deployed Worker.

**Debug tip:** open the **Actions** tab on GitHub. A red ✗ on *Type-check, test, build* means the code is broken; a red ✗ on *Deploy to Cloudflare* usually means a missing or wrong secret, and the log names it.

## Debugging toolkit

| Situation | Command |
|---|---|
| Is Wrangler logged in to Cloudflare? | `npx wrangler whoami` |
| Which secrets exist? | `npx wrangler secret list` |
| Watch the live Worker's logs while you click through sign-in | `npx wrangler tail` |
| Run the Worker on your Mac | `cp .env.example .dev.vars`, fill it in, `npm run dev` |
| Did a change break anything? | `npm run check` |
| Is the Worker up? | open `https://<your-worker>.workers.dev/`; it should say "postline-mcp is running" |
| Does OAuth discovery work? | open `https://<your-worker>.workers.dev/.well-known/oauth-authorization-server` |

## Order of setup, and where each failure lives

```
0. GitHub secrets + MCP_RESOURCE set ← GitHub repo settings (or an API token locally)
1. Deploy                             ← ci.yml → scripts/deploy.mjs → wrangler.jsonc
2. Secrets uploaded with the deploy   ← scripts/deploy.mjs
3. /callback added in LinkedIn app    ← LinkedIn portal
4. Claude connects                    ← index.ts → linkedin-handler.ts
5. Allowlist                          ← linkedin-handler.ts step 7
6. Tool calls                         ← index.ts → tools.ts → linkedin.ts / store.ts
```
