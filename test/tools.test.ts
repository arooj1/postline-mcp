import { describe, expect, it } from "vitest";
import { LinkedInClient } from "../src/linkedin";
import { exchangeCode, parseAllowlist } from "../src/linkedin-handler";
import { readImportTicket, Store } from "../src/store";
import {
	createImportLink,
	deleteImportedHistory,
	deletePost,
	downloadImage,
	draftPost,
	editPost,
	listMyPosts,
	publishPost,
	schemas,
	searchMyPosts,
	type ToolContext,
} from "../src/tools";
import { memoryKV, mockFetch } from "./helpers";

const NOW = new Date("2026-11-13T18:00:00Z");

function setup(responders: Parameters<typeof mockFetch>[0] = [], expiresAt = NOW.getTime() + 30 * 86400_000) {
	const kv = memoryKV();
	const m = mockFetch(responders);
	const ctx: ToolContext = {
		props: { memberId: "abc", name: "Arooj", accessToken: "tok", expiresAt },
		store: new Store(kv, "abc"),
		linkedin: new LinkedInClient("tok", "202609", m.fetch),
		fetchImpl: m.fetch,
		now: () => NOW,
	};
	return { ctx, kv, calls: m.calls };
}

const draftIdFrom = (text: string) => text.match(/draft_id: ([0-9a-f-]{36})/)![1];

