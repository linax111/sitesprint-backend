require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const { Pool } = require("pg");
const Anthropic = require("@anthropic-ai/sdk");

const app  = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

app.use(cors({ origin: "*" }));
app.use(express.json());

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_KEY
});

// ─── DB INIT ──────────────────────────────────────────────────────────────────
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS businesses (
        id            SERIAL PRIMARY KEY,
        name          TEXT NOT NULL,
        address       TEXT DEFAULT '',
        phone         TEXT DEFAULT '',
        category      TEXT DEFAULT '',
        rating        NUMERIC(2,1) DEFAULT 0,
        review_count  INT DEFAULT 0,
        hours         TEXT DEFAULT '',
        website       TEXT DEFAULT '',
        google_url    TEXT DEFAULT '',
        status        TEXT DEFAULT 'prospect',
        notes         TEXT DEFAULT '',
        area_searched TEXT DEFAULT '',
        preview_slug  TEXT DEFAULT '',
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS preview_slug TEXT DEFAULT '';`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS generated_sites (
        id          SERIAL PRIMARY KEY,
        business_id INT REFERENCES businesses(id) ON DELETE CASCADE,
        slug        TEXT UNIQUE NOT NULL,
        html        TEXT NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log("✅ Database synced successfully.");
  } catch (err) {
    console.error("❌ DB Init Error:", err);
  }
}

// ─── INDUSTRY IMAGE BANK ──────────────────────────────────────────────────────
function getIndustryImages(category) {
  const cat = (category || "business").toLowerCase();

  let imgs = [
    "https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&w=1600&q=80",
    "https://images.unsplash.com/photo-1460925895917-afdab827c52f?auto=format&fit=crop&w=800&q=80",
    "https://images.unsplash.com/photo-1542744094-3a31f103e35f?auto=format&fit=crop&w=800&q=80",
    "https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?auto=format&fit=crop&w=800&q=80",
    "https://images.unsplash.com/photo-1551836022-d5d88e9218df?auto=format&fit=crop&w=800&q=80"
  ];

  if (cat.includes("salon") || cat.includes("beauty") || cat.includes("hair")) {
    imgs = [
      "https://images.unsplash.com/photo-1562322140-8baeececf3df?auto=format&fit=crop&w=1600&q=80",
      "https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1605497746444-ac9da58480a8?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1487412720507-e7ab37603c6f?auto=format&fit=crop&w=800&q=80"
    ];
  } else if (cat.includes("repair") || cat.includes("auto") || cat.includes("mechanic")) {
    imgs = [
      "https://images.unsplash.com/photo-1619642751034-765dfdf7c58e?auto=format&fit=crop&w=1600&q=80",
      "https://images.unsplash.com/photo-1486006920555-c77dce18193b?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1563720223185-11003d516935?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1517524206127-48bbd363f3d7?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?auto=format&fit=crop&w=800&q=80"
    ];
  } else if (cat.includes("rest") || cat.includes("food") || cat.includes("cafe")) {
    imgs = [
      "https://images.unsplash.com/photo-1514933651103-005eec06c04b?auto=format&fit=crop&w=1600&q=80",
      "https://images.unsplash.com/photo-1555396273-367ea4eb4db5?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1504674900247-0877df9cc836?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1606787366850-de6330128bfc?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1414235077428-338989a2e8c0?auto=format&fit=crop&w=800&q=80"
    ];
  } else if (cat.includes("clean") || cat.includes("wash") || cat.includes("maid") || cat.includes("hvac")) {
    imgs = [
      "https://images.unsplash.com/photo-1581578731548-c64695cc6952?auto=format&fit=crop&w=1600&q=80",
      "https://images.unsplash.com/photo-1621905252507-b35492cc74b4?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1527515637-6742562d5395?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1584622650111-993a426fbf0a?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1545205597-3d9d02c29597?auto=format&fit=crop&w=800&q=80"
    ];
  }

  return imgs;
}

// ─── COLOR PALETTE PER INDUSTRY ───────────────────────────────────────────────
function getIndustryColors(category) {
  const cat = (category || "").toLowerCase();
  if (cat.includes("salon") || cat.includes("beauty") || cat.includes("hair"))
    return { primary: "#C9748A", accent: "#F2A7B8", dark: "#1a0d10" };
  if (cat.includes("auto") || cat.includes("repair") || cat.includes("mechanic"))
    return { primary: "#00B4D8", accent: "#90E0EF", dark: "#03045e" };
  if (cat.includes("rest") || cat.includes("food") || cat.includes("cafe"))
    return { primary: "#F4A261", accent: "#E76F51", dark: "#1a0a00" };
  if (cat.includes("dental") || cat.includes("medical") || cat.includes("health"))
    return { primary: "#4CC9F0", accent: "#7DF9FF", dark: "#03045e" };
  if (cat.includes("gym") || cat.includes("fitness"))
    return { primary: "#F72585", accent: "#FF6B6B", dark: "#10002b" };
  if (cat.includes("clean") || cat.includes("hvac") || cat.includes("plumb"))
    return { primary: "#52B788", accent: "#95D5B2", dark: "#081c15" };
  if (cat.includes("law") || cat.includes("legal"))
    return { primary: "#9B8EA0", accent: "#C9B8CE", dark: "#0d0a0e" };
  return { primary: "#6366f1", accent: "#818cf8", dark: "#0f0a1e" };
}

// ─── TWO-PASS HTML GENERATION (ANTI-TRUNCATION) ───────────────────────────────
async function generatePremiumHTML(biz) {
  const images = getIndustryImages(biz.category);
  const colors = getIndustryColors(biz.category);

  const SYSTEM = `You are an elite Awwwards-winning web designer.
Output ONLY raw HTML/CSS/JS — no markdown, no backticks, no explanations.
Rules:
- Use Tailwind CSS via CDN
- Use FontAwesome 6 icons via CDN: <i class="fa-solid fa-icon-name"></i>  (never raw SVG paths)
- Glassmorphism design: blur backdrops, glowing borders
- Primary color: ${colors.primary} | Accent: ${colors.accent} | Dark bg: ${colors.dark}
- Image placeholder classes (empty divs, DO NOT use <img> tags):
    Hero bg:    <div class="bg-hero-img ...">
    Feature:    <div class="feature-img ...">
    Gallery:    <div class="gallery-img-1 rounded-2xl h-72 w-full"></div>
                <div class="gallery-img-2 rounded-2xl h-72 w-full"></div>
                <div class="gallery-img-3 rounded-2xl h-72 w-full"></div>
- Keep all paragraph text 1–2 sentences max to save tokens
- No placeholders like "Lorem ipsum" or "[content here]"`;

  // ── PASS 1: head + navbar + hero + trust bar + services ─────────────────────
  const pass1Prompt = `Business: "${biz.name}" | Category: ${biz.category} | Rating: ${biz.rating} stars | Reviews: ${biz.review_count}

Generate ONLY these parts and STOP — do not write </body> or </html>:

1. Full <!DOCTYPE html><html><head> block including:
   - Tailwind CDN
   - FontAwesome 6 CDN
   - Google Fonts (pick 1 elegant font)
   - AOS animation library CDN
   - <style> block with glassmorphism utilities and .bg-hero-img / .feature-img / .gallery-img-1/2/3 as empty placeholders (background: transparent)
   - <title>${biz.name}</title>

2. <body> opening tag with dark background style

3. Sticky glassmorphism Navbar with:
   - Logo (business name)
   - Nav links: Home, Services, Gallery, Contact
   - CTA button "Get Quote"

4. Full-screen Hero section:
   - Use <div class="bg-hero-img w-full min-h-screen flex items-center justify-center relative">
   - Big headline, subheadline, two CTA buttons
   - Floating rating badge showing ${biz.rating}★

5. Trust metrics bar (3 stats relevant to ${biz.category})

6. Services section with heading + grid of 3 cards (each with FontAwesome icon, title, 1-sentence description)

End your output after the closing </section> of services. Do NOT close body or html.`;

  // ── PASS 2: gallery + contact + footer + scripts ─────────────────────────────
  const pass2Prompt = `Business: "${biz.name}" | Phone: ${biz.phone || "Call us"} | Address: ${biz.address || "Visit us"} | Hours: ${biz.hours || "Mon-Sat 9AM-6PM"}

Continue the HTML page. Start directly from a <section> tag. Generate these final parts then close the document:

1. Gallery section with heading + 3-column grid:
   <div class="gallery-img-1 rounded-2xl h-72 w-full" data-aos="zoom-in"></div>
   <div class="gallery-img-2 rounded-2xl h-72 w-full" data-aos="zoom-in" data-aos-delay="100"></div>
   <div class="gallery-img-3 rounded-2xl h-72 w-full" data-aos="zoom-in" data-aos-delay="200"></div>

2. Contact section with:
   - Business info (phone, address, hours) with FontAwesome icons
   - Contact form (name, email, message, submit button)

3. Footer with business name, tagline, copyright

4. <script> block initializing AOS: AOS.init({ duration: 800, once: true });

5. </body></html> to properly close the document

Start your output with <section (gallery section opening tag).`;

  try {
    console.log(`🎨 Pass 1: Generating head + hero + services for "${biz.name}"...`);
    const res1 = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: SYSTEM,
      messages: [{ role: "user", content: pass1Prompt }]
    });

    let part1 = res1.content[0].text.trim();
    part1 = part1.replace(/^```html?\n?/, "").replace(/^```\n?/, "").replace(/```$/, "").trim();

    console.log(`🎨 Pass 2: Generating gallery + contact + footer for "${biz.name}"...`);
    const res2 = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: SYSTEM,
      messages: [{ role: "user", content: pass2Prompt }]
    });

    let part2 = res2.content[0].text.trim();
    part2 = part2.replace(/^```html?\n?/, "").replace(/^```\n?/, "").replace(/```$/, "").trim();

    // Merge the two parts
    let htmlContent = part1 + "\n\n" + part2;

    // Safety net: ensure document is closed
    if (!htmlContent.includes("</html>")) {
      htmlContent += "\n</body>\n</html>";
    }

    // Inject real image URLs via CSS
    const cssInjection = `
<style>
  .bg-hero-img {
    background-image: linear-gradient(rgba(4,4,10,0.55), rgba(4,4,10,0.92)), url('${images[0]}');
    background-size: cover; background-position: center; background-attachment: fixed;
  }
  .feature-img {
    background-image: url('${images[1]}');
    background-size: cover; background-position: center;
  }
  .gallery-img-1 {
    background-image: url('${images[2]}');
    background-size: cover; background-position: center;
    transition: transform 0.5s ease; overflow: hidden;
  }
  .gallery-img-1:hover { transform: scale(1.05); }
  .gallery-img-2 {
    background-image: url('${images[3]}');
    background-size: cover; background-position: center;
    transition: transform 0.5s ease;
  }
  .gallery-img-2:hover { transform: scale(1.05); }
  .gallery-img-3 {
    background-image: url('${images[4]}');
    background-size: cover; background-position: center;
    transition: transform 0.5s ease;
  }
  .gallery-img-3:hover { transform: scale(1.05); }
</style>
</head>`;

    if (htmlContent.includes("</head>")) {
      htmlContent = htmlContent.replace("</head>", cssInjection);
    } else {
      // Fallback: inject before <body>
      htmlContent = htmlContent.replace("<body", cssInjection.replace("</head>", "") + "\n<body");
    }

    console.log(`✅ Site generated successfully for "${biz.name}" (${htmlContent.length} chars)`);
    return htmlContent.trim();

  } catch (error) {
    console.error("🔴 Generation Error:", error.message);
    return `<!DOCTYPE html><html><head><title>Error</title></head><body style="display:flex;align-items:center;justify-content:center;height:100vh;background:#0f0f13;font-family:sans-serif;"><h1 style="color:#ef4444;">AI generation failed. Please try again.</h1></body></html>`;
  }
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

app.get("/", (_, res) => res.json({ ok: true, service: "SiteSprint Engine v2" }));

// GET all businesses (with optional filters)
app.get("/api/businesses", async (req, res) => {
  try {
    const { status, q } = req.query;
    let sql = "SELECT * FROM businesses WHERE 1=1";
    const params = [];
    if (status && status !== "all") {
      sql += ` AND status=$${params.length + 1}`;
      params.push(status);
    }
    if (q) {
      sql += ` AND (name ILIKE $${params.length + 1} OR category ILIKE $${params.length + 2} OR address ILIKE $${params.length + 3})`;
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    sql += " ORDER BY created_at DESC";
    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST create business
app.post("/api/businesses", async (req, res) => {
  try {
    const b = req.body;
    const r = await pool.query(
      `INSERT INTO businesses (name,address,phone,category,rating,review_count,hours,website,google_url,status,area_searched)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        b.name, b.address || "", b.phone || "", b.category || "",
        b.rating || 0, b.review_count || 0, b.hours || "",
        b.website || "", b.google_url || "",
        b.status || "prospect", b.area_searched || ""
      ]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update business
