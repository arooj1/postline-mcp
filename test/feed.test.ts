import { describe, expect, it } from "vitest";
import { articleKey, buildFeed, excerpt } from "../src/feed";
import { LinkedInClient } from "../src/linkedin";
import { LinkedInHandler as app } from "../src/linkedin-handler";
import { readFeed, Store, type PostRecord } from "../src/store";
import { addWebsiteArticle, draftPost, editPost, publishPost, removeWebsiteArticle, schemas, type ToolContext } from "../src/tools";
import { memoryKV, mockFetch } from "./helpers";

const NOW = new Date("2026-11-26T18:00:00Z");
const PULSE = "https://www.linkedin.com/pulse/your-website-drives-both-sides-road-arooj-ahmed-qureshi-bv67c/";

function setup(feedFor: string | null = "abc") {
	const kv = memoryKV();
	let n = 0;
	const m = mockFetch([
		(c) => (c.url.endsWith("/rest/posts") && c.method === "POST" ? new Response("{}", { status: 201, headers: { "x-restli-id": `urn:li:share:${++n}` } }) : undefined),
		(c) => (c.url.includes("/rest/posts/") ? new Response(null, { status: 204 }) : undefined),
	]);
	const ctx: ToolContext = {
		props: { memberId: "abc", name: "Arooj", accessToken: "tok", expiresAt: NOW.getTime() + 30 * 86400_000 },
		store: new Store(kv, "abc", { publicFeedMemberId: feedFor ?? undefined }),
		linkedin: new LinkedInClient("tok", "202609", m.fetch),
		fetchImpl: m.fetch,
		now: () => NOW,
	};
	return { ctx, kv };
}

async function post(ctx: ToolContext, input: Record<string, unknown>) {
	const out = await draftPost(ctx, schemas.draft_post.parse(input));
	return publishPost(ctx, { draft_id: out.match(/draft_id: ([0-9a-f-]{36})/)![1] });
}

const record = (over: Partial<PostRecord>): PostRecord => ({
	urn: "urn:li:share:1",
	url: "https://www.linkedin.com/feed/update/urn:li:share:1/",
	text: "Hello",
	visibility: "PUBLIC",
	kind: "text",
	createdAt: "2026-11-20T10:00:00Z",
	...over,
});

describe("buildFeed", () => {
	it("keeps connections-only and unverified posts off the feed", () => {
		const feed = buildFeed({
			records: [
				record({ urn: "a", text: "public" }),
				record({ urn: "b", text: "connections", visibility: "CONNECTIONS" }),
				record({ urn: "c", text: "edited elsewhere", unverified: true }),
			],
			history: [],
			site: { articles: [], hidden: [] },
			now: NOW,
		});
		expect(feed.posts.map((p) => p.excerpt)).toEqual(["public"]);
	});

	it("turns posts that link a LinkedIn article into article cards, but not other links", () => {
		const feed = buildFeed({
			records: [
				record({ urn: "a", kind: "article", article: { url: PULSE, title: "Road", description: "Card text" } }),
				record({ urn: "b", kind: "article", article: { url: "https://example.com/x", title: "Elsewhere" } }),
			],
			history: [],
			site: { articles: [], hidden: [] },
			now: NOW,
		});
		expect(feed.articles).toEqual([{ url: PULSE, title: "Road", summary: "Card text", date: "2026-11-20", label: "ARTICLE" }]);
	});

	it("prefers hand-added articles, de-duplicates by link, hides removed ones, newest first", () => {
		const feed = buildFeed({
			records: [record({ kind: "article", article: { url: `${PULSE}?trk=x`, title: "From post" } })],
			history: [
				{ kind: "article", title: "Old one", url: "https://www.linkedin.com/pulse/old-abc", date: "2025-04-23T00:00:00Z", text: "Old" },
				{ kind: "article", title: "Hidden", url: "https://www.linkedin.com/pulse/hidden-abc", date: "2026-11-25T00:00:00Z", text: "x" },
			],
			site: {
				articles: [{ url: PULSE, title: "Hand", summary: "Mine", date: "2026-11-23", label: "AI GOVERNANCE" }],
				hidden: ["https://linkedin.com/pulse/hidden-abc/"],
			},
			now: NOW,
		});
		expect(feed.articles.map((a) => [a.title, a.label])).toEqual([
			["Hand", "AI GOVERNANCE"],
			["Old one", "ARTICLE"],
		]);
	});

	it("caps posts at three, newest first", () => {
		const records = ["01", "05", "03", "04", "02"].map((d) => record({ urn: d, text: d, createdAt: `2026-11-${d}T00:00:00Z` }));
		const feed = buildFeed({ records, history: [], site: { articles: [], hidden: [] }, now: NOW });
		expect(feed.posts.map((p) => p.excerpt)).toEqual(["05", "04", "03"]);
	});
});

