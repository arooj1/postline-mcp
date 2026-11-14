import { readFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
	collectExportPosts,
	extractSharesCsv,
	findZipEntry,
	parseArticle,
	parseCsv,
	parseShares,
	sanitizeImportedPosts,
} from "../src/importer";

const HEADER = "Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility";

describe("parseCsv", () => {
	it("handles quoted fields with commas, escaped quotes and line breaks", () => {
		const csv = 'a,b,c\n1,"hello, ""world""\nsecond line",3\r\n4,,6\n';
		expect(parseCsv(csv)).toEqual([
			["a", "b", "c"],
			["1", 'hello, "world"\nsecond line', "3"],
			["4", "", "6"],
		]);
	});

	it("strips a UTF-8 BOM, keeps trailing empty fields and ignores blank lines", () => {
		expect(parseCsv("﻿x,y\n\n1,\n")).toEqual([
			["x", "y"],
			["1", ""],
		]);
	});

	it("handles a last line without a newline and an unterminated quote", () => {
		expect(parseCsv('a,b\n1,"open')).toEqual([
			["a", "b"],
			["1", "open"],
		]);
	});
});

describe("parseShares", () => {
	const csv = [
		HEADER,
		'2024-03-01 09:15:00,https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A7100000000000000001,"First post, with ""quotes"".\n\nAnd a second paragraph. #AI",,,MEMBER_NETWORK',
		'2025-01-20 18:00:05,https://www.linkedin.com/feed/update/urn%3Ali%3AugcPost%3A7200000000000000002,"Newer post",https://example.com/article,,CONNECTIONS',
		"2023-07-07 07:07:07,,,,,MEMBER_NETWORK",
	].join("\n");

	it("maps rows to posts, newest first, decoding URNs and keeping multi-line text", () => {
		const { posts, skipped } = parseShares(csv);
		expect(skipped).toBe(1);
		expect(posts).toHaveLength(2);
		expect(posts[0]).toMatchObject({
			date: "2025-01-20T18:00:05.000Z",
			urn: "urn:li:ugcPost:7200000000000000002",
			text: "Newer post",
			sharedUrl: "https://example.com/article",
			visibility: "CONNECTIONS",
		});
		expect(posts[1].urn).toBe("urn:li:share:7100000000000000001");
		expect(posts[1].text).toBe('First post, with "quotes".\n\nAnd a second paragraph. #AI');
	});

	it("rejects files that aren't Shares.csv", () => {
		expect(() => parseShares("First Name,Last Name\nA,B\n")).toThrow(/doesn't look like LinkedIn's Shares.csv/);
	});
});

describe("extractSharesCsv", () => {
	const csv = `${HEADER}\n2024-01-01 00:00:00,,"Hi from the zip",,,MEMBER_NETWORK\n`;

	it("finds Shares.csv inside a deflated ZIP among other files", async () => {
		const zip = zipSync({
			"Connections.csv": strToU8("x".repeat(50_000)),
			"Shares.csv": strToU8(csv),
			"Profile.csv": strToU8("a,b\n"),
		});
		expect(await extractSharesCsv(zip, "Basic_LinkedInDataExport.zip")).toBe(csv);
	});

	it("finds it in a subfolder and in a stored (uncompressed) ZIP", async () => {
		const zip = zipSync({ "export/Shares.csv": [strToU8(csv), { level: 0 }] });
		expect(findZipEntry(zip, (n) => n.endsWith("Shares.csv"))?.method).toBe(0);
		expect(await extractSharesCsv(zip, "x.zip")).toBe(csv);
	});

	it("accepts the CSV directly", async () => {
		expect(await extractSharesCsv(strToU8(csv), "Shares.csv")).toBe(csv);
	});

	it("explains a ZIP without Shares.csv and a wrong file type", async () => {
		const zip = zipSync({ "Connections.csv": strToU8("a\n") });
		await expect(extractSharesCsv(zip, "x.zip")).rejects.toThrow(/No Shares.csv/);
		await expect(extractSharesCsv(strToU8("hello"), "notes.txt")).rejects.toThrow(/Upload the ZIP/);
	});
});

