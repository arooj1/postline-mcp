/**
 * Reads the post history from LinkedIn's "Get a copy of your data" export.
 *
 * The export is a ZIP. Two parts are imported:
 *   - Shares.csv (feed posts), columns: Date, ShareLink, ShareCommentary, SharedUrl, MediaUrl, Visibility
 *   - Articles/Articles/*.html (long-form articles), one HTML file each, with
 *     <h1><a href="…/pulse/…">Title</a></h1>, <p class="created">Created on YYYY-MM-DD HH:MM</p>,
 *     <p class="published">Published on YYYY-MM-DD HH:MM | ---</p>, then the body in a <div>.
 *     Unpublished drafts have "Published on ---" and are often empty.
 *
 * These functions run in the user's BROWSER on the upload page (see import-page.ts):
 * unzipping and parsing a large history takes more CPU than a free-plan Worker allows
 * per request. The Worker only receives the parsed JSON and checks it with
 * sanitizeImportedPosts(). The functions are self-contained (no imports, only standard
 * web APIs) because import-page.ts serialises them into the page with toString().
 */

export interface ImportedPost {
	/** "post" (Shares.csv) or "article" (Articles/*.html). Missing means post. */
	kind?: "post" | "article";
	/** Article title. */
	title?: string;
	/** urn:li:share / ugcPost / activity, when the ShareLink contains one. */
	urn?: string;
	url: string;
	/** ISO 8601 timestamp. */
	date: string;
	text: string;
	sharedUrl?: string;
	mediaUrl?: string;
	visibility?: string;
}

/** Limits enforced on upload. */
export const IMPORT_LIMITS = { maxPosts: 10_000, maxTextChars: 60_000, maxUrlChars: 2_000, maxBodyBytes: 20 * 1024 * 1024 };

/** RFC 4180 CSV parser: quoted fields, escaped quotes (""), commas and newlines inside quotes. */
export function parseCsv(input: string): string[][] {
	const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
	const rows: string[][] = [];
	let row: string[] = [];
	let i = 0;
	const n = text.length;
	while (i < n) {
		let field: string;
		if (text[i] === '"') {
			let value = "";
			let start = i + 1;
			for (;;) {
				const q = text.indexOf('"', start);
				if (q === -1) {
					value += text.slice(start);
					i = n;
					break;
				}
				value += text.slice(start, q);
				if (text[q + 1] === '"') {
					value += '"';
					start = q + 2;
				} else {
					i = q + 1;
					break;
				}
			}
			const stop = nextDelimiter(text, i);
			field = value + text.slice(i, stop);
			i = stop;
		} else {
			const stop = nextDelimiter(text, i);
			field = text.slice(i, stop);
			i = stop;
		}
		row.push(field);
		if (i >= n) break;
		if (text[i] === ",") {
			i++;
			if (i >= n) row.push("");
			continue;
		}
		// newline: \r\n, \n or \r
		i += text[i] === "\r" && text[i + 1] === "\n" ? 2 : 1;
		if (row.length > 1 || row[0] !== "") rows.push(row);
		row = [];
	}
	if (row.length > 1 || (row.length === 1 && row[0] !== "")) rows.push(row);
	return rows;
}

/** Index of the next comma or line break at or after `from` (or the end of the text). */
export function nextDelimiter(text: string, from: number): number {
	for (let j = from; j < text.length; j++) {
		const c = text.charCodeAt(j);
		if (c === 44 || c === 10 || c === 13) return j;
	}
	return text.length;
}

/** LinkedIn writes dates like "2024-05-13 14:22:05" (UTC). */
export function toIsoDate(value: string): string | null {
	const v = value.trim();
	const m = v.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/);
	const d = new Date(m ? `${m[1]}T${m[2].length === 5 ? `${m[2]}:00` : m[2]}Z` : v);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function urnFromLink(link: string): string | undefined {
	let decoded = link;
	try {
		decoded = decodeURIComponent(link);
	} catch {
		/* keep raw */
	}
	const m = decoded.match(/urn:li:(share|ugcPost|activity):(\d+)/);
	return m ? `urn:li:${m[1]}:${m[2]}` : undefined;
}

