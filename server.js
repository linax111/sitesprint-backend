// SiteSprint v9 — Real Google data + AI-unique sites per business
require("dotenv").config();
const express   = require("express");
const cors      = require("cors");
const { Pool }  = require("pg");
const Anthropic = require("@anthropic-ai/sdk");

const app  = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "2mb" }));

const ai   = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });
const GKEY = process.env.GOOGLE_API_KEY;

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

async function placeDetails(placeId) {
  const fields = "place_id,name,formatted_address,formatted_phone_number,international_phone_number,rating,user_ratings_total,opening_hours,website,types,reviews,editorial_summary,business_status,geometry,photos,url";
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=${fields}&key=${GKEY}&language=en&reviews_no_translations=true`;
  const d = await gfetch(url);
  if (d.status !== "OK") throw new Error(`Details ${d.status}: ${d.error_message || ""}`);
  return d.result;
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

// ─── PHOTO PROXY (keeps API key server-side) ──────────────────────────────────
app.get("/photo", async (req, res) => {
  try {
    const { ref, w = 1600 } = req.query;
    if (!ref)  return res.status(400).send("ref required");
    if (!GKEY) return res.status(500).send("Google API key not set");
    const url = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=${w}&photoreference=${encodeURIComponent(ref)}&key=${GKEY}`;
    const r = await fetch(url, { redirect: "follow" });
    if (!r.ok) return res.status(r.status).send("photo fetch failed");
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", r.headers.get("content-type") || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=2592000, immutable");
    res.send(buf);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// ─── AI: UNIQUE SITE GENERATOR ────────────────────────────────────────────────
