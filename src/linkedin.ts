/**
 * Minimal client for the parts of LinkedIn's official REST API that the self-serve
 * "Share on LinkedIn" (w_member_social) and "Sign In with LinkedIn using OpenID Connect"
 * products allow. Nothing here reads other members' data.
 */

export const LINKEDIN_API = "https://api.linkedin.com";
export const DEFAULT_LINKEDIN_VERSION = "202609";
/** LinkedIn's documented limit for post commentary. */
export const MAX_POST_LENGTH = 3000;
export const MAX_COMMENT_LENGTH = 1250;
/** LinkedIn accepts 2–20 images in one multi-image post. */
export const MIN_MULTI_IMAGES = 2;
export const MAX_MULTI_IMAGES = 20;

export type Visibility = "PUBLIC" | "CONNECTIONS";

/** LinkedIn reaction types, keyed by the label members see in the app. */
export const REACTIONS = {
	like: "LIKE",
	celebrate: "PRAISE",
	support: "APPRECIATION",
	love: "EMPATHY",
	insightful: "INTEREST",
	funny: "ENTERTAINMENT",
} as const;
export type ReactionLabel = keyof typeof REACTIONS;

export interface UserInfo {
	sub: string;
	name: string;
	picture?: string;
}

export interface ArticleInput {
	url: string;
	title: string;
	description?: string;
}

export interface CreatePostInput {
	authorUrn: string;
	text: string;
	visibility: Visibility;
	article?: ArticleInput;
	image?: { urn: string; altText: string };
	/** 2–20 images shown as a grid. */
	images?: Array<{ urn: string; altText: string }>;
	/** A PDF shown as a swipeable carousel (LinkedIn calls it a document post). */
	document?: { urn: string; title: string };
}

export class LinkedInError extends Error {
	constructor(
		readonly status: number,
		readonly body: string,
		message: string,
	) {
		super(message);
		this.name = "LinkedInError";
	}

	/** True when the member needs to sign in again. */
	get isAuthError(): boolean {
		return this.status === 401;
	}
}

/**
 * Escapes LinkedIn "little text" reserved characters so commentary is published exactly
 * as written. Without this, characters like ( ) [ ] _ * are parsed as markup and the
 * post is cut short or rejected. Hashtags (#word) are kept as real, clickable hashtags.
 */
