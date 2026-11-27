// Optional secrets, so they aren't in the generated wrangler types.
interface OptionalSecrets {
	// Comma-separated LinkedIn member IDs allowed to connect. Unset means nobody can.
	ALLOWED_MEMBER_IDS?: string;
	// The one LinkedIn member ID whose public website feed is served at /feed.json.
	// Unset means the feed is off.
	PUBLIC_FEED_MEMBER_ID?: string;
}
interface Env extends OptionalSecrets {}
declare namespace Cloudflare {
	interface Env extends OptionalSecrets {}
}