describe("sanitizeImportedPosts", () => {
	it("keeps valid posts, drops malformed ones and unsafe links", () => {
		const out = sanitizeImportedPosts([
			{ date: "2024-01-01T00:00:00Z", text: "ok", url: "https://www.linkedin.com/feed/update/urn:li:share:1/", urn: "urn:li:share:1" },
			{ date: "not a date", text: "bad date" },
			{ date: "2024-02-01T00:00:00Z", text: "" },
			{ date: "2024-03-01T00:00:00Z", text: "js link", url: "javascript:alert(1)", urn: "urn:li:evil:1", sharedUrl: "data:x" },
			"string",
			null,
		]);
		expect(out).toHaveLength(2);
		expect(out[0]).toEqual({ date: "2024-03-01T00:00:00.000Z", text: "js link", url: "" });
		expect(out[1].urn).toBe("urn:li:share:1");
	});

	it("rejects non-lists and oversized uploads", () => {
		expect(() => sanitizeImportedPosts({})).toThrow(/list/);
		expect(() => sanitizeImportedPosts(new Array(10_001).fill({}))).toThrow(/Too many/);
	});
});

describe("LinkedIn articles (real export markup)", () => {
	const published = readFileSync(new URL("./fixtures/article-published.html", import.meta.url), "utf8");
	const draft = readFileSync(new URL("./fixtures/article-draft.html", import.meta.url), "utf8");

	it("parses title, link, published date and clean text", () => {
		const a = parseArticle(published)!;
		expect(a).toMatchObject({
			kind: "article",
			title: "🎯 Sample: AI Projects & Why They Fail — It’s a Project",
			url: "https://www.linkedin.com/pulse/sample-article-about-ai-projects-example-abcde",
			date: "2025-05-15T19:13:00.000Z",
		});
		expect(a.visibility).toBeUndefined();
		expect(a.text).toContain('First paragraph with bold and a "quote" & an ampersand.');
		expect(a.text).toContain("🧠 A heading\n\n📦 1. “The Devil Is in the Data”");
		expect(a.text).toContain("- Step one: do this.\n- Step two.");
		expect(a.text).toContain("Line one\nline two <tag> 'apos' — dash");
		expect(a.text).toContain("---");
		expect(a.text).not.toMatch(/<\/?(p|div|h[1-6]|strong|em|li|ol|a|img|br|hr)\b|&amp;|margin:/);
		expect(a.text.startsWith("By the author")).toBe(true);
	});

	it("skips empty unpublished drafts", () => {
		expect(parseArticle(draft)).toBeNull();
	});

	it("collects posts and articles from one archive, newest first", async () => {
		const shares = `${HEADER}\n2026-01-01 08:00:00,,"A feed post",,,MEMBER_NETWORK\n`;
		const zip = zipSync({
			"Shares.csv": strToU8(shares),
			"Articles/Articles/sample-article.html": strToU8(published),
			"Articles/Articles/2022-02-22 23:31:19.0-Sample draft title.html": strToU8(draft),
			"Profile.csv": strToU8("a,b\n1,2\n"),
		});
		const out = await collectExportPosts(zip, "Basic_LinkedInDataExport.zip");
		expect(out).toMatchObject({ postCount: 1, articleCount: 1, skipped: 1 });
		expect(out.posts.map((p) => p.kind ?? "post")).toEqual(["post", "article"]);
	});

	it("works with an articles-only archive and explains an archive with neither", async () => {
		const articlesOnly = zipSync({ "Articles/Articles/a.html": strToU8(published), "Profile.csv": strToU8("x\n") });
		expect((await collectExportPosts(articlesOnly, "a.zip")).articleCount).toBe(1);
		const neither = zipSync({ "Profile.csv": strToU8("x\n") });
		await expect(collectExportPosts(neither, "a.zip")).rejects.toThrow(/Download larger data archive/);
	});

	it("keeps article kind and title through server validation", () => {
		const [a] = sanitizeImportedPosts([{ kind: "article", title: "T", date: "2025-01-01T00:00:00Z", text: "x".repeat(20_000), url: "https://www.linkedin.com/pulse/x" }]);
		expect(a).toMatchObject({ kind: "article", title: "T" });
		expect(a.text).toHaveLength(20_000);
	});
});