/** Turns Shares.csv text into posts, newest first. Rows without text or a date are skipped. */
export function parseShares(csv: string): { posts: ImportedPost[]; skipped: number } {
	const rows = parseCsv(csv);
	if (rows.length === 0) throw new Error("Shares.csv is empty.");
	const header = rows[0].map((h) => h.trim().toLowerCase());
	const col = (name: string) => header.indexOf(name.toLowerCase());
	const iDate = col("Date");
	const iLink = col("ShareLink");
	const iText = col("ShareCommentary");
	if (iDate < 0 || iText < 0) {
		throw new Error(`This doesn't look like LinkedIn's Shares.csv (columns found: ${rows[0].join(", ")}).`);
	}
	const iShared = col("SharedUrl");
	const iMedia = col("MediaUrl");
	const iVis = col("Visibility");

	const posts: ImportedPost[] = [];
	let skipped = 0;
	for (const r of rows.slice(1)) {
		const date = toIsoDate(r[iDate] ?? "");
		const text = (r[iText] ?? "").trim();
		if (!date || !text) {
			skipped++;
			continue;
		}
		const link = iLink >= 0 ? (r[iLink] ?? "").trim() : "";
		const post: ImportedPost = { date, text, url: link, urn: link ? urnFromLink(link) : undefined };
		const shared = iShared >= 0 ? r[iShared]?.trim() : "";
		const media = iMedia >= 0 ? r[iMedia]?.trim() : "";
		const vis = iVis >= 0 ? r[iVis]?.trim() : "";
		if (shared) post.sharedUrl = shared;
		if (media) post.mediaUrl = media;
		if (vis) post.visibility = vis;
		posts.push(post);
	}
	posts.sort((a, b) => b.date.localeCompare(a.date));
	return { posts, skipped };
}

export interface ZipEntry {
	name: string;
	/** 0 = stored, 8 = deflate */
	method: number;
	data: Uint8Array;
}

/** Lists files in a ZIP whose names match, by reading its central directory. */
export function listZipEntries(bytes: Uint8Array, match: (name: string) => boolean): ZipEntry[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let eocd = -1;
	for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
		if (view.getUint32(i, true) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new Error("That ZIP couldn't be opened. Upload the archive exactly as LinkedIn sent it.");
	const count = view.getUint16(eocd + 10, true);
	let p = view.getUint32(eocd + 16, true);
	const decoder = new TextDecoder();
	const out: ZipEntry[] = [];
	for (let k = 0; k < count; k++) {
		if (view.getUint32(p, true) !== 0x02014b50) break;
		const method = view.getUint16(p + 10, true);
		const compressedSize = view.getUint32(p + 20, true);
		const nameLen = view.getUint16(p + 28, true);
		const extraLen = view.getUint16(p + 30, true);
		const commentLen = view.getUint16(p + 32, true);
		const localOffset = view.getUint32(p + 42, true);
		const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
		if (match(name)) {
			const lNameLen = view.getUint16(localOffset + 26, true);
			const lExtraLen = view.getUint16(localOffset + 28, true);
			const start = localOffset + 30 + lNameLen + lExtraLen;
			out.push({ name, method, data: bytes.subarray(start, start + compressedSize) });
		}
		p += 46 + nameLen + extraLen + commentLen;
	}
	return out;
}

/** First matching ZIP entry, or null. */
export function findZipEntry(bytes: Uint8Array, match: (name: string) => boolean): ZipEntry | null {
	return listZipEntries(bytes, match)[0] ?? null;
}

/** Decompresses a ZIP entry to text using the platform's DecompressionStream. */
export async function readZipText(entry: ZipEntry): Promise<string> {
	if (entry.method === 0) return new TextDecoder().decode(entry.data);
	if (entry.method !== 8) throw new Error(`${entry.name} uses an unsupported compression method (${entry.method}).`);
	const stream = new Blob([entry.data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
	return await new Response(stream).text();
}

/** Finds Shares.csv in an uploaded ZIP (or accepts the CSV itself) and returns its text. */
export async function extractSharesCsv(bytes: Uint8Array, filename: string): Promise<string> {
	const isZip = bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b;
	if (!isZip) {
		if (!/\.csv$/i.test(filename)) throw new Error("Upload the ZIP from LinkedIn, or the Shares.csv file inside it.");
		return new TextDecoder().decode(bytes);
	}
	const entry = findZipEntry(bytes, (name) => /(^|\/)shares\.csv$/i.test(name));
	if (!entry) {
		throw new Error(
			"No Shares.csv in that archive. When requesting your data from LinkedIn, include Posts (sometimes labelled Shares).",
		);
	}
	return readZipText(entry);
}

/** Decodes the HTML entities LinkedIn's export uses (named basics plus numeric). */
export function decodeEntities(text: string): string {
	const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
		if (code[0] === "#") {
			const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
			return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
		}
		return named[code.toLowerCase()] ?? m;
	});
}

/** Converts article HTML to readable plain text, keeping paragraphs, headings and list items. */
export function htmlToText(html: string): string {
	const text = html
		.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<li[^>]*>/gi, "\n- ")
		.replace(/<hr[^>]*>/gi, "\n\n---\n\n")
		.replace(/<\/(p|h[1-6]|blockquote|li|ol|ul|div|pre)>/gi, "\n\n")
		.replace(/<[^>]+>/g, "");
	return decodeEntities(text)
		.split("\n")
		.map((line) => line.replace(/[ \t]+/g, " ").trim())
		.join("\n")
		.replace(/\n- \n+/g, "\n- ")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/(\n- [^\n]*)\n\n(?=- )/g, "$1\n")
		.replace(/(\n- [^\n]*)\n\n(?=- )/g, "$1\n")
		.trim();
}

