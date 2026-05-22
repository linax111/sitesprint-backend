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
  const photos = (p.photos || []).slice(0, 8).map(ph =>
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

  const prompt = `You are an award-winning web designer. Design and code a ONE-OF-A-KIND single-page website for the specific local business below. Each site you build must look distinctly different from any template — different palette, fonts, layout choices, copy tone. NEVER fall back to a generic SaaS purple-gradient look.

═══ BUSINESS DATA (use exactly as-is, never invent facts) ═══
Name: ${biz.name}
Category: ${biz.category}
Address: ${biz.address || "Address not listed"}
Phone: ${biz.phone || "Phone not listed"}
Rating: ${biz.rating}★ from ${biz.review_count} Google reviews
Hours: ${hoursBlock}
Description: ${biz.description || "(none)"}

═══ REAL GOOGLE REVIEWS (use the text VERBATIM in a testimonial section) ═══
${reviewsBlock}

═══ AVAILABLE PHOTOS (real Google Place photos — embed via these URLs) ═══
${photosBlock}

═══ CREATIVE BRIEF — make distinctive choices for THIS business ═══
1. PALETTE: Pick 3–5 colors that match the business's identity (a salon ≠ an auto shop ≠ a restaurant). Avoid the cliché purple/indigo gradient unless it genuinely fits.
2. TYPOGRAPHY: Pick a Google Fonts pairing that fits the brand mood. Don't default to Inter. Try pairings like Fraunces+Inter, Cormorant+Manrope, Bebas+Barlow, DM Serif+DM Sans, Space Grotesk+Space Mono, Playfair+Lato, Outfit+Lora, Archivo+Newsreader, etc.
3. DESIGN DIRECTION: Pick ONE clear direction — editorial/magazine, swiss-minimal, brutalist, glassmorphism, organic curves, art-deco, retro/80s, neo-cyber, warm cozy, sharp industrial, soft luxe, etc. Commit to it across the whole page.
4. LAYOUT: Vary the hero (centered, split, full-bleed image, off-center asymmetric, etc). Vary card styles. Vary section transitions.
5. SIGNATURE ELEMENT: Add ONE memorable visual element — a custom blob/shape, a marquee, an unusual grid, a creative cursor effect, an angled section, a duotone image treatment, etc.
6. COPY VOICE: Match the business — luxe formal for high-end salons, energetic and bold for gyms, warm and storytelling for restaurants, trustworthy and precise for medical/dental, etc.

═══ STRUCTURE (all required, but layout and styling unique) ═══
- Sticky responsive navigation with business name/logo + 3–5 nav links + CTA
- Hero: big business name, tagline, ONE strong CTA, hero image from IMG1
- About / value-prop section
- Services (3–6 — invent realistic services that match "${biz.category}", with short descriptions)
- Gallery (4–7 images from IMG2..IMG8 — varied grid, not a boring 3x3)
- Testimonials section using the REAL Google reviews verbatim, with reviewer names
- Contact: phone, address, hours, simple contact form (visual only; onsubmit shows "Sent!" state)
- Footer

═══ TECHNICAL REQUIREMENTS ═══
- Single self-contained HTML file: ALL CSS inline in <style>, ALL JS inline in <script>. No external CSS files.
- Mobile-first responsive (test mentally at 375px, 768px, 1280px).
- Font Awesome 6.5 via CDN OK: https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css
- Google Fonts via @import in <style>.
- Modern CSS: custom properties, grid, flex, clamp(), aspect-ratio.
- Smooth scroll, IntersectionObserver scroll-triggered animations, hover micro-interactions.
- Use the photo URLs given — DON'T invent URLs or use placeholders.
- Set <title>${biz.name}</title>.
- Performance: no jQuery, no heavy libs.

═══ OUTPUT FORMAT ═══
Output ONLY the complete HTML document. Start with <!DOCTYPE html> and end with </html>. NO markdown code fences, NO commentary before or after, NO explanations. Just the raw HTML.`;

  console.log(`🤖 Calling Claude for: ${biz.name}`);
  const r = await ai.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 16000,
    messages: [{ role: "user", content: prompt }],
  });

  let html = r.content[0]?.text?.trim() || "";
  // Strip any accidental markdown fences
  html = html.replace(/^```(?:html)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();

  // Validate
  const lc = html.toLowerCase();
  if (!lc.includes("<!doctype") && !lc.startsWith("<html")) {
    throw new Error("AI did not return valid HTML");
  }
  if (html.length < 2000) {
    throw new Error("AI returned suspiciously short HTML");
  }
  console.log(`✅ HTML generated for ${biz.name}: ${html.length} chars`);
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
app.post("/api/discover", async (req, res) => {
  try {
    const { area, category = "", limit = 12 } = req.body;
    if (!area)  return res.status(400).json({ error: "area required" });
    if (!GKEY)  return res.status(500).json({ error: "GOOGLE_API_KEY not configured" });

    // Build queries — focused if category given, broad otherwise
    const queries = category
      ? [`${category} in ${area}`]
      : [
          `restaurants in ${area}`,
          `salons in ${area}`,
          `auto repair shops in ${area}`,
          `dentists in ${area}`,
          `gyms in ${area}`,
          `cafes in ${area}`,
        ];

    const seen = new Set();
    const candidates = [];
    for (const q of queries) {
      try {
        const { results } = await placesTextSearch(q);
        for (const r of results.slice(0, 10)) {
          if (!seen.has(r.place_id)) {
            seen.add(r.place_id);
            candidates.push(r);
          }
        }
        if (candidates.length > 40) break;
      } catch (e) {
        console.warn("query failed", q, e.message);
      }
    }

    // Fetch details for each, keep only no-website
    const withoutWebsite = [];
    for (const c of candidates) {
      if (withoutWebsite.length >= limit) break;
      try {
        const p = await placeDetails(c.place_id);
        if (!p.website && p.business_status !== "CLOSED_PERMANENTLY") {
          withoutWebsite.push(shapeBusiness(p));
        }
      } catch (e) {
        console.warn("details failed", c.place_id, e.message);
      }
    }

    res.json({
      area,
      category: category || "all",
      scanned: candidates.length,
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