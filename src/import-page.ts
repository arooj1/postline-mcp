/**
 * The one-time upload page for importing LinkedIn post history.
 *
 * The file is unzipped and parsed in the browser (free-plan Workers have a ~10 ms CPU
 * budget per request; parsing a large export takes longer). The same parser functions
 * used in tests are serialised into the page with toString(), so there is one source of
 * truth. Only the parsed posts are sent to this Worker.
 */

import {
	extractSharesCsv,
	findZipEntry,
	nextDelimiter,
	parseCsv,
	parseShares,
	toIsoDate,
	urnFromLink,
} from "./importer";

// esbuild (keepNames) may wrap inner functions in __name(); define a no-op for the browser.
const CLIENT_LIBRARY = [
	"const __name = (fn) => fn;",
	...[parseCsv, nextDelimiter, toIsoDate, urnFromLink, parseShares, findZipEntry, extractSharesCsv].map((f) =>
		f.toString(),
	),
].join("\n");

/** Security headers for the import page: inline script only, fetch only to this origin, no referrer leak of the token. */
export const IMPORT_PAGE_HEADERS = {
	"Content-Type": "text/html; charset=utf-8",
	"Content-Security-Policy":
		"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src https://raw.githubusercontent.com; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
	"Referrer-Policy": "no-referrer",
	"X-Robots-Tag": "noindex, nofollow",
	"Cache-Control": "no-store",
};

const STYLE = `body{font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:10vh auto;padding:0 20px;color:#1f2937;line-height:1.55}
h1{font-size:1.35rem;margin:0 0 4px}p{margin:10px 0}.muted{color:#6b7280;font-size:.92rem}
.drop{border:1.5px dashed #9ca3af;border-radius:12px;padding:28px;text-align:center;margin:20px 0;cursor:pointer}
.drop.over{border-color:#1e3a5f;background:#f3f6fa}button{background:#1e3a5f;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:1rem;cursor:pointer}
button:disabled{opacity:.5;cursor:default}#status{margin-top:16px;white-space:pre-line}.ok{color:#166534}.err{color:#b91c1c}
img{width:40px;height:40px;border-radius:8px;vertical-align:middle;margin-right:10px}`;

export function renderImportPage(): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Import LinkedIn history · postline</title><style>${STYLE}</style></head><body>
<h1><img src="https://raw.githubusercontent.com/arooj1/postline-mcp/main/assets/logo.png" alt="">Import your LinkedIn post history</h1>
<p class="muted">Upload the ZIP from LinkedIn's <b>Get a copy of your data</b> (with Posts selected), or the <b>Shares.csv</b> inside it.
The file is read in this browser; only your posts' date, text and links are sent to your postline server. This link works once and expires 15 minutes after it was created.</p>
<label class="drop" id="drop"><input type="file" id="file" accept=".zip,.csv" hidden><span id="pick">Choose or drop the file here</span></label>
<button id="go" disabled>Import</button>
<div id="status" role="status"></div>
<script>
${CLIENT_LIBRARY}
const fileInput = document.getElementById("file"), drop = document.getElementById("drop"), go = document.getElementById("go"),
  status = document.getElementById("status"), pick = document.getElementById("pick");
let chosen = null;
function show(msg, cls) { status.textContent = msg; status.className = cls || ""; }
function choose(f) { chosen = f; pick.textContent = f ? f.name + " (" + Math.round(f.size / 1024) + " KB)" : "Choose or drop the file here"; go.disabled = !f; show(""); }
fileInput.addEventListener("change", () => choose(fileInput.files[0] || null));
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); choose(e.dataTransfer.files[0] || null); });
go.addEventListener("click", async () => {
  if (!chosen) { show("Choose a file first.", "err"); return; }
  go.disabled = true; show("Reading the file…");
  try {
    const bytes = new Uint8Array(await chosen.arrayBuffer());
    const csv = await extractSharesCsv(bytes, chosen.name);
    const { posts, skipped } = parseShares(csv);
    if (posts.length === 0) throw new Error("No posts found in Shares.csv.");
    show("Found " + posts.length + " posts. Uploading…");
    const res = await fetch(location.pathname, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ posts }) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || ("Upload failed (HTTP " + res.status + ")."));
    show("Imported " + out.imported + " posts (" + out.from + " to " + out.to + ")." + (skipped ? " Skipped " + skipped + " rows without text." : "") +
      "\\n\\nYou can close this tab and go back to Claude. Try: \\"search my posts about AI\\".", "ok");
  } catch (err) {
    show(err && err.message ? err.message : String(err), "err");
    go.disabled = false;
  }
});
</script></body></html>`;
}

export function renderImportExpired(): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link expired · postline</title><style>${STYLE}</style></head><body>
<h1>This import link has expired or was already used</h1><p>Ask Claude for a new one: <i>"create an import link for my LinkedIn history"</i>.</p></body></html>`;
}
