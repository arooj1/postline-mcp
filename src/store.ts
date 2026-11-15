/**
 * Per-member storage in Cloudflare KV. Every key starts with the member's LinkedIn ID,
 * so one deployment can safely serve more than one person later.
 *
 *   post:<memberId>:<postUrn>   -> PostRecord  (posts made or edited through postline)
 *   draft:<memberId>:<draftId>  -> Draft       (expires after 24 hours)
 *   history:<memberId>          -> PostHistory (imported from LinkedIn's data export; one value,
 *                                               so an import costs one KV write on the free plan)
 *   import:<token>              -> ImportTicket (one-time upload link, expires after 15 minutes)
 *   pdfupload:<token>           -> ImportTicket (one-time PDF upload link, expires after 15 minutes)
 *   doc:<memberId>:<docId>      -> PDF bytes    (uploaded carousel; metadata = DocumentMeta; expires after 60 days)
 *   imgupload:<token>           -> ImageUploadTicket (one-time image upload link, up to 20 images, expires after 15 minutes)
 *   upimg:<memberId>:<id>       -> image bytes  (uploaded image; metadata = UploadedImageMeta; expires after 60 days)
 *   sched:<memberId>:<id>       -> ScheduledPost (metadata = ScheduleMeta, so the publisher lists due posts in one call)
 *   media:<memberId>:<id>:<n>   -> image bytes  (images of a scheduled post, frozen when it was scheduled)
 */

import type { ImportedPost } from "./importer";
import type { ArticleInput, Visibility } from "./linkedin";

export const IMPORT_TTL_SECONDS = 15 * 60;

export interface PostHistory {
	importedAt: string;
	posts: ImportedPost[];
}

export interface ImportTicket {
	memberId: string;
	createdAt: string;
}

/** Creates a one-time upload link token for a member. */
export async function createImportTicket(kv: KVNamespace, memberId: string): Promise<string> {
	const token = randomToken();
	const ticket: ImportTicket = { memberId, createdAt: new Date().toISOString() };
	await kv.put(`import:${token}`, JSON.stringify(ticket), { expirationTtl: IMPORT_TTL_SECONDS });
	return token;
}

export async function readImportTicket(kv: KVNamespace, token: string): Promise<ImportTicket | null> {
	if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
	return kv.get<ImportTicket>(`import:${token}`, "json");
}

export async function consumeImportTicket(kv: KVNamespace, token: string): Promise<void> {
	await kv.delete(`import:${token}`);
}

/** One-time link for uploading a carousel PDF. Same shape and lifetime as an import link. */
export async function createPdfUploadTicket(kv: KVNamespace, memberId: string): Promise<string> {
	const token = randomToken();
	const ticket: ImportTicket = { memberId, createdAt: new Date().toISOString() };
	await kv.put(`pdfupload:${token}`, JSON.stringify(ticket), { expirationTtl: IMPORT_TTL_SECONDS });
	return token;
}

export async function readPdfUploadTicket(kv: KVNamespace, token: string): Promise<ImportTicket | null> {
	if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
	return kv.get<ImportTicket>(`pdfupload:${token}`, "json");
}

export async function consumePdfUploadTicket(kv: KVNamespace, token: string): Promise<void> {
	await kv.delete(`pdfupload:${token}`);
}

/** Most images one image upload link accepts (LinkedIn's limit for one post). */
export const MAX_IMAGES_PER_LINK = 20;

export interface ImageUploadTicket extends ImportTicket {
	/** Images uploaded through this link so far. */
	count: number;
}

/** One link for uploading 1–20 images for a post. Each image is its own request, so the link counts them. */
export async function createImageUploadTicket(kv: KVNamespace, memberId: string): Promise<string> {
	const token = randomToken();
	const ticket: ImageUploadTicket = { memberId, createdAt: new Date().toISOString(), count: 0 };
	await kv.put(`imgupload:${token}`, JSON.stringify(ticket), { expirationTtl: IMPORT_TTL_SECONDS });
	return token;
}

export async function readImageUploadTicket(kv: KVNamespace, token: string): Promise<ImageUploadTicket | null> {
	if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
	return kv.get<ImageUploadTicket>(`imgupload:${token}`, "json");
}

/** Counts one upload; the link is used up after MAX_IMAGES_PER_LINK. It keeps its original expiry. */
export async function recordImageUpload(kv: KVNamespace, token: string, ticket: ImageUploadTicket): Promise<void> {
	const count = ticket.count + 1;
	const secondsLeft = Math.floor((Date.parse(ticket.createdAt) + IMPORT_TTL_SECONDS * 1000 - Date.now()) / 1000);
	if (count >= MAX_IMAGES_PER_LINK || secondsLeft <= 0) {
		await kv.delete(`imgupload:${token}`);
		return;
	}
	// KV's shortest expiry is 60 seconds.
	await kv.put(`imgupload:${token}`, JSON.stringify({ ...ticket, count }), { expirationTtl: Math.max(60, secondsLeft) });
}

function randomToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(24));
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const DRAFT_TTL_SECONDS = 24 * 60 * 60;

export interface Draft {
	id: string;
	text: string;
	visibility: Visibility;
	article?: ArticleInput;
	image?: ImageSource;
	/** 2–20 images, each uploaded through an image upload link or from a public https URL. */
	images?: ImageSource[];
	/** A carousel PDF: one uploaded through a PDF upload link, or a public https URL. */
	document?: DocumentSource;
	createdAt: string;
}

export type DocumentSource = { title: string } & ({ uploadId: string; url?: undefined } | { url: string; uploadId?: undefined });

export type ImageSource = { altText: string } & ({ uploadId: string; url?: undefined } | { url: string; uploadId?: undefined });

export type PostKind = "text" | "article" | "image" | "images" | "document";

export interface PostRecord {
	urn: string;
	url: string;
	text: string;
	visibility: Visibility;
	kind: PostKind;
	createdAt: string;
	updatedAt?: string;
}

/** Small summary kept in KV list metadata so listing needs a single call. */
interface PostMeta {
	createdAt: string;
	preview: string;
}

export const DOCUMENT_TTL_SECONDS = 60 * 24 * 60 * 60;

export interface DocumentMeta {
	fileName: string;
	size: number;
	createdAt: string;
}

export interface UploadedImageMeta {
	fileName: string;
	size: number;
	contentType: string;
	createdAt: string;
}

export type ScheduleStatus = "scheduled" | "publishing" | "failed";

/** A post the member approved for publishing at a set time. */
export interface ScheduledPost {
	id: string;
	memberId: string;
	publishAt: string;
	status: ScheduleStatus;
	/** Set while the publisher is working on it, so two runs never publish it twice. */
	claimedAt?: string;
	attempts: number;
	lastError?: string;
	text: string;
	visibility: Visibility;
	article?: ArticleInput;
	/** Images frozen at scheduling time; bytes live under media:<memberId>:<id>:<n>. */
	images?: Array<{ altText: string; contentType: string }>;
	/** Uploaded PDF (doc:<memberId>:<docId>) frozen at scheduling time. */
	document?: { docId: string; title: string };
	/** The LinkedIn token, encrypted with a key derived from COOKIE_ENCRYPTION_KEY. Deleted with the record. */
	encryptedToken: string;
	tokenExpiresAt: number;
	createdAt: string;
}

/** Kept in KV list metadata so the publisher finds due posts with one list call. */
export interface ScheduleMeta {
	publishAt: string;
	status: ScheduleStatus;
}

const postKey = (memberId: string, urn: string) => `post:${memberId}:${urn}`;
const draftKey = (memberId: string, id: string) => `draft:${memberId}:${id}`;
const docKey = (memberId: string, id: string) => `doc:${memberId}:${id}`;
const upimgKey = (memberId: string, id: string) => `upimg:${memberId}:${id}`;
export const schedKey = (memberId: string, id: string) => `sched:${memberId}:${id}`;
const mediaKey = (memberId: string, id: string, n: number) => `media:${memberId}:${id}:${n}`;

export class Store {
	constructor(
		private readonly kv: KVNamespace,
		private readonly memberId: string,
	) {
		if (!memberId) throw new Error("Store needs a member ID.");
	}

