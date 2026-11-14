/**
 * Reads the post history from LinkedIn's "Get a copy of your data" export.
 *
 * The export is a ZIP; posts live in Shares.csv with columns:
 *   Date, ShareLink, ShareCommentary, SharedUrl, MediaUrl, Visibility
 *
 * These functions run in the user's BROWSER on the upload page (see import-page.ts):
 * unzipping and parsing a large history takes more CPU than a free-plan Worker allows
 * per request. The Worker only receives the parsed JSON and checks it with
 * sanitizeImportedPosts(). The functions are self-contained (no imports, only standard
 * web APIs) because import-page.ts serialises them into the page with toString().
 */

export interface ImportedPost {
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
export const IMPORT_LIMITS = { maxPosts: 10_000, maxTextChars: 10_000, maxUrlChars: 2_000, maxBodyBytes: 20 * 1024 * 1024 };

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

/**
 * Finds a file in a ZIP by reading its central directory. Returns the raw (possibly
 * deflated) bytes and the compression method: 0 = stored, 8 = deflate.
 */
export function findZipEntry(
	bytes: Uint8Array,
	match: (name: string) => boolean,
): { name: string; method: number; data: Uint8Array } | null {
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
			return { name, method, data: bytes.subarray(start, start + compressedSize) };
		}
		p += 46 + nameLen + extraLen + commentLen;
	}
	return null;
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
	if (entry.method === 0) return new TextDecoder().decode(entry.data);
	if (entry.method !== 8) throw new Error(`Shares.csv uses an unsupported compression method (${entry.method}).`);
	const stream = new Blob([entry.data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
	return await new Response(stream).text();
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
