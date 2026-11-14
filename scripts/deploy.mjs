// Deploys the Worker and uploads its secrets in one step. Used by GitHub Actions,
// and works locally too:  CLOUDFLARE_API_TOKEN=… MCP_RESOURCE=… … node scripts/deploy.mjs
//
// Secrets are written to a temporary file readable only by this user, passed to
// `wrangler deploy --secrets-file`, and deleted afterwards. Values are never printed.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REQUIRED_SECRETS = ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET", "COOKIE_ENCRYPTION_KEY"];
const OPTIONAL_SECRETS = ["ALLOWED_MEMBER_IDS"];
const REQUIRED_ENV = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "MCP_RESOURCE"];

const fail = (msg) => {
	console.error(`::error::${msg}`);
	process.exit(1);
};

const missing = [...REQUIRED_ENV, ...REQUIRED_SECRETS].filter((n) => !process.env[n]?.trim());
if (missing.length) {
	fail(`Missing: ${missing.join(", ")}. Add them under GitHub → Settings → Secrets and variables → Actions.`);
}

// Pasted secrets often carry a trailing space or newline, which Cloudflare rejects as
// "Invalid access token". Trim everything we pass on.
for (const name of [...REQUIRED_ENV, ...REQUIRED_SECRETS, ...OPTIONAL_SECRETS]) {
	if (process.env[name] !== undefined) process.env[name] = process.env[name].trim();
}
if (!/^[A-Za-z0-9_-]{30,}$/.test(process.env.CLOUDFLARE_API_TOKEN)) {
	fail("CLOUDFLARE_API_TOKEN doesn't look like a Cloudflare API token (letters, digits, - and _ only). Re-copy the token value shown once after creating it, not the token ID or name.");
}
if (!/^[0-9a-f]{32}$/.test(process.env.CLOUDFLARE_ACCOUNT_ID)) {
	fail("CLOUDFLARE_ACCOUNT_ID should be 32 characters of 0-9 and a-f (Workers & Pages page → Account ID).");
}

const resource = process.env.MCP_RESOURCE;
if (!/^https:\/\/[^/]+\/mcp$/.test(resource)) {
	fail(`MCP_RESOURCE must look like https://<worker>.workers.dev/mcp (got "${resource}").`);
}

const secrets = {};
for (const name of [...REQUIRED_SECRETS, ...OPTIONAL_SECRETS]) {
	const value = process.env[name]?.trim();
	if (value) secrets[name] = value;
}
if (!secrets.ALLOWED_MEMBER_IDS) {
	console.log(
		"::warning::ALLOWED_MEMBER_IDS is not set, so nobody can connect yet. Connect once in Claude to see your member ID, add it as a secret, and re-run this workflow.",
	);
}

const dir = mkdtempSync(join(tmpdir(), "postline-"));
const file = join(dir, "secrets.json");
let status = 1;
try {
	writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
	const result = spawnSync(
		"npx",
		["wrangler", "deploy", "--secrets-file", file, "--var", `MCP_RESOURCE:${resource}`],
		{ stdio: "inherit", env: process.env },
	);
	status = result.status ?? 1;
} finally {
	rmSync(dir, { recursive: true, force: true });
}

if (status !== 0) fail("wrangler deploy failed; see the log above.");
console.log(`Deployed. Add this URL to Claude as a custom connector: ${resource}`);
