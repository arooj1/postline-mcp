/**
 * Sign-in flow. postline is an OAuth server to Claude and an OAuth client to LinkedIn:
 *
 *   Claude -> /authorize -> consent page -> LinkedIn sign-in -> /callback -> back to Claude
 *
 * Structure adapted from Cloudflare's remote-mcp-github-oauth demo
 * (MIT, Copyright (c) 2025 Cloudflare, Inc.; see THIRD_PARTY_NOTICES.md).
 */

import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { LinkedInClient } from "./linkedin";
import type { Props } from "./tools";
import {
	addApprovedClient,
	bindStateToSession,
	createOAuthState,
	generateCSRFProtection,
	isClientApproved,
	OAuthError,
	renderApprovalDialog,
	sanitizeText,
	validateCSRFToken,
	validateOAuthState,
} from "./workers-oauth-utils";

export const LINKEDIN_AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization";
export const LINKEDIN_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
export const LINKEDIN_SCOPES = "openid profile w_member_social";

type Bindings = Env & { OAUTH_PROVIDER: OAuthHelpers };
const app = new Hono<{ Bindings: Bindings }>();

/** Parses ALLOWED_MEMBER_IDS ("abc, def") into a set. */
export function parseAllowlist(value: string | undefined): Set<string> {
	return new Set(
		(value ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);
}

app.get("/", (c) =>
	c.text("postline-mcp is running. Add this server's /mcp URL to Claude as a custom connector.\nhttps://github.com/arooj1/postline-mcp"),
);

app.get("/authorize", async (c) => {
	const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
	const { clientId } = oauthReqInfo;
	if (!clientId) return c.text("Invalid request", 400);

	if (await isClientApproved(c.req.raw, clientId, c.env.COOKIE_ENCRYPTION_KEY)) {
		const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV);
		const { setCookie } = await bindStateToSession(stateToken);
		return redirectToLinkedIn(c.req.raw, c.env, stateToken, { "Set-Cookie": setCookie });
	}

	const { token: csrfToken, setCookie } = generateCSRFProtection();
	return renderApprovalDialog(c.req.raw, {
		client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
		csrfToken,
		server: {
			name: "postline",
			description:
				"Lets Claude draft, publish, edit and delete posts on your own LinkedIn profile using LinkedIn's official API. Nothing is published without your confirmation.",
			logo: "https://raw.githubusercontent.com/arooj1/postline-mcp/main/assets/logo.png",
		},
		setCookie,
		state: { oauthReqInfo },
	});
});

app.post("/authorize", async (c) => {
	try {
		const formData = await c.req.raw.formData();
		validateCSRFToken(formData, c.req.raw);

		const encodedState = formData.get("state");
		if (!encodedState || typeof encodedState !== "string") return c.text("Missing state", 400);

		let state: { oauthReqInfo?: AuthRequest };
		try {
			state = JSON.parse(atob(encodedState));
		} catch {
			return c.text("Invalid state", 400);
		}
		if (!state.oauthReqInfo?.clientId) return c.text("Invalid request", 400);

		const approvedCookie = await addApprovedClient(c.req.raw, state.oauthReqInfo.clientId, c.env.COOKIE_ENCRYPTION_KEY);
		const { stateToken } = await createOAuthState(state.oauthReqInfo, c.env.OAUTH_KV);
		const { setCookie: sessionCookie } = await bindStateToSession(stateToken);

		const headers = new Headers();
		headers.append("Set-Cookie", approvedCookie);
		headers.append("Set-Cookie", sessionCookie);
		return redirectToLinkedIn(c.req.raw, c.env, stateToken, Object.fromEntries(headers));
	} catch (error) {
		if (error instanceof OAuthError) return error.toResponse();
		console.error("POST /authorize failed");
		return c.text("Internal server error", 500);
	}
});