describe("draft → publish flow", () => {
	it("draft_post saves a draft and calls nothing on LinkedIn", async () => {
		const { ctx, calls } = setup();
		const out = await draftPost(ctx, schemas.draft_post.parse({ text: "Hello LinkedIn" }));
		expect(out).toMatch(/^DRAFT — nothing has been posted/);
		expect(out).toContain("Visibility: Public");
		expect(out).toContain("Hello LinkedIn");
		expect(calls).toHaveLength(0);
	});

	it("publish_post publishes the draft, records it, and removes the draft", async () => {
		const { ctx, kv, calls } = setup([
			() => new Response("{}", { status: 201, headers: { "x-restli-id": "urn:li:share:77" } }),
		]);
		const id = draftIdFrom(await draftPost(ctx, schemas.draft_post.parse({ text: "Ship it", visibility: "CONNECTIONS" })));
		const out = await publishPost(ctx, { draft_id: id });
		expect(out).toContain("https://www.linkedin.com/feed/update/urn:li:share:77/");
		expect(JSON.parse(calls[0].body!).visibility).toBe("CONNECTIONS");
		expect(await ctx.store.getDraft(id)).toBeNull();
		expect(await ctx.store.getPost("urn:li:share:77")).toMatchObject({ text: "Ship it", kind: "text" });
		expect([...kv.data.keys()].every((k) => k.includes(":abc:"))).toBe(true);
	});

	it("publish_post refuses an unknown or already-used draft", async () => {
		const { ctx } = setup();
		await expect(publishPost(ctx, { draft_id: crypto.randomUUID() })).rejects.toThrow(/draft wasn't found/);
	});

	it("publish_post with an image downloads, uploads, then posts", async () => {
		const { ctx, calls } = setup([
			(c) => (c.url === "https://img.example/a.png" ? new Response(new Uint8Array(8), { headers: { "content-type": "image/png" } }) : undefined),
			(c) => (c.url.includes("initializeUpload") ? Response.json({ value: { uploadUrl: "https://up.example/1", image: "urn:li:image:5" } }) : undefined),
			(c) => (c.url === "https://up.example/1" ? new Response(null, { status: 201 }) : undefined),
			(c) => (c.url.endsWith("/rest/posts") ? new Response("{}", { status: 201, headers: { "x-restli-id": "urn:li:share:8" } }) : undefined),
		]);
		const id = draftIdFrom(
			await draftPost(ctx, schemas.draft_post.parse({ text: "Pic", image: { url: "https://img.example/a.png", alt_text: "A chart" } })),
		);
		await publishPost(ctx, { draft_id: id });
		const post = JSON.parse(calls.at(-1)!.body!);
		expect(post.content).toEqual({ media: { id: "urn:li:image:5", altText: "A chart" } });
	});

	it("rejects a draft with both a link and an image", async () => {
		const { ctx } = setup();
		await expect(
			draftPost(
				ctx,
				schemas.draft_post.parse({
					text: "x",
					link: { url: "https://a.com", title: "t" },
					image: { url: "https://b.com/i.png", alt_text: "i" },
				}),
			),
		).rejects.toThrow(/one kind of attachment/);
	});

	it("schema rejects posts over 3000 characters", () => {
		expect(schemas.draft_post.safeParse({ text: "a".repeat(3001) }).success).toBe(false);
	});
});

describe("expired LinkedIn sign-in", () => {
	it("blocks LinkedIn writes with a reconnect message", async () => {
		const { ctx, calls } = setup([], NOW.getTime() - 1000);
		await expect(editPost(ctx, { post: "urn:li:share:1", new_text: "x" })).rejects.toThrow(/expired on 2026-11-13.*reconnect/i);
		expect(calls).toHaveLength(0);
	});
});

describe("edit and delete", () => {
	it("edit_post updates LinkedIn and the local record", async () => {
		const { ctx } = setup([() => new Response(null, { status: 204 })]);
		await ctx.store.savePost({ urn: "urn:li:share:3", url: "u", text: "old", visibility: "PUBLIC", kind: "text", createdAt: "2026-11-01T00:00:00Z" });
		const out = await editPost(ctx, { post: "https://www.linkedin.com/feed/update/urn:li:share:3/", new_text: "new" });
		expect(out).toMatch(/updated in place/);
		expect(await ctx.store.getPost("urn:li:share:3")).toMatchObject({ text: "new", updatedAt: NOW.toISOString() });
	});

	it("edit_post refuses activity links with guidance", async () => {
		const { ctx, calls } = setup();
		await expect(editPost(ctx, { post: "urn:li:activity:123456789012", new_text: "x" })).rejects.toThrow(/activity ID/);
		expect(calls).toHaveLength(0);
	});

	it("delete_post clears the record even if LinkedIn says it's already gone", async () => {
		const { ctx } = setup([() => new Response("{}", { status: 404 })]);
		await ctx.store.savePost({ urn: "urn:li:share:4", url: "u", text: "t", visibility: "PUBLIC", kind: "text", createdAt: "2026-11-01T00:00:00Z" });
		await deletePost(ctx, { post: "urn:li:share:4" });
		expect(await ctx.store.getPost("urn:li:share:4")).toBeNull();
	});
});

describe("list_my_posts", () => {
	it("explains the limitation when empty", async () => {
		const { ctx } = setup();
		expect(await listMyPosts(ctx, { limit: 20 })).toMatch(/doesn't let self-serve apps read/);
	});

	it("lists newest first and only for this member", async () => {
		const { ctx, kv } = setup();
		await ctx.store.savePost({ urn: "urn:li:share:1", url: "", text: "older", visibility: "PUBLIC", kind: "text", createdAt: "2026-11-01T00:00:00Z" });
		await ctx.store.savePost({ urn: "urn:li:share:2", url: "", text: "newer", visibility: "PUBLIC", kind: "text", createdAt: "2026-11-10T00:00:00Z" });
		await new Store(kv, "someone-else").savePost({ urn: "urn:li:share:3", url: "", text: "not mine", visibility: "PUBLIC", kind: "text", createdAt: "2026-11-12T00:00:00Z" });
		const out = await listMyPosts(ctx, { limit: 20 });
		expect(out.indexOf("newer")).toBeLessThan(out.indexOf("older"));
		expect(out).not.toContain("not mine");
	});
});

describe("downloadImage", () => {
	it("rejects non-image content", async () => {
		const m = mockFetch([() => new Response("<html>", { headers: { "content-type": "text/html" } })]);
		await expect(downloadImage("https://x.com/a", m.fetch)).rejects.toThrow(/JPEG, PNG or GIF/);
	});

	it("rejects images over 8 MB", async () => {
		const m = mockFetch([() => new Response("x", { headers: { "content-type": "image/png", "content-length": String(9 * 1024 * 1024) } })]);
		await expect(downloadImage("https://x.com/a.png", m.fetch)).rejects.toThrow(/8 MB/);
	});

	it("rejects http URLs", async () => {
		await expect(downloadImage("http://x.com/a.png")).rejects.toThrow(/https/);
	});
});

describe("sign-in helpers", () => {
	it("parses the allowlist", () => {
		expect([...parseAllowlist(" a, b ,,c ")]).toEqual(["a", "b", "c"]);
		expect(parseAllowlist("").size).toBe(0);
		expect(parseAllowlist(undefined).size).toBe(0);
	});

	it("exchanges the code with LinkedIn's token endpoint", async () => {
		const m = mockFetch([() => Response.json({ access_token: "AQX", expires_in: 5184000 })]);
		const out = await exchangeCode("code1", "https://w.dev/callback", { LINKEDIN_CLIENT_ID: "id", LINKEDIN_CLIENT_SECRET: "sec" }, m.fetch);
		expect(out).toEqual({ accessToken: "AQX", expiresIn: 5184000 });
		const body = new URLSearchParams(m.calls[0].body!);
		expect(m.calls[0].url).toBe("https://www.linkedin.com/oauth/v2/accessToken");
		expect(body.get("grant_type")).toBe("authorization_code");
		expect(body.get("redirect_uri")).toBe("https://w.dev/callback");
	});

	it("returns null when LinkedIn refuses the code", async () => {
		const m = mockFetch([() => new Response("bad", { status: 400 })]);
		expect(await exchangeCode("c", "r", { LINKEDIN_CLIENT_ID: "i", LINKEDIN_CLIENT_SECRET: "s" }, m.fetch)).toBeNull();
	});
});

describe("history: import link, search and list", () => {
	const history = [
		{ date: "2025-06-01T10:00:00.000Z", text: "Evaluation matters more than model choice in regulated AI.", url: "https://www.linkedin.com/feed/update/urn:li:share:11/", urn: "urn:li:share:11" },
		{ date: "2024-02-01T10:00:00.000Z", text: "Teaching AI to 10,000 educators taught me patience.", url: "https://www.linkedin.com/feed/update/urn:li:activity:22/", urn: "urn:li:activity:22" },
	];

	it("create_import_link stores a one-time ticket for this member", async () => {
		const { ctx, kv } = setup();
		ctx.kv = kv;
		ctx.origin = "https://postline.example.workers.dev";
		const out = await createImportLink(ctx);
		const token = out.match(/\/import\/([A-Za-z0-9_-]+)/)![1];
		expect(out).toContain("https://postline.example.workers.dev/import/");
		expect(await readImportTicket(kv, token)).toMatchObject({ memberId: "abc" });
		expect(await readImportTicket(kv, "../bad")).toBeNull();
	});

	it("search_my_posts finds imported and postline posts by words, newest first", async () => {
		const { ctx } = setup();
		await ctx.store.saveHistory(history);
		await ctx.store.savePost({ urn: "urn:li:share:99", url: "https://www.linkedin.com/feed/update/urn:li:share:99/", text: "AI evaluation checklist, part 2", visibility: "PUBLIC", kind: "text", createdAt: "2026-11-01T00:00:00.000Z" });
		const all = await searchMyPosts(ctx, { limit: 10 });
		expect(all).toMatch(/^3 matching post\(s\) out of 3/);
		expect(all.indexOf("checklist")).toBeLessThan(all.indexOf("Evaluation matters"));
		const hits = await searchMyPosts(ctx, { query: "evaluation AI", limit: 10 });
		expect(hits).toMatch(/^2 matching/);
		expect(hits).not.toContain("educators");
		expect(await searchMyPosts(ctx, { query: "blockchain", limit: 10 })).toMatch(/No posts contain/);
	});

	it("list_my_posts merges sources and labels imported posts", async () => {
		const { ctx } = setup();
		await ctx.store.saveHistory(history);
		const out = await listMyPosts(ctx, { limit: 20 });
		expect(out).toMatch(/Showing 2 of 2/);
		expect(out).toContain("(imported)");
		expect(out).toContain("History imported");
	});

	it("search explains how to import when there is nothing", async () => {
		const { ctx } = setup();
		expect(await searchMyPosts(ctx, { limit: 10 })).toMatch(/create_import_link/);
	});

	it("delete_imported_history removes only the history", async () => {
		const { ctx } = setup();
		await ctx.store.saveHistory(history);
		expect(await deleteImportedHistory(ctx)).toMatch(/Deleted 2 imported posts/);
		expect(await ctx.store.getHistory()).toBeNull();
		expect(await deleteImportedHistory(ctx)).toMatch(/no imported history/);
	});
});
