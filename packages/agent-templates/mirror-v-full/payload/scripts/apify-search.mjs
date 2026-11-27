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

import { runActor } from './apify-client.mjs';

// Actor IDs (Apify store)
const ACTORS = {
  // Ordered fallback list: primary first. clockworks~tiktok-scraper may require
  // one-time Apify account approval; free-tiktok-scraper is the same-author backup.
  tiktok:   "clockworks~tiktok-scraper",
  xhs:      "zen-studio~rednote-search-scraper",   // 小红书关键词搜索（唯一可用）
  trends:   "emastra~google-trends-scraper",    // Google Trends
};

// ── Helpers ─────────────────────────────────────────────────
function sourceUrl(url, hosts) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !hosts.some(h=>u.hostname===h || u.hostname.endsWith('.'+h))) return null;
    u.search = ''; u.hash = ''; return u.href;
  } catch { return null; }
}

function xmlText(value = '') {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
}

async function officialTrending(geo, limit) {
  if (!/^[A-Z]{2}$/.test(geo)) throw new Error('Use a two-letter country code for --geo');
  const url = `https://trends.google.com/trending/rss?geo=${geo}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Official Trends RSS HTTP ${r.status}`);
  const xml = await r.text();
  if (!xml.includes('<rss')) throw new Error('Official Trends source is not RSS');
  const blocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m=>m[1]);
  const read = (s,tag) => xmlText(s.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]);
  const rows = blocks.slice(0,limit).map((s,i)=>({
    '#':i+1,'关键词':read(s,'title'),'预估搜索量':read(s,'ht:approx_traffic'),
    '发布时间':read(s,'pubDate'),'地区':geo,'来源':url,
  }));
  if(rows.some(r=>!r['关键词'])) throw new Error('RSS item lacks a title');
  return {status:rows.length?'ok':'empty',count:rows.length,results:rows,
    evidence:{source:'Google Trends official RSS',geo,scope:'Realtime trending; not a historical daily ranking',retrievedAt:new Date().toISOString()}};
}

// ── Platform formatters ─────────────────────────────────────

function formatTikTok(items, limit) {
  const rows = items.slice(0, limit).map((item, i) => ({
    "#": i + 1,
    "作者": item.authorMeta?.name || item.authorName || "?",
    "粉丝": formatCount(item.authorMeta?.fans ?? item.authorFollowers ?? null),
    "文案": (item.text || item.desc || "").slice(0, 80),
    "点赞": item.diggCount == null ? null : formatCount(item.diggCount),
    "播放": item.playCount == null ? null : formatCount(item.playCount),
    "评论": formatCount(item.commentCount ?? null),
    "分享": formatCount(item.shareCount ?? null),
    "链接": sourceUrl(item.webVideoUrl, ['tiktok.com']) || (item.id && item.authorMeta?.name ? `https://www.tiktok.com/@${encodeURIComponent(item.authorMeta.name)}/video/${encodeURIComponent(item.id)}` : null),
  }));
  return rows;
}