	async saveDraft(draft: Omit<Draft, "id" | "createdAt">): Promise<Draft> {
		const full: Draft = { ...draft, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
		await this.kv.put(draftKey(this.memberId, full.id), JSON.stringify(full), {
			expirationTtl: DRAFT_TTL_SECONDS,
		});
		return full;
	}

	async getDraft(id: string): Promise<Draft | null> {
		return this.kv.get<Draft>(draftKey(this.memberId, id), "json");
	}

	async deleteDraft(id: string): Promise<void> {
		await this.kv.delete(draftKey(this.memberId, id));
	}

	async savePost(record: PostRecord): Promise<void> {
		const meta: PostMeta = { createdAt: record.createdAt, preview: record.text.slice(0, 200) };
		await this.kv.put(postKey(this.memberId, record.urn), JSON.stringify(record), { metadata: meta });
	}

	async getPost(urn: string): Promise<PostRecord | null> {
		return this.kv.get<PostRecord>(postKey(this.memberId, urn), "json");
	}

	async deletePost(urn: string): Promise<void> {
		await this.kv.delete(postKey(this.memberId, urn));
	}

	async saveHistory(posts: ImportedPost[]): Promise<void> {
		const history: PostHistory = { importedAt: new Date().toISOString(), posts };
		await this.kv.put(`history:${this.memberId}`, JSON.stringify(history));
	}

	async getHistory(): Promise<PostHistory | null> {
		return this.kv.get<PostHistory>(`history:${this.memberId}`, "json");
	}

	async deleteHistory(): Promise<void> {
		await this.kv.delete(`history:${this.memberId}`);
	}

	/** Newest first. */
	async listPosts(limit: number): Promise<Array<{ urn: string; createdAt: string; preview: string }>> {
		const prefix = `post:${this.memberId}:`;
		const items: Array<{ urn: string; createdAt: string; preview: string }> = [];
		let cursor: string | undefined;
		do {
			const page = await this.kv.list<PostMeta>({ prefix, cursor });
			for (const key of page.keys) {
				items.push({
					urn: key.name.slice(prefix.length),
					createdAt: key.metadata?.createdAt ?? "",
					preview: key.metadata?.preview ?? "",
				});
			}
			cursor = page.list_complete ? undefined : page.cursor;
		} while (cursor);
		items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		return items.slice(0, limit);
	}

	// ---------- Uploaded carousel PDFs ----------

	async saveDocument(bytes: ArrayBuffer, fileName: string): Promise<string> {
		const id = crypto.randomUUID();
		const meta: DocumentMeta = { fileName, size: bytes.byteLength, createdAt: new Date().toISOString() };
		await this.kv.put(docKey(this.memberId, id), bytes, { metadata: meta, expirationTtl: DOCUMENT_TTL_SECONDS });
		return id;
	}

	async getDocument(id: string): Promise<{ bytes: ArrayBuffer; meta: DocumentMeta } | null> {
		const { value, metadata } = await this.kv.getWithMetadata<DocumentMeta>(docKey(this.memberId, id), "arrayBuffer");
		return value && metadata ? { bytes: value, meta: metadata } : null;
	}

	async getDocumentMeta(id: string): Promise<DocumentMeta | null> {
		const { metadata } = await this.kv.getWithMetadata<DocumentMeta>(docKey(this.memberId, id), "arrayBuffer");
		return metadata ?? null;
	}

	async deleteDocument(id: string): Promise<void> {
		await this.kv.delete(docKey(this.memberId, id));
	}

	// ---------- Uploaded images ----------

	async saveUploadedImage(bytes: ArrayBuffer, fileName: string, contentType: string): Promise<string> {
		const id = crypto.randomUUID();
		const meta: UploadedImageMeta = { fileName, size: bytes.byteLength, contentType, createdAt: new Date().toISOString() };
		await this.kv.put(upimgKey(this.memberId, id), bytes, { metadata: meta, expirationTtl: DOCUMENT_TTL_SECONDS });
		return id;
	}

	async getUploadedImage(id: string): Promise<{ bytes: ArrayBuffer; meta: UploadedImageMeta } | null> {
		const { value, metadata } = await this.kv.getWithMetadata<UploadedImageMeta>(upimgKey(this.memberId, id), "arrayBuffer");
		return value && metadata ? { bytes: value, meta: metadata } : null;
	}

	async getUploadedImageMeta(id: string): Promise<UploadedImageMeta | null> {
		const { metadata } = await this.kv.getWithMetadata<UploadedImageMeta>(upimgKey(this.memberId, id), "arrayBuffer");
		return metadata ?? null;
	}

	async deleteUploadedImage(id: string): Promise<void> {
		await this.kv.delete(upimgKey(this.memberId, id));
	}

	// ---------- Scheduled posts ----------

	async saveScheduled(post: ScheduledPost): Promise<void> {
		const meta: ScheduleMeta = { publishAt: post.publishAt, status: post.status };
		await this.kv.put(schedKey(this.memberId, post.id), JSON.stringify(post), { metadata: meta });
	}

	async getScheduled(id: string): Promise<ScheduledPost | null> {
		return this.kv.get<ScheduledPost>(schedKey(this.memberId, id), "json");
	}

	async listScheduled(): Promise<ScheduledPost[]> {
		const prefix = `sched:${this.memberId}:`;
		const ids: string[] = [];
		let cursor: string | undefined;
		do {
			const page = await this.kv.list({ prefix, cursor });
			for (const key of page.keys) ids.push(key.name.slice(prefix.length));
			cursor = page.list_complete ? undefined : page.cursor;
		} while (cursor);
		const posts = await Promise.all(ids.map((id) => this.getScheduled(id)));
		return posts.filter((p): p is ScheduledPost => p !== null).sort((a, b) => a.publishAt.localeCompare(b.publishAt));
	}

	async saveMedia(id: string, n: number, bytes: ArrayBuffer): Promise<void> {
		await this.kv.put(mediaKey(this.memberId, id, n), bytes);
	}

	async getMedia(id: string, n: number): Promise<ArrayBuffer | null> {
		return this.kv.get(mediaKey(this.memberId, id, n), "arrayBuffer");
	}

	/** Removes a scheduled post with its frozen images and PDF. */
	async deleteScheduled(post: ScheduledPost): Promise<void> {
		await Promise.all([
			this.kv.delete(schedKey(this.memberId, post.id)),
			...(post.images ?? []).map((_, n) => this.kv.delete(mediaKey(this.memberId, post.id, n))),
			...(post.document ? [this.deleteDocument(post.document.docId)] : []),
		]);
	}
}
