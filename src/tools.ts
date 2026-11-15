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
import { decryptToken, encryptToken } from "./crypto";
import {
	createImportTicket,
	createImageUploadTicket,
	createPdfUploadTicket,
	MAX_IMAGES_PER_LINK,
	Store,
	type Draft,
	type ImageSource,
	type PostKind,
	type PostRecord,
	type ScheduledPost,
	type ScheduleMeta,
} from "./store";
import type { CreatePostInput } from "./linkedin";

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
	/** KV namespace, for one-time import links. */
	kv?: KVNamespace;
	/** Public origin of this Worker, e.g. https://postline-mcp.example.workers.dev */
	origin?: string;
	fetchImpl?: typeof fetch;
	now?: () => Date;
	/** COOKIE_ENCRYPTION_KEY: encrypts the token kept with scheduled posts. */
	secret?: string;
	/** Injectable for tests. */
	sleep?: (ms: number) => Promise<void>;
}

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Kept under Cloudflare KV's 25 MiB value limit. LinkedIn itself allows up to 100 MB and 300 pages. */
export const MAX_PDF_BYTES = 20 * 1024 * 1024;
/** Earliest and latest times a post can be scheduled for. */
export const MIN_SCHEDULE_LEAD_MS = 10 * 60_000;
export const MAX_SCHEDULE_AHEAD_MS = 90 * 86_400_000;
/** A scheduled post must publish at least this long before the LinkedIn sign-in expires. */
export const TOKEN_EXPIRY_MARGIN_MS = 86_400_000;
/** Transient failures are retried on later runs; after this many attempts the post is marked failed. */
export const MAX_PUBLISH_ATTEMPTS = 3;
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

