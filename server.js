// SiteSprint v10 — Real Google + AI-unique sites + Auth + Export
require("dotenv").config();
const express   = require("express");
const cors      = require("cors");
const { Pool }  = require("pg");
const Anthropic = require("@anthropic-ai/sdk");
const bcrypt    = require("bcryptjs");
const jwt       = require("jsonwebtoken");

const app  = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "2mb" }));

const ai   = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });
const GKEY = process.env.GOOGLE_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET || "DEV-INSECURE-CHANGE-ME-IN-PRODUCTION";
if (JWT_SECRET === "DEV-INSECURE-CHANGE-ME-IN-PRODUCTION") {
  console.warn("⚠️  JWT_SECRET not set — using insecure default. Set a long random string in Railway env vars.");
}
const JWT_EXPIRES_IN = "30d";

// ─── DB INIT ──────────────────────────────────────────────────────────────────
async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS businesses (
    id SERIAL PRIMARY KEY,
    place_id TEXT,
    name TEXT NOT NULL,
    address TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    category TEXT DEFAULT '',
    rating NUMERIC(2,1) DEFAULT 0,
    review_count INT DEFAULT 0,
    hours_json JSONB DEFAULT '[]'::jsonb,
    website TEXT DEFAULT '',
    google_url TEXT DEFAULT '',
    photos_json JSONB DEFAULT '[]'::jsonb,
    reviews_json JSONB DEFAULT '[]'::jsonb,
    description TEXT DEFAULT '',
    location_lat NUMERIC,
    location_lng NUMERIC,
    status TEXT DEFAULT 'prospect',
    notes TEXT DEFAULT '',
    area_searched TEXT DEFAULT '',
    preview_slug TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );`);

  // Safe migrations for existing DBs
  const cols = [
    ["place_id", "TEXT"],
    ["photos_json", "JSONB DEFAULT '[]'::jsonb"],
    ["reviews_json", "JSONB DEFAULT '[]'::jsonb"],
    ["hours_json", "JSONB DEFAULT '[]'::jsonb"],
    ["description", "TEXT DEFAULT ''"],
    ["location_lat", "NUMERIC"],
    ["location_lng", "NUMERIC"],
    ["preview_slug", "TEXT DEFAULT ''"],
    ["google_url", "TEXT DEFAULT ''"],
    ["notes", "TEXT DEFAULT ''"],
  ];
  for (const [c, t] of cols) {
    try { await pool.query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS ${c} ${t};`); }
    catch (e) { console.warn(`migrate ${c}:`, e.message); }
  }

  await pool.query(`CREATE TABLE IF NOT EXISTS generated_sites (
    id SERIAL PRIMARY KEY,
    business_id INT REFERENCES businesses(id) ON DELETE CASCADE,
    slug TEXT UNIQUE NOT NULL,
    html TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );`);

  // Photo cache — every Google photo is downloaded once and served from DB forever
  // after. Eliminates repeat Google API calls and decouples uptime from Google quota.
  await pool.query(`CREATE TABLE IF NOT EXISTS photo_cache (
    ref TEXT PRIMARY KEY,
    content_type TEXT DEFAULT 'image/jpeg',
    bytes BYTEA NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );`);

  // Place Details cache — caches the full Google Places result per place_id.
  // Hugely reduces cost: searching the same area twice = nearly free.
  await pool.query(`CREATE TABLE IF NOT EXISTS place_details_cache (
    place_id TEXT PRIMARY KEY,
    details_json JSONB NOT NULL,
    is_full BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );`);

  // Users — authentication. First user to register becomes admin; after that
  // only admins can create new users (open registration is auto-closed).
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT DEFAULT '',
    role TEXT NOT NULL DEFAULT 'user',
    created_at TIMESTAMPTZ DEFAULT NOW()
  );`);

  // Client editor: each generated site can have an opt-in editor token
  // and a JSONB blob of text/image overrides applied at serve/export time.
  await pool.query(`ALTER TABLE generated_sites ADD COLUMN IF NOT EXISTS edit_token TEXT UNIQUE;`);
  await pool.query(`ALTER TABLE generated_sites ADD COLUMN IF NOT EXISTS edit_overrides JSONB DEFAULT '{}'::jsonb;`);
  await pool.query(`ALTER TABLE generated_sites ADD COLUMN IF NOT EXISTS edit_updated_at TIMESTAMPTZ;`);

  // Image uploads from the client editor (small images, stored as bytes)
  await pool.query(`CREATE TABLE IF NOT EXISTS editor_uploads (
    id TEXT PRIMARY KEY,                -- random short id used in URL
    site_id INT REFERENCES generated_sites(id) ON DELETE CASCADE,
    content_type TEXT DEFAULT 'image/jpeg',
    bytes BYTEA NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );`);
  console.log("✅ DB ready");
}

// ─── GOOGLE PLACES HELPERS ────────────────────────────────────────────────────
async function gfetch(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`Google HTTP ${r.status}`);
  return r.json();
}

async function placesTextSearch(query, pageToken = null) {
  let url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${GKEY}&language=en`;
  if (pageToken) url += `&pagetoken=${pageToken}`;
  const d = await gfetch(url);
  if (d.status !== "OK" && d.status !== "ZERO_RESULTS")
    throw new Error(`TextSearch ${d.status}: ${d.error_message || ""}`);
  return { results: d.results || [], nextPageToken: d.next_page_token };
}

async function placesFindPlace(query) {
  const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(query)}&inputtype=textquery&fields=place_id,name,formatted_address&key=${GKEY}`;
  const d = await gfetch(url);
  if (d.status !== "OK" && d.status !== "ZERO_RESULTS")
    throw new Error(`FindPlace ${d.status}`);
  return d.candidates?.[0] || null;
}

// Multi-page Text Search — fetches up to 60 results via next_page_token
async function placesTextSearchMultiPage(query, maxPages = 3) {
  const all = [];
  let pageToken = null;
  for (let i = 0; i < maxPages; i++) {
    if (pageToken) await new Promise(r => setTimeout(r, 2000)); // token must mature ~2s
    const { results, nextPageToken } = await placesTextSearch(query, pageToken);
    all.push(...results);
    if (!nextPageToken) break;
    pageToken = nextPageToken;
  }
  return all;
}

// FULL Place Details — used at BUILD time. Includes Atmosphere SKU (reviews, rating).
// Cost: $0.062 per call (Basic + Contact + Atmosphere)
const DETAILS_FIELDS_FULL = "place_id,name,formatted_address,formatted_phone_number,international_phone_number,rating,user_ratings_total,opening_hours,website,types,reviews,editorial_summary,business_status,geometry,photos,url";
// BASIC Place Details — used during DISCOVER to filter by website only. Skips Atmosphere SKU.
// Cost: $0.037 per call (Basic + Contact only). ~40% cheaper than full.
const DETAILS_FIELDS_BASIC = "place_id,name,formatted_address,formatted_phone_number,website,business_status,types,photos,opening_hours,geometry,url";

async function placeDetails(placeId, { full = true, useCache = true } = {}) {
  // Try cache first when allowed (and the cached entry meets our 'full' requirement)
  if (useCache) {
    try {
      const r = await pool.query(
        "SELECT details_json, is_full FROM place_details_cache WHERE place_id=$1",
        [placeId]
      );
      if (r.rows.length) {
        const row = r.rows[0];
        // Cached entry satisfies our request if: we asked for basic, OR cached is full
        if (!full || row.is_full) {
          return row.details_json;
        }
      }
    } catch (e) {
      console.warn("details cache read failed:", e.message);
    }
  }

  // Cache miss — fetch from Google
  const fields = full ? DETAILS_FIELDS_FULL : DETAILS_FIELDS_BASIC;
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=${fields}&key=${GKEY}&language=en&reviews_no_translations=true`;
  const d = await gfetch(url);
  if (d.status !== "OK") throw new Error(`Details ${d.status}: ${d.error_message || ""}`);
  const result = d.result;

  // Persist to cache (upsert; full data wins over basic if it exists)
  try {
    await pool.query(
      `INSERT INTO place_details_cache (place_id, details_json, is_full)
       VALUES ($1, $2, $3)
       ON CONFLICT (place_id) DO UPDATE SET
         details_json = CASE WHEN EXCLUDED.is_full OR NOT place_details_cache.is_full
                              THEN EXCLUDED.details_json ELSE place_details_cache.details_json END,
         is_full = place_details_cache.is_full OR EXCLUDED.is_full,
         created_at = NOW()`,
      [placeId, result, full]
    );
  } catch (e) {
    console.warn("details cache write failed:", e.message);
  }

  return result;
}

function mapCategory(types = [], name = "") {
  const t = (types.join(" ") + " " + name).toLowerCase();
  if (/hair|beauty|salon|nail|spa|barber/.test(t))            return "Salon & Spa";
  if (/dentist|dental|orthodont/.test(t))                     return "Dental";
  if (/car_repair|auto_repair|mechanic|car_wash|tire/.test(t))return "Auto Repair";
  if (/restaurant|food|meal_takeaway|bakery|pizza/.test(t))   return "Restaurant";
  if (/gym|fitness|yoga|crossfit/.test(t))                    return "Gym & Fitness";
  if (/cafe|coffee/.test(t))                                  return "Cafe & Coffee";
  if (/lodging|hotel|motel|inn/.test(t))                      return "Hotel";
  if (/doctor|hospital|clinic|physician|medical/.test(t))     return "Medical";
  if (/lawyer|attorney|legal/.test(t))                        return "Legal";
  if (/real_estate/.test(t))                                  return "Real Estate";
  if (/school|university|education/.test(t))                  return "Education";
  if (/clean/.test(t))                                        return "Cleaning";
  if (/plumb/.test(t))                                        return "Plumbing";
  if (/electric/.test(t))                                     return "Electrician";
  if (/roof/.test(t))                                         return "Roofing";
  if (/landscap|lawn/.test(t))                                return "Landscaping";
  if (/pet|veterinar/.test(t))                                return "Pet Services";
  if (/laundry|dry_clean/.test(t))                            return "Laundry";
  if (/store|shop|grocer|market/.test(t))                     return "Retail";
  return "Local Business";
}

// Shape a Place Details result into the business object we use everywhere
function shapeBusiness(p) {
  const photos = (p.photos || []).slice(0, 10).map(ph =>
    `/photo?ref=${encodeURIComponent(ph.photo_reference)}&w=1600`
  );
  const reviews = (p.reviews || []).map(r => ({
    name:   r.author_name,
    rating: r.rating,
    text:   (r.text || "").slice(0, 500),
    time:   r.relative_time_description || "",
    profile_photo: r.profile_photo_url || "",
  }));
  return {
    place_id:      p.place_id,
    name:          p.name,
    address:       p.formatted_address || "",
    phone:         p.formatted_phone_number || p.international_phone_number || "",
    rating:        p.rating || 0,
    review_count:  p.user_ratings_total || 0,
    hours:         p.opening_hours?.weekday_text || [],
    website:       p.website || "",
    google_url:    p.url || "",
    category:      mapCategory(p.types || [], p.name),
    description:   p.editorial_summary?.overview || "",
    photos,
    reviews,
    location:      p.geometry?.location || null,
    open_now:      p.opening_hours?.open_now ?? null,
  };
}

// ─── URL RESOLUTION ───────────────────────────────────────────────────────────
async function resolveGoogleUrl(url) {
  try {
    const r = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(10000),
    });
    return r.url;
  } catch (e) {
    console.error("URL resolve failed:", e.message);
    return url;
  }
}

function extractPlaceIdFromUrl(url) {
  // ChIJ format inside data param
  const m1 = url.match(/!1s(ChIJ[A-Za-z0-9_-]+)/);
  if (m1) return m1[1];
  // ?place_id= or &place_id=
  const m2 = url.match(/[?&]place_id=([A-Za-z0-9_-]+)/);
  if (m2) return m2[1];
  // place_id in any segment (rare)
  const m3 = url.match(/place_id[=:]([A-Za-z0-9_-]{20,})/);
  if (m3) return m3[1];
  return null;
}

function extractCoordsFromUrl(url) {
  // @lat,lng,zoom
  const m = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
  // !3d{lat}!4d{lng}
  const m2 = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (m2) return { lat: parseFloat(m2[1]), lng: parseFloat(m2[2]) };
  // ll=lat,lng (older format)
  const m3 = url.match(/[?&]ll=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m3) return { lat: parseFloat(m3[1]), lng: parseFloat(m3[2]) };
  // q=lat,lng (rare)
  const m4 = url.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m4) return { lat: parseFloat(m4[1]), lng: parseFloat(m4[2]) };
  return null;
}

function extractNameFromUrl(url) {
  // /place/Name/ or /place/Name@
  const m1 = url.match(/\/place\/([^/@?]+)/);
  if (m1) {
    const n = decodeURIComponent(m1[1].replace(/\+/g, " "));
    if (n && !n.match(/^-?\d+\.\d+,-?\d+\.\d+$/)) return n;  // skip if it's just coordinates
  }
  // /search/Name
  const m2 = url.match(/\/search\/([^/@?]+)/);
  if (m2) {
    const n = decodeURIComponent(m2[1].replace(/\+/g, " "));
    if (n) return n;
  }
  // ?q=Name or &q=Name (Google Maps search style)
  const m3 = url.match(/[?&]q=([^&]+)/);
  if (m3) {
    const n = decodeURIComponent(m3[1].replace(/\+/g, " "));
    // skip if q is just coordinates
    if (n && !n.match(/^-?\d+\.\d+,-?\d+\.\d+$/)) return n;
  }
  // ?query=Name
  const m4 = url.match(/[?&]query=([^&]+)/);
  if (m4) return decodeURIComponent(m4[1].replace(/\+/g, " "));
  return null;
}

