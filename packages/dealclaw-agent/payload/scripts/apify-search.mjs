#!/usr/bin/env node

/**
 * Apify Search — unified TikTok / 小红书 / Google Trends via Apify API
 *
 * Usage:
 *   node scripts/apify-search.mjs tiktok "铝合金门窗" --limit 20
 *   node scripts/apify-search.mjs xhs "AI绘画教程" --limit 15
 *   node scripts/apify-search.mjs trends "ai tools" --limit 10
 *   node scripts/apify-search.mjs trends --daily   (daily trending, no query)
 *
 * Env: APIFY_API_KEY (from ~/.openclaw/.env)
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ──────────────────────────────────────────────────
const ENV_PATH = resolve(process.env.HOME, ".openclaw/.env");
let API_KEY = process.env.APIFY_API_KEY;

if (!API_KEY) {
  try {
    const env = readFileSync(ENV_PATH, "utf-8");
    const m = env.match(/APIFY_API_KEY=(\S+)/);
    if (m) API_KEY = m[1];
  } catch {}
}

if (!API_KEY) {
  console.error("❌ APIFY_API_KEY not found. Set it in ~/.openclaw/.env");
  process.exit(1);
}

// Actor IDs (Apify store)
const ACTORS = {
  tiktok:   "clockworks~tiktok-scraper",        // TikTok post scraper (no login needed)
  xhs:      "zen-studio~rednote-search-scraper",   // 小红书关键词搜索（唯一可用）
  trends:   "emastra~google-trends-scraper",    // Google Trends
};

const BASE = "https://api.apify.com/v2";

// ── Helpers ─────────────────────────────────────────────────

async function callActor(actorId, input, timeoutSecs = 120) {
  // 1. Start the run
  const runUrl = `${BASE}/acts/${actorId}/runs?token=${API_KEY}`;
  const runRes = await fetch(runUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!runRes.ok) {
    const err = await runRes.text();
    throw new Error(`Run failed (${runRes.status}): ${err.slice(0, 300)}`);
  }
  const runData = await runRes.json();
  const runId = runData.data?.id;
  if (!runId) throw new Error("No run ID in response: " + JSON.stringify(runData).slice(0, 200));

  // 2. Poll until finished
  const start = Date.now();
  const maxMs = timeoutSecs * 1000;
  while (Date.now() - start < maxMs) {
    const statusUrl = `${BASE}/acts/${actorId}/runs/${runId}?token=${API_KEY}`;
    const stRes = await fetch(statusUrl);
    const st = await stRes.json();
    const s = st.data?.status;
    if (s === "SUCCEEDED") break;
    if (s === "FAILED" || s === "ABORTED" || s === "TIMED-OUT") {
      throw new Error(`Run ${s}: ${JSON.stringify(st.data?.statusMessage || "").slice(0, 200)}`);
    }
    await sleep(2000);
  }

  // 3. Fetch results from dataset
  const datasetId = runData.data?.defaultDatasetId;
  if (!datasetId) throw new Error("No dataset ID");

  const itemsUrl = `${BASE}/datasets/${datasetId}/items?token=${API_KEY}&clean=true&format=json`;
  const itemsRes = await fetch(itemsUrl);
  if (!itemsRes.ok) throw new Error(`Dataset fetch failed (${itemsRes.status})`);
  return await itemsRes.json();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Platform formatters ─────────────────────────────────────

function formatTikTok(items, limit) {
  const rows = items.slice(0, limit).map((item, i) => ({
    "#": i + 1,
    "作者": item.authorMeta?.name || item.authorName || "?",
    "粉丝": formatCount(item.authorMeta?.fans || item.authorFollowers),
    "文案": (item.text || item.desc || "").slice(0, 80),
    "点赞": formatCount(item.diggCount || item.playCount || 0),
    "评论": formatCount(item.commentCount || 0),
    "分享": formatCount(item.shareCount || 0),
    "链接": item.webVideoUrl || item.videoUrl || `https://tiktok.com/@${item.authorMeta?.name}/video/${item.id}`,
  }));
  return rows;
}

function formatXhs(items, limit) {
  const rows = items.slice(0, limit).map((item, i) => {
    // zen-studio format: author.nickname, engagement.liked_count
    // zhorex format: authorName, likes
    const author = item.author?.nickname || item.authorName || "?";
    const likes = item.engagement?.liked_count || item.likes || 0;
    const saves = item.engagement?.collected_count || item.saves || item.collects || 0;
    const comments = item.engagement?.comments_count || item.comments || 0;
    const shares = item.engagement?.shared_count || item.shares || 0;
    const url = item.url || item.postUrl || `https://www.xiaohongshu.com/explore/${item.postId || item.id}`;
    const tagInfo = item.tag_info || item.tags || [];
    const tags = (Array.isArray(tagInfo) ? tagInfo : Object.values(tagInfo || {}))
      .slice(0, 3)
      .map(t => t?.name || t?.tag_name || t)
      .join(", ");
    
    return {
      "#": i + 1,
      "作者": author,
      "标题": (item.title || "").slice(0, 60),
      "点赞": formatCount(likes),
      "收藏": formatCount(saves),
      "评论": formatCount(comments),
      "标签": tags,
      "链接": url,
    };
  });
  return rows;
}

function formatTrends(items, limit) {
  const rows = items.slice(0, limit).map((item, i) => ({
    "#": i + 1,
    "关键词": item.query || item.title || item.keyword || "?",
    "趋势": item.trend || item.interest || "—",
    "关联词": (item.relatedQueries || []).slice(0, 3).join(", "),
    "地区": item.geo || item.region || "全球",
  }));
  return rows;
}

function formatCount(n) {
  if (!n) return "0";
  n = Number(n);
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function printTable(rows) {
  if (rows.length === 0) {
    console.log("(no results)");
    return;
  }
  const keys = Object.keys(rows[0]);
  const widths = {};
  for (const k of keys) {
    widths[k] = Math.max(
      k.length,
      ...rows.map(r => String(r[k] ?? "").length)
    );
  }
  // Header
  const header = keys.map(k => k.padEnd(widths[k])).join(" │ ");
  console.log(header);
  console.log("─".repeat(header.length));
  // Rows
  for (const r of rows) {
    console.log(keys.map(k => String(r[k] ?? "").padEnd(widths[k])).join(" │ "));
  }
}

// ── Main ────────────────────────────────────────────────────

const args = process.argv.slice(2);
const platform = args[0];
const query = args[1];
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1]) || 20 : 20;
const jsonOut = args.includes("--json");
const daily = args.includes("--daily");

if (!platform || !ACTORS[platform]) {
  console.error("Usage: apify-search.mjs <tiktok|xhs|trends> [query] [--limit N] [--json]");
  console.error("       apify-search.mjs trends --daily [--limit N]");
  process.exit(1);
}

const actorId = ACTORS[platform];

// Build input per platform
let input;
switch (platform) {
  case "tiktok":
    if (!query) { console.error("❌ TikTok requires a search query"); process.exit(1); }
    input = {
      searchQueries: [query],
      maxResults: limit,
      sortBy: "relevant",
      shouldDownloadVideos: false,
      shouldDownloadCovers: false,
      shouldDownloadSlideshowImages: false,
    };
    break;
  case "xhs":
    if (!query) { console.error("❌ 小红书 requires a search query"); process.exit(1); }
    input = {
      keywords: [query],
      sortBy: "general",
      limit: limit,
    };
    break;
  case "trends":
    if (daily) {
      input = { mode: "dailyTrends", geo: "", searchTerms: [] };
    } else if (query) {
      input = { searchTerms: [query], mode: "interestOverTime", geo: "" };
    } else {
      console.error("❌ trends requires a query or --daily flag");
      process.exit(1);
    }
    break;
}

console.error(`🔍 Searching ${platform}: "${query || 'daily trends'}" (limit: ${limit})...`);

try {
  const items = await callActor(actorId, input, 180);

  if (!Array.isArray(items) || items.length === 0) {
    console.log(JSON.stringify({ status: "empty", count: 0, results: [] }));
    console.error("⚠️ No results returned.");
    process.exit(0);
  }

  let formatted;
  switch (platform) {
    case "tiktok":  formatted = formatTikTok(items, limit); break;
    case "xhs":     formatted = formatXhs(items, limit); break;
    case "trends":  formatted = formatTrends(items, limit); break;
  }

  if (jsonOut) {
    console.log(JSON.stringify({ status: "ok", count: formatted.length, results: formatted }, null, 2));
  } else {
    printTable(formatted);
    console.log(`\n📊 ${formatted.length} of ${items.length} total results shown.`);
  }

  // Also output raw JSON path for programmatic use
  if (!jsonOut) {
    console.log(`\n💡 Use --json for machine-readable output`);
  }

} catch (err) {
  console.error(`❌ Error: ${err.message}`);
  process.exit(1);
}
