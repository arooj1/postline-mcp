// Optional secret, so it isn't in the generated wrangler types.
// Comma-separated LinkedIn member IDs allowed to connect. Unset means nobody can.
interface Env {
	ALLOWED_MEMBER_IDS?: string;
}