app.get("/callback", async (c) => {
	let oauthReqInfo: AuthRequest;
	let clearSessionCookie: string;
	try {
		const result = await validateOAuthState(c.req.raw, c.env.OAUTH_KV);
		oauthReqInfo = result.oauthReqInfo;
		clearSessionCookie = result.clearCookie;
	} catch (error) {
		if (error instanceof OAuthError) return error.toResponse();
		return c.text("Internal server error", 500);
	}
	if (!oauthReqInfo.clientId) return c.text("Invalid OAuth request data", 400);

	const linkedinError = c.req.query("error");
	if (linkedinError) {
		return htmlPage(
			"LinkedIn sign-in was cancelled",
			`LinkedIn returned: ${sanitizeText(c.req.query("error_description") ?? linkedinError)}`,
			400,
		);
	}

	const code = c.req.query("code");
	if (!code) return c.text("Missing code", 400);

	const token = await exchangeCode(code, new URL("/callback", c.req.url).href, c.env);
	if (!token) return htmlPage("Sign-in failed", "LinkedIn didn't issue an access token. Try connecting again.", 502);

	const me = await new LinkedInClient(token.accessToken).getUserInfo();

	const allowlist = parseAllowlist(c.env.ALLOWED_MEMBER_IDS);
	if (!allowlist.has(me.sub)) {
		const hint =
			allowlist.size === 0
				? `This postline server has no allowed members yet. If this is your deployment, run <code>npx wrangler secret put ALLOWED_MEMBER_IDS</code> and enter <code>${sanitizeText(me.sub)}</code>, then connect again.`
				: "This postline server is private to its owner. Deploy your own copy: https://github.com/arooj1/postline-mcp";
		return htmlPage("Not allowed", hint, 403);
	}

	const props: Props = {
		memberId: me.sub,
		name: me.name,
		accessToken: token.accessToken,
		expiresAt: Date.now() + token.expiresIn * 1000,
	};

	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		metadata: { label: me.name },
		props,
		request: oauthReqInfo,
		scope: oauthReqInfo.scope,
		userId: me.sub,
	});

	const headers = new Headers({ Location: redirectTo });
	if (clearSessionCookie) headers.set("Set-Cookie", clearSessionCookie);
	return new Response(null, { status: 302, headers });
});

function redirectToLinkedIn(request: Request, env: Env, stateToken: string, headers: Record<string, string> = {}) {
	const url = new URL(LINKEDIN_AUTHORIZE_URL);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", env.LINKEDIN_CLIENT_ID);
	url.searchParams.set("redirect_uri", new URL("/callback", request.url).href);
	url.searchParams.set("scope", LINKEDIN_SCOPES);
	url.searchParams.set("state", stateToken);
	return new Response(null, { status: 302, headers: { ...headers, location: url.href } });
}

export async function exchangeCode(
	code: string,
	redirectUri: string,
	env: Pick<Env, "LINKEDIN_CLIENT_ID" | "LINKEDIN_CLIENT_SECRET">,
	fetchImpl: typeof fetch = (...a) => fetch(...a),
): Promise<{ accessToken: string; expiresIn: number } | null> {
	const res = await fetchImpl(LINKEDIN_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: redirectUri,
			client_id: env.LINKEDIN_CLIENT_ID,
			client_secret: env.LINKEDIN_CLIENT_SECRET,
		}).toString(),
	});
	if (!res.ok) {
		console.error(`LinkedIn token exchange failed: HTTP ${res.status}`);
		return null;
	}
	const data = (await res.json()) as { access_token?: string; expires_in?: number };
	if (!data.access_token) return null;
	return { accessToken: data.access_token, expiresIn: data.expires_in ?? 60 * 24 * 60 * 60 };
}

function htmlPage(title: string, bodyHtml: string, status: number): Response {
	const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${sanitizeText(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 20px;color:#1f2937;line-height:1.5}h1{font-size:1.4rem}code{background:#f3f4f6;padding:2px 6px;border-radius:4px}</style>
</head><body><h1>${sanitizeText(title)}</h1><p>${bodyHtml}</p></body></html>`;
	return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export { app as LinkedInHandler };