// Last-resort: fetch the page HTML and pull the business name from <title> or og:title.
// Works for share.google, maps.app.goo.gl, and the new Google Maps interface that doesn't
// embed place_id in the URL anymore.
async function scrapePageForName(url) {
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(10000),
    });
    const html = await r.text();
    // Try og:title first (cleanest)
    const og = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i)
            || html.match(/<meta\s+content=["']([^"']+)["']\s+property=["']og:title["']/i);
    if (og) {
      const clean = og[1].replace(/\s*[-·|]\s*Google\s*Maps?\s*$/i, "").trim();
      if (clean) return clean;
    }
    // <title> fallback
    const ti = html.match(/<title>([^<]+)<\/title>/i);
    if (ti) {
      const clean = ti[1].replace(/\s*[-·|]\s*Google\s*Maps?\s*$/i, "").trim();
      if (clean && !clean.toLowerCase().startsWith("google maps")) return clean;
    }
    // og:url often contains the real Maps URL even when the document URL doesn't
    const ogUrl = html.match(/<meta\s+property=["']og:url["']\s+content=["']([^"']+)["']/i);
    if (ogUrl) {
      const innerName = extractNameFromUrl(ogUrl[1]);
      if (innerName) return innerName;
    }
    return null;
  } catch (e) {
    console.warn("scrape failed:", e.message);
    return null;
  }
}

async function urlToPlaceId(url) {
  console.log("🔗 Input URL:", url.slice(0, 200));
  const resolved = await resolveGoogleUrl(url);
  console.log("📍 Resolved:", resolved.slice(0, 250));

  // 1) Direct place_id in URL
  let placeId = extractPlaceIdFromUrl(resolved);
  if (placeId) {
    console.log("✅ Found place_id directly:", placeId);
    return placeId;
  }

  // 2) Name + coords from URL → FindPlace
  const name = extractNameFromUrl(resolved);
  const coords = extractCoordsFromUrl(resolved);

  if (name) {
    const q = coords ? `${name} near ${coords.lat},${coords.lng}` : name;
    console.log("🔍 FindPlace fallback (from URL):", q);
    try {
      const c = await placesFindPlace(q);
      if (c?.place_id) {
        console.log("✅ FindPlace succeeded:", c.place_id);
        return c.place_id;
      }
    } catch (e) { console.warn("FindPlace failed:", e.message); }
  }

  // 3) Scrape the page itself for the business name
  console.log("🕷️ Trying HTML scrape for business name...");
  const scrapedName = await scrapePageForName(resolved);
  if (scrapedName) {
    console.log("✅ Scraped name:", scrapedName);
    const q = coords ? `${scrapedName} near ${coords.lat},${coords.lng}` : scrapedName;
    try {
      const c = await placesFindPlace(q);
      if (c?.place_id) {
        console.log("✅ FindPlace with scraped name succeeded:", c.place_id);
        return c.place_id;
      }
    } catch (e) { console.warn("FindPlace (scraped) failed:", e.message); }
  }

  throw new Error(`Couldn't extract a place from this URL. Resolved to: ${resolved.slice(0, 120)}${resolved.length > 120 ? "..." : ""}. Try copying the URL after the page fully loads, or use Discover and search by name.`);
}

// ─── CLIENT EDITOR HELPERS ────────────────────────────────────────────────────
// 1) Post-process generated HTML to mark editable elements with data-edit-id.
//    Runs after AI generates the site. Targets headings, paragraphs, and images.
function addEditMarkers(html) {
  let textIdx = 0;
  let imgIdx  = 0;

  // Heading/paragraph/quote tags with simple text content (no nested elements with text)
  html = html.replace(
    /<(h[1-6]|p|blockquote|cite|q|figcaption|li)(\s[^>]*?)?>([^<]{2,400})<\/\1>/gi,
    (match, tag, attrs = "", text) => {
      if (attrs.includes("data-edit-id")) return match;
      const trimmed = text.trim();
      if (!trimmed || /^[\d\s.,$%★]+$/.test(trimmed)) return match; // skip pure numbers/symbols
      const id = `text-${++textIdx}`;
      return `<${tag}${attrs} data-edit-id="${id}">${text}</${tag}>`;
    }
  );

  // Spans inside that contain only text (often used for inline emphasis).
  // Skip spans that look like they might be split-text targets (e.g. .char .word .split)
  // to avoid the AI's split-animation JS mangling our data-edit-id attributes.
  const SPLIT_HINT_RE = /class\s*=\s*["'][^"']*\b(?:char|word|split|letter|reveal|gsap-split|hero-title)\b/i;
  html = html.replace(
    /<(span|strong|em|a)(\s[^>]*?)?>([^<]{3,200})<\/\1>/gi,
    (match, tag, attrs = "", text) => {
      if (attrs.includes("data-edit-id")) return match;
      if (SPLIT_HINT_RE.test(attrs)) return match;  // don't tag elements likely to get JS-split
      const trimmed = text.trim();
      if (!trimmed || trimmed.length < 3) return match;
      if (/^[\d\s.,$%★]+$/.test(trimmed)) return match;
      const id = `text-${++textIdx}`;
      return `<${tag}${attrs} data-edit-id="${id}">${text}</${tag}>`;
    }
  );

  // Images
  html = html.replace(/<img(\s[^>]*?)?>/gi, (match, attrs = "") => {
    if (attrs.includes("data-edit-id")) return match;
    const id = `img-${++imgIdx}`;
    return `<img${attrs} data-edit-id="${id}">`;
  });

  return html;
}

// 2) Extract list of editable elements (for the editor UI sidebar)
function extractEditables(html) {
  const items = [];
  // Text elements
  const textRe = /<([a-z0-9]+)([^>]*data-edit-id="(text-\d+)"[^>]*)>([^<]*)<\/\1>/gi;
  let m;
  while ((m = textRe.exec(html))) {
    const tag = m[1].toLowerCase();
    const id = m[3];
    const text = m[4].trim();
    if (!text) continue;
    items.push({
      id, type: "text", tag,
      value: text,
      preview: text.slice(0, 80) + (text.length > 80 ? "…" : ""),
    });
  }
  // Image elements
  const imgRe = /<img([^>]*data-edit-id="(img-\d+)"[^>]*)>/gi;
  while ((m = imgRe.exec(html))) {
    const attrs = m[1];
    const id = m[2];
    const srcMatch = attrs.match(/\bsrc=["']([^"']+)["']/);
    items.push({
      id, type: "image",
      value: srcMatch ? srcMatch[1] : "",
    });
  }
  return items;
}

// 3) Apply overrides (text + image) to the saved HTML
function applyEditOverrides(html, overrides = {}) {
  if (!overrides || !Object.keys(overrides).length) return html;
  for (const [id, value] of Object.entries(overrides)) {
    if (value == null || value === "") continue;
    if (id.startsWith("text-")) {
      // Replace inner text of element with this data-edit-id
      const re = new RegExp(
        `(<[a-z0-9]+[^>]*data-edit-id="${id}"[^>]*>)([^<]*)(<\\/[a-z0-9]+>)`,
        "i"
      );
      html = html.replace(re, (m, openTag, _oldText, closeTag) => {
        const safe = String(value).replace(/</g, "&lt;").replace(/>/g, "&gt;");
        return `${openTag}${safe}${closeTag}`;
      });
    } else if (id.startsWith("img-")) {
      // Replace src attribute on the image with this data-edit-id
      const re = new RegExp(`<img([^>]*data-edit-id="${id}"[^>]*)>`, "i");
      html = html.replace(re, (m, attrs) => {
        const cleaned = attrs.replace(/\s+src=["'][^"']*["']/i, "");
        return `<img src="${value}"${cleaned}>`;
      });
    }
  }
  return html;
}

// 4) Random URL-safe token (for editor links)
function randomToken(len = 24) {
  return require("crypto").randomBytes(len).toString("base64url");
}

// 1×1 transparent PNG — sent when Google fails so the browser never shows a broken icon
const TRANSPARENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);
function sendTransparentPNG(res) {
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "public, max-age=60"); // short TTL so it auto-retries
  return res.send(TRANSPARENT_PNG);
}

// Fetch+cache a single photo. Returns { ok, contentType, bytes } or null on failure.
async function fetchAndCachePhoto(ref, width = 1600) {
  if (!ref || !GKEY) return null;
  try {
    const url = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=${width}&photoreference=${encodeURIComponent(ref)}&key=${GKEY}`;
    const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15000) });
    if (!r.ok) {
      console.warn(`📷 ${ref.slice(0, 20)}... → Google HTTP ${r.status}`);
      return null;
    }
    const ct = r.headers.get("content-type") || "image/jpeg";
    if (!ct.startsWith("image/")) {
      console.warn(`📷 ${ref.slice(0, 20)}... → non-image content-type: ${ct}`);
      return null;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    // Persist to DB cache (upsert)
    try {
      await pool.query(
        `INSERT INTO photo_cache (ref, content_type, bytes) VALUES ($1, $2, $3)
         ON CONFLICT (ref) DO UPDATE SET bytes=EXCLUDED.bytes, content_type=EXCLUDED.content_type, created_at=NOW()`,
        [ref, ct, buf]
      );
    } catch (e) {
      console.warn("photo cache write failed:", e.message);
    }
    return { ok: true, contentType: ct, bytes: buf };
  } catch (e) {
    console.warn(`📷 ${ref.slice(0, 20)}... → fetch error: ${e.message}`);
    return null;
  }
}

// ─── PHOTO PROXY (DB-cached; only hits Google on first miss) ──────────────────
app.get("/photo", async (req, res) => {
  try {
    const { ref, w = 1600 } = req.query;
    if (!ref) return sendTransparentPNG(res);

    // 1. Try DB cache first — zero Google calls if hit
    try {
      const cached = await pool.query(
        "SELECT content_type, bytes FROM photo_cache WHERE ref=$1",
        [ref]
      );
      if (cached.rows.length) {
        res.setHeader("Content-Type", cached.rows[0].content_type || "image/jpeg");
        res.setHeader("Cache-Control", "public, max-age=2592000, immutable");
        return res.send(cached.rows[0].bytes);
      }
    } catch (e) {
      console.warn("photo cache read failed:", e.message);
    }

    // 2. Cache miss — fetch from Google, cache, serve
    const result = await fetchAndCachePhoto(ref, w);
    if (!result) return sendTransparentPNG(res);
    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Cache-Control", "public, max-age=2592000, immutable");
    res.send(result.bytes);
  } catch (e) {
    console.warn("📷 photo proxy error:", e.message);
    sendTransparentPNG(res);
  }
});

// Pre-warm cache at build time. Downloads each photo once and caches it.
// Returns the proxy URLs of photos that successfully cached.
async function prefetchPhotos(photoUrls) {
  if (!photoUrls?.length) return [];

  const tasks = photoUrls.map(async (proxyUrl) => {
    // Manual-entry photos are stored locally as /editor-upload/X.
    // They don't go through the Google photo cache — they're already in our DB.
    // Just pass them through if the upload row exists.
    if (proxyUrl.startsWith("/editor-upload/")) {
      const id = proxyUrl.replace(/^\/editor-upload\//, "").split(/[?#]/)[0];
      try {
        const r = await pool.query("SELECT 1 FROM editor_uploads WHERE id=$1 LIMIT 1", [id]);
        return { url: proxyUrl, ok: r.rows.length > 0 };
      } catch {
        return { url: proxyUrl, ok: false };
      }
    }

    // Google photos use /photo?ref=X — extract the ref and prefetch.
    const m = proxyUrl.match(/[?&]ref=([^&]+)/);
    if (!m) return { url: proxyUrl, ok: false };
    const ref = decodeURIComponent(m[1]);

    // Already cached? skip Google entirely.
    try {
      const r = await pool.query("SELECT 1 FROM photo_cache WHERE ref=$1 LIMIT 1", [ref]);
      if (r.rows.length) return { url: proxyUrl, ok: true };
    } catch {}

    const result = await fetchAndCachePhoto(ref, 1600);
    return { url: proxyUrl, ok: !!result };
  });

  const results = await Promise.all(tasks);
  const valid = results.filter(r => r.ok).map(r => r.url);
  console.log(`📸 prefetch: ${valid.length}/${photoUrls.length} photos cached/validated`);
  return valid;
}

// Post-processing safety net: replace any /photo?ref=X URL not in our valid list
// with a cycled valid one (covers any URLs Claude invented or that became invalid later)
function bulletproofImages(html, validPhotos) {
  if (!validPhotos?.length) return html;
  const validSet = new Set(validPhotos);
  let i = 0;
  const cycle = () => validPhotos[i++ % validPhotos.length];
  let swapped = 0;

  // <img src="...">
  html = html.replace(/<img\b([^>]*?)\bsrc=(["'])([^"']+)\2/gi, (m, attrs, q, url) => {
    if (url.includes("/photo?ref=") && !validSet.has(url)) {
      swapped++;
      return `<img${attrs}src=${q}${cycle()}${q}`;
    }
    return m;
  });
  // CSS url('...') in inline styles or <style> blocks
  html = html.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, url) => {
    if (url.includes("/photo?ref=") && !validSet.has(url)) {
      swapped++;
      return `url('${cycle()}')`;
    }
    return m;
  });
  if (swapped) console.log(`🛡️  bulletproofImages: swapped ${swapped} invalid image references`);
  return html;
}

// ─── DESIGN SYSTEMS ───────────────────────────────────────────────────────────
// 15 distinct, professionally-chosen palettes + font pairings.
// Each site deterministically gets one based on its place_id (hash → index),
// so two different businesses NEVER get the same look, but rebuilding the same
// business gives the same family (consistent brand identity).
const DESIGN_SYSTEMS = [
  {
    id: "editorial-mono",
    name: "Editorial Black & White",
    mood: "High-end fashion magazine. Lots of whitespace. Monochrome with one bold accent. Drop caps, pull quotes, asymmetric grids.",
    palette: { bg: "#FAFAF7", surface: "#FFFFFF", ink: "#0A0A0A", muted: "#71717A", border: "#E4E4E7", accent: "#DC2626" },
    fonts: { display: "Fraunces", body: "Inter" },
    flavor: "Use Fraunces in italic for display headlines (clamp 4-9rem). Inter 400/500 for body. Single red accent reserved for emphasis only.",
  },
  {
    id: "sage-botanical",
    name: "Soft Sage Botanical",
    mood: "Organic, calm, premium plant-inspired. Curved shapes, soft edges, generous breathing room.",
    palette: { bg: "#F5F3EE", surface: "#FFFFFF", ink: "#1F2421", muted: "#5B6359", border: "#D9D5CB", accent: "#5A7C5A" },
    fonts: { display: "Cormorant Garamond", body: "Manrope" },
    flavor: "Cormorant in light/300 for elegant display. Manrope for clean body. Organic SVG blob shapes as decorative elements. Botanical feel without literal plants.",
  },
  {
    id: "coastal-teal",
    name: "Coastal Modern Teal",
    mood: "Refined, ocean-inspired, sophisticated. Like a high-end resort brand. Sand and water tones.",
    palette: { bg: "#F4F1EC", surface: "#FAF8F5", ink: "#1A2F38", muted: "#4A6470", border: "#D5CFC4", accent: "#2C7A8C" },
    fonts: { display: "DM Serif Display", body: "DM Sans" },
    flavor: "DM Serif Display large and tight. DM Sans for everything else. Subtle wave-shaped clip-paths or section dividers.",
  },
  {
    id: "sunset-coral",
    name: "Sunset Coral",
    mood: "Warm but VIBRANT, not brown. Sunset orange-pink-coral palette. Hand-crafted, energetic, joyful.",
    palette: { bg: "#FFF8F4", surface: "#FFFFFF", ink: "#2D1B14", muted: "#8B6F5C", border: "#F5E6DB", accent: "#EE6C4D" },
    fonts: { display: "Playfair Display", body: "Lato" },
    flavor: "Playfair italic for romantic display. Lato for body. Gradient accents using #EE6C4D → #F4A261. Curved underlines and circle motifs.",
  },
  {
    id: "industrial-yellow",
    name: "Industrial Steel + Caution Yellow",
    mood: "Dark mode. Workshop floor energy. Heavy machinery vibe. Bold, masculine, technical.",
    palette: { bg: "#0F0F0F", surface: "#1A1A1A", ink: "#F5F5F5", muted: "#A1A1AA", border: "#27272A", accent: "#FACC15" },
    fonts: { display: "Bebas Neue", body: "Barlow" },
    flavor: "Bebas Neue MASSIVE and condensed. Barlow for body. Diagonal stripe section dividers. Monospace numbers (JetBrains Mono) for stats.",
  },
  {
    id: "cobalt-tech",
    name: "Cobalt Modern Tech",
    mood: "Crisp, intelligent, premium tech brand feel. Like Linear or Vercel design language. Lots of whitespace.",
    palette: { bg: "#FAFAFA", surface: "#FFFFFF", ink: "#0A0E27", muted: "#4B5563", border: "#E5E7EB", accent: "#1E40AF" },
    fonts: { display: "Space Grotesk", body: "Inter" },
    flavor: "Space Grotesk at heavy weights for display. Inter for body. Subtle grid lines. Sharp 4-8px corners (not rounded). Pixel-perfect alignment.",
  },
  {
    id: "oxblood-vintage",
    name: "Oxblood Vintage Heritage",
    mood: "Old-school barbershop / heritage brand / Brooklyn craftsman. Established, masculine, classic.",
    palette: { bg: "#F2EDE5", surface: "#FFFAF0", ink: "#1A1410", muted: "#6B5847", border: "#D9D0BF", accent: "#722F37" },
    fonts: { display: "Playfair Display", body: "Lato" },
    flavor: "Playfair bold serif. Lato body. Decorative ornaments (✦ ✧ ◆) as separators. Established-in date as a badge.",
  },
  {
    id: "forest-premium",
    name: "Deep Forest Premium",
    mood: "Hushed, expensive, refined. Like a Michelin restaurant or premium spa. Deep greens with cream.",
    palette: { bg: "#F7F5F0", surface: "#FFFFFF", ink: "#0F1F17", muted: "#5B6359", border: "#DDD8CC", accent: "#1B4332" },
    fonts: { display: "Cormorant", body: "Inter" },
    flavor: "Cormorant LIGHT weight, very thin. Inter for body. Heavy negative space. Gold-thin underlines under accents.",
  },
  {
    id: "electric-plum",
    name: "Electric Plum",
    mood: "Confident, artistic, slightly avant-garde. Purple as the hero color, not just accent.",
    palette: { bg: "#FAFAFA", surface: "#FFFFFF", ink: "#1F0033", muted: "#6B5B7A", border: "#E5E0EC", accent: "#7E22CE" },
    fonts: { display: "Outfit", body: "Lora" },
    flavor: "Outfit black 900 for huge display. Lora italic for pull quotes. Purple gradient washes on photos using mix-blend-mode.",
  },
  {
    id: "terracotta-mexican",
    name: "Terracotta + Cobalt Mexican Modern",
    mood: "Vibrant, sun-soaked, papel picado energy. For taquerias, Latin businesses, anything joyful.",
    palette: { bg: "#FBF6EE", surface: "#FFFFFF", ink: "#2C1810", muted: "#8B5E3C", border: "#EDDFCA", accent: "#C1452F", accent2: "#1E40AF" },
    fonts: { display: "Archivo Black", body: "Inter" },
    flavor: "Archivo Black MASSIVE. Inter body. Use BOTH terracotta AND cobalt as duo-accents. SVG papel-picado / sun motifs. Playful.",
  },
  {
    id: "monochrome-luxe",
    name: "Monochrome Luxe",
    mood: "Pure white + pure black. Zero color. Achieves impact through scale, type, and texture only.",
    palette: { bg: "#FFFFFF", surface: "#FAFAFA", ink: "#000000", muted: "#525252", border: "#E5E5E5", accent: "#000000" },
    fonts: { display: "Instrument Serif", body: "Inter" },
    flavor: "Instrument Serif HUGE for display (clamp 5-12rem). Inter for everything else. No colors — use weight, scale, and noise/grain texture for impact.",
  },
  {
    id: "midnight-gold",
    name: "Midnight + Gold Luxury",
    mood: "Dark mode luxury. Champagne gold accents. Like a hotel bar or members club brand.",
    palette: { bg: "#0A0A0A", surface: "#141414", ink: "#FAFAFA", muted: "#A1A1AA", border: "#262626", accent: "#D4AF37" },
    fonts: { display: "Cormorant", body: "Inter" },
    flavor: "Cormorant in italic light. Inter for body. Hairline gold borders. Subtle gold-on-black hover states. Whisper-quiet, not loud.",
  },
  {
    id: "blush-boutique",
    name: "Soft Blush Boutique",
    mood: "Feminine, boutique-luxe, modern romance. For salons, beauty, florals — but elevated, not cutesy.",
    palette: { bg: "#FAF5F2", surface: "#FFFFFF", ink: "#2D1B26", muted: "#9B7E8E", border: "#EAD9D9", accent: "#C9748B" },
    fonts: { display: "Fraunces", body: "Manrope" },
    flavor: "Fraunces with italic display variant. Manrope body. Soft drop shadows. Rounded image masks (organic blob clip-paths).",
  },
  {
    id: "brutalist-alarm",
    name: "Brutalist Concrete + Alarm Orange",
    mood: "Raw, intentional, anti-design. Grid lines visible. Monospace. Striking, NOT corporate.",
    palette: { bg: "#EDEDED", surface: "#FFFFFF", ink: "#000000", muted: "#525252", border: "#000000", accent: "#FF3300" },
    fonts: { display: "Space Grotesk", body: "Space Mono" },
    flavor: "Space Grotesk at black 900 weight. Space Mono for body and numbers. Hard 1px black borders everywhere. Raw, unstyled <hr>. No border-radius anywhere.",
  },
  {
    id: "midcentury-mustard",
    name: "Mid-century Mustard + Teal",
    mood: "1950s modernist. Eames-era. Geometric shapes, mustard, teal, cream. Like a vintage travel poster.",
    palette: { bg: "#F4EFE0", surface: "#FFFAF0", ink: "#1F2A2E", muted: "#5C6B6F", border: "#D8CFB8", accent: "#E0A800", accent2: "#2E797F" },
    fonts: { display: "Fraunces", body: "Inter" },
    flavor: "Fraunces wide width. Inter body. Geometric SVG shapes (circles, semicircles, lines) as decoration. Use BOTH mustard AND teal.",
  },
];

// Deterministic seeded selector: same place_id always picks the same system,
// but two different businesses get different systems.
function pickDesignSystem(seed) {
  const s = String(seed || Math.random());
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  return DESIGN_SYSTEMS[Math.abs(hash) % DESIGN_SYSTEMS.length];
}

// ─── AI: STAGE 1 — CONTENT PLAN (cheap, focused JSON output) ─────────────────
// Generates a structured content plan that the HTML stage MUST use verbatim.
// This eliminates the "AI builds beautiful empty sections" failure mode:
// content is no longer optional — it's already written when the HTML stage starts.
async function generateContentPlan(biz) {
  const isManual = !biz.review_count && !biz.rating;
  const reviewsList = (biz.reviews || [])
    .filter(r => Number(r.rating) === 5)
    .slice(0, 6)
    .map(r => `${r.name}: "${(r.text || "").slice(0, 240)}"`)
    .join("\n");

  // For manual entries, the user can give us authoritative content directly.
  // Pull it out so we can construct a prompt section that tells the AI to USE it verbatim.
  const meta = biz._manual_meta || {};
  const userServicesBlock = (meta.services || []).length
    ? meta.services.map(s => `• ${s.name}${s.price ? ` — ${s.price}` : ""}${s.description ? ` — ${s.description}` : ""}`).join("\n")
    : "";

  const ownerBlock = meta.owner_name
    ? `Owner / Founder: ${meta.owner_name}${meta.years_in_business ? ` (in business ${meta.years_in_business} years)` : ""}`
    : (meta.years_in_business ? `Years in business: ${meta.years_in_business}` : "");

  const briefBlock = meta.site_brief
    ? `\n═══ ⚠️ SITE BRIEF — special instructions from the business owner (FOLLOW THESE CLOSELY) ═══\n${meta.site_brief}\n`
    : "";

  const prompt = `You are a senior content strategist for a top web agency. For the local business below, produce a JSON content plan that the design team will turn into a flagship website. Be specific, realistic, and on-brand for the category.

═══ BUSINESS ═══
Name: ${biz.name}
Category: ${biz.category}
Address: ${biz.address || "(none)"}
Phone: ${biz.phone || "(none)"}
Hours: ${biz.hours?.length ? biz.hours.join(" | ") : "(not listed)"}
${ownerBlock ? ownerBlock + "\n" : ""}Description: ${biz.description || "(none)"}
${isManual ? "Source: MANUAL ENTRY — no Google reviews available, generate plausible content from the description and category." : `Source: Google Places (rating ${biz.rating}★, ${biz.review_count} reviews)`}
${briefBlock}
${userServicesBlock ? `═══ ⚠️ USER-PROVIDED SERVICES (use these EXACTLY — do not invent, substitute, or omit any) ═══\n${userServicesBlock}\n\nFor the "services" array in your JSON: use these exact names. Keep prices as-given (or "Quote" if not provided). Expand descriptions if they're brief or empty, but never change the service names.\n` : ""}
═══ AVAILABLE GOOGLE REVIEWS (use verbatim where possible) ═══
${reviewsList || "(none — invent 3-4 realistic ones based on category)"}

═══ TASK ═══
Output ONLY a JSON object — no markdown, no preamble, no \`\`\` fences. Just the raw JSON. Structure:

{
  "tagline": "8-12 word headline that captures the brand essence",
  "subhead": "1-2 sentence supporting line that goes under the tagline",
  "about_paragraphs": ["paragraph 1 (~50 words)", "paragraph 2 (~50 words)"],
  "services": [
    {"name": "Service name (concise)", "price": "$XX or 'From $XX' or 'Quote'", "description": "1-2 sentence description"},
    ... ${userServicesBlock ? `(use the USER-PROVIDED services above — match the count and names EXACTLY)` : `(EXACTLY 5 services, category-appropriate, realistic pricing)`}
  ],
  "team": [
    {"name": "First name", "role": "Title like Senior Stylist / Master Barber / Owner", "bio": "1-2 sentence bio", "specialty": "what they're known for"},
    ... (EXACTLY 4-5 team members; ${meta.owner_name ? `INCLUDE "${meta.owner_name}" as the owner/founder in this list. ` : ""}extract additional names from reviews if any are mentioned by customers, otherwise invent realistic names matching the area/business type)
  ],
  "reviews": [
    {"author": "Customer name", "stars": 5, "text": "Quote (40-200 chars)"},
    ... (3-5 reviews; use VERBATIM Google reviews provided above where possible; if none, invent realistic ones)
  ],
  "stats": [
    {"value": "4.8★", "label": "Google Rating"},
    {"value": "27", "label": "5-Star Reviews"},
    {"value": "5+", "label": "Years Trusted"},
    {"value": "X", "label": "..."}
  ],
  "trust_badges": ["short trust signal 1", "short trust signal 2", "..."] (6-10 items for the marquee band),
  "contact_form_fields": [
    {"name": "name", "label": "Your Name", "type": "text", "required": true},
    {"name": "phone", "label": "Phone", "type": "tel", "required": true},
    {"name": "service", "label": "Service Interested In", "type": "select", "options": ["...service names..."]},
    {"name": "preferred_date", "label": "Preferred Date", "type": "date"},
    {"name": "message", "label": "Message", "type": "textarea"}
  ],
  "cta_primary": "Book Now / Call Today / Reserve Your Spot — pick the most natural for this category",
  "cta_secondary": "Get Directions / Learn More / View Menu — secondary action"
}

Output the raw JSON object ONLY. No surrounding text.`;

  console.log(`📝 Stage 1: generating content plan for ${biz.name}`);

  const stream = ai.messages.stream({
    model: "claude-sonnet-4-6",
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }],
  });
  const r = await stream.finalMessage();
  let raw = (r.content[0]?.text || "").trim();

  // Strip any accidental markdown fences
  raw = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();

  // Find the JSON object boundaries (defensive)
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    raw = raw.slice(firstBrace, lastBrace + 1);
  }

  let plan;
  try {
    plan = JSON.parse(raw);
  } catch (e) {
    console.error(`🔴 Stage 1: JSON parse failed for ${biz.name}:`, e.message);
    console.error("Raw output:", raw.slice(0, 500));
    throw new Error("Stage 1 produced invalid JSON: " + e.message);
  }

  console.log(`✅ Stage 1 done for ${biz.name}: ${plan.services?.length || 0} services, ${plan.team?.length || 0} team, ${plan.reviews?.length || 0} reviews`);
  return plan;
}