export function toLittleText(text: string): string {
	const reserved = /[\\|{}@\[\]()<>#*_~]/g;
	const parts: string[] = [];
	const hashtag = /(^|[^\p{L}\p{N}_&])#([\p{L}\p{N}_]+)/gu;
	let last = 0;
	for (const m of text.matchAll(hashtag)) {
		const start = m.index! + m[1].length;
		parts.push(text.slice(last, start).replace(reserved, (c) => `\\${c}`));
		parts.push(`{hashtag|\\#|${m[2].replace(reserved, (c) => `\\${c}`)}}`);
		last = start + 1 + m[2].length;
	}
	parts.push(text.slice(last).replace(reserved, (c) => `\\${c}`));
	return parts.join("");
}

/**
 * Accepts a post URN or a LinkedIn post URL and returns the URN.
 * Supported: urn:li:share:…, urn:li:ugcPost:…, urn:li:activity:…, /feed/update/<urn>/,
 * and /posts/<slug>-activity-<id>-… URLs.
 */
export function parsePostRef(ref: string): string {
	const trimmed = ref.trim();
	const decoded = (() => {
		try {
			return decodeURIComponent(trimmed);
		} catch {
			return trimmed;
		}
	})();
	const urn = decoded.match(/urn:li:(share|ugcPost|activity):(\d+)/);
	if (urn) return `urn:li:${urn[1]}:${urn[2]}`;
	const activity = decoded.match(/activity[-:](\d{10,})/);
	if (activity) return `urn:li:activity:${activity[1]}`;
	throw new Error(
		`Couldn't read a LinkedIn post from "${ref}". Paste the post's link (from "Copy link to post") or its urn:li:… ID.`,
	);
}

export function postUrl(urn: string): string {
	return `https://www.linkedin.com/feed/update/${urn}/`;
}

export class LinkedInClient {
	private readonly fetchImpl: typeof fetch;

	constructor(
		private readonly accessToken: string,
		private readonly version: string = DEFAULT_LINKEDIN_VERSION,
		fetchImpl?: typeof fetch,
	) {
		this.fetchImpl = fetchImpl ?? ((...args) => fetch(...args));
	}

	/** Headers for the unversioned /v2 API (no LinkedIn-Version header). */
	private v2Headers(): Record<string, string> {
		return {
			Authorization: `Bearer ${this.accessToken}`,
			"X-Restli-Protocol-Version": "2.0.0",
			"Content-Type": "application/json",
		};
	}

	private headers(extra: Record<string, string> = {}): Record<string, string> {
		return {
			Authorization: `Bearer ${this.accessToken}`,
			"LinkedIn-Version": this.version,
			"X-Restli-Protocol-Version": "2.0.0",
			"Content-Type": "application/json",
			...extra,
		};
	}

	private async request(path: string, init: RequestInit, action: string): Promise<Response> {
		const res = await this.fetchImpl(`${LINKEDIN_API}${path}`, init);
		if (!res.ok) {
			const body = await res.text();
			throw new LinkedInError(res.status, body, describeFailure(action, res.status, body));
		}
		return res;
	}

	async getUserInfo(): Promise<UserInfo> {
		const res = await this.request(
			"/v2/userinfo",
			{ headers: { Authorization: `Bearer ${this.accessToken}` } },
			"read your profile",
		);
		const data = (await res.json()) as UserInfo;
		return { sub: data.sub, name: data.name, picture: data.picture };
	}

	/** Creates a post and returns its URN. */
	async createPost(input: CreatePostInput): Promise<string> {
		const body: Record<string, unknown> = {
			author: input.authorUrn,
			commentary: toLittleText(input.text),
			visibility: input.visibility,
			distribution: {
				feedDistribution: "MAIN_FEED",
				targetEntities: [],
				thirdPartyDistributionChannels: [],
			},
			lifecycleState: "PUBLISHED",
			isReshareDisabledByAuthor: false,
		};
		if (input.article) {
			body.content = {
				article: {
					source: input.article.url,
					title: input.article.title,
					...(input.article.description ? { description: input.article.description } : {}),
				},
			};
		} else if (input.image) {
			body.content = { media: { id: input.image.urn, altText: input.image.altText } };
		} else if (input.images) {
			body.content = { multiImage: { images: input.images.map((i) => ({ id: i.urn, altText: i.altText })) } };
		} else if (input.document) {
			body.content = { media: { id: input.document.urn, title: input.document.title } };
		}
		const res = await this.request(
			"/rest/posts",
			{ method: "POST", headers: this.headers(), body: JSON.stringify(body) },
			"publish the post",
		);
		const urn = res.headers.get("x-restli-id");
		if (!urn) throw new LinkedInError(res.status, "", "LinkedIn accepted the post but returned no post ID.");
		return urn;
	}

	/** Replaces a post's text in place. Likes, comments and the link are kept. */
	async updatePostText(urn: string, text: string): Promise<void> {
		await this.request(
			`/rest/posts/${encodeURIComponent(urn)}`,
			{
				method: "POST",
				headers: this.headers({ "X-RestLi-Method": "PARTIAL_UPDATE" }),
				body: JSON.stringify({ patch: { $set: { commentary: toLittleText(text) } } }),
			},
			"edit the post",
		);
	}

	async deletePost(urn: string): Promise<void> {
		await this.request(
			`/rest/posts/${encodeURIComponent(urn)}`,
			{ method: "DELETE", headers: this.headers({ "X-RestLi-Method": "DELETE" }) },
			"delete the post",
		);
	}

	/** Uploads image bytes and returns the image URN to attach to a post. */
	async uploadImage(ownerUrn: string, bytes: ArrayBuffer, contentType: string): Promise<string> {
		return this.upload("images", "image", ownerUrn, bytes, contentType);
	}

	/**
	 * Uploads a PDF and returns the document URN to attach to a post. LinkedIn renders each
	 * page as a slide. Works with the self-serve w_member_social permission on a member's
	 * own profile (posting a document as a Company Page needs partner access).
	 */
	async uploadDocument(ownerUrn: string, bytes: ArrayBuffer): Promise<string> {
		return this.upload("documents", "document", ownerUrn, bytes, "application/pdf");
	}

	/** initializeUpload, then PUT the bytes to the URL LinkedIn returns. */
	private async upload(
		resource: "images" | "documents",
		field: "image" | "document",
		ownerUrn: string,
		bytes: ArrayBuffer,
		contentType: string,
	): Promise<string> {
		const init = await this.request(
			`/rest/${resource}?action=initializeUpload`,
			{
				method: "POST",
				headers: this.headers(),
				body: JSON.stringify({ initializeUploadRequest: { owner: ownerUrn } }),
			},
			`start the ${field} upload`,
		);
		const { value } = (await init.json()) as { value: { uploadUrl: string } & Record<string, string> };
		const urn = value[field];
		if (!value.uploadUrl || !urn) throw new LinkedInError(init.status, "", `LinkedIn didn't return an upload address for the ${field}.`);
		const put = await this.fetchImpl(value.uploadUrl, {
			method: "PUT",
			headers: { Authorization: `Bearer ${this.accessToken}`, "Content-Type": contentType },
			body: bytes,
		});
		if (!put.ok) {
			const body = await put.text();
			throw new LinkedInError(put.status, body, describeFailure(`upload the ${field}`, put.status, body));
		}
		return urn;
	}

	/**
	 * Comments on a post as the member. Returns the comment URN when LinkedIn provides one.
	 * Uses the unversioned /v2 endpoint: on the versioned /rest endpoint LinkedIn treats
	 * comments as a partner API (Community Management) and refuses self-serve apps.
	 */
	async comment(postUrn: string, actorUrn: string, text: string): Promise<string | undefined> {
		const res = await this.request(
			`/v2/socialActions/${encodeURIComponent(postUrn)}/comments`,
			{
				method: "POST",
				headers: this.v2Headers(),
				body: JSON.stringify({ actor: actorUrn, object: postUrn, message: { text } }),
			},
			"comment on the post",
		);
		return res.headers.get("x-restli-id") ?? undefined;
	}

	/** Reacts as the member. Uses /v2 for the same reason as comment(). */
	async react(postUrn: string, actorUrn: string, reaction: ReactionLabel): Promise<void> {
		await this.request(
			`/v2/reactions?actor=${encodeURIComponent(actorUrn)}`,
			{
				method: "POST",
				headers: this.v2Headers(),
				body: JSON.stringify({ root: postUrn, reactionType: REACTIONS[reaction] }),
			},
			"react to the post",
		);
	}
}

function describeFailure(action: string, status: number, body: string): string {
	const detail = (() => {
		try {
			const parsed = JSON.parse(body) as { message?: string };
			return parsed.message ? ` LinkedIn said: ${parsed.message}` : "";
		} catch {
			return "";
		}
	})();
	switch (status) {
		case 401:
			return `Couldn't ${action}: your LinkedIn sign-in has expired or was revoked. Reconnect postline in Claude's connector settings.`;
		case 403:
			return `Couldn't ${action}: LinkedIn refused permission. This usually means the post isn't yours, or the action needs access LinkedIn doesn't grant to self-serve apps.${detail}`;
		case 404:
			return `Couldn't ${action}: LinkedIn couldn't find that post. It may have been deleted.${detail}`;
		case 422:
			return `Couldn't ${action}: LinkedIn rejected the content.${detail}`;
		case 426:
			return `Couldn't ${action}: this LinkedIn API version has been retired. Update LINKEDIN_VERSION.${detail}`;
		case 429:
			return `Couldn't ${action}: LinkedIn's daily limit was reached. It resets at midnight UTC.`;
		default:
			return `Couldn't ${action}: LinkedIn returned HTTP ${status}.${detail}`;
	}
}
