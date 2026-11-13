/**
 * Tool logic, kept separate from MCP registration so it can be unit-tested.
 * Every handler gets the signed-in member's context and returns plain text for Claude.
 */

import { z } from "zod";
import {
	LinkedInClient,
	LinkedInError,
	MAX_COMMENT_LENGTH,
	MAX_POST_LENGTH,
	REACTIONS,
	parsePostRef,
	postUrl,
	type ReactionLabel,
} from "./linkedin";
import { Store, type PostRecord } from "./store";

/** What the OAuth flow stores for each signed-in member (encrypted by the OAuth provider). */
export interface Props {
	memberId: string;
	name: string;
	accessToken: string;
	/** When the LinkedIn access token expires, epoch milliseconds. */
	expiresAt: number;
}

export interface ToolContext {
	props: Props;
	store: Store;
	linkedin: LinkedInClient;
	fetchImpl?: typeof fetch;
	now?: () => Date;
}

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif"]);

const authorUrn = (p: Props) => `urn:li:person:${p.memberId}`;

const dateOnly = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Throws a clear message when the LinkedIn token behind this session has expired. */
export function assertTokenValid(ctx: ToolContext): void {
	const now = (ctx.now ?? (() => new Date()))().getTime();
	if (ctx.props.expiresAt && now >= ctx.props.expiresAt) {
		throw new Error(
			`Your LinkedIn sign-in expired on ${dateOnly(ctx.props.expiresAt)}. Disconnect and reconnect postline in Claude's connector settings to sign in again.`,
		);
	}
}

// ---------- Schemas ----------

export const schemas = {
	get_me: z.object({}),
	draft_post: z.object({
		text: z
			.string()
			.min(1)
			.max(MAX_POST_LENGTH)
			.describe(`The post text exactly as it should appear, up to ${MAX_POST_LENGTH} characters. Plain text; #hashtags become real hashtags.`),
		visibility: z
			.enum(["PUBLIC", "CONNECTIONS"])
			.default("PUBLIC")
			.describe("PUBLIC (anyone on LinkedIn) or CONNECTIONS (1st-degree connections only)."),
		link: z
			.object({
				url: z.string().url().describe("The https URL to share."),
				title: z.string().min(1).max(200).describe("Title shown on the link card."),
				description: z.string().max(300).optional().describe("Optional short description for the link card."),
			})
			.optional()
			.describe("Attach a link card. Can't be combined with an image."),
		image: z
			.object({
				url: z.string().url().describe("A public https URL of a JPEG, PNG or GIF, up to 8 MB."),
				alt_text: z.string().min(1).max(300).describe("Describes the image for screen readers."),
			})
			.optional()
			.describe("Attach one image. Can't be combined with a link."),
	}),
	publish_post: z.object({
		draft_id: z.string().uuid().describe("The draft_id returned by draft_post."),
	}),
	edit_post: z.object({
		post: z.string().min(1).describe("Link to the post, or its urn:li:share / urn:li:ugcPost ID."),
		new_text: z.string().min(1).max(MAX_POST_LENGTH).describe("The complete replacement text."),
	}),
	delete_post: z.object({
		post: z.string().min(1).describe("Link to the post, or its urn:li:… ID."),
	}),
	list_my_posts: z.object({
		limit: z.number().int().min(1).max(100).default(20).describe("How many posts to return, newest first."),
	}),
	comment_on_post: z.object({
		post: z.string().min(1).describe("Link to the post, or its urn:li:… ID."),
		text: z.string().min(1).max(MAX_COMMENT_LENGTH).describe(`The comment text, up to ${MAX_COMMENT_LENGTH} characters.`),
	}),
	react_to_post: z.object({
		post: z.string().min(1).describe("Link to the post, or its urn:li:… ID."),
		reaction: z
			.enum(Object.keys(REACTIONS) as [ReactionLabel, ...ReactionLabel[]])
			.default("like")
			.describe("like, celebrate, support, love, insightful or funny."),
	}),
};

type In<K extends keyof typeof schemas> = z.infer<(typeof schemas)[K]>;

// ---------- Handlers ----------

export async function getMe(ctx: ToolContext): Promise<string> {
	return [
		`Signed in to LinkedIn as ${ctx.props.name}.`,
		`Member ID: ${ctx.props.memberId}`,
		`LinkedIn sign-in valid until: ${dateOnly(ctx.props.expiresAt)}`,
	].join("\n");
}

export async function draftPost(ctx: ToolContext, input: In<"draft_post">): Promise<string> {
	if (input.link && input.image) throw new Error("A post can have a link or an image, not both.");
	if (input.link && !input.link.url.startsWith("https://")) throw new Error("Link URLs must start with https://.");
	if (input.image && !input.image.url.startsWith("https://")) throw new Error("Image URLs must start with https://.");
	const draft = await ctx.store.saveDraft({
		text: input.text,
		visibility: input.visibility,
		article: input.link,
		image: input.image ? { url: input.image.url, altText: input.image.alt_text } : undefined,
	});
	const attachment = draft.article
		? `Link card: ${draft.article.title} (${draft.article.url})`
		: draft.image
			? `Image: ${draft.image.url} (alt text: "${draft.image.altText}")`
			: "Attachment: none";
	return [
		"DRAFT — nothing has been posted to LinkedIn.",
		`draft_id: ${draft.id}`,
		`Visibility: ${draft.visibility === "PUBLIC" ? "Public" : "Connections only"}`,
		attachment,
		`Length: ${draft.text.length}/${MAX_POST_LENGTH} characters`,
		"",
		"----- post text -----",
		draft.text,
		"---------------------",
		"",
		"Show this preview to the user. Call publish_post with this draft_id only after they explicitly say to publish. The draft expires in 24 hours.",
	].join("\n");
}