const imageInput = z.object({
	upload_id: z.string().uuid().optional().describe("The upload_id of an image the user uploaded through create_image_upload_link."),
	url: z.string().url().optional().describe("Or: a public https URL of a JPEG, PNG or GIF, up to 8 MB."),
	alt_text: z.string().min(1).max(300).describe("Describes the image for screen readers."),
});

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
		image: imageInput
			.optional()
			.describe("Attach one image. Give upload_id or url, not both. Can't be combined with a link, images or a document."),
		images: z
			.array(imageInput)
			.min(2)
			.max(20)
			.optional()
			.describe(
				"Attach 2–20 images, shown as a grid, in this order. Each gives upload_id or url. Can't be combined with a link, a single image or a document.",
			),
		document: z
			.object({
				upload_id: z
					.string()
					.uuid()
					.optional()
					.describe("The upload_id of a PDF the user uploaded through create_pdf_upload_link."),
				url: z.string().url().optional().describe("Or: a public https URL of the PDF, up to 20 MB."),
				title: z.string().min(1).max(200).describe("Title shown above the carousel, e.g. \"MCP, explained\"."),
			})
			.optional()
			.describe(
				"Attach a PDF, shown as a swipeable carousel (a LinkedIn document post). Give upload_id or url, not both. Can't be combined with a link or images.",
			),
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
	create_import_link: z.object({}),
	search_my_posts: z.object({
		query: z
			.string()
			.max(200)
			.optional()
			.describe("Words to look for in post text (all must appear). Leave empty for the most recent posts."),
		limit: z.number().int().min(1).max(30).default(10).describe("How many posts to return, newest first."),
	}),
	delete_imported_history: z.object({
		confirm: z.literal(true).describe("Must be true. Deletes the imported history from postline (not from LinkedIn)."),
	}),
	create_pdf_upload_link: z.object({}),
	create_image_upload_link: z.object({}),
	schedule_post: z.object({
		draft_id: z.string().uuid().describe("The draft_id returned by draft_post."),
		publish_at: z
			.string()
			.describe(
				"When to publish, as an ISO 8601 date-time WITH a UTC offset, e.g. 2026-11-17T08:30:00-05:00. At least 10 minutes from now.",
			),
	}),
	list_scheduled_posts: z.object({}),
	cancel_scheduled_post: z.object({
		scheduled_id: z.string().uuid().describe("The scheduled_id returned by schedule_post or list_scheduled_posts."),
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
	const attachments = [input.link, input.image, input.images, input.document].filter(Boolean).length;
	if (attachments > 1) throw new Error("A post can have one kind of attachment: a link, an image, 2–20 images, or a PDF document.");
	if (input.link && !input.link.url.startsWith("https://")) throw new Error("Link URLs must start with https://.");
	const image = input.image ? await toImageSource(ctx, input.image) : undefined;
	const images = input.images ? await Promise.all(input.images.map((i) => toImageSource(ctx, i))) : undefined;
	const uploadIds = (images ?? []).map((i) => i.uploadId).filter(Boolean);
	if (new Set(uploadIds).size < uploadIds.length) {
		throw new Error("The same uploaded image is listed twice. Each upload_id can be used once per post.");
	}
	let document: Draft["document"];
	if (input.document) {
		const { upload_id, url, title } = input.document;
		if (!!upload_id === !!url) throw new Error("For a document, give either upload_id (from create_pdf_upload_link) or url, not both.");
		if (upload_id) {
			if (!(await ctx.store.getDocumentMeta(upload_id))) {
				throw new Error("That uploaded PDF wasn't found. It may have expired or been used already. Create a new upload link.");
			}
			document = { uploadId: upload_id, title };
		} else {
			if (!url!.startsWith("https://")) throw new Error("Document URLs must start with https://.");
			document = { url: url!, title };
		}
	}
	const draft = await ctx.store.saveDraft({
		text: input.text,
		visibility: input.visibility,
		article: input.link,
		image,
		images,
		document,
	});
	return [
		"DRAFT — nothing has been posted to LinkedIn.",
		`draft_id: ${draft.id}`,
		`Visibility: ${draft.visibility === "PUBLIC" ? "Public" : "Connections only"}`,
		await describeAttachment(ctx, draft),
		`Length: ${draft.text.length}/${MAX_POST_LENGTH} characters`,
		"",
		"----- post text -----",
		draft.text,
		"---------------------",
		"",
		"Show this preview to the user. Call publish_post (now) or schedule_post (later) with this draft_id only after they explicitly approve it. The draft expires in 24 hours.",
	].join("\n");
}

async function toImageSource(ctx: ToolContext, input: z.infer<typeof imageInput>): Promise<ImageSource> {
	const { upload_id, url, alt_text } = input;
	if (!!upload_id === !!url) throw new Error("For each image, give either upload_id (from create_image_upload_link) or url, not both.");
	if (upload_id) {
		if (!(await ctx.store.getUploadedImageMeta(upload_id))) {
			throw new Error("That uploaded image wasn't found. It may have expired or been used already. Create a new image upload link.");
		}
		return { uploadId: upload_id, altText: alt_text };
	}
	if (!url!.startsWith("https://")) throw new Error("Image URLs must start with https://.");
	return { url: url!, altText: alt_text };
}

/** How an image is named in previews: its uploaded file name, or its URL. */
async function imageLabel(ctx: ToolContext, img: ImageSource): Promise<string> {
	if (!img.uploadId) return img.url!;
	const meta = await ctx.store.getUploadedImageMeta(img.uploadId);
	return meta ? `uploaded ${meta.fileName}, ${(meta.size / 1024 / 1024).toFixed(1)} MB` : "uploaded image";
}

/** The bytes of a draft's image: from the upload store, or downloaded from its URL. */
async function loadDraftImage(ctx: ToolContext, img: ImageSource): Promise<{ bytes: ArrayBuffer; contentType: string }> {
	if (img.uploadId) {
		const found = await ctx.store.getUploadedImage(img.uploadId);
		if (!found) throw new Error("An uploaded image has expired or was already used. Create a new image upload link and draft again.");
		return { bytes: found.bytes, contentType: found.meta.contentType };
	}
	return downloadImage(img.url!, ctx.fetchImpl);
}

async function deleteUploadedImages(ctx: ToolContext, d: Pick<Draft, "image" | "images">): Promise<void> {
	const ids = [d.image, ...(d.images ?? [])].map((i) => i?.uploadId).filter((id): id is string => !!id);
	await Promise.all(ids.map((id) => ctx.store.deleteUploadedImage(id)));
}

async function describeAttachment(ctx: ToolContext, d: Pick<Draft, "article" | "image" | "images" | "document">): Promise<string> {
	if (d.article) return `Link card: ${d.article.title} (${d.article.url})`;
	if (d.image) return `Image: ${await imageLabel(ctx, d.image)} (alt text: "${d.image.altText}")`;
	if (d.images) {
		const labels = await Promise.all(d.images.map((i) => imageLabel(ctx, i)));
		return [`Images (${d.images.length}, in this order):`, ...d.images.map((i, n) => `  ${n + 1}. ${labels[n]} (alt text: "${i.altText}")`)].join("\n");
	}
	if (d.document) {
		if (d.document.uploadId) {
			const meta = await ctx.store.getDocumentMeta(d.document.uploadId);
			const file = meta ? `${meta.fileName}, ${(meta.size / 1024 / 1024).toFixed(1)} MB` : "uploaded PDF";
			return `Carousel (PDF): "${d.document.title}" (${file})`;
		}
		return `Carousel (PDF): "${d.document.title}" (${d.document.url})`;
	}
	return "Attachment: none";
}

const kindOf = (d: Pick<Draft, "article" | "image" | "images" | "document">): PostKind =>
	d.article ? "article" : d.image ? "image" : d.images ? "images" : d.document ? "document" : "text";

export async function publishPost(ctx: ToolContext, input: In<"publish_post">): Promise<string> {
	assertTokenValid(ctx);
	const draft = await ctx.store.getDraft(input.draft_id);
	if (!draft) throw new Error("That draft wasn't found. It may have expired (drafts last 24 hours) or already been published or scheduled. Create a new draft.");

	const owner = authorUrn(ctx.props);
	const content: Partial<CreatePostInput> = {};
	if (draft.image) {
		const { bytes, contentType } = await loadDraftImage(ctx, draft.image);
		content.image = { urn: await ctx.linkedin.uploadImage(owner, bytes, contentType), altText: draft.image.altText };
	} else if (draft.images) {
		content.images = [];
		for (const img of draft.images) {
			const { bytes, contentType } = await loadDraftImage(ctx, img);
			content.images.push({ urn: await ctx.linkedin.uploadImage(owner, bytes, contentType), altText: img.altText });
		}
	} else if (draft.document) {
		const bytes = await loadDraftPdf(ctx, draft.document);
		content.document = { urn: await ctx.linkedin.uploadDocument(owner, bytes), title: draft.document.title };
	}

	const urn = await createPostWithRetry(ctx.linkedin, { authorUrn: owner, text: draft.text, visibility: draft.visibility, article: draft.article, ...content }, ctx.sleep);
	const record: PostRecord = {
		urn,
		url: postUrl(urn),
		text: draft.text,
		visibility: draft.visibility,
		kind: kindOf(draft),
		createdAt: (ctx.now ?? (() => new Date()))().toISOString(),
	};
	await ctx.store.savePost(record);
	await ctx.store.deleteDraft(draft.id);
	if (draft.document?.uploadId) await ctx.store.deleteDocument(draft.document.uploadId);
	await deleteUploadedImages(ctx, draft);
	return `Published to LinkedIn.\nLink: ${record.url}\nPost ID: ${urn}`;
}

async function loadDraftPdf(ctx: ToolContext, doc: NonNullable<Draft["document"]>): Promise<ArrayBuffer> {
	if (doc.uploadId) {
		const found = await ctx.store.getDocument(doc.uploadId);
		if (!found) throw new Error("The uploaded PDF has expired or was already used. Create a new upload link and draft again.");
		return found.bytes;
	}
	return downloadPdf(doc.url!, ctx.fetchImpl);
}

/**
 * LinkedIn processes an uploaded PDF before a post can use it. If the post is created
 * too early it is rejected, so document posts retry a few times with a growing wait.
 */
export async function createPostWithRetry(
	linkedin: LinkedInClient,
	input: CreatePostInput,
	sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<string> {
	const waits = input.document ? [2000, 4000, 8000] : [];
	for (let attempt = 0; ; attempt++) {
		try {
			return await linkedin.createPost(input);
		} catch (err) {
			const retryable = err instanceof LinkedInError && [400, 409, 422, 500, 502, 503, 504].includes(err.status);
			if (!retryable || attempt >= waits.length) throw err;
			await sleep(waits[attempt]);
		}
	}
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
	const [own, history] = await Promise.all([ctx.store.listPosts(100), ctx.store.getHistory()]);
	type Item = { date: string; url: string; preview: string; source: "postline" | "imported" };
	const seen = new Set<string>();
	const items: Item[] = [];
	for (const p of own) {
		seen.add(p.urn);
		items.push({ date: p.createdAt, url: postUrl(p.urn), preview: p.preview, source: "postline" });
	}
	for (const p of history?.posts ?? []) {
		if (p.urn && seen.has(p.urn)) continue;
		const isArticle = p.kind === "article";
		items.push({
			date: p.date,
			url: p.url || (p.urn ? postUrl(p.urn) : ""),
			preview: isArticle ? `Article: ${p.title ?? ""} — ${p.text}` : p.text,
			source: "imported",
		});
	}
	if (items.length === 0) {
		return "No posts yet. postline knows about posts published through it, plus any history you import with create_import_link. LinkedIn doesn't let self-serve apps read your post history directly.";
	}
	items.sort((a, b) => b.date.localeCompare(a.date));
	const shown = items.slice(0, input.limit);
	const lines = shown.map(
		(p, i) =>
			`${i + 1}. ${p.date.slice(0, 10)}${p.source === "imported" ? " (imported)" : ""} — ${p.url || "no link"}\n   ${p.preview.replace(/\s+/g, " ").slice(0, 140)}`,
	);
	const articles = history?.posts.filter((p) => p.kind === "article").length ?? 0;
	const historyNote = history
		? ` History imported ${history.importedAt.slice(0, 10)} (${history.posts.length - articles} posts, ${articles} articles).`
		: "";
	return [`Showing ${shown.length} of ${items.length} post(s), newest first.${historyNote}`, ...lines].join("\n");
}

export async function createImportLink(ctx: ToolContext): Promise<string> {
	if (!ctx.kv || !ctx.origin) throw new Error("Import links aren't available on this deployment.");
	const token = await createImportTicket(ctx.kv, ctx.props.memberId);
	return [
		`Upload link (works once, expires in 15 minutes): ${ctx.origin}/import/${token}`,
		"",
		"Give the user this link. They open it in their browser and upload the ZIP from LinkedIn's \"Get a copy of your data\" (with Posts selected), or the Shares.csv inside it.",
		"Importing replaces any history imported before. After the upload, search_my_posts and list_my_posts include those posts.",
	].join("\n");
}

export async function createPdfUploadLink(ctx: ToolContext): Promise<string> {
	if (!ctx.kv || !ctx.origin) throw new Error("Upload links aren't available on this deployment.");
	const token = await createPdfUploadTicket(ctx.kv, ctx.props.memberId);
	return [
		`PDF upload link (works once, expires in 15 minutes): ${ctx.origin}/upload/${token}`,
		"",
		"Give the user this link. They open it in their browser and choose the carousel PDF (up to 20 MB). The page shows an upload_id when it's done.",
		"Then call draft_post with document: { upload_id, title }. Uploaded PDFs are kept for 60 days, or until the post using them is published or cancelled.",
	].join("\n");
}

export async function createImageUploadLink(ctx: ToolContext): Promise<string> {
	if (!ctx.kv || !ctx.origin) throw new Error("Upload links aren't available on this deployment.");
	const token = await createImageUploadTicket(ctx.kv, ctx.props.memberId);
	return [
		`Image upload link (expires in 15 minutes, up to ${MAX_IMAGES_PER_LINK} images): ${ctx.origin}/upload-image/${token}`,
		"",
		"Give the user this link. They open it in their browser and choose one or more images (JPEG, PNG or GIF, up to 8 MB each). The page shows one upload_id per image, in the order chosen.",
		"Then call draft_post with image: { upload_id, alt_text } for one image, or images: [{ upload_id, alt_text }, …] for 2–20. Uploaded images are kept for 60 days, or until the post using them is published or scheduled.",
	].join("\n");
}

/** Checks an uploaded image's size and file signature, and returns its media type. */
export function checkImage(bytes: ArrayBuffer): string {
	if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("The image is larger than 8 MB.");
	const b = new Uint8Array(bytes.slice(0, 4));
	if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
	if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
	if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
	throw new Error("That file isn't a JPEG, PNG or GIF.");
}

// ---------- Scheduling ----------

/** Parses an ISO 8601 date-time that carries an explicit offset (Z or ±hh:mm). */
export function parsePublishAt(value: string): Date {
	const trimmed = value.trim();
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i.test(trimmed)) {
		throw new Error(`publish_at must be an ISO 8601 date-time with a UTC offset, e.g. 2026-11-17T08:30:00-05:00. Got "${value}".`);
	}
	const date = new Date(trimmed);
	if (Number.isNaN(date.getTime())) throw new Error(`"${value}" isn't a real date and time.`);
	return date;
}

const formatWhen = (iso: string) => `${iso.replace("T", " ").slice(0, 16)} UTC`;

export async function schedulePost(ctx: ToolContext, input: In<"schedule_post">): Promise<string> {
	assertTokenValid(ctx);
	if (!ctx.secret) throw new Error("Scheduling isn't available on this deployment (COOKIE_ENCRYPTION_KEY is missing).");
	const draft = await ctx.store.getDraft(input.draft_id);
	if (!draft) throw new Error("That draft wasn't found. It may have expired (drafts last 24 hours) or already been published or scheduled. Create a new draft.");

	const now = (ctx.now ?? (() => new Date()))().getTime();
	const when = parsePublishAt(input.publish_at);
	if (when.getTime() < now + MIN_SCHEDULE_LEAD_MS) throw new Error("Schedule at least 10 minutes ahead. To post now, use publish_post.");
	if (when.getTime() > now + MAX_SCHEDULE_AHEAD_MS) throw new Error("Posts can be scheduled up to 90 days ahead.");
	if (when.getTime() > ctx.props.expiresAt - TOKEN_EXPIRY_MARGIN_MS) {
		throw new Error(
			`Your LinkedIn sign-in expires on ${dateOnly(ctx.props.expiresAt)}, so posts can only be scheduled until the day before. Reconnect postline (to get a fresh 60-day sign-in), then schedule it.`,
		);
	}

	const id = crypto.randomUUID();
	// Freeze the media now: what the user approved is exactly what gets published.
	let images: ScheduledPost["images"];
	const sources = draft.image ? [draft.image] : draft.images;
	if (sources) {
		images = [];
		try {
			for (const [n, img] of sources.entries()) {
				const { bytes, contentType } = await loadDraftImage(ctx, img);
				await ctx.store.saveMedia(id, n, bytes);
				images.push({ altText: img.altText, contentType });
			}
		} catch (err) {
			// Don't leave half a post's images behind.
			await ctx.store.deleteScheduled({ id, images } as ScheduledPost);
			throw err;
		}
	}
	let document: ScheduledPost["document"];
	if (draft.document) {
		if (draft.document.uploadId) {
			if (!(await ctx.store.getDocumentMeta(draft.document.uploadId))) {
				throw new Error("The uploaded PDF has expired or was already used. Create a new upload link and draft again.");
			}
			document = { docId: draft.document.uploadId, title: draft.document.title };
		} else {
			const bytes = await downloadPdf(draft.document.url!, ctx.fetchImpl);
			document = { docId: await ctx.store.saveDocument(bytes, fileNameFromUrl(draft.document.url!)), title: draft.document.title };
		}
	}

	const post: ScheduledPost = {
		id,
		memberId: ctx.props.memberId,
		publishAt: when.toISOString(),
		status: "scheduled",
		attempts: 0,
		text: draft.text,
		visibility: draft.visibility,
		article: draft.article,
		images,
		document,
		encryptedToken: await encryptToken(ctx.secret, ctx.props.accessToken, `${ctx.props.memberId}:${id}`),
		tokenExpiresAt: ctx.props.expiresAt,
		createdAt: new Date(now).toISOString(),
	};
	await ctx.store.saveScheduled(post);
	await ctx.store.deleteDraft(draft.id);
	// The images are now frozen with the scheduled post, so the uploads aren't needed any more.
	await deleteUploadedImages(ctx, draft);

	return [
		"SCHEDULED — not on LinkedIn yet.",
		`scheduled_id: ${id}`,
		`Publishes at: ${formatWhen(post.publishAt)} (you asked for ${input.publish_at.trim()}); postline checks every 5 minutes.`,
		`Visibility: ${post.visibility === "PUBLIC" ? "Public" : "Connections only"}`,
		describeScheduledAttachment(post),
		"",
		"----- post text -----",
		post.text,
		"---------------------",
		"",
		"Images and PDF are saved as they are now. To change anything, cancel_scheduled_post and draft it again.",
	].join("\n");
}

function describeScheduledAttachment(p: Pick<ScheduledPost, "article" | "images" | "document">): string {
	if (p.article) return `Link card: ${p.article.title} (${p.article.url})`;
	if (p.images) return p.images.length === 1 ? `Image (alt text: "${p.images[0].altText}")` : `Images: ${p.images.length}`;
	if (p.document) return `Carousel (PDF): "${p.document.title}"`;
	return "Attachment: none";
}

export async function listScheduledPosts(ctx: ToolContext): Promise<string> {
	const posts = await ctx.store.listScheduled();
	if (posts.length === 0) return "Nothing is scheduled.";
	const lines = posts.map((p, i) => {
		const status = p.status === "failed" ? `FAILED: ${p.lastError ?? "unknown error"}` : p.status === "publishing" ? "publishing now" : "scheduled";
		return [
			`${i + 1}. ${formatWhen(p.publishAt)} — ${status}`,
			`   scheduled_id: ${p.id}`,
			`   ${describeScheduledAttachment(p)} · ${p.visibility === "PUBLIC" ? "Public" : "Connections only"}`,
			`   ${p.text.replace(/\s+/g, " ").slice(0, 140)}`,
		].join("\n");
	});
	return [`${posts.length} scheduled post(s), soonest first.`, ...lines].join("\n");
}

export async function cancelScheduledPost(ctx: ToolContext, input: In<"cancel_scheduled_post">): Promise<string> {
	const post = await ctx.store.getScheduled(input.scheduled_id);
	if (!post) throw new Error("No scheduled post with that ID. It may already have been published or cancelled; check list_my_posts.");
	if (post.status === "publishing") throw new Error("That post is being published right now. If it goes out, delete it with delete_post.");
	await ctx.store.deleteScheduled(post);
	return `Cancelled the post scheduled for ${formatWhen(post.publishAt)}. Nothing was posted, and its saved images, PDF and token were deleted.`;
}

export interface PublisherDeps {
	kv: KVNamespace;
	secret: string;
	version?: string;
	fetchImpl?: typeof fetch;
	now?: () => Date;
	sleep?: (ms: number) => Promise<void>;
}

/** A claim older than this is treated as abandoned (the run that took it crashed). */
const STALE_CLAIM_MS = 15 * 60_000;

/**
 * Publishes every scheduled post that is due. Run by the Worker's cron trigger.
 * Returns one line per post handled, for logs (never includes tokens or post text).
 */
export async function publishDuePosts(deps: PublisherDeps): Promise<string[]> {
	const now = (deps.now ?? (() => new Date()))();
	const due: Array<{ memberId: string; id: string }> = [];
	let cursor: string | undefined;
	do {
		const page = await deps.kv.list<ScheduleMeta>({ prefix: "sched:", cursor });
		for (const key of page.keys) {
			const meta = key.metadata;
			if (!meta || meta.status === "failed" || meta.publishAt > now.toISOString()) continue;
			const [, memberId, id] = key.name.split(":");
			due.push({ memberId, id });
		}
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);

	const log: string[] = [];
	for (const { memberId, id } of due) {
		const store = new Store(deps.kv, memberId);
		const post = await store.getScheduled(id);
		if (!post) continue;
		if (post.status === "publishing" && post.claimedAt && now.getTime() - Date.parse(post.claimedAt) < STALE_CLAIM_MS) continue;
		post.status = "publishing";
		post.claimedAt = now.toISOString();
		post.attempts += 1;
		await store.saveScheduled(post);
		try {
			if (now.getTime() >= post.tokenExpiresAt) throw new Error("The LinkedIn sign-in expired before this post was due. Reconnect postline and schedule it again.");
			const token = await decryptToken(deps.secret, post.encryptedToken, `${memberId}:${id}`);
			const linkedin = new LinkedInClient(token, deps.version, deps.fetchImpl);
			const owner = `urn:li:person:${memberId}`;
			const content: Partial<CreatePostInput> = {};
			if (post.images) {
				const uploaded = [];
				for (const [n, img] of post.images.entries()) {
					const bytes = await store.getMedia(id, n);
					if (!bytes) throw new Error(`Image ${n + 1} of this post is missing from storage.`);
					uploaded.push({ urn: await linkedin.uploadImage(owner, bytes, img.contentType), altText: img.altText });
				}
				if (uploaded.length === 1) content.image = uploaded[0];
				else content.images = uploaded;
			}
			if (post.document) {
				const doc = await store.getDocument(post.document.docId);
				if (!doc) throw new Error("This post's PDF is missing from storage (uploaded PDFs are kept for 60 days).");
				content.document = { urn: await linkedin.uploadDocument(owner, doc.bytes), title: post.document.title };
			}
			const urn = await createPostWithRetry(
				linkedin,
				{ authorUrn: owner, text: post.text, visibility: post.visibility, article: post.article, ...content },
				deps.sleep,
			);
			await store.savePost({
				urn,
				url: postUrl(urn),
				text: post.text,
				visibility: post.visibility,
				kind: post.article ? "article" : post.document ? "document" : post.images ? (post.images.length > 1 ? "images" : "image") : "text",
				createdAt: now.toISOString(),
			});
			await store.deleteScheduled(post);
			log.push(`published ${id} as ${urn}`);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const transient = !(err instanceof LinkedInError) ? false : err.status === 429 || err.status >= 500;
			post.status = transient && post.attempts < MAX_PUBLISH_ATTEMPTS ? "scheduled" : "failed";
			post.lastError = message;
			post.claimedAt = undefined;
			await store.saveScheduled(post);
			log.push(`${post.status === "failed" ? "failed" : "will retry"} ${id}: ${message}`);
		}
	}
	return log;
}

/** Max characters of post text returned by one search, to keep responses a sensible size. */
const SEARCH_TEXT_BUDGET = 24_000;

export async function searchMyPosts(ctx: ToolContext, input: In<"search_my_posts">): Promise<string> {
	const [history, own] = await Promise.all([ctx.store.getHistory(), ctx.store.listPosts(100)]);
	const ownFull = await Promise.all(own.map((p) => ctx.store.getPost(p.urn)));
	type Item = { date: string; url: string; text: string; title?: string };
	const seen = new Set<string>();
	const all: Item[] = [];
	for (const p of ownFull) {
		if (!p) continue;
		seen.add(p.urn);
		all.push({ date: p.updatedAt ?? p.createdAt, url: p.url, text: p.text });
	}
	for (const p of history?.posts ?? []) {
		if (p.urn && seen.has(p.urn)) continue;
		all.push({
			date: p.date,
			url: p.url || (p.urn ? postUrl(p.urn) : ""),
			text: p.text,
			title: p.kind === "article" ? p.title || "(untitled article)" : undefined,
		});
	}
	if (all.length === 0) {
		return "No posts to search yet. Use create_import_link to import your LinkedIn post history.";
	}
	const words = (input.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
	const matches = all
		.filter((p) => words.every((w) => `${p.title ?? ""} ${p.text}`.toLowerCase().includes(w)))
		.sort((a, b) => b.date.localeCompare(a.date));
	if (matches.length === 0) return `No posts contain: ${words.join(" ")}. Searched ${all.length} posts.`;

	const out: string[] = [];
	let budget = SEARCH_TEXT_BUDGET;
	for (const p of matches.slice(0, input.limit)) {
		const text = p.text.length > budget ? `${p.text.slice(0, Math.max(0, budget))}… [truncated]` : p.text;
		const label = p.title ? `ARTICLE "${p.title}"` : "POST";
		out.push(`--- ${label} · ${p.date.slice(0, 10)} · ${p.url || "no link"}\n${text}`);
		budget -= text.length;
		if (budget <= 0) break;
	}
	return [
		`${matches.length} matching post(s) out of ${all.length}; showing ${out.length}, newest first.`,
		"Use these as examples of the user's own voice, topics and formatting (articles are long-form; posts show feed style). Don't copy them; avoid repeating what they've already written.",
		...out,
	].join("\n\n");
}

export async function deleteImportedHistory(ctx: ToolContext): Promise<string> {
	const history = await ctx.store.getHistory();
	if (!history) return "There's no imported history to delete.";
	await ctx.store.deleteHistory();
	return `Deleted ${history.posts.length} imported posts from postline. Nothing on LinkedIn was changed.`;
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

export async function downloadPdf(url: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<ArrayBuffer> {
	if (!url.startsWith("https://")) throw new Error("Document URLs must start with https://.");
	const res = await fetchImpl(url, { redirect: "follow" });
	if (!res.ok) throw new Error(`Couldn't download the PDF (HTTP ${res.status}).`);
	const declared = Number(res.headers.get("content-length") ?? 0);
	if (declared > MAX_PDF_BYTES) throw new Error("The PDF is larger than 20 MB.");
	const bytes = await res.arrayBuffer();
	return checkPdf(bytes);
}

/** Size and file-signature check shared by downloads and the upload page. */
export function checkPdf(bytes: ArrayBuffer): ArrayBuffer {
	if (bytes.byteLength > MAX_PDF_BYTES) throw new Error("The PDF is larger than 20 MB.");
	const head = new TextDecoder().decode(new Uint8Array(bytes.slice(0, 5)));
	if (head !== "%PDF-") throw new Error("That file isn't a PDF.");
	return bytes;
}

export function fileNameFromUrl(url: string): string {
	try {
		const last = new URL(url).pathname.split("/").filter(Boolean).pop();
		return last ? decodeURIComponent(last).slice(0, 120) : "document.pdf";
	} catch {
		return "document.pdf";
	}
}
