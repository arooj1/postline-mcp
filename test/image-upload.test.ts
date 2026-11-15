import { describe, expect, it } from "vitest";
import { LinkedInClient } from "../src/linkedin";
import { cleanFileName, LinkedInHandler } from "../src/linkedin-handler";
import { createImageUploadTicket, MAX_IMAGES_PER_LINK, readImageUploadTicket, recordImageUpload, Store } from "../src/store";
import {
	checkImage,
	createImageUploadLink,
	draftPost,
	MAX_IMAGE_BYTES,
	publishDuePosts,
	publishPost,
	schedulePost,
	schemas,
	type ToolContext,
} from "../src/tools";
import { memoryKV, mockFetch, type RecordedCall } from "./helpers";

const NOW = new Date("2026-11-15T12:00:00Z");
const SECRET = "test-cookie-encryption-key";
const bytes = (...b: number[]) => new Uint8Array([...b, 0, 0, 0, 0]).buffer as ArrayBuffer;
const PNG = bytes(0x89, 0x50, 0x4e, 0x47);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0);
const GIF = bytes(0x47, 0x49, 0x46, 0x38);
const noSleep = async () => {};

function setup() {
	const kv = memoryKV();
	let n = 0;
	const m = mockFetch([
		(c: RecordedCall) =>
			c.url.includes("/rest/images?action=initializeUpload")
				? Response.json({ value: { uploadUrl: `https://upload.linkedin.test/img${++n}`, image: `urn:li:image:I${n}` } })
				: undefined,
		(c: RecordedCall) => (c.url.startsWith("https://upload.linkedin.test/") ? new Response(null, { status: 201 }) : undefined),
		(c: RecordedCall) =>
			c.url.startsWith("https://cdn.example.com/") ? new Response(PNG, { headers: { "content-type": "image/png" } }) : undefined,
		(c: RecordedCall) =>
			c.url.endsWith("/rest/posts") ? new Response("{}", { status: 201, headers: { "x-restli-id": "urn:li:share:700" } }) : undefined,
	]);
	const ctx: ToolContext = {
		props: { memberId: "abc", name: "Arooj", accessToken: "tok-secret", expiresAt: NOW.getTime() + 45 * 86400_000 },
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
const postBodies = (calls: RecordedCall[]) => calls.filter((c) => c.url.endsWith("/rest/posts")).map((c) => JSON.parse(c.body!));
const draft = (ctx: ToolContext, input: Record<string, unknown>) => draftPost(ctx, schemas.draft_post.parse(input));

describe("checkImage", () => {
	it("reads the type from the file's signature", () => {
		expect(checkImage(PNG)).toBe("image/png");
		expect(checkImage(JPEG)).toBe("image/jpeg");
		expect(checkImage(GIF)).toBe("image/gif");
	});

	it("refuses other files and anything over 8 MB", () => {
		expect(() => checkImage(new TextEncoder().encode("%PDF-1.7").buffer as ArrayBuffer)).toThrow(/isn't a JPEG, PNG or GIF/);
		expect(() => checkImage(new ArrayBuffer(MAX_IMAGE_BYTES + 1))).toThrow(/larger than 8 MB/);
	});
});

describe("create_image_upload_link", () => {
	it("returns a link to the upload page and stores a ticket with no uploads yet", async () => {
		const { ctx, kv } = setup();
		const out = await createImageUploadLink(ctx);
		const token = out.match(/\/upload-image\/([A-Za-z0-9_-]+)/)![1];
		expect(out).toContain("https://postline.example.workers.dev/upload-image/");
		expect(await readImageUploadTicket(kv, token)).toMatchObject({ memberId: "abc", count: 0 });
	});

	it("counts uploads and is used up after 20", async () => {
		const { kv } = setup();
		const token = await createImageUploadTicket(kv, "abc");
		for (let i = 0; i < MAX_IMAGES_PER_LINK; i++) {
			const ticket = await readImageUploadTicket(kv, token);
			expect(ticket?.count).toBe(i);
			await recordImageUpload(kv, token, ticket!);
		}
		expect(await readImageUploadTicket(kv, token)).toBeNull();
	});
});

describe("the image upload page", () => {
	const env = (kv: KVNamespace) => ({ OAUTH_KV: kv }) as unknown as Env;
	const post = (kv: KVNamespace, token: string, body: ArrayBuffer, name = "dark-data.png") =>
		LinkedInHandler.request(
			`https://postline.example.workers.dev/upload-image/${token}`,
			{ method: "POST", body, headers: { "Content-Type": "image/png", "X-File-Name": encodeURIComponent(name) } },
			env(kv),
		);

	it("serves the page for a live link and an expiry page otherwise", async () => {
		const { kv } = setup();
		const token = await createImageUploadTicket(kv, "abc");
		const live = await LinkedInHandler.request(`https://postline.example.workers.dev/upload-image/${token}`, {}, env(kv));
		expect(live.status).toBe(200);
		expect(await live.text()).toContain("Upload post images");
		const dead = await LinkedInHandler.request("https://postline.example.workers.dev/upload-image/not-a-real-token-at-all", {}, env(kv));
		expect(dead.status).toBe(410);
	});

	it("stores each image under the member, typed by its signature, and counts it", async () => {
		const { kv } = setup();
		const token = await createImageUploadTicket(kv, "abc");
		const res = await post(kv, token, JPEG, "photo.png");
		expect(res.status).toBe(200);
		const out = (await res.json()) as { upload_id: string; file_name: string };
		expect(out.file_name).toBe("photo.png");
		const stored = await new Store(kv, "abc").getUploadedImage(out.upload_id);
		expect(stored?.meta).toMatchObject({ contentType: "image/jpeg", fileName: "photo.png" });
		expect((await readImageUploadTicket(kv, token))?.count).toBe(1);
	});

	it("refuses files that aren't images, and cross-site posts", async () => {
		const { kv } = setup();
		const token = await createImageUploadTicket(kv, "abc");
		const bad = await post(kv, token, new TextEncoder().encode("<svg/>").buffer as ArrayBuffer, "x.svg");
		expect(bad.status).toBe(400);
		const cross = await LinkedInHandler.request(
			`https://postline.example.workers.dev/upload-image/${token}`,
			{ method: "POST", body: PNG, headers: { Origin: "https://evil.example" } },
			env(kv),
		);
		expect(cross.status).toBe(403);
		expect((await readImageUploadTicket(kv, token))?.count).toBe(0);
	});
});

describe("draft_post with uploaded images", () => {
	it("previews an uploaded image by its file name and calls nothing", async () => {
		const { ctx, calls } = setup();
		const id = await ctx.store.saveUploadedImage(PNG, "dark-data.png", "image/png");
		const out = await draft(ctx, { text: "Hi", image: { upload_id: id, alt_text: "A chart" } });
		expect(out).toContain('Image: uploaded dark-data.png');
		expect(out).toContain('(alt text: "A chart")');
		expect(calls).toHaveLength(0);
	});

	it("needs exactly one source per image, a known upload_id, and no repeats", async () => {
		const { ctx } = setup();
		const id = await ctx.store.saveUploadedImage(PNG, "a.png", "image/png");
		await expect(draft(ctx, { text: "x", image: { alt_text: "a" } })).rejects.toThrow(/either upload_id/);
		await expect(draft(ctx, { text: "x", image: { upload_id: id, url: "https://cdn.example.com/a.png", alt_text: "a" } })).rejects.toThrow(
			/either upload_id/,
		);
		await expect(draft(ctx, { text: "x", image: { upload_id: crypto.randomUUID(), alt_text: "a" } })).rejects.toThrow(/wasn't found/);
		await expect(
			draft(ctx, { text: "x", images: [{ upload_id: id, alt_text: "a" }, { upload_id: id, alt_text: "b" }] }),
		).rejects.toThrow(/listed twice/);
		await expect(draft(ctx, { text: "x", image: { url: "http://cdn.example.com/a.png", alt_text: "a" } })).rejects.toThrow(/https/);
	});
});

describe("publishing and scheduling uploaded images", () => {
	it("publishes an uploaded image from storage (no download) and then deletes it", async () => {
		const { ctx, calls } = setup();
		const id = await ctx.store.saveUploadedImage(JPEG, "a.jpg", "image/jpeg");
		const draftId = draftIdFrom(await draft(ctx, { text: "One image", image: { upload_id: id, alt_text: "a" } }));
		expect(await publishPost(ctx, { draft_id: draftId })).toContain("urn:li:share:700");
		expect(calls.some((c) => c.url.startsWith("https://cdn.example.com/"))).toBe(false);
		expect(calls.find((c) => c.url === "https://upload.linkedin.test/img1")?.headers["content-type"]).toBe("image/jpeg");
		expect(postBodies(calls)[0].content).toEqual({ media: { id: "urn:li:image:I1", altText: "a" } });
		expect(await ctx.store.getUploadedImage(id)).toBeNull();
	});

	it("mixes uploaded and URL images in one post, in order", async () => {
		const { ctx, calls } = setup();
		const id = await ctx.store.saveUploadedImage(PNG, "first.png", "image/png");
		const draftId = draftIdFrom(
			await draft(ctx, {
				text: "Two",
				images: [{ upload_id: id, alt_text: "first" }, { url: "https://cdn.example.com/second.png", alt_text: "second" }],
			}),
		);
		await publishPost(ctx, { draft_id: draftId });
		expect(postBodies(calls)[0].content).toEqual({
			multiImage: { images: [{ id: "urn:li:image:I1", altText: "first" }, { id: "urn:li:image:I2", altText: "second" }] },
		});
	});

	it("freezes uploaded images when scheduling, frees the uploads, and publishes on time", async () => {
		const { ctx, kv, calls, fetch } = setup();
		const id = await ctx.store.saveUploadedImage(GIF, "a.gif", "image/gif");
		const draftId = draftIdFrom(await draft(ctx, { text: "Later", image: { upload_id: id, alt_text: "a" } }));
		await schedulePost(ctx, { draft_id: draftId, publish_at: "2026-11-15T13:00:00Z" });
		expect(await ctx.store.getUploadedImage(id)).toBeNull();
		const log = await publishDuePosts({ kv, secret: SECRET, fetchImpl: fetch, now: () => new Date("2026-11-15T13:02:00Z"), sleep: noSleep });
		expect(log[0]).toMatch(/^published /);
		expect(calls.find((c) => c.url === "https://upload.linkedin.test/img1")?.headers["content-type"]).toBe("image/gif");
		expect([...kv.data.keys()].filter((k) => /^(sched|media|upimg):/.test(k))).toEqual([]);
	});

	it("keeps the uploads if scheduling fails", async () => {
		const { ctx } = setup();
		const id = await ctx.store.saveUploadedImage(PNG, "a.png", "image/png");
		const draftId = draftIdFrom(await draft(ctx, { text: "Too soon", image: { upload_id: id, alt_text: "a" } }));
		await expect(schedulePost(ctx, { draft_id: draftId, publish_at: "2026-11-15T12:01:00Z" })).rejects.toThrow(/10 minutes/);
		expect(await ctx.store.getUploadedImage(id)).not.toBeNull();
	});
});

describe("cleanFileName", () => {
	it("uses the given fallback when nothing usable is left", () => {
		expect(cleanFileName(undefined, "image")).toBe("image");
		expect(cleanFileName(encodeURIComponent("<>"), "image")).toBe("image");
	});
});
