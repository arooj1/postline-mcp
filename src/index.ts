import { env } from "cloudflare:workers";
import OAuthProvider, { GrantType, OAuthError } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { LinkedInClient } from "./linkedin";
import { LinkedInHandler } from "./linkedin-handler";
import { Store } from "./store";
import {
	cancelScheduledPost,
	commentOnPost,
	createImageUploadLink,
	createImportLink,
	createPdfUploadLink,
	deleteImportedHistory,
	deletePost,
	draftPost,
	editPost,
	getMe,
	listMyPosts,
	listScheduledPosts,
	publishDuePosts,
	publishPost,
	reactToPost,
	schedulePost,
	schemas,
	searchMyPosts,
	type Props,
	type ToolContext,
} from "./tools";

const VERSION = "1.2.0";

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
		kv: env.OAUTH_KV,
		origin: new URL(env.MCP_RESOURCE).origin,
		secret: env.COOKIE_ENCRYPTION_KEY,
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
				"Prepares a LinkedIn post for review WITHOUT publishing it: text only, or with a link card, one image, 2–20 images, or a PDF carousel (document). Returns a draft_id and an exact preview. Always show the preview to the user and wait for their explicit approval before calling publish_post or schedule_post. To revise, call draft_post again.",
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
		"schedule_post",
		{
			title: "Schedule a drafted LinkedIn post",
			description:
				"Schedules a draft created by draft_post to publish automatically at a set time (checked every 5 minutes). Only call this after the user has seen the draft preview AND explicitly approved both the post and the time: nobody confirms again when it publishes. Images and the PDF are saved as they are now. Returns a scheduled_id.",
			inputSchema: schemas.schedule_post,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		},
		async (input) => run(() => schedulePost(ctx, input)),
	);

	server.registerTool(
		"list_scheduled_posts",
		{
			title: "List scheduled LinkedIn posts",
			description: "Lists the user's scheduled posts, soonest first, with their scheduled_id, time, status and any error.",
			inputSchema: schemas.list_scheduled_posts,
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async () => run(() => listScheduledPosts(ctx)),
	);

	server.registerTool(
		"cancel_scheduled_post",
		{
			title: "Cancel a scheduled LinkedIn post",
			description:
				"Cancels a scheduled post so it is never published, and deletes its saved images, PDF and token. Nothing on LinkedIn changes. Use it also to clear a post that failed.",
			inputSchema: schemas.cancel_scheduled_post,
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (input) => run(() => cancelScheduledPost(ctx, input)),
	);

	server.registerTool(
		"create_pdf_upload_link",
		{
			title: "Upload a carousel PDF",
			description:
				"Creates a one-time upload link (valid 15 minutes) where the user uploads a PDF for a LinkedIn carousel (document post). The page shows an upload_id; pass it to draft_post as document.upload_id. Give the link to the user; they open it in a browser.",
			inputSchema: schemas.create_pdf_upload_link,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async () => run(() => createPdfUploadLink(ctx)),
	);

	server.registerTool(
		"create_image_upload_link",
		{
			title: "Upload post images",
			description:
				"Creates an upload link (valid 15 minutes, up to 20 images) where the user uploads JPEG, PNG or GIF images for a post. The page shows one upload_id per image; pass them to draft_post as image.upload_id or images[].upload_id. Give the link to the user; they open it in a browser.",
			inputSchema: schemas.create_image_upload_link,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async () => run(() => createImageUploadLink(ctx)),
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
		"search_my_posts",
		{
			title: "Search my LinkedIn posts",
			description:
				"Returns the full text of the user's past LinkedIn posts and articles (imported history plus posts made through postline), optionally filtered by words. Use it to write new posts in the user's own voice and to avoid repeating topics they've already covered.",
			inputSchema: schemas.search_my_posts,
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async (input) => run(() => searchMyPosts(ctx, input)),
	);

	server.registerTool(
		"create_import_link",
		{
			title: "Import LinkedIn post history",
			description:
				"Creates a one-time upload link (valid 15 minutes) where the user uploads the ZIP from LinkedIn's 'Get a copy of your data' export, so their past posts become searchable. Give the link to the user; they open it in a browser.",
			inputSchema: schemas.create_import_link,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async () => run(() => createImportLink(ctx)),
	);

	server.registerTool(
		"delete_imported_history",
		{
			title: "Delete imported post history",
			description:
				"Deletes the imported LinkedIn post history stored in postline. Does not touch anything on LinkedIn. Confirm with the user first.",
			inputSchema: schemas.delete_imported_history,
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async () => run(() => deleteImportedHistory(ctx)),
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

const provider = new OAuthProvider<Env>({
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

export default {
	fetch: (request, bindings, ctx) => provider.fetch(request, bindings, ctx),
	// Cron trigger (wrangler.jsonc → triggers.crons): publishes scheduled posts that are due.
	scheduled: async (_controller, bindings, ctx) => {
		ctx.waitUntil(
			publishDuePosts({
				kv: bindings.OAUTH_KV,
				secret: bindings.COOKIE_ENCRYPTION_KEY,
				version: bindings.LINKEDIN_VERSION || undefined,
			}).then((log) => {
				for (const line of log) console.log(`scheduled: ${line}`);
			}),
		);
	},
} satisfies ExportedHandler<Env>;