export async function publishPost(ctx: ToolContext, input: In<"publish_post">): Promise<string> {
	assertTokenValid(ctx);
	const draft = await ctx.store.getDraft(input.draft_id);
	if (!draft) throw new Error("That draft wasn't found. It may have expired (drafts last 24 hours) or already been published. Create a new draft.");

	let image: { urn: string; altText: string } | undefined;
	if (draft.image) {
		const { bytes, contentType } = await downloadImage(draft.image.url, ctx.fetchImpl);
		const urn = await ctx.linkedin.uploadImage(authorUrn(ctx.props), bytes, contentType);
		image = { urn, altText: draft.image.altText };
	}

	const urn = await ctx.linkedin.createPost({
		authorUrn: authorUrn(ctx.props),
		text: draft.text,
		visibility: draft.visibility,
		article: draft.article,
		image,
	});
	const record: PostRecord = {
		urn,
		url: postUrl(urn),
		text: draft.text,
		visibility: draft.visibility,
		kind: draft.article ? "article" : draft.image ? "image" : "text",
		createdAt: (ctx.now ?? (() => new Date()))().toISOString(),
	};
	await ctx.store.savePost(record);
	await ctx.store.deleteDraft(draft.id);
	return `Published to LinkedIn.\nLink: ${record.url}\nPost ID: ${urn}`;
}

export async function editPost(ctx: ToolContext, input: In<"edit_post">): Promise<string> {
	assertTokenValid(ctx);
	const urn = parsePostRef(input.post);
	requirePostUrn(urn, "edit");
	await ctx.linkedin.updatePostText(urn, input.new_text);
	const existing = await ctx.store.getPost(urn);
	const now = (ctx.now ?? (() => new Date()))().toISOString();
	await ctx.store.savePost(
		existing
			? { ...existing, text: input.new_text, updatedAt: now }
			: { urn, url: postUrl(urn), text: input.new_text, visibility: "PUBLIC", kind: "text", createdAt: now, updatedAt: now },
	);
	return `Post updated in place (likes and comments kept).\nLink: ${postUrl(urn)}`;
}

export async function deletePost(ctx: ToolContext, input: In<"delete_post">): Promise<string> {
	assertTokenValid(ctx);
	const urn = parsePostRef(input.post);
	requirePostUrn(urn, "delete");
	try {
		await ctx.linkedin.deletePost(urn);
	} catch (err) {
		// Already gone on LinkedIn: still clear our record.
		if (!(err instanceof LinkedInError && err.status === 404)) throw err;
	}
	await ctx.store.deletePost(urn);
	return `Deleted ${urn} from LinkedIn.`;
}

export async function listMyPosts(ctx: ToolContext, input: In<"list_my_posts">): Promise<string> {
	const posts = await ctx.store.listPosts(input.limit);
	if (posts.length === 0) {
		return "No posts recorded yet. postline only knows about posts published or edited through it; LinkedIn doesn't let self-serve apps read your post history.";
	}
	const lines = posts.map(
		(p, i) => `${i + 1}. ${p.createdAt.slice(0, 10)} — ${postUrl(p.urn)}\n   ${p.preview.replace(/\s+/g, " ").slice(0, 140)}`,
	);
	return [`${posts.length} post(s) published through postline, newest first:`, ...lines].join("\n");
}

export async function commentOnPost(ctx: ToolContext, input: In<"comment_on_post">): Promise<string> {
	assertTokenValid(ctx);
	const urn = parsePostRef(input.post);
	await ctx.linkedin.comment(urn, authorUrn(ctx.props), input.text);
	return `Comment posted on ${postUrl(urn)}`;
}

export async function reactToPost(ctx: ToolContext, input: In<"react_to_post">): Promise<string> {
	assertTokenValid(ctx);
	const urn = parsePostRef(input.post);
	await ctx.linkedin.react(urn, authorUrn(ctx.props), input.reaction);
	return `Reacted "${input.reaction}" to ${postUrl(urn)}`;
}

// ---------- Helpers ----------

/**
 * LinkedIn's edit and delete endpoints need the post's share/ugcPost ID. Links copied from
 * the LinkedIn app often carry an activity ID instead, which the self-serve API can't map.
 */
function requirePostUrn(urn: string, action: "edit" | "delete"): void {
	if (urn.startsWith("urn:li:activity:")) {
		throw new Error(
			`To ${action} a post, use the link postline returned when it published it (it contains urn:li:share or urn:li:ugcPost), or pick it from list_my_posts. Links copied from the LinkedIn app carry an activity ID that LinkedIn's API can't ${action}.`,
		);
	}
}

export async function downloadImage(
	url: string,
	fetchImpl: typeof fetch = (...a) => fetch(...a),
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
	if (!url.startsWith("https://")) throw new Error("Image URLs must start with https://.");
	const res = await fetchImpl(url, { redirect: "follow" });
	if (!res.ok) throw new Error(`Couldn't download the image (HTTP ${res.status}).`);
	const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
	if (!IMAGE_TYPES.has(contentType)) {
		throw new Error(`The image must be JPEG, PNG or GIF; that URL returned "${contentType || "unknown type"}".`);
	}
	const declared = Number(res.headers.get("content-length") ?? 0);
	if (declared > MAX_IMAGE_BYTES) throw new Error("The image is larger than 8 MB.");
	const bytes = await res.arrayBuffer();
	if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("The image is larger than 8 MB.");
	return { bytes, contentType };
}