// Build ready-to-paste HTML snippets from the content plan.
// The Stage 2 AI must include these snippets — they're not optional data, they're literal HTML.
// This is the single most reliable way to ensure content cards never get skipped.
function htmlEscape(s) {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function initialsOf(name) {
  return String(name || "X")
    .split(/\s+/).map(p => p[0] || "").join("").slice(0, 2).toUpperCase();
}
function buildContentSnippets(plan) {
  const services = (plan.services || []).map((s, i) => {
    return `<article class="service-card" data-service-i="${i}">
  <h3 class="service-name">${htmlEscape(s.name)}</h3>
  <div class="service-price">${htmlEscape(s.price || "")}</div>
  <p class="service-description">${htmlEscape(s.description || "")}</p>
</article>`;
  }).join("\n");

  const team = (plan.team || []).map((m, i) => {
    return `<article class="team-card" data-team-i="${i}">
  <div class="team-avatar" aria-hidden="true">${htmlEscape(initialsOf(m.name))}</div>
  <h3 class="team-name">${htmlEscape(m.name)}</h3>
  <div class="team-role">${htmlEscape(m.role || "")}</div>
  <p class="team-bio">${htmlEscape(m.bio || "")}</p>${m.specialty ? `
  <div class="team-specialty">Specialty: ${htmlEscape(m.specialty)}</div>` : ""}
</article>`;
  }).join("\n");

  const reviews = (plan.reviews || []).map((r, i) => {
    return `<article class="review-card" data-review-i="${i}">
  <div class="review-stars" aria-label="${r.stars || 5} stars">${"★".repeat(r.stars || 5)}</div>
  <blockquote class="review-text">${htmlEscape(r.text)}</blockquote>
  <cite class="review-author">— ${htmlEscape(r.author)}</cite>
</article>`;
  }).join("\n");

  const stats = (plan.stats || []).map((s) => {
    return `<div class="stat-item">
  <div class="stat-value">${htmlEscape(s.value)}</div>
  <div class="stat-label">${htmlEscape(s.label)}</div>
</div>`;
  }).join("\n");

  const formFields = (plan.contact_form_fields || []).map(f => {
    if (f.type === "select") {
      const opts = (f.options || []).map(o => `    <option>${htmlEscape(o)}</option>`).join("\n");
      return `<div class="form-field">
  <label for="${f.name}">${htmlEscape(f.label)}</label>
  <select id="${f.name}" name="${f.name}"${f.required ? " required" : ""}>
    <option value="">Choose...</option>
${opts}
  </select>
</div>`;
    }
    if (f.type === "textarea") {
      return `<div class="form-field">
  <label for="${f.name}">${htmlEscape(f.label)}</label>
  <textarea id="${f.name}" name="${f.name}" rows="4"${f.required ? " required" : ""}></textarea>
</div>`;
    }
    return `<div class="form-field">
  <label for="${f.name}">${htmlEscape(f.label)}</label>
  <input type="${f.type || "text"}" id="${f.name}" name="${f.name}"${f.required ? " required" : ""}>
</div>`;
  }).join("\n");

  const trustBadges = (plan.trust_badges || []).map(b => htmlEscape(b)).join(" ★ ");

  return { services, team, reviews, stats, formFields, trustBadges };
}

// ─── AI: UNIQUE SITE GENERATOR ────────────────────────────────────────────────
async function generateUniqueHTML(biz) {
  // Pre-download all photos to DB cache. This:
  //  - Eliminates Google API calls at view time (served from DB)
  //  - Ensures we only feed Claude URLs that we KNOW will work
  const validPhotos = await prefetchPhotos(biz.photos || []);
  const photos  = validPhotos.slice(0, 10);
  // Only 5-star reviews (per user requirement)
  const reviews = (biz.reviews || []).filter(r => Number(r.rating) === 5).slice(0, 5);

  // STAGE 1: Generate concrete content plan as JSON.
  // This is the most important architectural decision: by the time Stage 2 runs,
  // all section content is already written — Stage 2 just designs and lays out.
  // This eliminates "beautiful empty sections" because content is no longer optional.
  const contentPlan = await generateContentPlan(biz);

  const reviewsBlock = reviews.length
    ? reviews.map((r, i) =>
        `R${i+1}: ${r.name} (${r.rating}★, ${r.time}): "${(r.text || "").slice(0, 280)}"`
      ).join("\n")
    : "(no 5-star Google reviews available — omit the testimonials section gracefully)";

  const photosBlock = photos.length
    ? photos.map((u, i) => `IMG${i+1}: ${u}`).join("\n")
    : "(no Google photos — use only solid colors / gradients, no broken images)";

  const hoursBlock = biz.hours?.length ? biz.hours.join(" | ") : "Hours not listed";

  // Build ready-to-paste HTML snippets from the content plan.
  // The Stage 2 AI MUST include these — they are the source of truth for content,
  // not optional reference data.
  const snippets = buildContentSnippets(contentPlan);

  // Detect manual-entry businesses (no Google reviews/rating)
  const isManual = !biz.review_count && !biz.rating;
  const ratingLine = (biz.rating > 0 && biz.review_count > 0)
    ? `Rating: ${biz.rating}★ from ${biz.review_count} Google reviews`
    : `Rating: (not available — DO NOT invent a rating or review count; do not show star ratings anywhere on the site)`;
  const sourceLine = isManual
    ? "Source: MANUAL ENTRY — business is not on Google Places. No reviews, no rating, possibly few photos. Design accordingly: lean into typography, brand color, and the description below. Skip review/rating UI entirely."
    : "Source: Google Places listing (rich data available)";

  // Deterministically pick a design system based on this business's place_id.
  // Two different businesses → different design systems → no two sites look alike.
  const ds = pickDesignSystem(biz.place_id || biz.name);
  console.log(`🎨 Design system for ${biz.name}: ${ds.name}${isManual ? " (manual entry)" : ""}`);

  const paletteBlock = `
  --bg:      ${ds.palette.bg};       /* page background */
  --surface: ${ds.palette.surface};  /* cards / panels */
  --ink:     ${ds.palette.ink};      /* primary text / headlines */
  --muted:   ${ds.palette.muted};    /* secondary text */
  --border:  ${ds.palette.border};   /* hairline dividers */
  --accent:  ${ds.palette.accent};   /* brand accent — buttons, highlights, key emphasis */${ds.palette.accent2 ? `
  --accent2: ${ds.palette.accent2};  /* secondary accent — use sparingly for variety */` : ""}`;

  const prompt = `You are an elite web designer at a top-tier creative agency. Your sites win Awwwards Site of the Day and FWA awards. A flagship site from your studio costs $15,000+. You are designing a one-off, hand-crafted luxury website for the specific local business below. When the business owner sees this site, they need to IMMEDIATELY want it for their business — it should feel impossible to refuse.

This is NOT a template. NOT a starter. NOT generic. This is a bespoke flagship.

═══ BUSINESS DATA (use exactly as-is — never invent facts) ═══
Name: ${biz.name}
Category: ${biz.category}
Address: ${biz.address || "Address not listed"}
Phone: ${biz.phone || "Phone not listed"}
${ratingLine}
Hours: ${hoursBlock}
Description: ${biz.description || "(none)"}
${sourceLine}

═══ REAL GOOGLE 5-STAR REVIEWS (use VERBATIM — these are real customers) ═══
${reviewsBlock}

═══ AVAILABLE PHOTOS (real Google Place photos — embed via these URLs) ═══
${photosBlock}

═══════════════════════════════════════════════════════════════════════════════
═══ ⚠️ PRIORITY ORDER (READ THIS FIRST — IT OVERRIDES EVERYTHING ELSE BELOW) ═══
═══════════════════════════════════════════════════════════════════════════════
When you can't fit everything, drop items from the BOTTOM of this list, NEVER the top.

PRIORITY 1 (MANDATORY — if missing, the output is REJECTED):
   ▸ EVERY item in the CONTENT PLAN below appears in the final HTML — services, team, reviews, stats, form fields, trust badges
   ▸ Services section renders ALL ${contentPlan.services?.length || 5} services as visible cards (name, price, description)
   ▸ Team section renders ALL ${contentPlan.team?.length || 4} team members as visible cards (name, role, bio, initials avatar)
   ▸ Reviews section renders ALL ${contentPlan.reviews?.length || 3} reviews as visible cards (quote, author, 5 stars)
   ▸ Contact section renders a form with the EXACT fields from contact_form_fields + visible phone/address/hours
   ▸ Stats render as a prominent band/row using the values from the plan
   ▸ Trust badges render in a marquee using the trust_badges array
   ▸ Gallery uses ALL provided photos
   ▸ Hero image visible on mobile
   ▸ Sticky bottom CTA bar on mobile
   ▸ Nav/menu text MUST be readable against its background (contrast check — see Contrast Rules below)
   ▸ Any badge/overlay positioned on an image MUST fully fit inside its container (no clipping)

PRIORITY 2 (MANDATORY for premium feel):
   ▸ Beautiful design system applied (palette, fonts, mood)
   ▸ GSAP scroll animations on key elements
   ▸ Lenis smooth scroll
   ▸ ONE Three.js hero "shock" moment (KEEP UNDER 80 LINES of JS — use a simple particle field or animated gradient mesh, not a complex scene)
   ▸ Mobile swipe carousel for gallery
   ▸ Hamburger menu for mobile nav

PRIORITY 3 (NICE TO HAVE — drop these if running tight):
   ▸ Lottie animations
   ▸ Elaborate decorative SVGs
   ▸ Complex marquee variations beyond a single band

THREE.JS BUDGET RULE: Keep the entire Three.js scene under 80 lines / 4KB of code. A simple particle field with 300 dots IS the shock factor — don't over-engineer. If you find yourself writing 200+ lines of Three.js, simplify down to particles or skip and use an SVG-based animated background instead.

═══════════════════════════════════════════════════════════════════════════════
═══ 🎨 CONTRAST RULES (the most common visual bug — DO NOT make this mistake) ═══
═══════════════════════════════════════════════════════════════════════════════
NAV / HEADER TEXT must always be readable against its background:

   ▸ If the nav sits OVER a dark hero (dark image, dark overlay, dark gradient):
     → nav text color MUST be light (#fff, --bg if light, or rgba(255,255,255,.9))
     → NEVER use --ink (which is dark) for nav text on a dark hero
   
   ▸ If the nav sits over a LIGHT background:
     → nav text uses --ink (dark)
   
   ▸ BEST PRACTICE: scroll-aware nav
     • Initial state: transparent background, light text (over dark hero)
     • After scrolling past hero (e.g., scrollY > 80): solid background (--bg or backdrop-filter: blur), --ink text
     • Add JS: window.addEventListener('scroll', () => nav.classList.toggle('scrolled', window.scrollY > 80))
   
   ▸ ABSOLUTE MINIMUM: If you don't do scroll-aware, FORCE light text on a dark hero. Test mentally: "Can I read the menu items right now?"

HERO BACKGROUND TREATMENT:
   ▸ If hero uses a photo as background, ALWAYS add a dark gradient overlay so text on top is readable:
     background-image: linear-gradient(135deg, rgba(0,0,0,.55), rgba(0,0,0,.3)), url(photo);
   ▸ Hero TEXT on dark background: white / very light
   ▸ Hero TEXT on light background: dark / --ink

═══════════════════════════════════════════════════════════════════════════════
═══ 🖼️ OVERLAY/BADGE POSITIONING (don't cut things off) ═══
═══════════════════════════════════════════════════════════════════════════════
Floating review badges, stat callouts, rating chips, or any decorative overlay placed on top of an image:

   ▸ MUST fit fully inside the parent — never clipped at edges
   ▸ Safe pattern: position: absolute; bottom: 16px; right: 16px; (positive inset)
   ▸ DANGER pattern: bottom: -20px; right: -20px; (negative inset that requires parent to NOT have overflow:hidden — easy to break)
   ▸ If you want a badge to "float outside" the image edge: parent must have overflow: visible AND enough margin around it to fit the badge
   ▸ The badge should never be cut off — test mentally: "If I screenshot this section, is the entire badge visible?"

═══════════════════════════════════════════════════════════════════════════════

${biz._manual_meta?.site_brief ? `═══════════════════════════════════════════════════════════════════════════════
═══ ⚠️ SITE BRIEF FROM THE BUSINESS OWNER (READ FIRST — FOLLOW CLOSELY) ═══
═══════════════════════════════════════════════════════════════════════════════
The business owner gave these specific instructions. They override defaults where they conflict — adjust copy tone, color emphasis, section priorities, and creative direction accordingly:

${biz._manual_meta.site_brief}

═══════════════════════════════════════════════════════════════════════════════

` : ""}═══════════════════════════════════════════════════════════════════════════════
═══ 📋 READY-TO-PASTE CONTENT (these snippets MUST appear in your HTML) ═══
═══════════════════════════════════════════════════════════════════════════════
The HTML snippets below are PRE-RENDERED. You MUST include every single one in your HTML.
You can:
   • Restyle them freely (any CSS, animations, hover states)
   • Add wrapper containers around them
   • Modify class names if needed
   • Add extra decorative elements
You CANNOT:
   • Skip any of them
   • Reduce the number of cards
   • Remove the content text (names, prices, descriptions, quotes, authors must appear)
   • Replace with placeholders or "lorem ipsum"

─── HERO CONTENT (use in your hero) ───
Tagline: ${JSON.stringify(contentPlan.tagline || "")}
Subhead: ${JSON.stringify(contentPlan.subhead || "")}
Primary CTA button text: ${JSON.stringify(contentPlan.cta_primary || "Book Now")}
Secondary CTA button text: ${JSON.stringify(contentPlan.cta_secondary || "Get Directions")}

─── ABOUT PARAGRAPHS (use in the about/story section) ───
${(contentPlan.about_paragraphs || []).map((p, i) => `Paragraph ${i+1}: ${JSON.stringify(p)}`).join("\n")}

─── TRUST MARQUEE BAND (use as scrolling text in a marquee somewhere prominent) ───
${snippets.trustBadges}

─── STATS BAND (paste ALL ${contentPlan.stats?.length || 0} into a stats row/band) ───
${snippets.stats}

─── SERVICES CARDS (paste ALL ${contentPlan.services?.length || 0} into your services section) ───
${snippets.services}

─── TEAM CARDS (paste ALL ${contentPlan.team?.length || 0} into your team section) ───
${snippets.team}

─── REVIEW CARDS (paste ALL ${contentPlan.reviews?.length || 0} into your reviews section) ───
${snippets.reviews}

─── CONTACT FORM FIELDS (paste ALL ${contentPlan.contact_form_fields?.length || 0} into your contact form) ───
${snippets.formFields}

⛔ If you skip any of the cards above, your output will be rejected and you must redo this work.
⛔ If you build a section heading (e.g. "Our Services") and then DON'T include the matching cards, your output will be rejected.
⛔ The cards above are CONTENT — restyling is fine, deleting is not.

═══════════════════════════════════════════════════════════════════════════════

═══════════════════════════════════════════════════════════════════════════════
═══ MANDATORY DESIGN SYSTEM — USE EXACTLY (NON-NEGOTIABLE) ═══
═══════════════════════════════════════════════════════════════════════════════
Aesthetic: **${ds.name}**
Mood: ${ds.mood}
Direction: ${ds.flavor}

🎨 PALETTE — Use these EXACT hex codes as CSS custom properties on :root:
:root {${paletteBlock}
}
Use --accent for ALL primary brand moments (buttons, key links, highlights). The accent IS the brand color — feature it prominently, not just as a footnote. Buttons must use it. Headlines may use it. Make this palette OBVIOUS.

📝 FONTS — Use EXACTLY these two Google Fonts (and nothing else):
   Display: "${ds.fonts.display}" → for hero, section headlines, large numbers
   Body:    "${ds.fonts.body}" → everything else (paragraphs, nav, buttons, captions)

Import via @import in <style>:
   @import url('https://fonts.googleapis.com/css2?family=${ds.fonts.display.replace(/ /g, "+")}:ital,wght@0,300;0,400;0,500;0,600;0,700;0,800;0,900;1,400&family=${ds.fonts.body.replace(/ /g, "+")}:wght@300;400;500;600;700;800&display=swap');

⛔ DO NOT swap these fonts for "Inter" or any other default. Do not invent additional fonts. The two above are the entire typeface system. Use weight + size + style for variety, not different families.

⛔ DO NOT shift the palette toward brown/amber/beige unless --accent IS brown. Stick to the hex codes above.

═══════════════════════════════════════════════════════════════════════════════

═══ THE WOW BAR — NON-NEGOTIABLE QUALITY STANDARDS ═══

【1】HERO — visually arresting, pick ONE treatment that fits the ${ds.name} aesthetic:
   • Full-bleed image with mask-reveal animated text
   • Asymmetric split (oversized headline breaking the grid)
   • Text-stroke / background-clip:text huge type with image showing through letters
   • Layered photo composition with parallax depth on scroll
   • Floating photo cards / 3D tilted images
   • Duotone-treated hero image with accent-color filter
   • Marquee headline scrolling horizontally
   • Word-by-word stagger fade-up entrance

【2】TYPOGRAPHY — must POP, not whisper:
   • Display headlines clamp(3rem, 9vw, 8rem) — go BIG with ${ds.fonts.display}
   • Dramatic weight contrast — pair 300 weight against 900 weight in same composition
   • Letter-spacing manipulation: tight (-0.04em) for display, expanded (0.2em) for eyebrows
   • Use italic display variant where ${ds.fonts.display} supports it
   • text-stroke / background-clip:text / drop-shadow for impact on chosen accent moments

【3】SCROLL-TRIGGERED ANIMATIONS — use GSAP ScrollTrigger (see Agency-Tier Libraries below) or IntersectionObserver fallback:
   • Text fade-up with stagger on entry (split chars/words)
   • Image parallax / scale-up on scroll
   • Count-up stat animations (animate numbers from 0 to target)
   • Section dividers that reveal as you scroll
   • Sticky scroll sections where content transforms / morphs

【4】CUSTOM VISUAL TREATMENTS (pick what fits the ${ds.name} mood):
   • Custom inline SVG decorations (organic shapes, geometric patterns, hand-drawn lines)
   • Duotone or color-washed photos using CSS filters (mix-blend-mode with --accent)
   • Glassmorphism panels where appropriate
   • Subtle grain/noise texture overlays
   • Custom shape clip-paths on images (organic blobs, hexagons, arches, raw rectangles depending on aesthetic)

【5】INTERACTIVE MICRO-MOMENTS:
   • Buttons: hover lift + shadow + color shift (NOT flat rects)
   • Cards: 3D tilt on hover (transform: perspective + rotate3d)
   • Magnetic CTA buttons (subtle JS nudge toward cursor)
   • Smooth scroll with offset for sticky nav
   • Image hover: zoom, mask reveal, or filter shift

【6】LAYOUT VARIATION — BREAK THE GRID:
   • Asymmetric splits (image left 60%, text right 40%, or staggered)
   • Overlapping elements (negative margins, z-index layering)
   • Diagonal section dividers using clip-path: polygon
   • Marquee / scrolling text bands between sections
   • Bento grids (different-sized boxes packed cleverly)
   • Magazine-style editorial spreads with pull-quotes
   • DO NOT make every section be "centered heading + 3 columns"

【7】SIGNATURE MOMENT — every site needs ONE wow:
   Pick something memorable for THIS business: animated SVG, horizontal-scroll gallery,
   reviews marquee, count-up stat block, masked-text marquee header, before/after slider,
   or animated wordmark. Make it specific to the business.

═══════════════════════════════════════════════════════════════════════════════
═══ AGENCY-TIER LIBRARIES — USE THESE FOR THE "SHOCK" FACTOR ═══
═══════════════════════════════════════════════════════════════════════════════
You have access to the industry-standard premium libraries via CDN. THESE are
what separates an Awwwards Site of the Day winner from a generic template.
Include them and USE them — don't just load them and use vanilla CSS.

【LIB1】GSAP 3 + ScrollTrigger — the animation standard for award-winning sites
   <script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>
   <script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/ScrollTrigger.min.js"></script>

   ALWAYS use GSAP for:
   • Hero text reveal (split chars/words manually, stagger with gsap.from)
   • Image parallax with scrub on scroll (ScrollTrigger + yPercent)
   • Pinned sections where content morphs as user scrolls
   • Counter animations (gsap.to with onUpdate)
   • Mouse-following effects with smooth interpolation
   • Hover micro-interactions with eased timelines

   Required pattern at the top of your script:
   gsap.registerPlugin(ScrollTrigger);

   ⚠️⚠️ CRITICAL — TEXT SPLIT ANIMATIONS — READ CAREFULLY:
   The post-processor adds data-edit-id attributes to your spans. If you try to split
   a heading using .innerHTML, you WILL mangle those attributes and they will show up
   as visible text on the page (e.g. 'class="accent-word" data-edit-id="text-55">Cut').
   
   FORBIDDEN PATTERNS (these BREAK the page):
   ✗ el.innerHTML.split('').map(c => '<span>'+c+'</span>')   ← splits inside tag attributes
   ✗ el.innerHTML.split(' ').map(w => '<span>'+w+'</span>')  ← same problem with words
   ✗ ANY use of .innerHTML for splitting when the element contains nested <span>
   
   SAFE PATTERNS (use one of these):
   
   PATTERN A — char-split a SIMPLE heading (no nested spans):
   const el = document.querySelector('.hero-title');
   const text = el.textContent;
   el.textContent = '';
   for (const c of text) {
     const span = document.createElement('span');
     span.className = 'char';
     span.textContent = c === ' ' ? '\\u00A0' : c;
     el.appendChild(span);
   }
   gsap.from('.hero-title .char', { y:100, opacity:0, duration:1, stagger:0.03, ease:'power4.out' });
   
   PATTERN B — accent words WITH split: split each part separately
   HTML: <h1 class="hero-title"><span class="part">Where Every</span> <span class="accent-word part">Cut</span> <span class="part">Tells Your</span> <span class="stroke-word part">Story</span></h1>
   JS: split each .part using textContent (PATTERN A logic), keeping the outer accent span intact
   
   PATTERN C — simplest: NO char split, just word/line reveal via CSS
   HTML: heading with nested <span class="accent-word"> as needed
   CSS: .hero-title { opacity: 0; }
   JS: gsap.from('.hero-title', { y:60, opacity:0, duration:1.2, ease:'power3.out' });
        gsap.from('.hero-subhead', { y:30, opacity:0, duration:1, delay:0.3 });
   
   When in doubt, USE PATTERN C — it always works.

   Example parallax:
   gsap.to('.parallax-img', { yPercent: -20, ease: 'none', scrollTrigger: { trigger: '.section', start: 'top bottom', end: 'bottom top', scrub: 1 } });

【LIB2】Lenis — smooth inertia scroll (every premium 2024+ site has this)
   <script src="https://unpkg.com/lenis@1.1.6/dist/lenis.min.js"></script>

   ALWAYS initialize at the start of your script:
   const lenis = new Lenis({ duration: 1.2, easing: t => Math.min(1, 1.001 - Math.pow(2, -10 * t)) });
   function raf(t) { lenis.raf(t); requestAnimationFrame(raf); }
   requestAnimationFrame(raf);
   lenis.on('scroll', ScrollTrigger.update);  // sync with GSAP
   gsap.ticker.add(t => lenis.raf(t * 1000));
   gsap.ticker.lagSmoothing(0);

   This alone makes the site feel like it costs 5x more.

【LIB3】Three.js — real WebGL 3D (use SELECTIVELY for ONE signature moment)
   <script src="https://unpkg.com/three@0.160.0/build/three.min.js"></script>

   Use for ONE of these in the hero (pick what fits the ${ds.name} aesthetic):
   • Particle field reacting to mouse (300-600 particles in --accent color)
   • Animated mesh gradient (PlaneGeometry with custom shader using --accent / --accent2)
   • Floating geometric shapes (icosahedrons, torus knots) with subtle rotation
   • Distorted blob using IcosahedronGeometry with vertex shader noise
   • Wireframe geometry that morphs as you scroll

   Constraints:
   • Keep under 200 lines of Three.js code
   • Use ONLY core Three.js (no OrbitControls, no loaders)
   • Position the canvas absolutely behind hero content with z-index: 0
   • Set canvas size on resize: renderer.setSize(window.innerWidth, window.innerHeight)
   • Use lower density / disable on mobile if perf concern
   • USE --accent / --accent2 for any colors

【LIB4】(optional) Lottie — JSON animations from LottieFiles
   <script src="https://cdnjs.cloudflare.com/ajax/libs/lottie-web/5.12.2/lottie.min.js"></script>
   Use sparingly for: success states, hero icons, decorative loops.

═══ THE "SHOCK" HERO — pick ONE for this site ═══
The first 2 seconds when the business owner loads this site must be UNFORGETTABLE.
Pick ONE of these treatments for the hero (match the ${ds.name} aesthetic):

▸ OPTION A — 3D PARTICLE FIELD
  Three.js scene: 300-500 floating particles in --accent. Particles slowly drift
  and respond to mouse with parallax. Massive split-char headline overlay
  with GSAP stagger reveal. Subtle vignette.

▸ OPTION B — ANIMATED MESH GRADIENT
  Three.js PlaneGeometry with custom shader. Smooth gradient using --bg, --accent,
  --accent2 (or palette shifts) that morphs over time. Display type overlay with
  text-stroke or background-clip mask.

▸ OPTION C — SCROLL-PINNED NARRATIVE HERO
  Hero pinned for 200vh via ScrollTrigger. As user scrolls, layered text/images
  transform, swap, or morph. Reveals the brand story across 2-3 "frames" before
  releasing to the next section.

▸ OPTION D — KINETIC SPLIT-CHAR HERO
  Display title is split into individual characters. Each animates in independently
  (rotate, translate, scale with stagger). On hover, characters subtly react.
  Photo behind has GSAP slow zoom + parallax.

▸ OPTION E — DUOTONE PHOTO + NOISE OVERLAY
  Hero photo with --accent duotone (mix-blend-mode). Animated SVG noise texture
  overlay. GSAP infinite slow zoom. Huge headline with stroked outline + filled
  characters interleaved.

▸ OPTION F — MARQUEE BAND + TILT GALLERY
  Auto-scrolling marquee of huge type at top (e.g. business name x10, separated by
  ★). Below: bento gallery cards that tilt in 3D as mouse moves using CSS perspective +
  GSAP mouse tracking.

The "shock" treatment IS the centerpiece. Don't water it down.

═══════════════════════════════════════════════════════════════════════════════

═══════════════════════════════════════════════════════════════════════════════
═══ MOBILE EXCELLENCE — TREAT MOBILE AS PRIMARY (NON-NEGOTIABLE) ═══
═══════════════════════════════════════════════════════════════════════════════
70%+ of local-business visitors come from mobile (Google Maps clicks on phones).
The mobile experience must be as polished as desktop — NOT a shrunk-down afterthought.

🎯 MOBILE-SPECIFIC REQUIREMENTS — implement ALL of these:

【M1】HAMBURGER NAV at ≤768px
   • Desktop: full horizontal nav
   • Mobile: hamburger icon (right side) → opens FULL-SCREEN overlay menu
   • Overlay: huge tappable links (clamp 28px-40px), backdrop blur, slide/fade in
   • Pattern:
     @media(max-width:768px){
       .nav-links{display:none;}
       .hamburger{display:flex;}
       .mobile-menu.open{display:flex;}
     }
   • Hamburger toggles via JS: button.onclick = () => menu.classList.toggle('open')
   • Lock body scroll when menu open: document.body.style.overflow = open ? 'hidden' : ''

【M2】GALLERY MUST BE A SWIPE CAROUSEL ON MOBILE — this is critical, the user has complained about static galleries on mobile
   • Use CSS scroll-snap, NOT a JS library:
     .gallery-mobile{
       display:flex; gap:14px; overflow-x:auto; scroll-snap-type:x mandatory;
       padding:0 20px 20px; -webkit-overflow-scrolling:touch;
       scrollbar-width:none; /* hide scrollbar */
     }
     .gallery-mobile::-webkit-scrollbar{display:none;}
     .gallery-mobile > *{
       flex:0 0 85%; scroll-snap-align:center;
       aspect-ratio:4/5; border-radius:14px; overflow:hidden;
     }
   • Show ALL photos in the carousel (don't truncate)
   • Add dot indicators below that highlight the current slide (IntersectionObserver)
   • Add a subtle "← swipe →" hint that fades out after first interaction
   • Each card: rounded corners, real photo bg, name/caption overlay at bottom

【M3】HERO that doesn't break on mobile
   • Massive desktop text must scale DOWN appropriately — use clamp() religiously:
     font-size: clamp(2.5rem, 11vw, 8rem);
   • On mobile: stack hero elements vertically. If desktop is asymmetric split, mobile is full-width
   • Hero photo: full-width on mobile with smart object-position (so faces aren't cropped weird)
   • CTAs: minimum 52px tall on mobile, full-width or near-full-width
   • Test mentally at 375×667 (iPhone SE) — the smallest realistic viewport

【M4】STICKY MOBILE CTA BAR (bottom of viewport, ≤768px only)
   • A persistent action bar fixed to bottom on mobile only:
     position:fixed; bottom:0; left:0; right:0; padding:12px 16px;
     background:var(--surface); backdrop-filter:blur(20px);
     border-top:1px solid var(--border); z-index:50;
     display:flex; gap:10px;
   • Two buttons: "📞 Call" (tel: link to ${biz.phone || "phone"}) and "📍 Directions" (Google Maps link)
   • Hide on desktop with @media(min-width:769px){display:none}
   • This is the #1 most-clicked element on mobile local-business sites

【M5】SERVICES section on mobile
   • If desktop is bento/asymmetric, mobile becomes a vertical stack OR a horizontal scroll-snap row
   • Cards: full-width with adequate padding (20px+), 44px+ touch targets
   • Avoid 2-column grids at 375px — too cramped

【M6】TYPOGRAPHY fluidity — every font-size declaration MUST use clamp()
   • h1: clamp(2.5rem, 9vw, 7rem)
   • h2: clamp(1.8rem, 5vw, 4rem)
   • h3: clamp(1.3rem, 3vw, 2rem)
   • body: clamp(15px, 1.05vw, 17px)
   • NO fixed pixel sizes anywhere on text

【M7】TOUCH TARGETS
   • Every button/link minimum 44×44px on mobile
   • Padding inside buttons: 14px 22px minimum
   • Spacing between tappable elements: 8px minimum

【M8】MOBILE LAYOUT — STRICT GRID RULES (most common failure point)
   • Services / Team / Reviews cards: SINGLE COLUMN at ≤640px. Period.
     Pattern: @media (max-width: 640px) { .services-grid, .team-grid, .reviews-grid { grid-template-columns: 1fr !important; gap: 16px; } }
   • NEVER use grid-template-columns: 1fr 1fr (or repeat(2, 1fr)) WITHOUT a media query collapsing it at ≤640px
   • Use this safe pattern: grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr));
   • Tablet (641-1024px): max 2 columns
   • Desktop (≥1025px): 3-4 columns
   • Replace overlapping/negative-margin elements with stacked positive-flow on mobile
   • Remove decorative absolute-positioned elements that would clutter mobile
   • Padding: 16-20px horizontal on mobile (not 80px+)

【M9】HORIZONTAL OVERFLOW PREVENTION (mandatory — must work at 320px)
   • html, body { overflow-x: hidden; max-width: 100vw; }
   • Every section: max-width: 100%; box-sizing: border-box;
   • NEVER use 'width: 100vw' (it includes the scrollbar and overflows — use 'width: 100%' instead)
   • Three.js canvas: width: 100%; (NOT 100vw)
   • Marquee containers: overflow: hidden; max-width: 100vw;
   • Defensive on text containers: overflow-wrap: break-word; word-wrap: break-word;
   • Hero text: use clamp() — at 375px width the largest size must not overflow
   • Section padding: padding: clamp(40px, 8vw, 120px) clamp(16px, 4vw, 80px);
   • Test mentally: at 320px width, is there horizontal scroll? If yes, fix it.

【M10】PERFORMANCE on mobile
   • Lazy-load images below the fold: <img loading="lazy" decoding="async">
   • Use the FIRST photo for hero, smaller photos for cards
   • No autoplay videos
   • Respect prefers-reduced-motion — disable scroll animations for those users
   • Three.js: lower particle count on mobile (e.g. 150 instead of 400) or disable entirely below 600px width

═══════════════════════════════════════════════════════════════════════════════

═══ STRUCTURE (every section gets its own visual identity within the ${ds.name} system) ═══
1. Sticky nav — logo + 4-5 nav links + prominent CTA. Becomes glassmorphic / colored on scroll.
2. HERO — wow treatment from above, using --accent prominently
3. Trust band / marquee — auto-scrolling: "★★★★★ ${biz.rating} • ${biz.review_count} Reviews • Family Owned • Open Today •"
4. ABOUT — magazine-style asymmetric, NOT centered. Pull quote from a review. Image with creative crop using --accent filters.
5. SERVICES (4-6) — varied card design fitting the ${ds.name} aesthetic. Invent realistic services for "${biz.category}" with 1-2 sentence descriptions.
6. GALLERY — creative grid using ALL provided photos. Desktop: bento/masonry/asymmetric grid. Mobile (≤768px): MUST become a horizontal scroll-snap carousel with visible swipe indicators (dots or progress bar). Every photo must be visible/reachable on mobile — never hide photos with display:none on small screens.
7. REVIEWS — feature the BEST review as a huge pull-quote with author. Then marquee/grid of others. Use real Google reviews verbatim.
8. CONTACT — split layout: info (phone, address, hours) + visual contact form. --accent on the CTA.
9. FOOTER — branded, not just links. Include hours, social-ish icons, copyright.

═══════════════════════════════════════════════════════════════════════════════
═══ COMPLETENESS — EVERY SECTION MUST BE FILLED (CRITICAL) ═══
═══════════════════════════════════════════════════════════════════════════════
A section's heading is a PROMISE to the visitor. NEVER leave a promise unfulfilled.
The most common failure of AI-generated sites is "shell without content" — bold
headings followed by empty space. THIS IS UNACCEPTABLE.

【C1】If you write "Meet the Team" / "Our Stylists" / "The Hands Behind…" →
   You MUST follow with 3-6 actual team member cards. Each card has:
   • Name (extract from reviews if mentioned, or invent realistic names matching the area/culture)
   • Role/title (e.g. "Master Stylist", "Senior Barber", "Color Specialist")
   • 1-2 sentence bio
   • Avatar: if no photo, use INITIALS in a gradient circle (background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 60%, var(--ink))))
   NEVER write "Meet the Team" then leave the section visually empty below.

【C2】If you write "Reviews" / "Testimonials" / "Real Clients" / "What People Say" →
   You MUST include 3-6 visible review cards with FULL review text shown.
   Use the provided Google reviews verbatim. If none provided, invent 3-4 realistic
   testimonials based on the category and description. Each card needs:
   • Quote text (40-200 chars visible)
   • Author name
   • Star rating (5 stars visual)

【C3】If you write "Our Services" / "What We Do" / "Services" →
   You MUST list 4-6 services. Each service:
   • Name (specific to category — e.g. for a barbershop: "Precision Fade", "Beard Sculpt", "Hot Towel Shave", "Hair Color")
   • 1-2 sentence description
   • Icon or visual element

【C4】If you write "Our Story" / "About Us" / any About section →
   The TEXT must fill its column appropriately — don't make a narrow text column
   sit in a viewport with vast empty whitespace on the other side. Either:
   (a) full-width text with comfortable max-width 70ch, OR
   (b) two-column with TEXT on one side and an IMAGE/visual on the other side
   NEVER leave 60% of the viewport empty next to your story text.

【C5】NEVER leave entire viewport-height sections empty or as solid color blocks.
   If a section exists in your HTML, it must have visible CONTENT inside it.
   No section should render as just a colored rectangle.

【C6】TEXT WRAPPING for headlines (prevents "Every" → "Ever" + "y"):
   ALL display headlines MUST use:
   text-wrap: balance;
   overflow-wrap: normal;
   word-break: normal;
   hyphens: none;
   Single words must NEVER break mid-character. If a word doesn't fit, reduce
   font-size (lower the upper clamp() bound) rather than letting words break.

【C7】MARQUEE overflow (prevents text bleeding off-screen):
   Marquee CONTAINER: overflow: hidden; width: 100%; max-width: 100vw;
   Marquee CONTENT: white-space: nowrap; display: inline-flex; animation: marquee linear infinite;
   NEVER allow horizontal scroll on the page body.

【C8】MOBILE HERO IMAGE (critical — your last site failed this):
   The hero photo MUST be visible on mobile (≤768px). RULES:
   • DO NOT use display:none on the hero image at any breakpoint
   • If desktop hero is a side-by-side split, MOBILE STACKS: text on top, image full-width below (or vice versa). Image stays VISIBLE.
   • Hero image on mobile: width: 100%; aspect-ratio: 4/5; max-height: 70vh; object-fit: cover;
   • If hero uses background-image on a wrapper, ensure the wrapper has explicit min-height on mobile (e.g. min-height: 50vh)
   ALWAYS verify: at 375px width, is the hero image VISIBLE? If no, fix the layout.

【C9】SECTION SPACING — never leave huge empty space:
   • Section padding: clamp(60px, 8vw, 120px) vertical, clamp(20px, 4vw, 80px) horizontal
   • Content max-width inside a section: 1280px max (most), 70ch for text columns
   • If a column on desktop is narrow, the OTHER column must have actual content (image, illustration, callout) — never let one column hold real content while the other is empty space

═══════════════════════════════════════════════════════════════════════════════

═══ TECHNICAL REQUIREMENTS ═══
• Single self-contained HTML file. ALL CSS inline in <style>. ALL JS inline in <script>.
• Mobile-first responsive — TEST mentally at 375×667 (iPhone SE) first, then 414×896, then 768, 1280. All MOBILE EXCELLENCE rules above are mandatory.
• Font Awesome 6.5 via CDN: https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css
• Google Fonts via the @import shown above (ONLY ${ds.fonts.display} and ${ds.fonts.body}).
• GSAP + ScrollTrigger via CDN (mandatory): see Agency-Tier Libraries section above
• Lenis smooth scroll via CDN (mandatory): see Agency-Tier Libraries section above
• Three.js via CDN (optional but encouraged for hero shock factor)
• Modern CSS only: custom properties, grid, flex, clamp(), aspect-ratio, color-mix() ok.
• Use the EXACT photo URLs given — DON'T invent placeholders.
• <title>${biz.name}</title>
• Performance: lean. Inline SVG instead of icon fonts where it shines. Lazy-load below-fold images.
• Accessibility: semantic HTML, alt-equivalents, focus states, prefers-reduced-motion respected (skip GSAP/Three.js animations for those users).

═══ ANTI-PATTERNS — DO NOT ═══
✗ Default to brown/beige/amber tones (unless the palette above explicitly contains them)
✗ Use any font besides ${ds.fonts.display} and ${ds.fonts.body}
✗ Generic SaaS purple/indigo gradient look (unless that IS your accent)
✗ Centered hero with subtitle + CTA + image below (boring default)
✗ Boring 3-column "Our Services" with identical cards
✗ Centered headings on every section
✗ Plain rectangle buttons with no hover personality
✗ Flat boxy cards without depth or character
✗ Lorem ipsum or generic copy — use the real business voice
✗ A site that could be ANY business

✗ MOBILE FAILS — never do these:
   ✗ Static photo grid on mobile that just stacks vertically with everything tiny
   ✗ display:none on photos at mobile breakpoints (every photo must be visible)
   ✗ Fixed pixel font-sizes (must use clamp())
   ✗ Multi-column layouts at ≤640px (services/team/reviews MUST be single column)
   ✗ 'grid-template-columns: 1fr 1fr' without a media query collapsing it on mobile
   ✗ 'width: 100vw' anywhere (overflows because of scrollbar — use 'width: 100%')
   ✗ Missing 'overflow-x: hidden' on html AND body (causes horizontal scroll on mobile)
   ✗ A grid card crushed to <100px wide on mobile (single letter per line)
   ✗ Tiny touch targets (<44px)
   ✗ Horizontal scroll on the whole page
   ✗ Hero text so big it overflows on iPhone SE (375px wide)
   ✗ Desktop nav links shown on mobile (must have hamburger)
   ✗ Forgetting the sticky bottom mobile CTA bar

✗ AGENCY-TIER FAILS — never do these:
   ✗ Skipping GSAP / Lenis entirely — these libraries are MANDATORY for premium feel
   ✗ Loading Three.js but only using it for a static rectangle (use it meaningfully or skip it)
   ✗ Plain CSS hover transitions when you have GSAP available (use eased timelines)
   ✗ Hard scroll behavior when Lenis is available (always init Lenis at top of script)
   ✗ Building hero with only HTML/CSS when one of the SHOCK HERO options should be used

✗ COMPLETENESS FAILS — these are unacceptable and will cause rejection:
   ✗ A "Meet the Team" heading with no team cards visible below it
   ✗ A "Reviews" / "Testimonials" heading with no review cards visible below it
   ✗ A "Services" heading with no service cards visible below it
   ✗ An empty viewport-height section (just a colored background, no content)
   ✗ A narrow text column with vast empty whitespace beside it (no image, no callout)
   ✗ Words breaking mid-character ("Every" rendering as "Ever\ny")
   ✗ Marquee text bleeding off the side of the page (causing horizontal scroll)
   ✗ Hero image hidden on mobile (display:none at small breakpoints)
   ✗ Section that "looks designed" but contains only headings without supporting content

✗ CONTRAST/CLIPPING FAILS — these break the visual quality:
   ✗ Dark nav text on a dark hero (invisible menu items)
   ✗ Hero photo as background WITHOUT a dark gradient overlay (text unreadable on top)
   ✗ Review/stat/rating badge cut off at the bottom or edge of its parent (clipped)
   ✗ Absolutely-positioned overlay with negative inset when parent has overflow:hidden
   ✗ Skipping the Three.js hero entirely (use a SIMPLE one, under 80 lines — don't skip)

═══ COPY VOICE — match this business ═══
Read the reviews. Match the energy of the actual customers. A salon's voice ≠ an auto shop's voice ≠ a taqueria's voice. Reference the city/neighborhood from the address. Use specifics. Make the copy feel hand-written for THIS business, not template-generated.

═══ OUTPUT FORMAT ═══
Output ONLY the complete HTML document. Start with <!DOCTYPE html> and end with </html>. NO markdown code fences. NO commentary before or after.

═══ SELF-CHECK BEFORE OUTPUTTING ═══
Mentally walk through your HTML and verify EACH of these is true. If any fail, fix before outputting:

□ Every section heading has visible content below it (no empty "Meet the Team" or "Reviews" sections)
□ Hero image is visible on mobile (no display:none at small breakpoints)
□ Nav text is readable against its background (light text on dark hero, dark text on light bg)
□ Any badge/overlay on an image fits fully inside its parent (no clipping at edges)
□ Hero photo background has a dark gradient overlay so text is readable
□ No words break mid-character anywhere (text-wrap: balance on all headlines)
□ No section is just an empty colored rectangle
□ Marquees have overflow:hidden on their container
□ All 4-6 service cards / team cards / review cards are present and filled with text
□ Services/Team/Reviews grids COLLAPSE TO SINGLE COLUMN at ≤640px (mandatory media query)
□ html AND body BOTH have overflow-x: hidden
□ NO 'width: 100vw' anywhere (use 'width: 100%')
□ At 320px width, no element causes horizontal scroll
□ No card on mobile is crushed to less than 200px wide
□ Mobile hamburger menu actually opens (JS wired up)
□ Sticky mobile CTA bar present (Call + Directions buttons)
□ Hero text fits at 375px (no overflow)
□ Every photo URL provided is used SOMEWHERE in the site (gallery, hero, about, etc.)
□ Lenis smooth scroll initialized at script start
□ GSAP ScrollTrigger.registerPlugin called
□ Three.js hero shock moment is present (simple particles or animated gradient, <80 lines)

If ANY of these fails — fix it. Do not output a site with empty sections, invisible nav text, or mobile horizontal overflow.

Build the entire site within the **${ds.name}** design system using GSAP + Lenis (mandatory) and Three.js (encouraged for the SHOCK hero). Show real ambition — typical output is 35,000-55,000 characters of carefully crafted code. Make this site WIN.`;

  console.log(`🤖 Calling Claude for: ${biz.name}`);

  // NOTE: Sonnet 4.6 doesn't support assistant message prefill, so we rely on the
  // prompt's CONTENT MANIFEST section to make the AI commit to listing content
  // before designing. The post-processor strips any leading HTML comment.
  const CONTINUATION_REQUEST =
    "Continue the HTML exactly where you stopped. Do NOT repeat any content already written. " +
    "Do NOT add any preamble, explanation, or markdown. Output only the next characters of the HTML " +
    "so when concatenated to what you already wrote it forms one valid document ending in </html>.";

  let html = "";
  let attempts = 0;
  const MAX_ATTEMPTS = 5;
  const PER_CALL_TOKENS = 32000;

  while (attempts < MAX_ATTEMPTS) {
    attempts++;

    // Build messages fresh each iteration so continuation conversations stay valid.
    const callMessages = attempts === 1
      ? [{ role: "user", content: prompt }]
      : [
          { role: "user", content: prompt },
          { role: "assistant", content: html },
          { role: "user", content: CONTINUATION_REQUEST },
        ];

    const stream = ai.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: PER_CALL_TOKENS,
      messages: callMessages,
    });
    const r = await stream.finalMessage();

    const chunk = r.content[0]?.text || "";
    html += chunk;

    console.log(`📦 ${biz.name} chunk ${attempts}: +${chunk.length} chars (stop_reason=${r.stop_reason}, total=${html.length})`);

    if (r.stop_reason !== "max_tokens") break;
    if (html.toLowerCase().includes("</html>")) break;
  }

  // Strip any accidental markdown fences at the boundaries
  html = html.replace(/^```(?:html)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();

  // Validate structure
  const lc = html.toLowerCase();
  if (!lc.includes("<!doctype") && !lc.startsWith("<html")) {
    throw new Error("AI did not return valid HTML (no doctype/html tag)");
  }
  if (html.length < 2000) {
    throw new Error("AI returned suspiciously short HTML");
  }
  if (!lc.includes("</html>")) {
    // Last-resort recovery: best-effort close so the page at least renders
    console.warn(`⚠️ ${biz.name}: HTML missing </html> after ${attempts} attempts — auto-closing`);
    if (!lc.includes("</body>")) html += "\n</body>";
    html += "\n</html>";
  }

  // Safety net: replace any /photo?ref=X URL that isn't in our validated set
  // (covers cases where Claude reuses a ref imprecisely or a photo later 403s)
  html = bulletproofImages(html, validPhotos);

  // CONTENT PRESENCE VALIDATION — verify Stage 2 actually rendered the content plan.
  // We check that names from services/team/reviews appear somewhere in the HTML.
  // If many are missing, log a clear warning so we know completeness failed.
  const required = [
    ...(contentPlan.services || []).map(s => s.name).filter(Boolean),
    ...(contentPlan.team || []).map(m => m.name).filter(Boolean),
    ...(contentPlan.reviews || []).map(r => r.author).filter(Boolean),
  ];
  const missing = required.filter(name => !html.includes(name));
  const pctMissing = required.length ? Math.round(100 * missing.length / required.length) : 0;
  if (missing.length > 0) {
    console.warn(`⚠️ ${biz.name}: ${missing.length}/${required.length} (${pctMissing}%) required strings missing from HTML`);
    console.warn(`   Missing: ${missing.slice(0, 6).join(" | ")}${missing.length > 6 ? " ..." : ""}`);
  } else {
    console.log(`✅ ${biz.name}: all ${required.length} required content strings present in HTML`);
  }

  console.log(`✅ ${biz.name}: HTML done — ${html.length} chars, ${attempts} call(s)`);
  return html;
}

// ─── UPSERT business by place_id ──────────────────────────────────────────────
async function upsertBusiness(biz, areaSearched = "") {
  if (biz.place_id) {
    const existing = await pool.query("SELECT * FROM businesses WHERE place_id=$1", [biz.place_id]);
    if (existing.rows.length) {
      const updated = await pool.query(
        `UPDATE businesses SET
          name=$1, address=$2, phone=$3, category=$4, rating=$5, review_count=$6,
          hours_json=$7, website=$8, photos_json=$9, reviews_json=$10, description=$11,
          location_lat=$12, location_lng=$13, google_url=$14, updated_at=NOW()
         WHERE place_id=$15 RETURNING *`,
        [biz.name, biz.address, biz.phone, biz.category, biz.rating, biz.review_count,
         JSON.stringify(biz.hours || []), biz.website,
         JSON.stringify(biz.photos || []), JSON.stringify(biz.reviews || []),
         biz.description, biz.location?.lat ?? null, biz.location?.lng ?? null,
         biz.google_url || "", biz.place_id]
      );
      return updated.rows[0];
    }
  }
  const inserted = await pool.query(
    `INSERT INTO businesses
       (place_id, name, address, phone, category, rating, review_count,
        hours_json, website, photos_json, reviews_json, description,
        location_lat, location_lng, google_url, area_searched, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'prospect')
     RETURNING *`,
    [biz.place_id || null, biz.name, biz.address, biz.phone, biz.category,
     biz.rating, biz.review_count,
     JSON.stringify(biz.hours || []), biz.website,
     JSON.stringify(biz.photos || []), JSON.stringify(biz.reviews || []),
     biz.description, biz.location?.lat ?? null, biz.location?.lng ?? null,
     biz.google_url || "", areaSearched]
  );
  return inserted.rows[0];
}

async function buildAndSaveSite(biz, areaSearched = "") {
  const saved = await upsertBusiness(biz, areaSearched);

  let html;
  try {
    html = await generateUniqueHTML(biz);
  } catch (e) {
    console.error("AI failed, trying once more:", e.message);
    html = await generateUniqueHTML(biz); // one retry
  }

  // Post-process: tag every editable element with data-edit-id so the client
  // editor (and download endpoint) can target it later.
  html = addEditMarkers(html);

  const slug = `b${saved.id}-${Date.now().toString(36)}`;
  await pool.query(
    `INSERT INTO generated_sites (business_id, slug, html) VALUES ($1,$2,$3)`,
    [saved.id, slug, html]
  );
  await pool.query(
    `UPDATE businesses SET preview_slug=$1, status='site shown', updated_at=NOW() WHERE id=$2`,
    [slug, saved.id]
  );
  return { saved: { ...saved, preview_slug: slug }, slug };
}

// ─── AUTH MIDDLEWARE & ROUTES ─────────────────────────────────────────────────
function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Authentication required" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin only" });
  next();
}

// Public: how to start? — tells the frontend if registration is open (no users yet)
app.get("/api/auth/state", async (req, res) => {
  try {
    const r = await pool.query("SELECT COUNT(*)::int AS c FROM users");
    res.json({ registration_open: r.rows[0].c === 0, user_count: r.rows[0].c });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Public: register. Allowed only when no users exist (first → admin).
app.post("/api/auth/register", async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });

    const count = await pool.query("SELECT COUNT(*)::int AS c FROM users");
    if (count.rows[0].c > 0) {
      return res.status(403).json({ error: "Registration is closed. Ask the admin to create your account." });
    }

    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      "INSERT INTO users (email, password_hash, name, role) VALUES ($1,$2,$3,'admin') RETURNING id, email, name, role",
      [email.toLowerCase().trim(), hash, name || ""]
    );
    const user = r.rows[0];
    res.json({ token: signToken(user), user });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "Email already registered" });
    res.status(500).json({ error: e.message });
  }
});

// Public: login
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });
    const r = await pool.query(
      "SELECT id, email, password_hash, name, role FROM users WHERE email=$1",
      [email.toLowerCase().trim()]
    );
    if (!r.rows.length) return res.status(401).json({ error: "Invalid email or password" });
    const u = r.rows[0];
    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return res.status(401).json({ error: "Invalid email or password" });
    const user = { id: u.id, email: u.email, name: u.name, role: u.role };
    res.json({ token: signToken(user), user });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Authenticated: who am I?
app.get("/api/auth/me", requireAuth, async (req, res) => {
  const r = await pool.query("SELECT id, email, name, role, created_at FROM users WHERE id=$1", [req.user.id]);
  if (!r.rows.length) return res.status(404).json({ error: "User not found" });
  res.json({ user: r.rows[0] });
});

// Admin: list users
app.get("/api/auth/users", requireAuth, requireAdmin, async (req, res) => {
  const r = await pool.query("SELECT id, email, name, role, created_at FROM users ORDER BY created_at DESC");
  res.json({ users: r.rows });
});

// Admin: create a new user
app.post("/api/auth/users", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { email, password, name, role = "user" } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      "INSERT INTO users (email, password_hash, name, role) VALUES ($1,$2,$3,$4) RETURNING id, email, name, role, created_at",
      [email.toLowerCase().trim(), hash, name || "", role === "admin" ? "admin" : "user"]
    );
    res.json({ user: r.rows[0] });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "Email already registered" });
    res.status(500).json({ error: e.message });
  }
});

// Admin: delete a user (can't delete yourself)
app.delete("/api/auth/users/:id", requireAuth, requireAdmin, async (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: "Cannot delete yourself" });
  await pool.query("DELETE FROM users WHERE id=$1", [req.params.id]);
  res.json({ deleted: true });
});

// Authenticated: change own password
app.post("/api/auth/change-password", requireAuth, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) return res.status(400).json({ error: "Both current and new password required" });
    if (new_password.length < 8) return res.status(400).json({ error: "New password must be at least 8 characters" });
    const r = await pool.query("SELECT password_hash FROM users WHERE id=$1", [req.user.id]);
    if (!r.rows.length) return res.status(404).json({ error: "User not found" });
    const ok = await bcrypt.compare(current_password, r.rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: "Current password incorrect" });
    const hash = await bcrypt.hash(new_password, 10);
    await pool.query("UPDATE users SET password_hash=$1 WHERE id=$2", [hash, req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.get("/", (_, res) => res.json({
  ok: true,
  service: "SiteSprint v10",
  google_api: !!GKEY,
  anthropic_api: !!process.env.ANTHROPIC_KEY,
}));

// === Everything below requires authentication ===
// (auth/* routes were already defined and matched above; this middleware runs
//  for any subsequent /api/* path that isn't already handled)
app.use("/api", requireAuth);

// DISCOVER — real Google search filtered to businesses WITHOUT a website
//
// Cost-optimized:
//  - Default: 15 small-biz categories (was 55, ~3x cheaper)
//  - User can specify a category for focused deep-paginated search
//  - Filter pass uses placeDetails with full=false (Basic+Contact SKU = $0.037)
//    instead of full Atmosphere SKU ($0.062) — ~40% cheaper per place check
//  - Place Details are cached in DB, so re-searching the same area is nearly free
app.post("/api/discover", async (req, res) => {
  try {
    const { area, category = "", limit = 50, deep = false } = req.body;
    if (!area)  return res.status(400).json({ error: "area required" });
    if (!GKEY)  return res.status(500).json({ error: "GOOGLE_API_KEY not configured" });

    // Default 15 categories — high "no website" hit-rate with reasonable cost.
    // Set deep=true to use the full 55-category scan (~3x more expensive).
    const SMALL_BIZ_DEFAULT = [
      "barber shops", "nail salons", "tattoo shops", "tailors",
      "auto repair", "tire shops", "car detailing",
      "taquerias", "food trucks", "small family restaurants",
      "handymen", "locksmiths", "lawn care",
      "florists", "ethnic markets",
    ];
    const SMALL_BIZ_DEEP = [
      ...SMALL_BIZ_DEFAULT,
      // Extra coverage for deep scan
      "hair salons", "beauty salons", "piercing studios", "lash studios",
      "brow studios", "massage therapists", "dry cleaners", "shoe repair",
      "car wash", "auto body shops", "oil change shops", "mobile mechanics",
      "auto glass repair", "donut shops", "ice cream shops", "bakeries",
      "sandwich shops", "pizzerias", "bbq joints", "juice bars",
      "smoothie shops", "boba tea shops", "halal restaurants",
      "vietnamese restaurants", "ethiopian restaurants",
      "plumbers", "electricians", "cleaning services", "pet groomers",
      "junk removal", "moving companies", "painters", "fence contractors",
      "hvac repair", "convenience stores", "smoke shops", "thrift stores",
      "consignment shops", "tax preparers", "notaries", "tutors",
      "music lessons", "dance studios", "martial arts dojos", "photographers",
    ];
    const SMALL_BIZ = deep ? SMALL_BIZ_DEEP : SMALL_BIZ_DEFAULT;

    let queries, paginate;
    if (category) {
      queries  = [`${category} in ${area}`];
      paginate = true;
    } else {
      queries  = SMALL_BIZ.map(q => `${q} in ${area}`);
      paginate = false;
    }

    // Run all searches in parallel
    const searchPromises = queries.map(async q => {
      try {
        return paginate
          ? await placesTextSearchMultiPage(q, 3)
          : (await placesTextSearch(q)).results;
      } catch (e) {
        console.warn("⚠️ query failed", q, e.message);
        return [];
      }
    });
    const allResults = (await Promise.all(searchPromises)).flat();

    // Dedupe by place_id (and merge Text Search metadata: rating, review_count, photos)
    const seen = new Map();
    for (const r of allResults) {
      if (r.place_id && !seen.has(r.place_id)) {
        seen.set(r.place_id, r);
      }
    }
    const candidates = [...seen.values()];
    console.log(`🔍 ${area} — ${queries.length} queries → ${candidates.length} unique candidates`);

    // Filter pass: fetch BASIC details (cheaper) just to check website + business_status
    const withoutWebsite = [];
    let idx = 0;
    let detailsChecked = 0;
    let detailsFromCache = 0;
    const CONCURRENCY = 12;

    const worker = async () => {
      while (idx < candidates.length && withoutWebsite.length < limit) {
        const my = idx++;
        const c  = candidates[my];
        try {
          // Quick cache check first (avoid Google call entirely if we have any cached entry)
          let p;
          let fromCache = false;
          try {
            const cr = await pool.query("SELECT details_json FROM place_details_cache WHERE place_id=$1", [c.place_id]);
            if (cr.rows.length) {
              p = cr.rows[0].details_json;
              fromCache = true;
              detailsFromCache++;
            }
          } catch {}

          if (!p) {
            p = await placeDetails(c.place_id, { full: false });
            detailsChecked++;
          }

          if (!p.website && p.business_status !== "CLOSED_PERMANENTLY") {
            // Merge text-search rating into the shaped result (since basic SKU doesn't include rating)
            if (!p.rating && c.rating) p.rating = c.rating;
            if (!p.user_ratings_total && c.user_ratings_total) p.user_ratings_total = c.user_ratings_total;
            withoutWebsite.push(shapeBusiness(p));
          }
        } catch (e) {
          console.warn("details failed", c.place_id, e.message);
        }
      }
    };
    await Promise.all(Array(CONCURRENCY).fill(0).map(() => worker()));

    // Rough cost estimate (USD) — Text Search $0.032, Details Basic+Contact $0.037
    const estCostUSD = (queries.length * 0.032 + detailsChecked * 0.037).toFixed(2);

    // Check which place_ids already have a built site in our DB,
    // so the UI can show "View Site" instead of "Build Unique Site"
    // (avoids re-running expensive Claude generation by accident).
    const placeIds = withoutWebsite.map(b => b.place_id).filter(Boolean);
    let existingMap = new Map();
    if (placeIds.length) {
      const er = await pool.query(
        `SELECT place_id, id, preview_slug, status
           FROM businesses
          WHERE place_id = ANY($1::text[]) AND preview_slug IS NOT NULL`,
        [placeIds]
      );
      for (const row of er.rows) existingMap.set(row.place_id, row);
    }

    // Tag each candidate with whether it's already built
    for (const b of withoutWebsite) {
      const ex = existingMap.get(b.place_id);
      if (ex) {
        b.already_built = true;
        b.existing_id = ex.id;
        b.existing_slug = ex.preview_slug;
        b.existing_status = ex.status;
      }
    }

    const alreadyBuiltCount = withoutWebsite.filter(b => b.already_built).length;
    console.log(`✅ ${area}: checked ${detailsChecked} (cache hits: ${detailsFromCache}), found ${withoutWebsite.length} without website (${alreadyBuiltCount} already built). Est cost: $${estCostUSD}`);

    res.json({
      area,
      category: category || (deep ? `deep scan (${SMALL_BIZ.length} categories)` : `default scan (${SMALL_BIZ.length} categories)`),
      queries_used: queries.length,
      scanned: candidates.length,
      details_checked: detailsChecked,
      details_from_cache: detailsFromCache,
      count: withoutWebsite.length,
      already_built_count: alreadyBuiltCount,
      estimated_cost_usd: estCostUSD,
      businesses: withoutWebsite,
    });
  } catch (e) {
    console.error("🔴 discover:", e);
    res.status(500).json({ error: e.message });
  }
});

// BUILD — fetch full data for a place_id (or accept passed business), generate unique site, save
app.post("/api/build", async (req, res) => {
  try {
    const { place_id, business, area_searched = "" } = req.body;
    if (!place_id && !business) return res.status(400).json({ error: "place_id or business required" });
    if (!GKEY)  return res.status(500).json({ error: "GOOGLE_API_KEY not configured" });

    // Always re-fetch from Google when we have a place_id (fresh photos/reviews)
    let biz;
    if (place_id) {
      const p = await placeDetails(place_id);
      biz = shapeBusiness(p);
    } else {
      biz = business;
    }

    const { saved, slug } = await buildAndSaveSite(biz, area_searched);
    res.json({ business: saved, slug, previewUrl: `/preview/${slug}` });
  } catch (e) {
    console.error("🔴 build:", e);
    res.status(500).json({ error: e.message });
  }
});

// FROM URL — paste any Google Maps URL, including share.google
app.post("/api/from-url", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "url required" });
    if (!GKEY) return res.status(500).json({ error: "GOOGLE_API_KEY not configured" });

    const placeId = await urlToPlaceId(url);
    const p   = await placeDetails(placeId);
    const biz = shapeBusiness(p);
    biz.google_url = url;

    const { saved, slug } = await buildAndSaveSite(biz);
    res.json({ business: saved, slug, previewUrl: `/preview/${slug}` });
  } catch (e) {
    console.error("🔴 from-url:", e);
    res.status(500).json({ error: e.message });
  }
});

// UPLOAD PHOTO — for manual entries (no Google profile yet)
// Reuses editor_uploads table with NULL site_id for pre-build uploads
app.post("/api/upload-photo", express.raw({ type: ["image/*"], limit: "8mb" }), async (req, res) => {
  try {
    if (!req.body || !req.body.length) return res.status(400).json({ error: "no image data" });
    if (req.body.length > 6 * 1024 * 1024) return res.status(400).json({ error: "image too large (max 6 MB)" });
    const uploadId = randomToken(10);
    const contentType = req.headers["content-type"] || "image/jpeg";
    await pool.query(
      "INSERT INTO editor_uploads (id, site_id, content_type, bytes) VALUES ($1, NULL, $2, $3)",
      [uploadId, contentType, req.body]
    );
    res.json({ url: `/editor-upload/${uploadId}` });
  } catch (e) {
    console.error("upload-photo:", e);
    res.status(500).json({ error: e.message });
  }
});

// FROM SCRATCH — build site from manual data (no Google profile)
// For businesses that only exist on Instagram, WhatsApp, etc.
app.post("/api/from-scratch", async (req, res) => {
  try {
    const {
      name, category, description, phone, address, hours, photo_urls, instagram,
      owner_name, years_in_business, services, site_brief,
    } = req.body;
    if (!name?.trim() || !category?.trim()) {
      return res.status(400).json({ error: "Business name and category are required" });
    }

    // Normalize Instagram handle — strip URL prefix, leading @, trailing slashes
    let igHandle = (instagram || "").trim();
    if (igHandle) {
      const igMatch = igHandle.match(/(?:instagram\.com\/)?@?([a-zA-Z0-9._]+)/);
      igHandle = igMatch ? igMatch[1].replace(/\/+$/, "") : "";
    }

    // Compose a rich description that includes everything the user gave us.
    // This becomes the seed for Stage 1 (content plan) — the more we feed it, the more
    // it sticks to the user's wishes rather than inventing.
    const descParts = [];
    if (description?.trim()) descParts.push(description.trim());
    if (owner_name?.trim()) descParts.push(`Owner / Founder: ${owner_name.trim()}`);
    if (years_in_business) descParts.push(`Years in business: ${years_in_business}`);
    if (igHandle) descParts.push(`Instagram: @${igHandle}`);
    if (site_brief?.trim()) {
      descParts.push(`\n=== SITE BRIEF (special instructions from the business owner — follow these closely) ===\n${site_brief.trim()}`);
    }
    if (Array.isArray(services) && services.length > 0) {
      const svcLines = services
        .filter(s => s.name?.trim())
        .map(s => `• ${s.name}${s.price ? ` — ${s.price}` : ""}${s.description ? ` — ${s.description}` : ""}`);
      if (svcLines.length) {
        descParts.push(`\n=== SERVICES (use these exact services in the site — do not substitute) ===\n${svcLines.join("\n")}`);
      }
    }
    const fullDescription = descParts.join("\n");

    // Build a biz object that matches what shapeBusiness() produces, just from manual input
    const biz = {
      place_id:     `manual-${randomToken(10)}`,  // synthetic so upsert works
      name:         name.trim(),
      category:     category.trim(),
      address:      (address || "").trim(),
      phone:        (phone || "").trim(),
      rating:       0,
      review_count: 0,
      website:      null,
      hours:        Array.isArray(hours) ? hours.filter(Boolean) : [],
      reviews:      [],
      photos:       Array.isArray(photo_urls) ? photo_urls.filter(Boolean) : [],
      description:  fullDescription,
      google_url:   igHandle ? `https://instagram.com/${igHandle}` : null,
      // Pass user-provided services and metadata through so Stage 1 can use them directly
      _manual_meta: {
        owner_name: owner_name?.trim() || "",
        years_in_business: years_in_business || "",
        site_brief: site_brief?.trim() || "",
        services: Array.isArray(services)
          ? services.filter(s => s.name?.trim()).map(s => ({
              name: s.name.trim(),
              price: (s.price || "").trim(),
              description: (s.description || "").trim(),
            }))
          : [],
      },
    };

    const { saved, slug } = await buildAndSaveSite(biz);
    res.json({ business: saved, slug, previewUrl: `/preview/${slug}` });
  } catch (e) {
    console.error("🔴 from-scratch:", e);
    res.status(500).json({ error: e.message });
  }
});