async function generateUniqueHTML(biz) {
  const photos  = (biz.photos || []).slice(0, 8);
  const reviews = (biz.reviews || []).slice(0, 5);

  const reviewsBlock = reviews.length
    ? reviews.map((r, i) =>
        `R${i+1}: ${r.name} (${r.rating}★, ${r.time}): "${(r.text || "").slice(0, 280)}"`
      ).join("\n")
    : "(no Google reviews available)";

  const photosBlock = photos.length
    ? photos.map((u, i) => `IMG${i+1}: ${u}`).join("\n")
    : "(no Google photos — use only solid colors / gradients, no broken images)";

  const hoursBlock = biz.hours?.length ? biz.hours.join(" | ") : "Hours not listed";

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

═══ REAL GOOGLE REVIEWS (use VERBATIM — these are real customers) ═══
${reviewsBlock}

═══ AVAILABLE PHOTOS (real Google Place photos — embed via these URLs) ═══
${photosBlock}

═══ THE WOW BAR — NON-NEGOTIABLE QUALITY STANDARDS ═══

【1】HERO — visually arresting, pick ONE treatment:
   • Full-bleed image with mask-reveal animated text
   • Asymmetric split (oversized headline breaking the grid)
   • Text-stroke / background-clip:text huge type with image showing through letters
   • Layered photo composition with parallax depth on scroll
   • Gradient mesh background with floating photo cards / 3D tilted images
   • Duotone-treated hero image with brand colors
   • Marquee headline scrolling horizontally
   • Animated text entrance (word-by-word stagger fade-up)

【2】TYPOGRAPHY — must POP, not whisper:
   • Display headlines using clamp() for fluid sizing (e.g., clamp(3rem, 9vw, 8rem))
   • Mix display + body font with dramatic contrast (weight, style, scale)
   • Use text-stroke, drop-shadow, or gradient/clip-path text for impact
   • Vary weight dramatically across the page (300 vs 900 in the same section)
   • Letter-spacing manipulation: tight for display, expanded for eyebrows
   • Pairings to consider: Fraunces+Inter, Cormorant+Manrope, Bebas+Barlow,
     DM Serif Display+DM Sans, Space Grotesk+Space Mono, Playfair+Lato,
     Outfit+Lora, Archivo Black+Inter, Editorial New-style serifs, Geist Sans,
     Instrument Serif, Migra. DO NOT default to plain Inter everywhere.

【3】SCROLL-TRIGGERED ANIMATIONS (use IntersectionObserver — no library):
   • Text fade-up with stagger on entry
   • Image parallax / scale-up on scroll
   • Count-up stat animations (animate numbers from 0 to target)
   • Section dividers that reveal as you scroll
   • Sticky scroll sections where content transforms
   • Clip-path reveal masks on images and text

【4】CUSTOM VISUAL TREATMENTS:
   • Custom inline SVG decorations (organic blobs, waves, geometric patterns)
   • Duotone or color-washed photos using CSS filters (filter: grayscale + mix-blend)
   • Glassmorphism panels (backdrop-filter: blur)
   • Subtle grain/noise texture overlays
   • Animated gradient meshes
   • Custom shape clip-paths on images (organic blobs, hexagons, arches)
   • Color-mix() palette work

【5】INTERACTIVE MICRO-MOMENTS:
   • Buttons: hover lift + shadow + color shift (NOT flat rects)
   • Cards: 3D tilt on hover (transform: perspective + rotate3d)
   • Magnetic CTA buttons that nudge toward cursor (subtle JS)
   • Smooth scroll with offset for sticky nav
   • Image galleries: hover zoom, mask reveals, cursor-following effects
   • Custom cursor dot follower (optional, must be tasteful)

【6】LAYOUT VARIATION — BREAK THE GRID:
   • Asymmetric splits (image left 60%, text right 40%, or reversed/staggered)
   • Overlapping elements (negative margins, z-index layering)
   • Diagonal section dividers using clip-path: polygon
   • Marquee / scrolling text bands between sections
   • Bento grids (different sized boxes packed cleverly)
   • Magazine-style editorial spreads with pull-quotes
   • DO NOT make every section be "centered heading + 3 columns"

【7】THE SIGNATURE MOMENT — every site needs ONE wow:
   Pick something memorable just for this business. Examples:
   • Animated SVG hero illustration
   • Horizontal-scroll photo gallery with snap
   • Auto-scrolling "wall of reviews" marquee
   • Stat counters with animated count-up
   • 3D card flip / parallax on reviews
   • Masked-text marquee header
   • Animated logo / wordmark
   • Before/after CSS-only slider

═══ STRUCTURE (every section gets its own visual identity) ═══
1. Sticky nav — logo + 4-5 nav links + prominent CTA. Becomes glassmorphic / colored on scroll.
2. HERO — wow treatment from above
3. Trust band / marquee — could be auto-scrolling: "★★★★★ ${biz.rating} • ${biz.review_count} Reviews • Since X • Family Owned • Open Today •" etc.
4. ABOUT — magazine-style asymmetric, NOT centered. Pull quote from a review. Image with creative crop.
5. SERVICES (4-6) — varied card design. NOT boring 3-column. Could be bento, alternating L/R, vertical numbered, etc. Invent realistic services for "${biz.category}" with 1-2 sentence descriptions.
6. GALLERY — creative grid using ALL provided photos. Try bento, masonry, horizontal scroll-snap, or mixed sizes. Apply duotone filters or hover effects.
7. REVIEWS — feature the BEST review as a huge pull-quote with author. Then a marquee/grid of the others. Use real Google reviews verbatim.
8. CONTACT — split layout: info (phone, address, hours) + visual contact form. Add a styled "Get in touch" or map placeholder visual.
9. FOOTER — branded, not just links. Include hours, social-ish icons, copyright.

═══ DESIGN DIRECTION CHOICES (pick ONE and commit) ═══
Editorial magazine • Swiss minimal with grid lines • Brutalist with raw type •
Glassmorphism + gradient mesh • Organic curves and blobs • Warm cozy hand-crafted •
Sharp industrial mono • Soft luxe gold accents • Neo-retro 80s • Y2K nostalgia •
Mid-century modern • Art-deco geometric • Modern editorial serif •
Anti-design intentional rough • Premium minimal with lots of whitespace

═══ TECHNICAL REQUIREMENTS ═══
• Single self-contained HTML file. ALL CSS inline in <style>. ALL JS inline in <script>.
• Mobile-first responsive — test mentally at 375px, 768px, 1280px.
• Font Awesome 6.5 via CDN: https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css
• Google Fonts via @import in <style>.
• Modern CSS only: custom properties, grid, flex, clamp(), aspect-ratio, color-mix() ok.
• IntersectionObserver for scroll animations (no GSAP / no jQuery / no libs).
• Use the EXACT photo URLs given — DON'T invent placeholders.
• <title>${biz.name}</title>
• Performance: lean. No external libs. Inline SVG instead of icon fonts where it shines.
• Accessibility: semantic HTML, alt-equivalents, focus states, prefers-reduced-motion respected.

═══ ANTI-PATTERNS — DO NOT ═══
✗ Generic SaaS purple/indigo gradient look
✗ Inter as the only font
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
Output ONLY the complete HTML document. Start with <!DOCTYPE html> and end with </html>. NO markdown code fences. NO commentary before or after. NO explanations.

Give this site real ambition — typical output for a wow-factor flagship is 25,000-40,000 characters of carefully crafted code. Don't shortcut. Don't skim. Make this site WIN.`;

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

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.get("/", (_, res) => res.json({
  ok: true,
  service: "SiteSprint v9",
  google_api: !!GKEY,
  anthropic_api: !!process.env.ANTHROPIC_KEY,
}));

// DISCOVER — real Google search filtered to businesses WITHOUT a website
//
// Strategy:
//  - If user picked a category: paginate that one query (up to 60 results)
//  - If broad search: run 55+ small-business queries in parallel — categories
//    far more likely to lack a website (barber, nails, taqueria, food truck,
//    tailor, handyman, locksmith, etc.) than "restaurants in X" which mostly
//    surfaces big chains that already have sites
//  - Fetch details with concurrency 10, stop once we have `limit` no-website hits
app.post("/api/discover", async (req, res) => {
  try {
    const { area, category = "", limit = 50 } = req.body;
    if (!area)  return res.status(400).json({ error: "area required" });
    if (!GKEY)  return res.status(500).json({ error: "GOOGLE_API_KEY not configured" });

    // 55 small-biz categories with high "no website" rate, grouped by intent
    const SMALL_BIZ = [
      // Personal care & beauty
      "barber shops", "nail salons", "hair salons", "beauty salons",
      "tattoo shops", "piercing studios", "lash studios", "brow studios",
      "tailors", "dry cleaners", "shoe repair", "massage therapists",
      // Auto
      "auto repair", "tire shops", "car detailing", "car wash",
      "auto body shops", "oil change shops", "mobile mechanics", "auto glass repair",
      // Food
      "taquerias", "food trucks", "donut shops", "ice cream shops",
      "small family restaurants", "bakeries", "sandwich shops", "pizzerias",
      "bbq joints", "juice bars", "smoothie shops", "boba tea shops",
      "halal restaurants", "vietnamese restaurants", "ethiopian restaurants",
      // Home & services
      "handymen", "locksmiths", "lawn care", "plumbers",
      "electricians", "cleaning services", "pet groomers", "junk removal",
      "moving companies", "painters", "fence contractors", "hvac repair",
      // Retail
      "convenience stores", "ethnic markets", "florists", "smoke shops",
      "thrift stores", "consignment shops",
      // Professional
      "tax preparers", "notaries", "tutors", "music lessons",
      "dance studios", "martial arts dojos", "photographers",
    ];

    // Build query plan
    let queries, paginate;
    if (category) {
      queries  = [`${category} in ${area}`];
      paginate = true;   // one focused query → fetch all 60 results
    } else {
      queries  = SMALL_BIZ.map(q => `${q} in ${area}`);
      paginate = false;  // many queries → just first 20 each is plenty
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

    // Dedupe by place_id
    const seen = new Set();
    const candidates = [];
    for (const r of allResults) {
      if (r.place_id && !seen.has(r.place_id)) {
        seen.add(r.place_id);
        candidates.push(r);
      }
    }
    console.log(`🔍 ${area} — ${queries.length} queries → ${candidates.length} unique candidates`);

    // Fetch details with concurrency; stop once we have `limit` no-website hits
    const withoutWebsite = [];
    let idx = 0;
    let detailsChecked = 0;
    const CONCURRENCY = 12;

    const worker = async () => {
      while (idx < candidates.length && withoutWebsite.length < limit) {
        const my = idx++;
        const c  = candidates[my];
        try {
          const p = await placeDetails(c.place_id);
          detailsChecked++;
          if (!p.website && p.business_status !== "CLOSED_PERMANENTLY") {
            withoutWebsite.push(shapeBusiness(p));
          }
        } catch (e) {
          console.warn("details failed", c.place_id, e.message);
        }
      }
    };
    await Promise.all(Array(CONCURRENCY).fill(0).map(() => worker()));

    console.log(`✅ ${area}: checked ${detailsChecked}/${candidates.length}, found ${withoutWebsite.length} without website`);

    res.json({
      area,
      category: category || `small-biz mix (${SMALL_BIZ.length} categories)`,
      queries_used: queries.length,
      scanned: candidates.length,
      details_checked: detailsChecked,
      count: withoutWebsite.length,
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
  .then(() => app.listen(PORT, () => console.log(`🚀 SiteSprint v9 on :${PORT} — Google:${GKEY?"✅":"❌"} Anthropic:${process.env.ANTHROPIC_KEY?"✅":"❌"}`)))
  .catch(err => { console.error("startup failed:", err); process.exit(1); });