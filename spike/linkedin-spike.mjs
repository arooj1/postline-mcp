// Phase 0 spike: verify what LinkedIn's self-serve API actually lets us do.
// Run: node --env-file=.env spike/linkedin-spike.mjs
//
// Steps (each asks before running):
//   1. Read your basic profile (OpenID userinfo)
//   2. Publish a short test post, visible to CONNECTIONS only
//   3. Try to edit that post's text in place (the open question)
//   4. Delete the test post
// No dependencies. Your token is never printed.

import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

const TOKEN = process.env.LINKEDIN_ACCESS_TOKEN;
const VERSION = process.env.LINKEDIN_VERSION || "202609";
const API = "https://api.linkedin.com";

if (!TOKEN) {
  console.error("LINKEDIN_ACCESS_TOKEN is missing. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const rl = readline.createInterface({ input: stdin, output: stdout });
const ask = async (q) => (await rl.question(`\n${q} [y/N] `)).trim().toLowerCase() === "y";

const results = [];
const record = (step, ok, detail) => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${step}: ${detail}`);
};

function restHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${TOKEN}`,
    "LinkedIn-Version": VERSION,
    "X-Restli-Protocol-Version": "2.0.0",
    "Content-Type": "application/json",
    ...extra,
  };
}

async function explain(res) {
  const text = await res.text();
  let hint = "";
  if (res.status === 401) hint = " (token expired or invalid; generate a new one)";
  if (res.status === 403) hint = " (permission not granted for this action)";
  if (res.status === 426 || /version/i.test(text)) hint = " (try a more recent LINKEDIN_VERSION in .env)";
  return `HTTP ${res.status}${hint} ${text.slice(0, 300)}`;
}

async function main() {
  // 1. Who am I?
  const me = await fetch(`${API}/v2/userinfo`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!me.ok) {
    record("Read profile", false, await explain(me));
    return;
  }
  const profile = await me.json();
  const author = `urn:li:person:${profile.sub}`;
  record("Read profile", true, `signed in as ${profile.name}`);

  // 2. Publish
  if (!(await ask("Publish a test post visible to your CONNECTIONS only?"))) return;
  const stamp = new Date().toISOString();
  const create = await fetch(`${API}/rest/posts`, {
    method: "POST",
    headers: restHeaders(),
    body: JSON.stringify({
      author,
      commentary: `Testing an open-source tool I'm building. This post will be deleted in a minute. (${stamp})`,
      visibility: "CONNECTIONS",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: true,
    }),
  });
  if (!create.ok) {
    record("Publish post", false, await explain(create));
    return;
  }
  const postUrn = create.headers.get("x-restli-id");
  const encoded = encodeURIComponent(postUrn);
  record("Publish post", true, `${postUrn}  →  https://www.linkedin.com/feed/update/${postUrn}/`);

  // 3. Edit in place
  if (await ask("Open the link above, then try editing the post text in place?")) {
    const edit = await fetch(`${API}/rest/posts/${encoded}`, {
      method: "POST",
      headers: restHeaders({ "X-RestLi-Method": "PARTIAL_UPDATE" }),
      body: JSON.stringify({
        patch: { $set: { commentary: `EDITED via API. This post will be deleted in a minute. (${stamp})` } },
      }),
    });
    record("Edit post in place", edit.ok, edit.ok ? "text updated; refresh the post to confirm" : await explain(edit));
  }

  // 4. Delete (default yes, to avoid leaving a test post behind)
  const keep = !(await ask("Delete the test post now? (recommended)"));
  if (keep) {
    console.log(`\nLeft the post up. Delete it yourself from LinkedIn when done: ${postUrn}`);
    return;
  }
  const del = await fetch(`${API}/rest/posts/${encoded}`, {
    method: "DELETE",
    headers: restHeaders({ "X-RestLi-Method": "DELETE" }),
  });
  record("Delete post", del.ok, del.ok ? "deleted" : await explain(del));
}

try {
  await main();
} catch (err) {
  console.error("Unexpected error:", err.message);
} finally {
  rl.close();
  console.log("\n--- Summary (paste this back to Claude) ---");
  console.log(`LinkedIn-Version: ${VERSION}`);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.step}  ${r.ok ? "" : r.detail}`);
}
