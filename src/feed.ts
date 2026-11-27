/**
 * The public website feed: a small JSON summary of the owner's PUBLIC LinkedIn activity,
 * for showing on their own website (articles and latest posts).
 *
 * It is off unless the Worker has a PUBLIC_FEED_MEMBER_ID secret, and it only ever covers
 * that one member. It holds nothing that isn't already public on LinkedIn:
 *   - posts made through postline with PUBLIC visibility (never connections-only posts),
 *   - LinkedIn articles: ones the owner added with add_website_article, ones a postline
 *     post linked to, and ones in the imported history.
 *
 * The feed is built when something changes and stored as one KV value, so serving it
 * costs one KV read and no list calls (the free plan allows 1,000 lists a day and the
 * scheduled-post cron already uses 288).
 */

import type { ImportedPost } from "./importer";
import type { PostRecord } from "./store";

export const FEED_ARTICLE_LIMIT = 6;
export const FEED_POST_LIMIT = 3;
const EXCERPT_CHARS = 220;
export const DEFAULT_ARTICLE_LABEL = "ARTICLE";

/** An article the owner added by hand (LinkedIn's API can't publish or read articles). */
export interface WebsiteArticle {
	url: string;
	title: string;
	summary: string;
	/** YYYY-MM-DD */
	date: string;
	/** Short topic label shown on the card, e.g. "AI GOVERNANCE". */
	label?: string;
}

export interface WebsiteArticles {
	articles: WebsiteArticle[];
	/** Article URLs the owner removed; they stay off the feed even if a post or the history links them. */
	hidden: string[];
}

export interface FeedArticle {
	url: string;
	title: string;
	summary: string;
	date: string;
	label: string;
}

export interface FeedPost {
	url: string;
	date: string;
	excerpt: string;
	kind: PostRecord["kind"];
}

export interface Feed {
	updatedAt: string;
	articles: FeedArticle[];
	posts: FeedPost[];
}

const PULSE = /^https:\/\/(www\.)?linkedin\.com\/pulse\/[^\s?#]+/i;

export const isPulseUrl = (url: string) => PULSE.test(url);

/** Same article, whatever the query string, trailing slash or www. */
export function articleKey(url: string): string {
	try {
		const u = new URL(url);
		return `linkedin.com${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
	} catch {
		return url.toLowerCase();
	}
}

/** First ~220 characters of a post, cut at a word, without trailing hashtag lines. */
export function excerpt(text: string, max = EXCERPT_CHARS): string {
	const lines = text.trim().split("\n");
	while (lines.length > 1 && /^(\s*#\S+\s*)+$/.test(lines[lines.length - 1])) lines.pop();
	const flat = lines.join(" ").replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	const cut = flat.slice(0, max);
	const space = cut.lastIndexOf(" ");
	return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, "")}…`;
}

export function buildFeed(input: {
	records: PostRecord[];
	history: ImportedPost[];
	site: WebsiteArticles;
	now: Date;
}): Feed {
	const hidden = new Set(input.site.hidden.map(articleKey));
	const byKey = new Map<string, FeedArticle>();
	const add = (a: FeedArticle) => {
		const key = articleKey(a.url);
		if (!hidden.has(key) && !byKey.has(key)) byKey.set(key, a);
	};

	// Hand-added articles win: the owner wrote their title, summary and label.
	for (const a of input.site.articles) add({ ...a, label: a.label || DEFAULT_ARTICLE_LABEL });

	const publicPosts = input.records
		.filter((r) => r.visibility === "PUBLIC" && !r.unverified)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

	for (const r of publicPosts) {
		if (r.article && isPulseUrl(r.article.url)) {
			add({
				url: r.article.url,
				title: r.article.title,
				summary: r.article.description?.trim() || excerpt(r.text),
				date: r.createdAt.slice(0, 10),
				label: DEFAULT_ARTICLE_LABEL,
			});
		}
	}
	for (const p of input.history) {
		if (p.kind === "article" && p.url && isPulseUrl(p.url) && p.title) {
			add({ url: p.url, title: p.title, summary: excerpt(p.text), date: p.date.slice(0, 10), label: DEFAULT_ARTICLE_LABEL });
		}
	}

	const articles = [...byKey.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, FEED_ARTICLE_LIMIT);
	const posts = publicPosts.slice(0, FEED_POST_LIMIT).map((r) => ({
		url: r.url,
		date: r.createdAt.slice(0, 10),
		excerpt: excerpt(r.text),
		kind: r.kind,
	}));
	return { updatedAt: input.now.toISOString(), articles, posts };
}
