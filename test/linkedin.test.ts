import { describe, expect, it } from "vitest";
import { LinkedInClient, LinkedInError, parsePostRef, toLittleText } from "../src/linkedin";
import { mockFetch } from "./helpers";

describe("toLittleText", () => {
	it("escapes LinkedIn reserved characters so text is published verbatim", () => {
		expect(toLittleText("Results (Q3) [draft] *bold* _x_ ~y~ a<b>c @me {x} a|b \\")).toBe(
			"Results \\(Q3\\) \\[draft\\] \\*bold\\* \\_x\\_ \\~y\\~ a\\<b\\>c \\@me \\{x\\} a\\|b \\\\",
		);
	});

	it("turns #hashtags into real hashtags", () => {
		expect(toLittleText("Shipping #AI and #MCP today")).toBe(
			"Shipping {hashtag|\\#|AI} and {hashtag|\\#|MCP} today",
		);
	});

	it("handles a hashtag at the very start and leaves lone # escaped", () => {
		expect(toLittleText("#OpenSource rocks, item # 2")).toBe("{hashtag|\\#|OpenSource} rocks, item \\# 2");
	});

	it("does not treat URL fragments or mid-word # as hashtags", () => {
		expect(toLittleText("see a.com/page#section and C#")).toBe("see a.com/page\\#section and C\\#");
	});

	it("leaves plain text and emoji alone", () => {
		expect(toLittleText("Hello, world! 🚀 Line two.\nNew line.")).toBe("Hello, world! 🚀 Line two.\nNew line.");
	});
});