app.put("/api/businesses/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const b = req.body;
    const allowed = ["name","address","phone","category","rating","review_count","hours","website","google_url","status","notes","preview_slug"];
    const sets = [];
    const params = [];
    for (const col of allowed) {
      if (col in b) {
        sets.push(`${col}=$${params.length + 1}`);
        params.push(b[col]);
      }
    }
    if (!sets.length) return res.json({ ok: true });
    sets.push("updated_at=NOW()");
    params.push(id);
    await pool.query(`UPDATE businesses SET ${sets.join(",")} WHERE id=$${params.length}`, params);
    const r = await pool.query("SELECT * FROM businesses WHERE id=$1", [id]);
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE business
app.delete("/api/businesses/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM businesses WHERE id=$1", [req.params.id]);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST search area (generates 20 mock businesses)
app.post("/api/search", async (req, res) => {
  try {
    const { area } = req.body;
    if (!area) return res.status(400).json({ error: "area required" });

    const categories = [
      { cat: "Auto Repair",  name: "Motors & Glass"      },
      { cat: "Restaurant",   name: "Grill & Bistro"       },
      { cat: "Salon",        name: "Beauty Studio"        },
      { cat: "Plumbing",     name: "Rooter Services"      },
      { cat: "Dental",       name: "Family Dentistry"     },
      { cat: "Gym",          name: "Fitness Center"       },
      { cat: "Landscaping",  name: "Lawn & Garden"        },
      { cat: "Roofing",      name: "Roofing Experts"      },
      { cat: "Cafe",         name: "Coffee Roasters"      },
      { cat: "Cleaning",     name: "Commercial Cleaners"  }
    ];

    const results = [];
    for (let i = 1; i <= 20; i++) {
      const type = categories[i % categories.length];
      results.push({
        id: 1000 + i,
        name: `${area} Elite ${type.name}`,
        address: `${100 + i * 15} Commerce Blvd, ${area}`,
        phone: `(555) 019-${(i * 123).toString().padStart(4, "0")}`,
        category: type.cat,
        rating: parseFloat((4 + Math.random()).toFixed(1)),
        review_count: Math.floor(Math.random() * 400) + 45,
        hours: "Mon-Sat 8AM - 6PM",
        area_searched: area
      });
    }

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GENERATE SITE (shared handler) ───────────────────────────────────────────
const generateHandler = async (req, res) => {
  try {
    const { id } = req.params;

    // Try to find existing business
    let bizResult = await pool.query("SELECT * FROM businesses WHERE id=$1", [id]);
    let currentBiz;

    if (bizResult.rows.length) {
      currentBiz = bizResult.rows[0];
    } else {
      // Business not in DB yet — insert it from request body
      const b = req.body;
      const insertResult = await pool.query(
        `INSERT INTO businesses (name,address,phone,category,rating,review_count,hours,status,area_searched)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          b.name || "Business", b.address || "", b.phone || "",
          b.category || "", b.rating || 5, b.review_count || 50,
          b.hours || "", "prospect", b.area_searched || ""
        ]
      );
      currentBiz = insertResult.rows[0];
    }

    // Generate HTML via two-pass Claude
    const html = await generatePremiumHTML(currentBiz);
    const slug = `${currentBiz.id}-${Date.now()}`;

    // Save generated site
    await pool.query(
      `INSERT INTO generated_sites (business_id, slug, html)
       VALUES ($1,$2,$3)
       ON CONFLICT (slug) DO UPDATE SET html=EXCLUDED.html`,
      [currentBiz.id, slug, html]
    );

    // Update business record with new slug + status
    await pool.query(
      "UPDATE businesses SET preview_slug=$1, status='site shown', updated_at=NOW() WHERE id=$2",
      [slug, currentBiz.id]
    );

    res.json({ url: `/preview/${slug}`, slug });
  } catch (err) {
    console.error("🔴 Generate Route Error:", err);
    res.status(500).json({ error: err.message });
  }
};

app.post("/api/generate/:id", generateHandler);
app.post("/generate/:id", generateHandler);

// ─── SERVE PREVIEW ────────────────────────────────────────────────────────────
app.get("/preview/:slug", async (req, res) => {
  try {
    const r = await pool.query("SELECT html FROM generated_sites WHERE slug=$1", [req.params.slug]);
    if (!r.rows.length) return res.status(404).send("<h1>Site not found</h1>");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(r.rows[0].html);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 SiteSprint Engine v2 active on port ${PORT}`));
});