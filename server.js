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
  // Standard CID
  const m1 = url.match(/!1s(ChIJ[A-Za-z0-9_-]+)/);
  if (m1) return m1[1];
  // ?place_id= param
  const m2 = url.match(/[?&]place_id=([A-Za-z0-9_-]+)/);
  if (m2) return m2[1];
  return null;
}

function extractCoordsFromUrl(url) {
  const m = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
  const m2 = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (m2) return { lat: parseFloat(m2[1]), lng: parseFloat(m2[2]) };
  return null;
}

function extractNameFromUrl(url) {
  const m = url.match(/\/place\/([^/@?]+)/);
  if (m) return decodeURIComponent(m[1].replace(/\+/g, " "));
  return null;
}

async function urlToPlaceId(url) {
  const resolved = await resolveGoogleUrl(url);
  console.log("📍 Resolved:", resolved.slice(0, 200));

  let placeId = extractPlaceIdFromUrl(resolved);
  if (placeId) return placeId;

  const name = extractNameFromUrl(resolved);
  const coords = extractCoordsFromUrl(resolved);

  if (name) {
    const q = coords ? `${name} near ${coords.lat},${coords.lng}` : name;
    console.log("🔍 Falling back to FindPlace:", q);
    const c = await placesFindPlace(q);
    if (c?.place_id) return c.place_id;
  }

  throw new Error("Couldn't extract a place from this URL. Use the Discover tab and search the business by name instead.");
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
  console.log(`📸 prefetch: ${valid.length}/${photoUrls.length} photos cached`);
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

// ─── AI: UNIQUE SITE GENERATOR ────────────────────────────────────────────────
async function generateUniqueHTML(biz) {
  // Pre-download all photos to DB cache. This:
  //  - Eliminates Google API calls at view time (served from DB)
  //  - Ensures we only feed Claude URLs that we KNOW will work
  const validPhotos = await prefetchPhotos(biz.photos || []);
  const photos  = validPhotos.slice(0, 10);
  // Only 5-star reviews (per user requirement)
  const reviews = (biz.reviews || []).filter(r => Number(r.rating) === 5).slice(0, 5);

  const reviewsBlock = reviews.length
    ? reviews.map((r, i) =>
        `R${i+1}: ${r.name} (${r.rating}★, ${r.time}): "${(r.text || "").slice(0, 280)}"`
      ).join("\n")
    : "(no 5-star Google reviews available — omit the testimonials section gracefully)";

  const photosBlock = photos.length
    ? photos.map((u, i) => `IMG${i+1}: ${u}`).join("\n")
    : "(no Google photos — use only solid colors / gradients, no broken images)";

  const hoursBlock = biz.hours?.length ? biz.hours.join(" | ") : "Hours not listed";

  // Deterministically pick a design system based on this business's place_id.
  // Two different businesses → different design systems → no two sites look alike.
  const ds = pickDesignSystem(biz.place_id || biz.name);
  console.log(`🎨 Design system for ${biz.name}: ${ds.name}`);

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
Rating: ${biz.rating}★ from ${biz.review_count} Google reviews
Hours: ${hoursBlock}
Description: ${biz.description || "(none)"}

═══ REAL GOOGLE 5-STAR REVIEWS (use VERBATIM — these are real customers) ═══
${reviewsBlock}

═══ AVAILABLE PHOTOS (real Google Place photos — embed via these URLs) ═══
${photosBlock}

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

【3】SCROLL-TRIGGERED ANIMATIONS (use IntersectionObserver — no library):
   • Text fade-up with stagger on entry
   • Image parallax / scale-up on scroll
   • Count-up stat animations (animate numbers from 0 to target)
   • Section dividers that reveal as you scroll
   • Sticky scroll sections where content transforms

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

═══ STRUCTURE (every section gets its own visual identity within the ${ds.name} system) ═══
1. Sticky nav — logo + 4-5 nav links + prominent CTA. Becomes glassmorphic / colored on scroll.
2. HERO — wow treatment from above, using --accent prominently
3. Trust band / marquee — auto-scrolling: "★★★★★ ${biz.rating} • ${biz.review_count} Reviews • Family Owned • Open Today •"
4. ABOUT — magazine-style asymmetric, NOT centered. Pull quote from a review. Image with creative crop using --accent filters.
5. SERVICES (4-6) — varied card design fitting the ${ds.name} aesthetic. Invent realistic services for "${biz.category}" with 1-2 sentence descriptions.
6. GALLERY — creative grid using ALL provided photos. Bento, masonry, horizontal scroll-snap. Apply duotone/filter effects using --accent.
7. REVIEWS — feature the BEST review as a huge pull-quote with author. Then marquee/grid of others. Use real Google reviews verbatim.
8. CONTACT — split layout: info (phone, address, hours) + visual contact form. --accent on the CTA.
9. FOOTER — branded, not just links. Include hours, social-ish icons, copyright.

═══ TECHNICAL REQUIREMENTS ═══
• Single self-contained HTML file. ALL CSS inline in <style>. ALL JS inline in <script>.
• Mobile-first responsive — test mentally at 375px, 768px, 1280px.
• Font Awesome 6.5 via CDN: https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css
• Google Fonts via the @import shown above (ONLY ${ds.fonts.display} and ${ds.fonts.body}).
• Modern CSS only: custom properties, grid, flex, clamp(), aspect-ratio, color-mix() ok.
• IntersectionObserver for scroll animations (no GSAP / no jQuery / no libs).
• Use the EXACT photo URLs given — DON'T invent placeholders.
• <title>${biz.name}</title>
• Performance: lean. No external libs. Inline SVG instead of icon fonts where it shines.
• Accessibility: semantic HTML, alt-equivalents, focus states, prefers-reduced-motion respected.

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

═══ COPY VOICE — match this business ═══
Read the reviews. Match the energy of the actual customers. A salon's voice ≠ an auto shop's voice ≠ a taqueria's voice. Reference the city/neighborhood from the address. Use specifics. Make the copy feel hand-written for THIS business, not template-generated.

═══ OUTPUT FORMAT ═══
Output ONLY the complete HTML document. Start with <!DOCTYPE html> and end with </html>. NO markdown code fences. NO commentary before or after.

Build the entire site within the **${ds.name}** design system. Show real ambition — typical output is 25,000-40,000 characters of carefully crafted code. Make this site WIN.`;

  console.log(`🤖 Calling Claude for: ${biz.name}`);

  // Multi-turn generation with auto-continuation if max_tokens is hit
  const messages = [{ role: "user", content: prompt }];
  let html = "";
  let attempts = 0;
  const MAX_ATTEMPTS = 5;       // safety cap; usually 1-2 calls is enough
  const PER_CALL_TOKENS = 32000; // Sonnet 4.6 supports up to 64K; 32K is a safe per-call ceiling

  while (attempts < MAX_ATTEMPTS) {
    attempts++;
    // Use streaming — required by Anthropic API for requests where
    // max_tokens could push total time over 10 minutes.
    // .finalMessage() awaits completion and returns the same shape as create().
    const stream = ai.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: PER_CALL_TOKENS,
      messages,
    });
    const r = await stream.finalMessage();

    const chunk = r.content[0]?.text || "";
    html += chunk;

    console.log(`📦 ${biz.name} chunk ${attempts}: +${chunk.length} chars (stop_reason=${r.stop_reason}, total=${html.length})`);

    // Done when the model finishes naturally
    if (r.stop_reason !== "max_tokens") break;

    // Hit the per-call cap — ask Claude to continue from the exact cutoff
    messages.push({ role: "assistant", content: chunk });
    messages.push({
      role: "user",
      content:
        "Continue the HTML exactly where you stopped. Do NOT repeat any content already written. " +
        "Do NOT add any preamble, explanation, or markdown. Output only the next characters of the HTML " +
        "so when concatenated to what you already wrote it forms one valid document ending in </html>.",
    });

    // Extra safety: if we already have </html> somehow, stop
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

    console.log(`✅ ${area}: checked ${detailsChecked} (cache hits: ${detailsFromCache}), found ${withoutWebsite.length} without website. Est cost: $${estCostUSD}`);

    res.json({
      area,
      category: category || (deep ? `deep scan (${SMALL_BIZ.length} categories)` : `default scan (${SMALL_BIZ.length} categories)`),
      queries_used: queries.length,
      scanned: candidates.length,
      details_checked: detailsChecked,
      details_from_cache: detailsFromCache,
      count: withoutWebsite.length,
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
      `SELECT b.name, b.preview_slug, gs.html
         FROM businesses b
         JOIN generated_sites gs ON gs.slug = b.preview_slug
        WHERE b.id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: "No built site for this business" });

    // Rewrite /photo?ref=X → https://<this-backend>/photo?ref=X so the HTML is
    // portable to any domain. Photos continue being served from sitesprint backend
    // (already DB-cached, so reliable).
    const baseUrl = process.env.BASE_URL ||
      `${req.protocol === "https" || req.headers["x-forwarded-proto"] === "https" ? "https" : req.protocol}://${req.get("host")}`;
    let html = r.rows[0].html.replace(/(["'(])\/photo\?ref=/g, `$1${baseUrl}/photo?ref=`);

    const safeName = (r.rows[0].name || "site").replace(/[^a-z0-9]/gi, "_").toLowerCase();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}.html"`);
    res.send(html);
  } catch (e) {
    console.error("export:", e);
    res.status(500).json({ error: e.message });
  }
});

// PREVIEW — serve the AI-generated HTML
app.get("/preview/:slug", async (req, res) => {
  try {
    const r = await pool.query("SELECT html FROM generated_sites WHERE slug=$1", [req.params.slug]);
    if (!r.rows.length) return res.status(404).send("<h1>Site not found</h1>");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(r.rows[0].html);
  } catch (e) { res.status(500).send(e.message); }
});

const PORT = process.env.PORT || 3001;
initDB()
  .then(() => app.listen(PORT, () => console.log(`🚀 SiteSprint v10 on :${PORT} — Google:${GKEY?"✅":"❌"} Anthropic:${process.env.ANTHROPIC_KEY?"✅":"❌"} JWT:${process.env.JWT_SECRET?"✅":"⚠️ default"}`)))
  .catch(err => { console.error("startup failed:", err); process.exit(1); });