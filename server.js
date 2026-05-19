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

// اتصال مستقیم به غول طراحی
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_KEY
});

// ─── DB INIT ─────────────────────────────────────────────────────────────────
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS businesses (
        id           SERIAL PRIMARY KEY,
        name         TEXT NOT NULL,
        address      TEXT DEFAULT '',
        phone        TEXT DEFAULT '',
        category     TEXT DEFAULT '',
        rating       NUMERIC(2,1) DEFAULT 0,
        review_count INT DEFAULT 0,
        hours        TEXT DEFAULT '',
        website      TEXT DEFAULT '',
        google_url   TEXT DEFAULT '',
        status       TEXT DEFAULT 'prospect',
        notes        TEXT DEFAULT '',
        area_searched TEXT DEFAULT '',
        preview_slug  TEXT DEFAULT '',
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        updated_at   TIMESTAMPTZ DEFAULT NOW()
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

// ─── DYNAMIC IMAGE BANK ───────────────────────────────────────────────────────
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

// ─── CLAUDE ARCHITECT ENGINE (ANTI-TRUNCATION EDITION) ────────────────────────
async function generatePremiumHTML(biz) {
  const images = getIndustryImages(biz.category);

  const prompt = `You are an elite Awwwards-winning UI/UX web designer and frontend architect.
Generate a stunning, UNIQUE, high-end single-page landing page.

Business: ${biz.name} | Category: ${biz.category} | Rating: ${biz.rating}

🚨 CRITICAL ANTI-TRUNCATION RULES (YOU MUST OBEY):
1. Output the FULL, complete code from <!DOCTYPE html> to </html>. Never stop halfway.
2. DO NOT use placeholders like "".
3. TO SAVE TOKENS: Keep paragraph texts very concise (1-2 sentences max). 
4. TO SAVE TOKENS: NEVER use raw <svg> paths. Only use <i class="fa-solid fa-icon-name"></i> (FontAwesome is included).

### Design & Layout:
1. Tailor the color palette strictly to "${biz.category}" (e.g. Rose Gold for Salon, Electric Cyan for Auto, Warm Amber for Food). Use Tailwind CSS.
2. Build a Glassmorphism design (blur backdrops, glowing borders).
3. Include 6 Sections: Navbar, Epic Hero Section, Trust Metrics, Services Grid (3 cards), Visual Gallery Grid (3 items), and Contact Form/Footer.

### Image Injection Rule:
Use EXACTLY these CSS classes on empty <div> elements (I will inject them later):
- Hero Background: class="bg-hero-img"
- Feature Image: class="feature-img"
- Gallery Items:
  <div class="gallery-img-1 rounded-2xl h-72 w-full" data-aos="zoom-in"></div>
  <div class="gallery-img-2 rounded-2xl h-72 w-full" data-aos="zoom-in" data-aos-delay="100"></div>
  <div class="gallery-img-3 rounded-2xl h-72 w-full" data-aos="zoom-in" data-aos-delay="200"></div>

Return ONLY raw HTML/CSS/JS code starting with <!DOCTYPE html> and ending with </html>. No markdown, no explanations.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6", 
      max_tokens: 8192,
      temperature: 0.7,
      messages: [{ role: "user", content: prompt }],
    });

    let htmlContent = response.content[0].text.trim();
    if (htmlContent.startsWith("```html")) htmlContent = htmlContent.replace(/```html/, "");
    if (htmlContent.startsWith("```")) htmlContent = htmlContent.replace(/```/, "");
    if (htmlContent.endsWith("```")) htmlContent = htmlContent.slice(0, -3);
    
    // Auto-fix if Claude still forgets the closing tags
    if (!htmlContent.includes("</html>")) {
        htmlContent += "\n</body>\n</html>";
    }
    
    const cssInjection = `
    <style>
      .bg-hero-img {
        background-image: linear-gradient(rgba(4, 4, 10, 0.6), rgba(4, 4, 10, 0.95)), url('${images[0]}');
        background-size: cover; background-position: center;
      }
      .feature-img {
        background-image: url('${images[1]}'); background-size: cover; background-position: center;
      }
      .gallery-img-1 { background-image: url('${images[2]}'); background-size: cover; background-position: center; transition: transform 0.5s; }
      .gallery-img-1:hover { transform: scale(1.05); }
      .gallery-img-2 { background-image: url('${images[3]}'); background-size: cover; background-position: center; transition: transform 0.5s; }
      .gallery-img-2:hover { transform: scale(1.05); }
      .gallery-img-3 { background-image: url('${images[4]}'); background-size: cover; background-position: center; transition: transform 0.5s; }
      .gallery-img-3:hover { transform: scale(1.05); }
    </style>
    </head>`;

    if (htmlContent.includes("</head>")) {
      htmlContent = htmlContent.replace("</head>", cssInjection);
    } else {
      htmlContent += cssInjection.replace("</head>", ""); 
    }
    
    return htmlContent.trim();
  } catch (error) {
    console.error("🔴 Claude Architect Error:", error.message);
    return `<!DOCTYPE html><html><body><h1 style="color:red; text-align:center; margin-top:20%;">Error connecting to AI. Please try again.</h1></body></html>`;
  }
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

app.get("/", (_, res) => res.json({ ok: true, service: "SiteSprint Claude 4.6 Engine" }));

app.get("/api/businesses", async (req, res) => {
  const { status, q } = req.query;
  let sql = "SELECT * FROM businesses WHERE 1=1";
  const params = [];
  if (status && status !== "all") { sql += ` AND status=$${params.length+1}`; params.push(status); }
  if (q) { sql += ` AND (name ILIKE $${params.length+1} OR category ILIKE $${params.length+2} OR address ILIKE $${params.length+3})`; params.push(`%${q}%`,`%${q}%`,`%${q}%`); }
  sql += " ORDER BY created_at DESC";
  const result = await pool.query(sql, params);
  res.json(result.rows);
});

app.post("/api/businesses", async (req, res) => {
  try {
    const b = req.body;
    const r = await pool.query(
      `INSERT INTO businesses (name,address,phone,category,rating,review_count,hours,website,google_url,status,area_searched)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [b.name, b.address||"", b.phone||"", b.category||"", b.rating||0, b.review_count||0,
       b.hours||"", b.website||"", b.google_url||"", b.status||"prospect", b.area_searched||""]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/businesses/:id", async (req, res) => {
  const { id } = req.params;
  const b = req.body;
  const allowed = ["name","address","phone","category","rating","review_count","hours","website","google_url","status","notes","preview_slug"];
  const sets = []; const params = [];
  for (const col of allowed) {
    if (col in b) { sets.push(`${col}=$${params.length+1}`); params.push(b[col]); }
  }
  if (!sets.length) return res.json({ ok: true });
  sets.push(`updated_at=NOW()`);
  params.push(id);
  await pool.query(`UPDATE businesses SET ${sets.join(",")} WHERE id=$${params.length}`, params);
  const r = await pool.query("SELECT * FROM businesses WHERE id=$1", [id]);
  res.json(r.rows[0]);
});

app.delete("/api/businesses/:id", async (req, res) => {
  await pool.query("DELETE FROM businesses WHERE id=$1", [req.params.id]);
  res.json({ deleted: true });
});

// سیستم جستجوی هوشمند: تولید ۲۰ بیزینس داینامیک در اصناف مختلف
app.post("/api/search", async (req, res) => {
  const { area } = req.body;
  if (!area) return res.status(400).json({ error: "area required" });

  const categories = [
    { cat: "Auto Repair", name: "Motors & Glass" },
    { cat: "Restaurant", name: "Grill & Bistro" },
    { cat: "Salon", name: "Beauty Studio" },
    { cat: "Plumbing", name: "Rooter Services" },
    { cat: "Dental", name: "Family Dentistry" },
    { cat: "Gym", name: "Fitness Center" },
    { cat: "Landscaping", name: "Lawn & Garden" },
    { cat: "Roofing", name: "Roofing Experts" },
    { cat: "Cafe", name: "Coffee Roasters" },
    { cat: "Cleaning", name: "Commercial Cleaners" }
  ];

  const results = [];
  for (let i = 1; i <= 20; i++) {
    const type = categories[i % categories.length];
    results.push({
      id: 1000 + i,
      name: `${area} Elite ${type.name}`,
      address: `${100 + (i * 15)} Commerce Blvd, ${area}`,
      phone: `(555) 019-${(i * 123).toString().padStart(4, '0')}`,
      category: type.cat,
      rating: (4 + Math.random()).toFixed(1),
      review_count: Math.floor(Math.random() * 400) + 45,
      hours: "Mon-Sat 8AM - 6PM",
      area_searched: area
    });
  }
  
  res.json(results);
});

const generateHandler = async (req, res) => {
  try {
    const { id } = req.params;
    let biz = await pool.query("SELECT * FROM businesses WHERE id=$1", [id]);
    
    if (!biz.rows.length) {
      const b = req.body;
      const insertResult = await pool.query(
        `INSERT INTO businesses (name, address, phone, category, rating, review_count, hours, status, area_searched)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [b.name || "Business", b.address || "", b.phone || "", b.category || "", b.rating || 5, b.review_count || 50, b.hours || "", "prospect", b.area_searched || ""]
      );
      biz = insertResult;
    }

    const currentBiz = biz.rows[0];
    const html = await generatePremiumHTML(currentBiz);
    const slug = `${currentBiz.id}-${Date.now()}`;

    await pool.query(
      `INSERT INTO generated_sites (business_id, slug, html)
       VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO UPDATE SET html=EXCLUDED.html`,
      [currentBiz.id, slug, html]
    );

    await pool.query("UPDATE businesses SET preview_slug=$1 WHERE id=$2", [slug, currentBiz.id]);
    res.json({ url: `/preview/${slug}`, slug });
  } catch (err) {
    console.error("🔴 Generation Route Error:", err);
    res.status(500).json({ error: err.message });
  }
};

app.post("/api/generate/:id", generateHandler);
app.post("/generate/:id", generateHandler);

app.get("/preview/:slug", async (req, res) => {
  try {
    const r = await pool.query("SELECT html FROM generated_sites WHERE slug=$1", [req.params.slug]);
    if (!r.rows.length) return res.status(404).send("Site not found");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(r.rows[0].html);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

const PORT = process.env.PORT || 3001;
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 SiteSprint Claude 4.6 Engine active on port ${PORT}`));
});