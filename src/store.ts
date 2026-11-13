/**
 * Per-member storage in Cloudflare KV. Every key starts with the member's LinkedIn ID,
 * so one deployment can safely serve more than one person later.
 *
 *   post:<memberId>:<postUrn>   -> PostRecord  (posts made or edited through postline)
 *   draft:<memberId>:<draftId>  -> Draft       (expires after 24 hours)
 */

import type { ArticleInput, Visibility } from "./linkedin";

export const DRAFT_TTL_SECONDS = 24 * 60 * 60;

export interface Draft {
	id: string;
	text: string;
	visibility: Visibility;
	article?: ArticleInput;
	image?: { url: string; altText: string };
	createdAt: string;
}

export interface PostRecord {
	urn: string;
	url: string;
	text: string;
	visibility: Visibility;
	kind: "text" | "article" | "image";
	createdAt: string;
	updatedAt?: string;
}

/** Small summary kept in KV list metadata so listing needs a single call. */
interface PostMeta {
	createdAt: string;
	preview: string;
}

const postKey = (memberId: string, urn: string) => `post:${memberId}:${urn}`;
const draftKey = (memberId: string, id: string) => `draft:${memberId}:${id}`;

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
}
