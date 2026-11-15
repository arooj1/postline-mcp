import { describe, expect, it } from "vitest";
import { decryptToken, encryptToken } from "../src/crypto";
import { LinkedInClient, LinkedInError } from "../src/linkedin";
import { cleanFileName } from "../src/linkedin-handler";
import { Store } from "../src/store";
import {
	cancelScheduledPost,
	checkPdf,
	createPostWithRetry,
	draftPost,
	listScheduledPosts,
	parsePublishAt,
	publishDuePosts,
	publishPost,
	schedulePost,
	schemas,
	type ToolContext,
} from "../src/tools";
import { memoryKV, mockFetch, type RecordedCall } from "./helpers";

const NOW = new Date("2026-11-15T12:00:00Z");
const SECRET = "test-cookie-encryption-key";
const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF").buffer as ArrayBuffer;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer as ArrayBuffer;
const noSleep = async () => {};

const created = (urn: string) => () => new Response("{}", { status: 201, headers: { "x-restli-id": urn } });

/** Answers LinkedIn's upload, image download and post calls. */
function linkedInResponders(postUrn = "urn:li:share:900") {
	let n = 0;
	return [
		(c: RecordedCall) =>
			c.url.includes("/rest/documents?action=initializeUpload")
				? Response.json({ value: { uploadUrl: "https://upload.linkedin.test/doc", document: "urn:li:document:D1" } })
				: undefined,
		(c: RecordedCall) =>
			c.url.includes("/rest/images?action=initializeUpload")
				? Response.json({ value: { uploadUrl: `https://upload.linkedin.test/img${++n}`, image: `urn:li:image:I${n}` } })
				: undefined,
		(c: RecordedCall) => (c.url.startsWith("https://upload.linkedin.test/") ? new Response(null, { status: 201 }) : undefined),
		(c: RecordedCall) =>
			c.url.startsWith("https://cdn.example.com/") ? new Response(PNG, { headers: { "content-type": "image/png" } }) : undefined,
		(c: RecordedCall) =>
			c.url.startsWith("https://files.example.com/") ? new Response(PDF, { headers: { "content-type": "application/pdf" } }) : undefined,
		(c: RecordedCall) => (c.url.endsWith("/rest/posts") ? created(postUrn)() : undefined),
	];
}

function setup(responders = linkedInResponders(), expiresAt = NOW.getTime() + 45 * 86400_000) {
	const kv = memoryKV();
	const m = mockFetch(responders);
	const ctx: ToolContext = {
		props: { memberId: "abc", name: "Arooj", accessToken: "tok-secret", expiresAt },
		store: new Store(kv, "abc"),
		linkedin: new LinkedInClient("tok-secret", "202609", m.fetch),
		fetchImpl: m.fetch,
		now: () => NOW,
		secret: SECRET,
		sleep: noSleep,
		kv,
		origin: "https://postline.example.workers.dev",
	};
	return { ctx, kv, calls: m.calls, fetch: m.fetch };
}

const draftIdFrom = (text: string) => text.match(/draft_id: ([0-9a-f-]{36})/)![1];
const scheduledIdFrom = (text: string) => text.match(/scheduled_id: ([0-9a-f-]{36})/)![1];
const postBodies = (calls: RecordedCall[]) => calls.filter((c) => c.url.endsWith("/rest/posts")).map((c) => JSON.parse(c.body!));

describe("LinkedIn client: documents and multi-image", () => {
	it("uploads a PDF through /rest/documents and returns the document URN", async () => {
		const { fetch, calls } = setup();
		const urn = await new LinkedInClient("tok", "202609", fetch).uploadDocument("urn:li:person:abc", PDF);
		expect(urn).toBe("urn:li:document:D1");
		expect(JSON.parse(calls[0].body!)).toEqual({ initializeUploadRequest: { owner: "urn:li:person:abc" } });
		expect(calls[1]).toMatchObject({ method: "PUT", url: "https://upload.linkedin.test/doc" });
		expect(calls[1].headers["content-type"]).toBe("application/pdf");
	});

	it("builds document and multiImage post content", async () => {
		const { fetch, calls } = setup();
		const li = new LinkedInClient("tok", "202609", fetch);
		await li.createPost({ authorUrn: "urn:li:person:abc", text: "a", visibility: "PUBLIC", document: { urn: "urn:li:document:D1", title: "MCP" } });
		await li.createPost({
			authorUrn: "urn:li:person:abc",
			text: "b",
			visibility: "PUBLIC",
			images: [
				{ urn: "urn:li:image:1", altText: "one" },
				{ urn: "urn:li:image:2", altText: "two" },
			],
		});
		const [doc, multi] = postBodies(calls);
		expect(doc.content).toEqual({ media: { id: "urn:li:document:D1", title: "MCP" } });
		expect(multi.content).toEqual({
			multiImage: { images: [{ id: "urn:li:image:1", altText: "one" }, { id: "urn:li:image:2", altText: "two" }] },
		});
	});
});

