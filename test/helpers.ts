/** In-memory stand-in for Cloudflare KV, enough for Store. */
export function memoryKV() {
	const data = new Map<string, { value: string; metadata?: unknown; expiresAt?: number }>();
	const kv = {
		data,
		async get(key: string, type?: "json") {
			const entry = data.get(key);
			if (!entry || (entry.expiresAt && entry.expiresAt < Date.now())) return null;
			return type === "json" ? JSON.parse(entry.value) : entry.value;
		},
		async put(key: string, value: string, opts?: { metadata?: unknown; expirationTtl?: number }) {
			data.set(key, {
				value,
				metadata: opts?.metadata,
				expiresAt: opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : undefined,
			});
		},
		async delete(key: string) {
			data.delete(key);
		},
		async list(opts: { prefix?: string; cursor?: string }) {
			const keys = [...data.entries()]
				.filter(([k]) => k.startsWith(opts.prefix ?? ""))
				.map(([name, e]) => ({ name, metadata: e.metadata }));
			return { keys, list_complete: true, cursor: undefined };
		},
	};
	return kv as unknown as KVNamespace & { data: typeof data };
}

export interface RecordedCall {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string | undefined;
}

/** A fetch mock that records calls and answers from a list of responders. */
export function mockFetch(responders: Array<(call: RecordedCall) => Response | undefined>) {
	const calls: RecordedCall[] = [];
	const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const headers: Record<string, string> = {};
		new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
		const call: RecordedCall = {
			url: String(input),
			method: init?.method ?? "GET",
			headers,
			body: typeof init?.body === "string" ? init.body : init?.body ? "[binary]" : undefined,
		};
		calls.push(call);
		for (const r of responders) {
			const res = r(call);
			if (res) return res;
		}
		throw new Error(`Unexpected fetch: ${call.method} ${call.url}`);
	}) as typeof fetch;
	return { fetch: fn, calls };
}