// REBUILD — regenerate a unique site for an existing business
app.post("/api/rebuild/:id", async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM businesses WHERE id=$1", [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: "not found" });
    const row = r.rows[0];

    // Refresh from Google when possible
    let biz;
    if (row.place_id) {
      try {
        const p = await placeDetails(row.place_id);
        biz = shapeBusiness(p);
      } catch (e) {
        console.warn("refresh from Google failed, using stored data:", e.message);
      }
    }
    if (!biz) {
      biz = {
        place_id:     row.place_id,
        name:         row.name,
        address:      row.address || "",
        phone:        row.phone || "",
        category:     row.category || "Local Business",
        rating:       parseFloat(row.rating) || 0,
        review_count: row.review_count || 0,
        hours:        row.hours_json || [],
        website:      row.website || "",
        photos:       row.photos_json || [],
        reviews:      row.reviews_json || [],
        description:  row.description || "",
      };
    }

    const { saved, slug } = await buildAndSaveSite(biz, row.area_searched || "");
    res.json({ business: saved, slug, previewUrl: `/preview/${slug}` });
  } catch (e) {
    console.error("🔴 rebuild:", e);
    res.status(500).json({ error: e.message });
  }
});

// CRUD
app.get("/api/businesses", async (req, res) => {
  try {
    const { status } = req.query;
    let sql = "SELECT * FROM businesses"; const p = [];
    if (status && status !== "all") { sql += " WHERE status=$1"; p.push(status); }
    sql += " ORDER BY created_at DESC";
    const r = await pool.query(sql, p);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Warm photo cache for ALL existing businesses (one-time recovery for old sites)
// Visit in browser: GET /api/warm-cache  — or POST from a client
app.all("/api/warm-cache", async (req, res) => {
  try {
    const all = await pool.query("SELECT id, name, photos_json FROM businesses WHERE photos_json IS NOT NULL");
    let totalPhotos = 0, cached = 0, failed = 0;
    const failures = [];
    for (const row of all.rows) {
      const photos = row.photos_json || [];
      if (!photos.length) continue;
      totalPhotos += photos.length;
      const valid = await prefetchPhotos(photos);
      cached += valid.length;
      if (valid.length < photos.length) {
        failed += photos.length - valid.length;
        failures.push({ business: row.name, photos: photos.length, cached: valid.length });
      }
      console.log(`🔥 warmed ${valid.length}/${photos.length} for ${row.name}`);
    }
    res.json({
      ok: true,
      businesses_processed: all.rows.length,
      total_photos: totalPhotos,
      cached_successfully: cached,
      failed,
      failures: failures.slice(0, 20),
      hint: failed > 0
        ? "Some photos failed to cache. Check /api/diagnose to see why. Most likely cause: Google API quota."
        : "All photos cached successfully. Existing sites should work now (force-refresh your browser).",
    });
  } catch (e) {
    console.error("warm-cache:", e);
    res.status(500).json({ error: e.message });
  }
});

// Cache status check
app.get("/api/cache-status", async (req, res) => {
  try {
    const r = await pool.query("SELECT COUNT(*)::int AS cnt, COALESCE(SUM(LENGTH(bytes)), 0)::bigint AS total_bytes FROM photo_cache");
    res.json({
      cached_photos: r.rows[0].cnt,
      total_bytes: Number(r.rows[0].total_bytes),
      total_mb: Math.round(Number(r.rows[0].total_bytes) / 1024 / 1024 * 100) / 100,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Diagnose Google API connectivity — tests if photos are actually fetchable
app.get("/api/diagnose", async (req, res) => {
  const report = {
    env: {
      google_api_key_set: !!GKEY,
      google_api_key_preview: GKEY ? GKEY.slice(0, 8) + "…" + GKEY.slice(-4) : null,
      anthropic_key_set: !!process.env.ANTHROPIC_KEY,
      database_url_set: !!process.env.DATABASE_URL,
      node_env: process.env.NODE_ENV || "development",
    },
    tests: {},
  };

  // Test 1: A simple Text Search (cheap, tells us if API key works at all)
  try {
    const r = await fetch(
      `https://maps.googleapis.com/maps/api/place/textsearch/json?query=coffee+in+manhattan&key=${GKEY}`,
      { signal: AbortSignal.timeout(8000) }
    );
    const j = await r.json();
    report.tests.text_search = {
      http: r.status,
      api_status: j.status,
      error_message: j.error_message || null,
      results_returned: j.results?.length || 0,
    };
  } catch (e) {
    report.tests.text_search = { error: e.message };
  }

  // Test 2: Photo API — pick a random ref from our DB and try fetching
  try {
    const pr = await pool.query(
      "SELECT photos_json, name FROM businesses WHERE photos_json IS NOT NULL AND jsonb_array_length(photos_json) > 0 LIMIT 1"
    );
    if (pr.rows.length) {
      const photoUrl = pr.rows[0].photos_json[0];
      const m = photoUrl.match(/[?&]ref=([^&]+)/);
      if (m) {
        const ref = decodeURIComponent(m[1]);
        const r = await fetch(
          `https://maps.googleapis.com/maps/api/place/photo?maxwidth=400&photoreference=${encodeURIComponent(ref)}&key=${GKEY}`,
          { redirect: "follow", signal: AbortSignal.timeout(8000) }
        );
        report.tests.photo_fetch = {
          tested_with_business: pr.rows[0].name,
          http: r.status,
          content_type: r.headers.get("content-type"),
          content_length: r.headers.get("content-length"),
          final_url: r.url.slice(0, 100) + "…",
          ok: r.ok && (r.headers.get("content-type") || "").startsWith("image/"),
        };
      } else {
        report.tests.photo_fetch = { error: "No valid ref found in DB photo URL" };
      }
    } else {
      report.tests.photo_fetch = { skipped: "No businesses with photos in DB" };
    }
  } catch (e) {
    report.tests.photo_fetch = { error: e.message };
  }

  // Test 3: Cache stats
  try {
    const cs = await pool.query("SELECT COUNT(*)::int AS cnt FROM photo_cache");
    report.tests.cache = { cached_photo_count: cs.rows[0].cnt };
  } catch (e) {
    report.tests.cache = { error: e.message };
  }

  // Interpret
  const t = report.tests;
  if (t.photo_fetch?.http === 403 || t.text_search?.api_status === "OVER_QUERY_LIMIT") {
    report.diagnosis = "❌ Google API QUOTA EXCEEDED or key restrictions block server requests. Check Google Cloud Console → APIs → Places API → Quotas. Also verify the key has no HTTP referrer restriction (server keys should accept any referrer / be unrestricted, or restricted to your server IP).";
  } else if (t.text_search?.api_status === "REQUEST_DENIED") {
    report.diagnosis = "❌ API key invalid or Places API not enabled. Enable Places API (Legacy) in Google Cloud Console.";
  } else if (t.photo_fetch?.ok) {
    report.diagnosis = "✅ Google Photos API is working. If images still don't show, try POST /api/warm-cache then force-refresh the page.";
  } else if (t.text_search?.api_status === "OK" && t.photo_fetch && !t.photo_fetch.ok) {
    report.diagnosis = "⚠️ Text Search works but Photo fetch fails. Likely: Place Photos API not enabled, or photo-specific quota limit reached.";
  } else {
    report.diagnosis = "⚠️ Indeterminate. Inspect raw test results above.";
  }

  res.json(report);
});

app.get("/api/businesses/:id", async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM businesses WHERE id=$1", [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: "not found" });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/businesses/:id", async (req, res) => {
  try {
    const allowed = ["status", "notes", "name", "phone", "address", "category"];
    const sets = [], vals = [];
    for (const k of allowed) {
      if (k in req.body) { sets.push(`${k}=$${vals.length + 1}`); vals.push(req.body[k]); }
    }
    if (!sets.length) {
      const r = await pool.query("SELECT * FROM businesses WHERE id=$1", [req.params.id]);
      return res.json(r.rows[0]);
    }
    sets.push("updated_at=NOW()"); vals.push(req.params.id);
    await pool.query(`UPDATE businesses SET ${sets.join(",")} WHERE id=$${vals.length}`, vals);
    const r = await pool.query("SELECT * FROM businesses WHERE id=$1", [req.params.id]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/businesses/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM businesses WHERE id=$1", [req.params.id]);
    res.json({ deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// EXPORT — download generated HTML with photo URLs rewritten to absolute
// (so the file works hosted anywhere, photos still served by sitesprint backend)
app.get("/api/export/:id", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT b.name, b.preview_slug, gs.html, gs.edit_overrides
         FROM businesses b
         JOIN generated_sites gs ON gs.slug = b.preview_slug
        WHERE b.id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: "No built site for this business" });

    // Apply client edits (text & image overrides) BEFORE rewriting photo URLs
    let html = applyEditOverrides(r.rows[0].html, r.rows[0].edit_overrides || {});

    // Rewrite /photo?ref=X and /editor-upload/X → absolute URLs so the HTML is
    // portable to any domain (images keep working from sitesprint backend).
    const baseUrl = process.env.BASE_URL ||
      `${req.protocol === "https" || req.headers["x-forwarded-proto"] === "https" ? "https" : req.protocol}://${req.get("host")}`;
    html = html
      .replace(/(["'(])\/photo\?ref=/g, `$1${baseUrl}/photo?ref=`)
      .replace(/(["'(])\/editor-upload\//g, `$1${baseUrl}/editor-upload/`);

    const safeName = (r.rows[0].name || "site").replace(/[^a-z0-9]/gi, "_").toLowerCase();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}.html"`);
    res.send(html);
  } catch (e) {
    console.error("export:", e);
    res.status(500).json({ error: e.message });
  }
});

// PREVIEW — serve the AI-generated HTML (with client edits applied)
app.get("/preview/:slug", async (req, res) => {
  try {
    const r = await pool.query("SELECT html, edit_overrides FROM generated_sites WHERE slug=$1", [req.params.slug]);
    if (!r.rows.length) return res.status(404).send("<h1>Site not found</h1>");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const html = applyEditOverrides(r.rows[0].html, r.rows[0].edit_overrides || {});
    res.send(html);
  } catch (e) { res.status(500).send(e.message); }
});

// ═══════════════════════════════════════════════════════════════════════
// CLIENT EDITOR — token-gated, no login needed
// ═══════════════════════════════════════════════════════════════════════

// 1) Admin/owner enables the editor and gets a shareable link
app.post("/api/sites/:id/enable-editor", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT gs.id, gs.edit_token, b.name
         FROM generated_sites gs
         JOIN businesses b ON b.id = gs.business_id
        WHERE b.id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: "No site for this business" });

    let token = r.rows[0].edit_token;
    if (!token) {
      token = randomToken(18);
      await pool.query("UPDATE generated_sites SET edit_token=$1 WHERE id=$2", [token, r.rows[0].id]);
    }
    const baseUrl = process.env.BASE_URL ||
      `${req.protocol === "https" || req.headers["x-forwarded-proto"] === "https" ? "https" : req.protocol}://${req.get("host")}`;
    res.json({
      token,
      editor_url: `${baseUrl}/editor/${token}`,
      business_name: r.rows[0].name,
    });
  } catch (e) {
    console.error("enable-editor:", e);
    res.status(500).json({ error: e.message });
  }
});

// 2) Editor data — list of editable elements + current overrides (token-gated, public)
app.get("/api/editor/:token/data", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT gs.html, gs.edit_overrides, gs.slug, b.name, b.id AS biz_id
         FROM generated_sites gs
         JOIN businesses b ON b.id = gs.business_id
        WHERE gs.edit_token = $1`,
      [req.params.token]
    );
    if (!r.rows.length) return res.status(404).json({ error: "Invalid editor link" });

    const row = r.rows[0];
    const editables = extractEditables(row.html);
    res.json({
      business_name: row.name,
      slug: row.slug,
      editables,
      overrides: row.edit_overrides || {},
    });
  } catch (e) {
    console.error("editor data:", e);
    res.status(500).json({ error: e.message });
  }
});

// 3) Save overrides
app.post("/api/editor/:token/save", async (req, res) => {
  try {
    const { overrides } = req.body;
    if (!overrides || typeof overrides !== "object")
      return res.status(400).json({ error: "overrides object required" });

    const r = await pool.query(
      "UPDATE generated_sites SET edit_overrides=$1, edit_updated_at=NOW() WHERE edit_token=$2 RETURNING id",
      [overrides, req.params.token]
    );
    if (!r.rowCount) return res.status(404).json({ error: "Invalid editor link" });
    res.json({ saved: true });
  } catch (e) {
    console.error("editor save:", e);
    res.status(500).json({ error: e.message });
  }
});

// 4) Client uploads an image (replaces an img-N slot)
app.post("/api/editor/:token/upload", express.raw({ type: ["image/*"], limit: "8mb" }), async (req, res) => {
  try {
    const r = await pool.query("SELECT id FROM generated_sites WHERE edit_token=$1", [req.params.token]);
    if (!r.rows.length) return res.status(404).json({ error: "Invalid editor link" });
    if (!req.body || !req.body.length) return res.status(400).json({ error: "no image data" });
    if (req.body.length > 6 * 1024 * 1024) return res.status(400).json({ error: "image too large (max 6 MB)" });

    const uploadId = randomToken(10);
    const contentType = req.headers["content-type"] || "image/jpeg";
    await pool.query(
      "INSERT INTO editor_uploads (id, site_id, content_type, bytes) VALUES ($1,$2,$3,$4)",
      [uploadId, r.rows[0].id, contentType, req.body]
    );
    res.json({ url: `/editor-upload/${uploadId}` });
  } catch (e) {
    console.error("editor upload:", e);
    res.status(500).json({ error: e.message });
  }
});

// 5) Serve uploaded images
app.get("/editor-upload/:id", async (req, res) => {
  try {
    const r = await pool.query("SELECT content_type, bytes FROM editor_uploads WHERE id=$1", [req.params.id]);
    if (!r.rows.length) return sendTransparentPNG(res);
    res.setHeader("Content-Type", r.rows[0].content_type || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.send(r.rows[0].bytes);
  } catch (e) { sendTransparentPNG(res); }
});

// 6) The editor HTML page itself (public, token-gated by URL)
app.get("/editor/:token", async (req, res) => {
  const r = await pool.query("SELECT 1 FROM generated_sites WHERE edit_token=$1", [req.params.token]);
  if (!r.rows.length) return res.status(404).send("<h1>Invalid editor link</h1>");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(editorPageHtml(req.params.token));
});

function editorPageHtml(token) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Edit Your Site</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;
    background: #06060c; color: #e2e8f0; height: 100vh; display: flex; overflow: hidden;
  }
  #sidebar {
    width: 380px; min-width: 380px; background: #0a0a14; border-right: 1px solid rgba(255,255,255,.06);
    display: flex; flex-direction: column; overflow: hidden;
  }
  #header { padding: 18px 20px; border-bottom: 1px solid rgba(255,255,255,.06); }
  #header h1 { font-size: 20px; font-weight: 800; background: linear-gradient(135deg,#818cf8,#c084fc); -webkit-background-clip: text; -webkit-text-fill-color: transparent; letter-spacing: -0.5px; }
  #header .biz { font-size: 13px; color: #94a3b8; margin-top: 2px; }
  #header .hint { font-size: 11px; color: #64748b; margin-top: 8px; line-height: 1.5; }
  #items { flex: 1; overflow-y: auto; padding: 8px 0; }
  .group-label { font-size: 10px; font-weight: 700; color: #475569; padding: 14px 20px 6px; letter-spacing: 2px; text-transform: uppercase; }
  .item { padding: 12px 20px; border-bottom: 1px solid rgba(255,255,255,.04); }
  .item-label { font-size: 10px; color: #64748b; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 1px; }
  .item textarea, .item input[type="text"] {
    width: 100%; background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.08);
    color: #e2e8f0; border-radius: 8px; padding: 9px 11px; font-size: 13px;
    font-family: inherit; resize: vertical; outline: none; line-height: 1.5;
  }
  .item textarea:focus, .item input:focus { border-color: rgba(129,140,248,.5); }
  .item textarea { min-height: 60px; }
  .img-preview {
    width: 100%; aspect-ratio: 4/3; background: #14141a; border-radius: 8px;
    background-size: cover; background-position: center; cursor: pointer;
    border: 1px solid rgba(255,255,255,.08); display: flex; align-items: center; justify-content: center;
    color: #64748b; font-size: 12px; transition: all .2s;
  }
  .img-preview:hover { border-color: #6366f1; }
  .img-preview input { display: none; }
  #actions {
    padding: 14px 20px; border-top: 1px solid rgba(255,255,255,.06);
    display: flex; flex-direction: column; gap: 8px; background: #0a0a14;
  }
  button {
    padding: 11px 16px; border-radius: 9px; border: none; font-weight: 700;
    font-size: 13px; font-family: inherit; cursor: pointer; transition: all .15s;
  }
  .btn-primary { background: linear-gradient(135deg,#6366f1,#8b5cf6); color: #fff; }
  .btn-primary:hover { transform: translateY(-1px); }
  .btn-primary:disabled { opacity: .5; cursor: not-allowed; }
  .btn-ghost { background: rgba(255,255,255,.04); color: #94a3b8; border: 1px solid rgba(255,255,255,.08); }
  #status { font-size: 12px; color: #64748b; text-align: center; padding: 4px; min-height: 20px; }
  #preview { flex: 1; height: 100vh; background: #fff; position: relative; }
  #preview iframe { width: 100%; height: 100%; border: none; }
  #loading {
    position: absolute; inset: 0; background: rgba(6,6,12,.95);
    display: flex; align-items: center; justify-content: center; color: #94a3b8;
    z-index: 10; transition: opacity .3s;
  }
  #loading.hidden { opacity: 0; pointer-events: none; }
  .toast {
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
    padding: 12px 20px; border-radius: 10px; font-size: 13px; font-weight: 600;
    box-shadow: 0 10px 30px rgba(0,0,0,.4); z-index: 9999;
  }
  .toast.success { background: #10b981; color: #fff; }
  .toast.error { background: #ef4444; color: #fff; }
</style>
</head>
<body>
  <div id="sidebar">
    <div id="header">
      <h1>Edit Your Site</h1>
      <div class="biz" id="biz-name">Loading…</div>
      <div class="hint">Click any field below to edit. Changes preview instantly on the right. Click "Save" when finished.</div>
    </div>
    <div id="items">Loading…</div>
    <div id="status"></div>
    <div id="actions">
      <button class="btn-primary" id="save-btn" onclick="saveAll()">💾 Save Changes</button>
      <button class="btn-ghost" onclick="window.open(previewSlug ? '/preview/' + previewSlug : '#', '_blank')">↗ Open in New Tab</button>
    </div>
  </div>
  <div id="preview">
    <div id="loading">Loading preview…</div>
    <iframe id="frame" src=""></iframe>
  </div>

<script>
  const TOKEN = ${JSON.stringify(token)};
  let editables = [];
  let overrides = {};
  let previewSlug = '';
  let saveTimer;

  function toast(msg, type='success') {
    const t = document.createElement('div');
    t.className = 'toast ' + type;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

  async function init() {
    try {
      const r = await fetch('/api/editor/' + TOKEN + '/data');
      if (!r.ok) throw new Error('Failed to load');
      const d = await r.json();
      document.getElementById('biz-name').textContent = d.business_name;
      editables = d.editables || [];
      overrides = d.overrides || {};
      previewSlug = d.slug;
      renderItems();
      const frame = document.getElementById('frame');
      frame.onload = () => { document.getElementById('loading').classList.add('hidden'); };
      frame.src = '/preview/' + d.slug + '?t=' + Date.now();
    } catch (e) {
      document.getElementById('items').innerHTML = '<div style="padding:20px;color:#ef4444">Error: ' + e.message + '</div>';
    }
  }

  function renderItems() {
    const wrap = document.getElementById('items');
    wrap.innerHTML = '';
    const texts = editables.filter(e => e.type === 'text');
    const imgs = editables.filter(e => e.type === 'image');

    if (texts.length) {
      const label = document.createElement('div');
      label.className = 'group-label';
      label.textContent = '✏️ Text (' + texts.length + ')';
      wrap.appendChild(label);
      texts.forEach(it => wrap.appendChild(makeTextItem(it)));
    }
    if (imgs.length) {
      const label = document.createElement('div');
      label.className = 'group-label';
      label.textContent = '🖼️ Images (' + imgs.length + ')';
      wrap.appendChild(label);
      imgs.forEach(it => wrap.appendChild(makeImageItem(it)));
    }
  }

  function makeTextItem(it) {
    const div = document.createElement('div');
    div.className = 'item';
    const current = (overrides[it.id] !== undefined ? overrides[it.id] : it.value);
    const isLong = current.length > 80;
    div.innerHTML =
      '<div class="item-label">' + it.tag.toUpperCase() + '</div>' +
      (isLong
        ? '<textarea>' + escape(current) + '</textarea>'
        : '<input type="text" value="' + escape(current) + '">');
    const input = div.querySelector('textarea, input');
    input.addEventListener('input', () => {
      overrides[it.id] = input.value;
      scheduleAutoSave();
    });
    return div;
  }

  function makeImageItem(it) {
    const div = document.createElement('div');
    div.className = 'item';
    const current = (overrides[it.id] !== undefined ? overrides[it.id] : it.value);
    const fullUrl = current.startsWith('http') ? current : (window.location.origin + current);
    div.innerHTML =
      '<div class="item-label">Image · ' + it.id + '</div>' +
      '<label class="img-preview" style="background-image:url(\\'' + fullUrl + '\\')">' +
        '<input type="file" accept="image/*">' +
        '<span style="background:rgba(0,0,0,.6);padding:4px 10px;border-radius:4px">Click to replace</span>' +
      '</label>';
    const input = div.querySelector('input[type="file"]');
    const preview = div.querySelector('.img-preview');
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      preview.innerHTML = '<span>Uploading…</span>';
      try {
        const r = await fetch('/api/editor/' + TOKEN + '/upload', {
          method: 'POST',
          headers: { 'Content-Type': file.type },
          body: file,
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Upload failed');
        overrides[it.id] = d.url;
        preview.style.backgroundImage = "url('" + d.url + "')";
        preview.innerHTML = '<input type="file" accept="image/*"><span style="background:rgba(0,0,0,.6);padding:4px 10px;border-radius:4px">Click to replace</span>';
        preview.querySelector('input').addEventListener('change', input.onchange);
        scheduleAutoSave();
        toast('Image uploaded');
      } catch (e) {
        toast(e.message, 'error');
      }
    });
    return div;
  }

  function escape(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function scheduleAutoSave() {
    document.getElementById('status').textContent = '✎ Unsaved changes';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveAll, 2500);
  }

  async function saveAll() {
    const btn = document.getElementById('save-btn');
    btn.disabled = true; btn.textContent = '⏳ Saving…';
    document.getElementById('status').textContent = '';
    try {
      const r = await fetch('/api/editor/' + TOKEN + '/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overrides }),
      });
      if (!r.ok) throw new Error((await r.json()).error || 'Save failed');
      btn.textContent = '✓ Saved';
      // Refresh iframe to show changes
      document.getElementById('frame').src = '/preview/' + previewSlug + '?t=' + Date.now();
      document.getElementById('loading').classList.remove('hidden');
      toast('All changes saved');
      setTimeout(() => { btn.textContent = '💾 Save Changes'; btn.disabled = false; }, 1500);
    } catch (e) {
      btn.textContent = '💾 Save Changes'; btn.disabled = false;
      toast(e.message, 'error');
    }
  }

  init();
</script>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════════════
// STANDALONE PHP EXPORT — single index.php file that includes everything
// The client uploads this to their cPanel and edits on their own domain.
// We're completely out of the loop after handoff.
// ═══════════════════════════════════════════════════════════════════════

// Add the column once (idempotent)
pool.query(`ALTER TABLE generated_sites ADD COLUMN IF NOT EXISTS standalone_password TEXT;`).catch(()=>{});

app.get("/api/export/:id/php", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT gs.id, gs.html, gs.edit_overrides, gs.standalone_password, b.name
         FROM generated_sites gs
         JOIN businesses b ON b.id = gs.business_id
        WHERE b.id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: "No site for this business" });

    // Apply any edits made on sitesprint (so they're baked into the PHP)
    let html = applyEditOverrides(r.rows[0].html, r.rows[0].edit_overrides || {});

    // Rewrite /photo?ref=... to absolute URLs (sitesprint backend serves the cached photos)
    const baseUrl = process.env.BASE_URL ||
      `${req.protocol === "https" || req.headers["x-forwarded-proto"] === "https" ? "https" : req.protocol}://${req.get("host")}`;
    html = html
      .replace(/(["'(])\/photo\?ref=/g, `$1${baseUrl}/photo?ref=`)
      .replace(/(["'(])\/editor-upload\//g, `$1${baseUrl}/editor-upload/`);

    // Generate or reuse standalone password
    let password = r.rows[0].standalone_password;
    if (!password) {
      // alphanumeric only — safe for PHP single-quoted string and URL params
      password = require("crypto").randomBytes(6).toString("base64url").replace(/[-_]/g, "x");
      await pool.query("UPDATE generated_sites SET standalone_password=$1 WHERE id=$2", [password, r.rows[0].id]);
    }

    // Build the PHP file
    const phpContent = buildStandalonePhp(html, password);

    const safeName = (r.rows[0].name || "site").replace(/[^a-z0-9]/gi, "_").toLowerCase();
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="index.php"`);
    res.setHeader("X-Edit-Password", password); // also available in header for frontend
    res.send(phpContent);
  } catch (e) {
    console.error("php export:", e);
    res.status(500).json({ error: e.message });
  }
});

// Helper: get the password (for re-displaying after page reload)
app.get("/api/sites/:id/php-password", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT gs.standalone_password
         FROM generated_sites gs
         JOIN businesses b ON b.id = gs.business_id
        WHERE b.id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: "Not found" });
    res.json({ password: r.rows[0].standalone_password });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function buildStandalonePhp(html, password) {
  // Base64-encode the HTML so we don't have to worry about quote/heredoc escaping
  const b64 = Buffer.from(html, "utf-8").toString("base64");

  // The editor JS that gets injected ONLY when in edit mode.
  // This runs in the client's browser on their own domain. It POSTs to the same
  // index.php with ?api=save and ?api=upload.
  const editorJs = `
(function(){
  var STYLE = \`
    #se-toggle{position:fixed;top:14px;right:14px;z-index:99998;background:#6366f1;color:#fff;border:none;padding:9px 14px;border-radius:8px;font-weight:700;font-size:13px;cursor:pointer;font-family:-apple-system,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.3)}
    #se-panel{position:fixed;right:0;top:0;bottom:0;width:380px;max-width:90vw;background:#0a0a14;color:#e2e8f0;z-index:99999;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Inter,sans-serif;display:flex;flex-direction:column;box-shadow:-12px 0 40px rgba(0,0,0,.5);border-left:1px solid rgba(255,255,255,.08);transform:translateX(100%);transition:transform .3s ease}
    #se-panel.open{transform:translateX(0)}
    #se-header{padding:18px 20px;border-bottom:1px solid rgba(255,255,255,.06);display:flex;justify-content:space-between;align-items:center}
    #se-header h2{margin:0;font-size:17px;font-weight:800;background:linear-gradient(135deg,#818cf8,#c084fc);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
    #se-close{background:none;border:none;color:#64748b;cursor:pointer;font-size:22px;padding:0;width:30px;height:30px}
    #se-hint{padding:10px 20px;font-size:11px;color:#64748b;border-bottom:1px solid rgba(255,255,255,.04);line-height:1.5}
    #se-items{flex:1;overflow-y:auto;padding:8px 0}
    .se-group{font-size:10px;font-weight:700;color:#475569;padding:14px 20px 6px;letter-spacing:2px;text-transform:uppercase}
    .se-item{padding:11px 20px;border-bottom:1px solid rgba(255,255,255,.04)}
    .se-item label{display:block;font-size:10px;color:#64748b;margin-bottom:5px;text-transform:uppercase;letter-spacing:1px}
    .se-item textarea,.se-item input[type=text]{width:100%;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);color:#e2e8f0;border-radius:7px;padding:8px 10px;font-size:13px;font-family:inherit;resize:vertical;outline:none;line-height:1.5;box-sizing:border-box}
    .se-item textarea:focus,.se-item input:focus{border-color:rgba(129,140,248,.5)}
    .se-item textarea{min-height:55px}
    .se-img{width:100%;aspect-ratio:4/3;background:#14141a;border-radius:7px;background-size:cover;background-position:center;cursor:pointer;border:1px solid rgba(255,255,255,.08);position:relative;overflow:hidden}
    .se-img:hover{border-color:#6366f1}
    .se-img span{position:absolute;bottom:8px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.7);padding:4px 10px;border-radius:4px;font-size:11px;color:#fff}
    .se-img input{display:none}
    #se-actions{padding:14px 20px;border-top:1px solid rgba(255,255,255,.06);display:flex;flex-direction:column;gap:8px}
    #se-actions button{padding:11px 16px;border-radius:8px;border:none;font-weight:700;font-size:13px;font-family:inherit;cursor:pointer}
    #se-save{background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff}
    #se-save:disabled{opacity:.5;cursor:not-allowed}
    #se-logout{background:rgba(239,68,68,.1);color:#fca5a5;border:1px solid rgba(239,68,68,.3) !important}
    #se-status{padding:6px 20px;font-size:11px;color:#64748b;text-align:center}
    .se-toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#10b981;color:#fff;padding:10px 18px;border-radius:8px;font-size:13px;font-weight:600;z-index:100000;box-shadow:0 10px 30px rgba(0,0,0,.3)}
    .se-toast.error{background:#ef4444}
  \`;
  var style=document.createElement('style');style.textContent=STYLE;document.head.appendChild(style);

  var toggle=document.createElement('button');
  toggle.id='se-toggle';toggle.textContent='✏️ Edit';
  document.body.appendChild(toggle);

  var panel=document.createElement('div');
  panel.id='se-panel';
  panel.innerHTML=\`
    <div id="se-header">
      <h2>Edit Your Site</h2>
      <button id="se-close">×</button>
    </div>
    <div id="se-hint">Click any text to edit it, or any image to replace it. Changes save when you click Save.</div>
    <div id="se-items"></div>
    <div id="se-status"></div>
    <div id="se-actions">
      <button id="se-save">💾 Save Changes</button>
      <button id="se-logout">Exit Edit Mode</button>
    </div>
  \`;
  document.body.appendChild(panel);

  toggle.onclick=function(){panel.classList.add('open');toggle.style.display='none'};
  document.getElementById('se-close').onclick=function(){panel.classList.remove('open');toggle.style.display=''};
  document.getElementById('se-logout').onclick=function(){window.location.href='?api=logout'};

  function toast(msg,err){var t=document.createElement('div');t.className='se-toast'+(err?' error':'');t.textContent=msg;document.body.appendChild(t);setTimeout(function(){t.remove()},2500)}
  function esc(s){var d=document.createElement('div');d.textContent=s;return d.innerHTML}

  var overrides={};
  var items=document.getElementById('se-items');
  var texts=[],imgs=[];
  document.querySelectorAll('[data-edit-id]').forEach(function(el){
    var id=el.getAttribute('data-edit-id');
    if(!id) return;
    if(id.indexOf('text-')===0) texts.push({id:id,el:el});
    else if(id.indexOf('img-')===0) imgs.push({id:id,el:el});
  });

  if(texts.length){
    var g=document.createElement('div');g.className='se-group';g.textContent='✏️ Text ('+texts.length+')';items.appendChild(g);
    texts.forEach(function(it){
      var div=document.createElement('div');div.className='se-item';
      var v=it.el.textContent.trim();
      var long=v.length>80;
      div.innerHTML='<label>'+it.id+' · '+it.el.tagName.toLowerCase()+'</label>'+(long?'<textarea>'+esc(v)+'</textarea>':'<input type="text" value="'+esc(v)+'">');
      var input=div.querySelector('textarea, input');
      input.addEventListener('input',function(){overrides[it.id]=input.value;it.el.textContent=input.value});
      input.addEventListener('focus',function(){it.el.scrollIntoView({behavior:'smooth',block:'center'})});
      items.appendChild(div);
    });
  }

  if(imgs.length){
    var g2=document.createElement('div');g2.className='se-group';g2.textContent='🖼️ Images ('+imgs.length+')';items.appendChild(g2);
    imgs.forEach(function(it){
      var div=document.createElement('div');div.className='se-item';
      div.innerHTML='<label>'+it.id+'</label><label class="se-img" style="background-image:url(\\''+it.el.src+'\\')"><input type="file" accept="image/*"><span>Click to replace</span></label>';
      var fi=div.querySelector('input[type=file]');
      var preview=div.querySelector('.se-img');
      fi.addEventListener('change',async function(){
        var f=fi.files[0];if(!f)return;
        preview.innerHTML='<span>Uploading...</span>';
        try{
          var r=await fetch('?api=upload',{method:'POST',headers:{'Content-Type':f.type},body:f});
          var d=await r.json();
          if(!r.ok)throw new Error(d.error||'Upload failed');
          overrides[it.id]=d.url;
          it.el.src=d.url;
          preview.style.backgroundImage="url('"+d.url+"')";
          preview.innerHTML='<input type="file" accept="image/*"><span>Click to replace</span>';
          preview.querySelector('input').addEventListener('change',fi.onchange);
          toast('Image uploaded');
        }catch(e){preview.innerHTML='<input type="file" accept="image/*"><span style="background:#ef4444">Failed</span>';toast(e.message,1)}
      });
      items.appendChild(div);
    });
  }

  document.getElementById('se-save').onclick=async function(){
    var btn=this;btn.disabled=true;btn.textContent='⏳ Saving...';
    try{
      var r=await fetch('?api=save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({overrides:overrides})});
      var d=await r.json();
      if(!r.ok)throw new Error(d.error||'Save failed');
      btn.textContent='✅ Saved';
      toast('All changes saved');
      setTimeout(function(){btn.textContent='💾 Save Changes';btn.disabled=false},1500);
    }catch(e){btn.textContent='💾 Save Changes';btn.disabled=false;toast(e.message,1)}
  };
})();`;

  return `<?php
// =========================================================================
//   SiteSprint Standalone Site + Editor
//   Upload this single file to your cPanel public_html/ folder.
//   Visit yourdomain.com to see the site.
//   Visit yourdomain.com?edit=PASSWORD to enter edit mode.
// =========================================================================

$EDIT_PASSWORD = '${password}';
$DATA_FILE = __DIR__ . '/_data.json';
$UPLOAD_DIR = __DIR__ . '/uploads';
$COOKIE_NAME = 'siteedit_${password.slice(0, 4)}';

function ssLoadData() {
  global $DATA_FILE;
  if (!file_exists($DATA_FILE)) return ['overrides' => new stdClass()];
  $d = @json_decode(file_get_contents($DATA_FILE), true);
  return is_array($d) ? $d : ['overrides' => new stdClass()];
}
function ssSaveData($data) {
  global $DATA_FILE;
  @file_put_contents($DATA_FILE, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
}
function ssIsAuth() {
  global $EDIT_PASSWORD, $COOKIE_NAME;
  if (($_GET['edit'] ?? null) === $EDIT_PASSWORD) return true;
  if (($_COOKIE[$COOKIE_NAME] ?? null) === $EDIT_PASSWORD) return true;
  return false;
}

// ── API ROUTES ───────────────────────────────────────────────────────────
$api = $_GET['api'] ?? null;

if ($api === 'save') {
  header('Content-Type: application/json');
  if (!ssIsAuth()) { http_response_code(401); echo '{"error":"unauthorized"}'; exit; }
  $body = json_decode(file_get_contents('php://input'), true) ?: [];
  ssSaveData(['overrides' => $body['overrides'] ?? [], 'updated_at' => date('c')]);
  echo json_encode(['saved' => true]);
  exit;
}

if ($api === 'upload') {
  header('Content-Type: application/json');
  if (!ssIsAuth()) { http_response_code(401); echo '{"error":"unauthorized"}'; exit; }
  if (!is_dir($UPLOAD_DIR)) @mkdir($UPLOAD_DIR, 0755, true);
  if (!is_dir($UPLOAD_DIR)) { http_response_code(500); echo '{"error":"cannot create uploads dir"}'; exit; }
  $data = file_get_contents('php://input');
  if (!$data || strlen($data) > 8000000) { http_response_code(400); echo '{"error":"missing or too large (max 8MB)"}'; exit; }
  $contentType = $_SERVER['CONTENT_TYPE'] ?? 'image/jpeg';
  $ext = 'jpg';
  if (strpos($contentType, 'png') !== false) $ext = 'png';
  elseif (strpos($contentType, 'webp') !== false) $ext = 'webp';
  elseif (strpos($contentType, 'gif') !== false) $ext = 'gif';
  $name = bin2hex(random_bytes(8)) . '.' . $ext;
  @file_put_contents($UPLOAD_DIR . '/' . $name, $data);
  echo json_encode(['url' => 'uploads/' . $name]);
  exit;
}

if ($api === 'logout') {
  setcookie($COOKIE_NAME, '', time() - 3600, '/');
  header('Location: ' . strtok($_SERVER['REQUEST_URI'], '?'));
  exit;
}

// Set cookie after first auth via ?edit=
if (($_GET['edit'] ?? null) === $EDIT_PASSWORD) {
  setcookie($COOKIE_NAME, $EDIT_PASSWORD, time() + 86400 * 30, '/');
}
$ssInEditMode = ssIsAuth();

// ── LOAD HTML + APPLY OVERRIDES ──────────────────────────────────────────
$ssData = ssLoadData();
$ssOverrides = $ssData['overrides'] ?? [];

$html = base64_decode('${b64}');

foreach ((array)$ssOverrides as $id => $value) {
  $value = (string)$value;
  $idQuoted = preg_quote($id, '/');
  if (strpos($id, 'text-') === 0) {
    $html = preg_replace_callback(
      '/(<[a-zA-Z0-9]+[^>]*data-edit-id="' . $idQuoted . '"[^>]*>)([^<]*)(<\\/[a-zA-Z0-9]+>)/',
      function($m) use ($value) {
        return $m[1] . htmlspecialchars($value, ENT_QUOTES | ENT_HTML5) . $m[3];
      },
      $html,
      1
    );
  } elseif (strpos($id, 'img-') === 0) {
    $safeValue = htmlspecialchars($value, ENT_QUOTES);
    $html = preg_replace_callback(
      '/<img([^>]*data-edit-id="' . $idQuoted . '"[^>]*)>/',
      function($m) use ($safeValue) {
        $attrs = preg_replace('/\\s+src=("[^"]*"|\\'[^\\']*\\')/', '', $m[1]);
        return '<img src="' . $safeValue . '"' . $attrs . '>';
      },
      $html,
      1
    );
  }
}

// ── INJECT EDITOR JS WHEN IN EDIT MODE ───────────────────────────────────
if ($ssInEditMode) {
  $editorJs = <<<'EOJS_SITESPRINT'
${editorJs}
EOJS_SITESPRINT;
  $html = str_replace('</body>', '<script>' . $editorJs . '</script></body>', $html);
}

header('Content-Type: text/html; charset=utf-8');
echo $html;
`;
}

const PORT = process.env.PORT || 3001;
initDB()
  .then(() => app.listen(PORT, () => console.log(`🚀 SiteSprint v10 on :${PORT} — Google:${GKEY?"✅":"❌"} Anthropic:${process.env.ANTHROPIC_KEY?"✅":"❌"} JWT:${process.env.JWT_SECRET?"✅":"⚠️ default"}`)))
  .catch(err => { console.error("startup failed:", err); process.exit(1); });