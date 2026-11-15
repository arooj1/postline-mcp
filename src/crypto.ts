/**
 * Encrypts the LinkedIn token kept with a scheduled post.
 *
 * Scheduled posts are published by a cron run, when no one is connected, so the token
 * can't be read from the OAuth grant then. It is stored with the scheduled post instead,
 * encrypted with AES-256-GCM under a key derived (HKDF-SHA-256) from COOKIE_ENCRYPTION_KEY,
 * and deleted together with the post once it is published or cancelled.
 */

const INFO = new TextEncoder().encode("postline:scheduled-token:v1");

async function deriveKey(secret: string): Promise<CryptoKey> {
	if (!secret) throw new Error("COOKIE_ENCRYPTION_KEY is not set, so scheduled posts can't be stored safely.");
	const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveKey"]);
	return crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: INFO },
		base,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Returns base64(iv ‖ ciphertext). The id is bound as associated data, so a token can't be moved to another post. */
export async function encryptToken(secret: string, token: string, boundTo: string): Promise<string> {
	const key = await deriveKey(secret);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(boundTo) },
			key,
			new TextEncoder().encode(token),
		),
	);
	const out = new Uint8Array(iv.length + ct.length);
	out.set(iv);
	out.set(ct, iv.length);
	return toBase64(out);
}

export async function decryptToken(secret: string, sealed: string, boundTo: string): Promise<string> {
	const key = await deriveKey(secret);
	const bytes = fromBase64(sealed);
	const pt = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: new TextEncoder().encode(boundTo) },
		key,
		bytes.slice(12),
	);
	return new TextDecoder().decode(pt);
}
