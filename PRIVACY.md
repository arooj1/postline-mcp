# Privacy Policy — postline-mcp

_Last updated: November 14, 2026_

postline-mcp is open-source software. There is no central service run by the author. Each person who uses it runs their own copy (on their own computer or their own Cloudflare account) with their own LinkedIn developer app.

## What data it handles

When you connect your LinkedIn account, your copy of postline-mcp receives:

- **Your basic profile** (name, profile photo, LinkedIn member ID), through the `openid` and `profile` permissions, to identify you as the author of posts.
- **An access token** that lets it publish, edit, comment and react on your behalf, through the `w_member_social` permission.
- **A record of posts you create through it** (post ID, text, date), so you can list, edit and delete them later.
- **Your post history, only if you import it** (date, text, link, attached URL, visibility) from your own LinkedIn data export. The export file is read in your browser; only those post fields are sent to your deployment. Other files in the export (connections, messages and so on) are never read or uploaded.

## Where it is stored

Only in the deployment you control: a local `.env` file, or Cloudflare KV storage in your own Cloudflare account. The author of postline-mcp never receives, sees or stores your data or token.

## What it does not do

- It does not read your feed, other members' posts, your messages, or your connections.
- It does not sell, share or use your data for advertising.
- It never publishes, edits or deletes anything without your explicit confirmation.

## Removing your data

- Revoke access at any time: LinkedIn → Settings → Data privacy → Permitted services.
- Ask Claude to *delete my imported history* (the `delete_imported_history` tool), or delete your Cloudflare KV namespace to remove everything.

## Contact

Questions: open an issue at https://github.com/arooj1/postline-mcp/issues