/** Parses one exported article. Returns null for empty drafts. */
export function parseArticle(html: string): ImportedPost | null {
	const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "";
	const title = htmlToText(h1) || htmlToText(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "");
	const link = h1.match(/href="(https:\/\/www\.linkedin\.com\/pulse\/[^"]+)"/i)?.[1] ?? "";
	const created = html.match(/class="created"[^>]*>\s*Created on ([^<]*)</i)?.[1] ?? "";
	const published = html.match(/class="published"[^>]*>\s*Published on ([^<]*)</i)?.[1] ?? "";
	const afterMeta = html.split(/class="published"[^>]*>[^<]*<\/p>/i)[1] ?? "";
	const bodyHtml = afterMeta.replace(/<\/body>[\s\S]*$/i, "");
	const text = htmlToText(bodyHtml);
	const date = toIsoDate(published) ?? toIsoDate(created);
	if (!text || !date) return null;
	const post: ImportedPost = { kind: "article", title, date, text, url: link };
	if (!toIsoDate(published)) post.visibility = "DRAFT";
	return post;
}

/** Reads everything importable from an upload: Shares.csv posts and Articles/*.html. */
export async function collectExportPosts(
	bytes: Uint8Array,
	filename: string,
): Promise<{ posts: ImportedPost[]; skipped: number; postCount: number; articleCount: number }> {
	const isZip = bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b;
	if (!isZip) {
		const { posts, skipped } = parseShares(await extractSharesCsv(bytes, filename));
		return { posts, skipped, postCount: posts.length, articleCount: 0 };
	}
	const shares = findZipEntry(bytes, (name) => /(^|\/)shares\.csv$/i.test(name));
	const articleEntries = listZipEntries(bytes, (name) => /(^|\/)articles\/.*\.html?$/i.test(name));
	if (!shares && articleEntries.length === 0) {
		throw new Error(
			"No posts or articles in that archive. Request LinkedIn's full archive (\"Download larger data archive\"), which includes Shares.csv.",
		);
	}
	const posts: ImportedPost[] = [];
	let skipped = 0;
	let postCount = 0;
	if (shares) {
		const parsed = parseShares(await readZipText(shares));
		posts.push(...parsed.posts);
		skipped += parsed.skipped;
		postCount = parsed.posts.length;
	}
	let articleCount = 0;
	for (const entry of articleEntries) {
		const article = parseArticle(await readZipText(entry));
		if (article) {
			posts.push(article);
			articleCount++;
		} else {
			skipped++;
		}
	}
	posts.sort((a, b) => b.date.localeCompare(a.date));
	return { posts, skipped, postCount, articleCount };
}

/** Server-side check of the JSON the upload page sends. Drops anything malformed. */
export function sanitizeImportedPosts(input: unknown): ImportedPost[] {
	if (!Array.isArray(input)) throw new Error("Expected a list of posts.");
	if (input.length > IMPORT_LIMITS.maxPosts) throw new Error(`Too many posts (limit ${IMPORT_LIMITS.maxPosts}).`);
	const str = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : undefined);
	const out: ImportedPost[] = [];
	for (const item of input) {
		if (!item || typeof item !== "object") continue;
		const o = item as Record<string, unknown>;
		const text = str(o.text, IMPORT_LIMITS.maxTextChars)?.trim();
		const date = typeof o.date === "string" && !Number.isNaN(Date.parse(o.date)) ? new Date(o.date).toISOString() : undefined;
		if (!text || !date) continue;
		const url = str(o.url, IMPORT_LIMITS.maxUrlChars) ?? "";
		const post: ImportedPost = { date, text, url: /^https:\/\//.test(url) ? url : "" };
		if (o.kind === "article") post.kind = "article";
		const title = str(o.title, 300)?.trim();
		if (title) post.title = title;
		const urn = str(o.urn, 100);
		if (urn && /^urn:li:(share|ugcPost|activity):\d+$/.test(urn)) post.urn = urn;
		const shared = str(o.sharedUrl, IMPORT_LIMITS.maxUrlChars);
		if (shared && /^https?:\/\//.test(shared)) post.sharedUrl = shared;
		const media = str(o.mediaUrl, IMPORT_LIMITS.maxUrlChars);
		if (media && /^https?:\/\//.test(media)) post.mediaUrl = media;
		const vis = str(o.visibility, 50);
		if (vis) post.visibility = vis;
		out.push(post);
	}
	out.sort((a, b) => b.date.localeCompare(a.date));
	return out;
}