describe("draft_post with images and documents", () => {
	it("allows only one kind of attachment", async () => {
		const { ctx } = setup();
		await expect(
			draftPost(
				ctx,
				schemas.draft_post.parse({
					text: "x",
					image: { url: "https://cdn.example.com/a.png", alt_text: "a" },
					document: { url: "https://files.example.com/a.pdf", title: "t" },
				}),
			),
		).rejects.toThrow(/one kind of attachment/);
	});

	it("needs 2–20 images", () => {
		expect(() => schemas.draft_post.parse({ text: "x", images: [{ url: "https://cdn.example.com/a.png", alt_text: "a" }] })).toThrow();
	});

	it("needs exactly one document source, and a known upload_id", async () => {
		const { ctx } = setup();
		await expect(draftPost(ctx, schemas.draft_post.parse({ text: "x", document: { title: "t" } }))).rejects.toThrow(/either upload_id/);
		await expect(
			draftPost(ctx, schemas.draft_post.parse({ text: "x", document: { upload_id: crypto.randomUUID(), title: "t" } })),
		).rejects.toThrow(/wasn't found/);
	});

	it("previews an uploaded carousel with its file name and calls nothing on LinkedIn", async () => {
		const { ctx, calls } = setup();
		const uploadId = await ctx.store.saveDocument(PDF, "mcp-explained.pdf");
		const out = await draftPost(ctx, schemas.draft_post.parse({ text: "Swipe", document: { upload_id: uploadId, title: "MCP, explained" } }));
		expect(out).toContain('Carousel (PDF): "MCP, explained" (mcp-explained.pdf');
		expect(calls).toHaveLength(0);
	});
});

describe("publish_post with a carousel or several images", () => {
	it("publishes an uploaded PDF as a document post and then deletes the stored PDF", async () => {
		const { ctx, calls } = setup();
		const uploadId = await ctx.store.saveDocument(PDF, "deck.pdf");
		const id = draftIdFrom(await draftPost(ctx, schemas.draft_post.parse({ text: "Swipe", document: { upload_id: uploadId, title: "Deck" } })));
		const out = await publishPost(ctx, { draft_id: id });
		expect(out).toContain("urn:li:share:900");
		expect(postBodies(calls)[0].content).toEqual({ media: { id: "urn:li:document:D1", title: "Deck" } });
		expect(await ctx.store.getDocument(uploadId)).toBeNull();
		expect(await ctx.store.getPost("urn:li:share:900")).toMatchObject({ kind: "document" });
	});

	it("publishes 2+ images as one multi-image post, in order", async () => {
		const { ctx, calls } = setup();
		const id = draftIdFrom(
			await draftPost(
				ctx,
				schemas.draft_post.parse({
					text: "Grid",
					images: [
						{ url: "https://cdn.example.com/1.png", alt_text: "first" },
						{ url: "https://cdn.example.com/2.png", alt_text: "second" },
					],
				}),
			),
		);
		await publishPost(ctx, { draft_id: id });
		expect(postBodies(calls)[0].content.multiImage.images).toEqual([
			{ id: "urn:li:image:I1", altText: "first" },
			{ id: "urn:li:image:I2", altText: "second" },
		]);
		expect(await ctx.store.getPost("urn:li:share:900")).toMatchObject({ kind: "images" });
	});
});

describe("createPostWithRetry", () => {
	const failingThen = (statuses: number[]) => {
		let i = 0;
		return mockFetch([
			() => (i < statuses.length ? new Response(JSON.stringify({ message: "not ready" }), { status: statuses[i++] }) : created("urn:li:share:1")()),
		]);
	};

	it("retries a document post while LinkedIn is still processing the PDF", async () => {
		const m = failingThen([422, 422]);
		const waits: number[] = [];
		const urn = await createPostWithRetry(
			new LinkedInClient("t", "202609", m.fetch),
			{ authorUrn: "urn:li:person:a", text: "x", visibility: "PUBLIC", document: { urn: "urn:li:document:D", title: "t" } },
			async (ms) => void waits.push(ms),
		);
		expect(urn).toBe("urn:li:share:1");
		expect(waits).toEqual([2000, 4000]);
	});

	it("does not retry other posts, or sign-in errors", async () => {
		const text = failingThen([422]);
		await expect(
			createPostWithRetry(new LinkedInClient("t", "202609", text.fetch), { authorUrn: "a", text: "x", visibility: "PUBLIC" }, noSleep),
		).rejects.toBeInstanceOf(LinkedInError);
		const auth = failingThen([401]);
		await expect(
			createPostWithRetry(
				new LinkedInClient("t", "202609", auth.fetch),
				{ authorUrn: "a", text: "x", visibility: "PUBLIC", document: { urn: "u", title: "t" } },
				noSleep,
			),
		).rejects.toMatchObject({ status: 401 });
	});
});

describe("schedule_post", () => {
	it("requires an explicit UTC offset", () => {
		expect(() => parsePublishAt("2026-11-17T08:30:00")).toThrow(/UTC offset/);
		expect(parsePublishAt("2026-11-17T08:30:00-05:00").toISOString()).toBe("2026-11-17T13:30:00.000Z");
	});

	it("refuses times too soon, too far ahead, or past the sign-in expiry", async () => {
		const { ctx } = setup(linkedInResponders(), NOW.getTime() + 10 * 86400_000);
		const id = draftIdFrom(await draftPost(ctx, schemas.draft_post.parse({ text: "Later" })));
		await expect(schedulePost(ctx, { draft_id: id, publish_at: "2026-11-15T12:05:00Z" })).rejects.toThrow(/10 minutes/);
		await expect(schedulePost(ctx, { draft_id: id, publish_at: "2027-03-01T12:00:00Z" })).rejects.toThrow(/90 days/);
		await expect(schedulePost(ctx, { draft_id: id, publish_at: "2026-11-25T08:00:00Z" })).rejects.toThrow(/sign-in expires on 2026-11-25/);
	});

	it("stores the post with an encrypted token, freezes its images, and consumes the draft", async () => {
		const { ctx, kv, calls } = setup();
		const id = draftIdFrom(
			await draftPost(ctx, schemas.draft_post.parse({ text: "Tuesday post", image: { url: "https://cdn.example.com/sketch.png", alt_text: "notes" } })),
		);
		const out = await schedulePost(ctx, { draft_id: id, publish_at: "2026-11-17T08:30:00-05:00" });
		expect(out).toMatch(/^SCHEDULED — not on LinkedIn yet/);
		expect(out).toContain("Publishes at: 2026-11-17 13:30 UTC");
		const sid = scheduledIdFrom(out);
		const stored = await ctx.store.getScheduled(sid);
		expect(stored).toMatchObject({ status: "scheduled", attempts: 0, images: [{ altText: "notes", contentType: "image/png" }] });
		expect(JSON.stringify([...kv.data.values()].map((e) => e.value))).not.toContain("tok-secret");
		expect(await ctx.store.getMedia(sid, 0)).not.toBeNull();
		expect(await ctx.store.getDraft(id)).toBeNull();
		expect(calls.some((c) => c.url.includes("linkedin.com"))).toBe(false);
	});
});

describe("publishDuePosts (the cron publisher)", () => {
	async function scheduleOne(ctx: ToolContext, input: Record<string, unknown>, at = "2026-11-15T13:00:00Z") {
		const id = draftIdFrom(await draftPost(ctx, schemas.draft_post.parse(input)));
		return scheduledIdFrom(await schedulePost(ctx, { draft_id: id, publish_at: at }));
	}

	it("does nothing before the time", async () => {
		const { ctx, kv, fetch } = setup();
		await scheduleOne(ctx, { text: "Not yet" });
		expect(await publishDuePosts({ kv, secret: SECRET, fetchImpl: fetch, now: () => NOW, sleep: noSleep })).toEqual([]);
	});

	it("publishes a due carousel with the stored token, records it, and deletes everything it kept", async () => {
		const { ctx, kv, calls, fetch } = setup();
		const uploadId = await ctx.store.saveDocument(PDF, "deck.pdf");
		const sid = await scheduleOne(ctx, { text: "Carousel day", document: { upload_id: uploadId, title: "Deck" } });
		const later = () => new Date("2026-11-15T13:02:00Z");
		const log = await publishDuePosts({ kv, secret: SECRET, fetchImpl: fetch, now: later, sleep: noSleep });
		expect(log).toEqual([`published ${sid} as urn:li:share:900`]);
		const post = calls.find((c) => c.url.endsWith("/rest/posts"))!;
		expect(post.headers.authorization).toBe("Bearer tok-secret");
		expect(JSON.parse(post.body!).content).toEqual({ media: { id: "urn:li:document:D1", title: "Deck" } });
		expect(await ctx.store.getPost("urn:li:share:900")).toMatchObject({ kind: "document", text: "Carousel day" });
		expect([...kv.data.keys()].filter((k) => /^(sched|doc|media):/.test(k))).toEqual([]);
	});

	it("retries transient LinkedIn failures, then marks the post failed with the reason", async () => {
		const { ctx, kv } = setup();
		const sid = await scheduleOne(ctx, { text: "Flaky" });
		const down = mockFetch([() => new Response("{}", { status: 503 })]);
		const run = (min: number) =>
			publishDuePosts({ kv, secret: SECRET, fetchImpl: down.fetch, now: () => new Date(`2026-11-15T13:${String(min).padStart(2, "0")}:00Z`), sleep: noSleep });
		expect((await run(1))[0]).toMatch(/^will retry/);
		expect((await run(6))[0]).toMatch(/^will retry/);
		expect((await run(11))[0]).toMatch(/^failed/);
		expect(await ctx.store.getScheduled(sid)).toMatchObject({ status: "failed", attempts: 3 });
		expect(await run(16)).toEqual([]);
		expect(await listScheduledPosts(ctx)).toContain("FAILED: Couldn't publish the post: LinkedIn returned HTTP 503.");
	});

	it("fails at once on an expired or revoked sign-in", async () => {
		const { ctx, kv } = setup();
		const sid = await scheduleOne(ctx, { text: "Revoked" });
		const revoked = mockFetch([() => new Response("{}", { status: 401 })]);
		const log = await publishDuePosts({ kv, secret: SECRET, fetchImpl: revoked.fetch, now: () => new Date("2026-11-15T13:01:00Z"), sleep: noSleep });
		expect(log[0]).toMatch(/^failed .*Reconnect postline/);
		expect(await ctx.store.getScheduled(sid)).toMatchObject({ status: "failed", attempts: 1 });
	});

	it("skips a post another run is already publishing", async () => {
		const { ctx, kv, fetch } = setup();
		const sid = await scheduleOne(ctx, { text: "Busy" });
		const post = (await ctx.store.getScheduled(sid))!;
		await ctx.store.saveScheduled({ ...post, status: "publishing", claimedAt: "2026-11-15T13:00:30Z" });
		expect(await publishDuePosts({ kv, secret: SECRET, fetchImpl: fetch, now: () => new Date("2026-11-15T13:01:00Z"), sleep: noSleep })).toEqual([]);
	});
});

describe("list and cancel", () => {
	it("lists soonest first and cancel deletes the post, its images and its PDF", async () => {
		const { ctx, kv } = setup();
		const uploadId = await ctx.store.saveDocument(PDF, "deck.pdf");
		const a = draftIdFrom(await draftPost(ctx, schemas.draft_post.parse({ text: "Second", document: { upload_id: uploadId, title: "Deck" } })));
		const b = draftIdFrom(await draftPost(ctx, schemas.draft_post.parse({ text: "First" })));
		const sa = scheduledIdFrom(await schedulePost(ctx, { draft_id: a, publish_at: "2026-11-19T13:30:00Z" }));
		await schedulePost(ctx, { draft_id: b, publish_at: "2026-11-17T13:30:00Z" });
		const list = await listScheduledPosts(ctx);
		expect(list.indexOf("First")).toBeLessThan(list.indexOf("Second"));
		await cancelScheduledPost(ctx, { scheduled_id: sa });
		expect(await ctx.store.getScheduled(sa)).toBeNull();
		expect([...kv.data.keys()].some((k) => k.startsWith("doc:"))).toBe(false);
		await expect(cancelScheduledPost(ctx, { scheduled_id: sa })).rejects.toThrow(/No scheduled post/);
	});
});

describe("helpers", () => {
	it("binds the encrypted token to its post", async () => {
		const sealed = await encryptToken(SECRET, "tok", "abc:1");
		expect(await decryptToken(SECRET, sealed, "abc:1")).toBe("tok");
		await expect(decryptToken(SECRET, sealed, "abc:2")).rejects.toThrow();
		await expect(decryptToken("other-key", sealed, "abc:1")).rejects.toThrow();
	});

	it("accepts only real PDFs and cleans file names", () => {
		expect(() => checkPdf(PNG)).toThrow(/isn't a PDF/);
		expect(checkPdf(PDF)).toBe(PDF);
		expect(cleanFileName(encodeURIComponent("<script>MCP deck.pdf"))).toBe("scriptMCP deck.pdf");
		expect(cleanFileName(undefined)).toBe("carousel.pdf");
	});
});
