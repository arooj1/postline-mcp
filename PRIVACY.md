# Privacy Policy — postline-mcp

_Last updated: November 27, 2026_

postline-mcp is open-source software. There is no central service run by the author. Each person who uses it runs their own copy (on their own computer or their own Cloudflare account) with their own LinkedIn developer app.

## What data it handles

When you connect your LinkedIn account, your copy of postline-mcp receives:

- **Your basic profile** (name, profile photo, LinkedIn member ID), through the `openid` and `profile` permissions, to identify you as the author of posts.
- **An access token** that lets it publish, edit, comment and react on your behalf, through the `w_member_social` permission.
- **A record of posts you create through it** (post ID, text, date), so you can list, edit and delete them later.
- **Uploads and scheduled posts, only if you use them.** A PDF or image you upload, and a scheduled post's text, images, PDF and an encrypted copy of your token, are kept until the post is published or cancelled (uploads at most 60 days; images uploaded for a scheduled post are deleted once they are saved with it).
- **Your post and article history, only if you import it** (date, title, text, link, attached URL, visibility) from your own LinkedIn data export. The export file is read in your browser; only those post fields are sent to your deployment. Other files in the export (connections, messages and so on) are never read or uploaded.

## The optional public website feed

If the person running a copy sets `PUBLIC_FEED_MEMBER_ID`, that copy publishes a public JSON feed at `/feed.json` for that one member, so their own website can show their latest posts and articles. It contains only what is already public on LinkedIn: the link, date and first ~220 characters of their newest 3 **Public** posts made through postline, and the link, title, date and a short summary of their LinkedIn articles. Connections-only posts are never included. It is off unless that setting is made, and covers no one else. Remove an article with the `remove_website_article` tool, or unset the setting to turn the feed off.

## Where it is stored

Only in the deployment you control: a local `.env` file, or Cloudflare KV storage in your own Cloudflare account. The author of postline-mcp never receives, sees or stores your data or token.

## What it does not do

- It does not read your feed, other members' posts, your messages, or your connections.
- It does not sell, share or use your data for advertising.
- It never publishes, edits or deletes anything without your explicit confirmation. A scheduled post is confirmed when you schedule it, and you can cancel it until it goes out.

## Removing your data

- Revoke access at any time: LinkedIn → Settings → Data privacy → Permitted services.
- Ask Claude to *delete my imported history* (the `delete_imported_history` tool), or delete your Cloudflare KV namespace to remove everything.

## Contact

Questions: open an issue at https://github.com/arooj1/postline-mcp/issues
