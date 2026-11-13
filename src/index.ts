import { env } from "cloudflare:workers";
import OAuthProvider, { GrantType, OAuthError } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { LinkedInClient } from "./linkedin";
import { LinkedInHandler } from "./linkedin-handler";
import { Store } from "./store";
import {
	commentOnPost,
	deletePost,
	draftPost,
	editPost,
	getMe,
	listMyPosts,
	publishPost,
	reactToPost,
	schemas,
	type Props,
	type ToolContext,
} from "./tools";

const VERSION = "0.1.0";

type TextResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/** Runs a handler and turns any error into a readable tool error instead of a crash. */
async function run(fn: () => Promise<string>): Promise<TextResult> {
	try {
		return { content: [{ type: "text", text: await fn() }] };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { content: [{ type: "text", text: message }], isError: true };
	}
}

function createServer() {
	const server = new McpServer({ name: "postline", version: VERSION });
	const props = getMcpAuthContext()?.props as Props | undefined;
	if (!props) return server;

	const ctx: ToolContext = {
		props,
		store: new Store(env.OAUTH_KV, props.memberId),
		linkedin: new LinkedInClient(props.accessToken, env.LINKEDIN_VERSION || undefined),
	};

	server.registerTool(
		"get_me",
		{
			title: "Who am I on LinkedIn",
			description: "Shows which LinkedIn account postline is signed in as and when the sign-in expires.",
			inputSchema: schemas.get_me,
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async () => run(() => getMe(ctx)),
	);

	server.registerTool(
		"draft_post",
		{
			title: "Draft a LinkedIn post",
			description:
				"Prepares a LinkedIn post for review WITHOUT publishing it. Returns a draft_id and an exact preview. Always show the preview to the user and wait for their explicit approval before calling publish_post. To revise, call draft_post again.",
			inputSchema: schemas.draft_post,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (input) => run(() => draftPost(ctx, input)),
	);

	server.registerTool(
		"publish_post",
		{
			title: "Publish a drafted LinkedIn post",
			description:
				"Publishes a draft created by draft_post to the user's LinkedIn profile. Only call this after the user has seen the draft preview and explicitly said to publish it.",
			inputSchema: schemas.publish_post,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		},
		async (input) => run(() => publishPost(ctx, input)),
	);

	server.registerTool(
		"edit_post",
		{
			title: "Edit a LinkedIn post's text",
			description:
				"Replaces the text of one of the user's own LinkedIn posts in place; likes and comments are kept. Show the user the new text and get their confirmation first. Only the text can be changed, not links or images.",
			inputSchema: schemas.edit_post,
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
		},
		async (input) => run(() => editPost(ctx, input)),
	);

	server.registerTool(
		"delete_post",
		{
			title: "Delete a LinkedIn post",
			description:
				"Permanently deletes one of the user's own LinkedIn posts, including its likes and comments. Cannot be undone. Confirm with the user before calling.",
			inputSchema: schemas.delete_post,
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
		},
		async (input) => run(() => deletePost(ctx, input)),
	);

	server.registerTool(
		"list_my_posts",
		{
			title: "List posts made through postline",
			description:
				"Lists posts the user published or edited through postline, newest first, with links. LinkedIn does not let self-serve apps read the user's full post history or feed.",
			inputSchema: schemas.list_my_posts,
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async (input) => run(() => listMyPosts(ctx, input)),
	);

	server.registerTool(
		"comment_on_post",
		{
			title: "Comment on a LinkedIn post",
			description:
				"Posts a comment as the user on a LinkedIn post, given its link or ID. Show the comment text to the user and get confirmation first.",
			inputSchema: schemas.comment_on_post,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		},
		async (input) => run(() => commentOnPost(ctx, input)),
	);

	server.registerTool(
		"react_to_post",
		{
			title: "React to a LinkedIn post",
			description: "Adds the user's reaction (like, celebrate, support, love, insightful, funny) to a LinkedIn post.",
			inputSchema: schemas.react_to_post,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		},
		async (input) => run(() => reactToPost(ctx, input)),
	);

	return server;
}

const mcpHandler = createMcpHandler(createServer);

export default new OAuthProvider<Env>({
	apiHandler: { fetch: (request, bindings, ctx) => mcpHandler(request, bindings, ctx) } satisfies ExportedHandler<Env>,
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	tokenEndpoint: "/token",
	defaultHandler: LinkedInHandler as any,
	resourceMetadata: { resource: env.MCP_RESOURCE },
	// Keep Claude's connection alive exactly as long as the LinkedIn token behind it.
	// When LinkedIn's token expires, Claude is asked to sign in again.
	tokenExchangeCallback: ({ grantType, props }) => {
		const p = props as Props;
		const secondsLeft = Math.floor((p.expiresAt - Date.now()) / 1000);
		if (secondsLeft < 60) {
			throw new OAuthError("invalid_grant", {
				description: "Your LinkedIn sign-in has expired. Reconnect postline to sign in again.",
			});
		}
		if (grantType === GrantType.AUTHORIZATION_CODE) return { refreshTokenTTL: secondsLeft };
	},
});