describe("excerpt and articleKey", () => {
	it("drops trailing hashtag lines and cuts long text at a word", () => {
		expect(excerpt("What would yours find?\n\n#AIGovernance #Privacy")).toBe("What would yours find?");
		const long = excerpt("word ".repeat(100));
		expect(long.length).toBeLessThanOrEqual(221);
		expect(long.endsWith("word…")).toBe(true);
	});

	it("treats www, query strings and trailing slashes as the same article", () => {
		expect(articleKey(`${PULSE}?trk=1`)).toBe(articleKey("https://linkedin.com/pulse/your-website-drives-both-sides-road-arooj-ahmed-qureshi-bv67c"));
	});
});

describe("feed kept up to date by the tools", () => {
	it("publishing, editing and deleting refresh the stored feed", async () => {
		const { ctx, kv } = setup();
		await post(ctx, { text: "First public post #AI" });
		await post(ctx, { text: "Just for connections", visibility: "CONNECTIONS" });
		await post(ctx, { text: "New article!", link: { url: PULSE, title: "Your website drives on both sides of the road" } });
		let feed = await readFeed(kv, "abc");
		expect(feed!.posts.map((p) => p.excerpt).sort()).toEqual(["First public post #AI", "New article!"]);
		expect(feed!.posts.some((p) => p.excerpt.includes("connections"))).toBe(false);
		expect(feed!.articles[0].title).toBe("Your website drives on both sides of the road");

		await editPost(ctx, { post: "urn:li:share:1", new_text: "Edited text" });
		feed = await readFeed(kv, "abc");
		expect(feed!.posts.map((p) => p.excerpt)).toContain("Edited text");
	});

	it("add_website_article and remove_website_article change only the feed", async () => {
		const { ctx, kv } = setup();
		const out = await addWebsiteArticle(
			ctx,
			schemas.add_website_article.parse({ url: PULSE, title: "Road", summary: "Nine findings.", date: "2026-11-23", label: "ai governance" }),
		);
		expect(out).toContain("Added on the website feed");
		expect((await readFeed(kv, "abc"))!.articles[0]).toMatchObject({ title: "Road", label: "AI GOVERNANCE" });
		await removeWebsiteArticle(ctx, { url: PULSE });
		expect((await readFeed(kv, "abc"))!.articles).toEqual([]);
	});

	it("rejects links that aren't LinkedIn articles", () => {
		expect(() =>
			schemas.add_website_article.parse({ url: "https://example.com/a", title: "x", summary: "y", date: "2026-11-23" }),
		).toThrow(/LinkedIn article link/);
	});

	it("does nothing for members the feed isn't on for", async () => {
		const { ctx, kv } = setup(null);
		await post(ctx, { text: "Hello" });
		const out = await addWebsiteArticle(ctx, schemas.add_website_article.parse({ url: PULSE, title: "R", summary: "S", date: "2026-11-23" }));
		expect(out).toContain("feed is off");
		expect(await readFeed(kv, "abc")).toBeNull();
	});
});

describe("GET /feed.json", () => {
	const env = (kv: KVNamespace, id?: string) => ({ OAUTH_KV: kv, PUBLIC_FEED_MEMBER_ID: id }) as unknown as Env;

	it("is 404 when the feed is off", async () => {
		const res = await app.fetch(new Request("https://p.example/feed.json"), env(memoryKV()));
		expect(res.status).toBe(404);
	});

	it("serves the stored feed, cacheable, or an empty one before the first change", async () => {
		const { ctx, kv } = setup();
		let res = await app.fetch(new Request("https://p.example/feed.json"), env(kv, "abc"));
		expect(await res.json()).toEqual({ updatedAt: null, articles: [], posts: [] });
		await post(ctx, { text: "Hi" });
		res = await app.fetch(new Request("https://p.example/feed.json"), env(kv, "abc"));
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("public, max-age=300");
		expect(((await res.json()) as { posts: unknown[] }).posts).toHaveLength(1);
	});
});