function formatXhs(items, limit) {
  const rows = items.slice(0, limit).map((item, i) => {
    // zen-studio format: author.nickname, engagement.liked_count
    // zhorex format: authorName, likes
    const author = item.author?.nickname || item.authorName || "?";
    const likes = item.engagement?.liked_count ?? item.likes ?? null;
    const saves = item.engagement?.collected_count ?? item.saves ?? item.collects ?? null;
    const comments = item.engagement?.comments_count ?? item.comments ?? null;
    const id = item.postId || item.noteId || item.id;
    const url = sourceUrl(item.url || item.postUrl, ['xiaohongshu.com','xhslink.com']) || (id ? `https://www.xiaohongshu.com/explore/${encodeURIComponent(id)}` : null);
    const tagInfo = item.tag_info || item.tags || [];
    const tags = (Array.isArray(tagInfo) ? tagInfo : Object.values(tagInfo || {}))
      .slice(0, 3)
      .map(t => t?.name || t?.tag_name || t?.tagName || (typeof t === 'string' ? t : ''))
      .filter(Boolean)
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
  const rows = items.slice(0, limit).map((item, i) => {
    const term = item.searchTerm || item.inputUrlOrTerm;
    const series = item.interestOverTime_timelineData;
    if (!term || !Array.isArray(series) || !series.length) throw new Error('Trends result lacks keyword or time series');
    const related = item.relatedQueries_top || [];
    return {
      '#': i + 1,
      '关键词': term,
      '时间点数': series.length,
      '最新指数': series.at(-1)?.hasData?.[0] === false ? null : (series.at(-1)?.value?.[0] ?? null),
      '开始时间': series[0]?.formattedTime ?? null,
      '结束时间': series.at(-1)?.formattedTime ?? null,
      '关联词': related.slice(0, 3).map(r=>r.query).filter(Boolean).join(', '),
      ...(jsonOut ? {series, relatedQueries:related} : {}),
    };
  });
  return rows;
}

function formatCount(n) {
  if (n == null) return null;
  if (!n) return "0";
  n = Number(n);
  if (!Number.isFinite(n)) return null;
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
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 20;
if (!Number.isInteger(limit) || limit < 1 || limit > 100) { console.error('limit must be 1–100'); process.exit(1); }
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name)+1] : fallback;
const account = option('--account', 'default');
const statePath = option('--state', undefined);
const timeout = Number(option('--timeout', '240'));
const maxCharge = Number(option('--max-charge', '0.5'));
let evidence;
const jsonOut = args.includes("--json");
const daily = args.includes("--daily");

if (!platform || !ACTORS[platform]) {
  console.error("Usage: apify-search.mjs <tiktok|xhs|trends> [query] [--limit N] [--json]");
  console.error("       apify-search.mjs trends --daily [--limit N]");
  process.exit(1);
}

if (platform === 'trends' && daily) {
  try {
    const result = await officialTrending(option('--geo','US').toUpperCase(), limit);
    console.error(`Official Trends RSS (${result.evidence.geo}); realtime trending, not historical daily rankings`);
    if (jsonOut) console.log(JSON.stringify(result,null,2)); else printTable(result.results);
    process.exit(0);
  } catch (e) { console.error(`Trends RSS failed: ${e.message}`); process.exit(1); }
}

const actorIds = Array.isArray(ACTORS[platform]) ? ACTORS[platform] : [ACTORS[platform]];

// Build input per platform
let input;
switch (platform) {
  case "tiktok":
    if (!query) { console.error("❌ TikTok requires a search query"); process.exit(1); }
    input = {
      searchQueries: [query],
      resultsPerPage: limit,
      searchSection: '/video',
      shouldDownloadVideos: false,
      shouldDownloadCovers: false,
      shouldDownloadSlideshowImages: false,
    };
    break;
  case "xhs":
    if (!query) { console.error("❌ 小红书 requires a search query"); process.exit(1); }
    input = {
      keywords: [query],
      sortType: "general",
      maxResults: limit,
      topUpFromOtherSorts: false,
    };
    break;
  case "trends":
    if (daily) {
      console.error('Daily trending is not supported by this Actor schema; use a keyword query or verified alternative');
      process.exit(1);
    } else if (query) {
      input = { searchTerms: [query], timeRange: 'now 7-d', geo: "", maxItems: limit };
    } else {
      console.error("❌ trends requires a query or --daily flag");
      process.exit(1);
    }
    break;
}

console.error(`🔍 Searching ${platform}: "${query || 'daily trends'}" (limit: ${limit})...`);

try {
  let items, lastErr;
  for (const aid of actorIds) {
    try {
      const result = await runActor(aid, input, {account, timeout, maxCharge, statePath});
      items = result.items; evidence = result.evidence;
      if (Array.isArray(items) && items.length > 0) break;
      console.error(`⚠️ ${aid} returned 0 results, trying next actor...`);
    } catch (e) {
      lastErr = e;
      console.error(`⚠️ ${aid} failed: ${String(e.message).slice(0, 180)}`);
    }
  }
  if (!items) throw lastErr || new Error("all actors failed");

  if (!Array.isArray(items) || items.length === 0) {
    console.log(JSON.stringify({ status: "empty", count: 0, results: [], evidence }));
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
    if (platform !== 'trends' && formatted.some(r=>!r['链接'])) throw new Error('Rows lack verifiable public source links');
    console.log(JSON.stringify({ status: "ok", count: formatted.length, results: formatted, evidence }, null, 2));
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