describe("parsePostRef", () => {
	it("reads share, ugcPost and activity URNs", () => {
		expect(parsePostRef("urn:li:share:7527072361288814592")).toBe("urn:li:share:7527072361288814592");
		expect(parsePostRef("urn:li:ugcPost:123456789012")).toBe("urn:li:ugcPost:123456789012");
		expect(parsePostRef("urn:li:activity:7527072361288814592")).toBe("urn:li:activity:7527072361288814592");
	});

	it("reads feed/update links, including URL-encoded ones", () => {
		expect(parsePostRef("https://www.linkedin.com/feed/update/urn:li:share:7527072361288814592/")).toBe(
			"urn:li:share:7527072361288814592",
		);
		expect(parsePostRef("https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A7527072361288814592/")).toBe(
			"urn:li:share:7527072361288814592",
		);
	});

	it("reads /posts/ share links as activity URNs", () => {
		expect(
			parsePostRef("https://www.linkedin.com/posts/arooj-a-qureshi_ai-mcp-activity-7527072361288814592-AbCd?utm_source=share"),
		).toBe("urn:li:activity:7527072361288814592");
	});

	it("rejects things that aren't posts", () => {
		expect(() => parsePostRef("https://www.linkedin.com/in/arooj-a-qureshi")).toThrow(/Couldn't read a LinkedIn post/);
	});
});

describe("LinkedInClient", () => {
	const ok = (body: unknown = {}, headers: Record<string, string> = {}, status = 200) =>
		new Response(status === 204 ? null : JSON.stringify(body), { status, headers });

	it("creates a text post with the right endpoint, headers and body", async () => {
		const m = mockFetch([() => ok({}, { "x-restli-id": "urn:li:share:1" }, 201)]);
		const urn = await new LinkedInClient("tok", "202609", m.fetch).createPost({
			authorUrn: "urn:li:person:abc",
			text: "Hello (world) #AI",
			visibility: "PUBLIC",
		});
		expect(urn).toBe("urn:li:share:1");
		const call = m.calls[0];
		expect(call.url).toBe("https://api.linkedin.com/rest/posts");
		expect(call.method).toBe("POST");
		expect(call.headers.authorization).toBe("Bearer tok");
		expect(call.headers["linkedin-version"]).toBe("202609");
		expect(call.headers["x-restli-protocol-version"]).toBe("2.0.0");
		const body = JSON.parse(call.body!);
		expect(body).toMatchObject({
			author: "urn:li:person:abc",
			commentary: "Hello \\(world\\) {hashtag|\\#|AI}",
			visibility: "PUBLIC",
			lifecycleState: "PUBLISHED",
			distribution: { feedDistribution: "MAIN_FEED" },
		});
		expect(body.content).toBeUndefined();
	});

	it("attaches a link card", async () => {
		const m = mockFetch([() => ok({}, { "x-restli-id": "urn:li:share:2" }, 201)]);
		await new LinkedInClient("tok", "202609", m.fetch).createPost({
			authorUrn: "urn:li:person:abc",
			text: "Read this",
			visibility: "CONNECTIONS",
			article: { url: "https://example.com/a", title: "A title" },
		});
		expect(JSON.parse(m.calls[0].body!).content).toEqual({
			article: { source: "https://example.com/a", title: "A title" },
		});
	});

	it("edits in place with PARTIAL_UPDATE on the encoded URN", async () => {
		const m = mockFetch([() => ok(null, {}, 204)]);
		await new LinkedInClient("tok", "202609", m.fetch).updatePostText("urn:li:share:9", "New *text*");
		const call = m.calls[0];
		expect(call.url).toBe("https://api.linkedin.com/rest/posts/urn%3Ali%3Ashare%3A9");
		expect(call.headers["x-restli-method"]).toBe("PARTIAL_UPDATE");
		expect(JSON.parse(call.body!)).toEqual({ patch: { $set: { commentary: "New \\*text\\*" } } });
	});

	it("deletes with the DELETE method header", async () => {
		const m = mockFetch([() => ok(null, {}, 204)]);
		await new LinkedInClient("tok", "202609", m.fetch).deletePost("urn:li:share:9");
		expect(m.calls[0].method).toBe("DELETE");
		expect(m.calls[0].headers["x-restli-method"]).toBe("DELETE");
	});

	it("uploads an image in two steps and returns the image URN", async () => {
		const m = mockFetch([
			(c) =>
				c.url.includes("initializeUpload")
					? ok({ value: { uploadUrl: "https://upload.example/x", image: "urn:li:image:42" } })
					: undefined,
			(c) => (c.url === "https://upload.example/x" ? new Response(null, { status: 201 }) : undefined),
		]);
		const urn = await new LinkedInClient("tok", "202609", m.fetch).uploadImage(
			"urn:li:person:abc",
			new ArrayBuffer(10),
			"image/png",
		);
		expect(urn).toBe("urn:li:image:42");
		expect(JSON.parse(m.calls[0].body!)).toEqual({ initializeUploadRequest: { owner: "urn:li:person:abc" } });
		expect(m.calls[1].method).toBe("PUT");
		expect(m.calls[1].headers["content-type"]).toBe("image/png");
	});

	it("comments and reacts with the member as actor", async () => {
		const m = mockFetch([() => ok({}, {}, 201)]);
		const client = new LinkedInClient("tok", "202609", m.fetch);
		await client.comment("urn:li:share:9", "urn:li:person:abc", "Great post");
		await client.react("urn:li:share:9", "urn:li:person:abc", "insightful");
		expect(m.calls[0].url).toBe("https://api.linkedin.com/rest/socialActions/urn%3Ali%3Ashare%3A9/comments");
		expect(JSON.parse(m.calls[0].body!)).toEqual({
			actor: "urn:li:person:abc",
			object: "urn:li:share:9",
			message: { text: "Great post" },
		});
		expect(m.calls[1].url).toBe("https://api.linkedin.com/rest/reactions?actor=urn%3Ali%3Aperson%3Aabc");
		expect(JSON.parse(m.calls[1].body!)).toEqual({ root: "urn:li:share:9", reactionType: "INTEREST" });
	});

	it("turns LinkedIn errors into clear messages", async () => {
		const m = mockFetch([() => new Response(JSON.stringify({ message: "Not owner" }), { status: 403 })]);
		const err = await new LinkedInClient("tok", "202609", m.fetch).deletePost("urn:li:share:9").catch((e) => e);
		expect(err).toBeInstanceOf(LinkedInError);
		expect(err.status).toBe(403);
		expect(err.message).toMatch(/refused permission.*Not owner/);
	});

	it("flags expired tokens", async () => {
		const m = mockFetch([() => new Response("{}", { status: 401 })]);
		const err = await new LinkedInClient("tok", "202609", m.fetch).getUserInfo().catch((e) => e);
		expect(err.isAuthError).toBe(true);
		expect(err.message).toMatch(/Reconnect postline/);
	});
});
