require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const { Pool } = require("pg");

const app  = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

app.use(cors({ origin: "*" }));
app.use(express.json());

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
    console.log("✅ Database Ready.");
  } catch (err) {
    console.error("❌ DB Init Error:", err);
  }
}

// ─── ULTRA-PREMIUM LOCAL HTML GENERATOR (بدون نیاز به هوش مصنوعی و بدون باگ) ───
function generateLocalPremiumHTML(biz) {
  // تشخیص تصویر مناسب بر اساس نوع کسب و کار برای زیبایی بیشتر
  let bgImage = "https://images.unsplash.com/photo-1617788138017-80ad40651399?auto=format&fit=crop&w=1920&q=80"; // خودرو
  if (/salon|hair|beauty|nail/i.test(biz.category)) {
    bgImage = "https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&w=1920&q=80";
  } else if (/food|restaurant|grill/i.test(biz.category)) {
    bgImage = "https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?auto=format&fit=crop&w=1920&q=80";
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${biz.name} | Premium Presentation</title>
    <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&family=Inter:wght@300;400;600&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <link rel="stylesheet" href="https://unpkg.com/aos@next/dist/aos.css" />
    <style>
        :root {
            --bg-dark: #090d16;
            --card-bg: rgba(255, 255, 255, 0.03);
            --border: rgba(255, 255, 255, 0.08);
            --accent: #a8ff78;
            --accent-glow: rgba(168, 255, 120, 0.4);
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            background-color: var(--bg-dark);
            color: #f3f4f6;
            font-family: 'Inter', sans-serif;
            overflow-x: hidden;
        }
        h1, h2, h3 { font-family: 'Space Grotesk', sans-serif; font-weight: 700; color: #fff; }
        
        /* Hero Section */
        .hero {
            position: relative;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            background: linear-gradient(rgba(9,13,22,0.85), rgba(9,13,22,0.95)), url('${bgImage}');
            background-size: cover;
            background-position: center;
            padding: 20px;
            text-align: center;
        }
        .hero::before {
            content: ''; position: absolute; top: 20%; left: 50%; width: 400px; height: 400px;
            background: var(--accent-glow); filter: blur(150px); border-radius: 50%; z-index: 1; transform: translate(-50%, -50%);
        }
        .hero-content { position: relative; z-index: 2; max-width: 850px; }
        .badge {
            background: rgba(255, 255, 255, 0.05); border: 1px solid var(--border);
            padding: 6px 16px; border-radius: 50px; font-size: 12px; font-weight: 600;
            letter-spacing: 0.05em; color: var(--accent); display: inline-block; margin-bottom: 24px;
        }
        .hero h1 { font-size: 3.5rem; line-height: 1.1; margin-bottom: 20px; letter-spacing: -0.02em; }
        .hero p { font-size: 1.15rem; color: #9ca3af; margin-bottom: 35px; font-weight: 300; line-height: 1.6; }
        
        .cta-btn {
            background: var(--accent); color: #000; padding: 14px 32px; border-radius: 10px;
            font-size: 14px; font-weight: 700; text-decoration: none; display: inline-flex;
            align-items: center; gap: 8px; box-shadow: 0 4px 20px var(--accent-glow); transition: 0.3s;
        }
        .cta-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 25px var(--accent); }

        /* Specs Grid */
        .specs-container { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-top: 50px; }
        .spec-box {
            background: var(--card-bg); border: 1px solid var(--border); padding: 20px;
            border-radius: 14px; backdrop-filter: blur(10px); text-align: left;
        }
        .spec-box i { color: var(--accent); font-size: 18px; margin-bottom: 12px; display: block; }
        .spec-box div { font-size: 11px; color: #6b7280; text-transform: uppercase; font-weight: 700; }
        .spec-box p { font-size: 13px; color: #e5e7eb; marginTop: 4px; font-weight: 600; }

        /* Features Section */
        .features { padding: 100px 20px; max-width: 1100px; margin: 0 auto; text-align: center; }
        .features h2 { font-size: 2.2rem; margin-bottom: 45px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 24px; }
        .card {
            background: var(--card-bg); border: 1px solid var(--border); padding: 35px 25px;
            border-radius: 16px; backdrop-filter: blur(10px); text-align: left; transition: 0.3s;
        }
        .card:hover { border-color: rgba(168, 255, 120, 0.3); transform: translateY(-4px); }
        .icon-wrapper {
            width: 45px; height: 45px; background: rgba(168,255,120,0.1); border-radius: 10px;
            display: flex; align-items: center; justify-content: center; margin-bottom: 20px; color: var(--accent);
        }
        .card h3 { font-size: 18px; margin-bottom: 12px; }
        .card p { color: #9ca3af; font-size: 13.5px; line-height: 1.6; font-weight: 300; }

        /* Footer */
        footer { padding: 40px 20px; text-align: center; border-top: 1px solid var(--border); color: #4b5563; font-size: 12px; }
    </style>
</head>
<body>

    <section class="hero">
        <div class="hero-content" data-aos="fade-up">
            <span class="badge"><i class="fa-solid from-neutral-400 fa-star"></i> ${biz.rating || "5.0"} RATED PREMIUM SERVICE</span>
            <h1>Modern Digital Experience For For ${biz.name}</h1>
            <p>Transforming local trust into a high-converting digital storefront. Explore your customized premium solution crafted specifically for the ${biz.category || "local"} market.</p>
            
            <a href="tel:${biz.phone}" class="cta-btn">
                <i class="fa-solid fa-phone"></i> Contact Business: ${biz.phone || "Connect Now"}
            </a>

            <div class="specs-container">
                <div class="spec-box">
                    <i class="fa-solid fa-location-dot"></i>
                    <div>Location & Address</div>
                    <p>${biz.address || "Ballantyne, Charlotte NC"}</p>
                </div>
                <div class="spec-box">
                    <i class="fa-solid fa-tags"></i>
                    <div>Industry Core</div>
                    <p>${biz.category || "Premium Services"}</p>
                </div>
                <div class="spec-box">
                    <i class="fa-solid fa-clock"></i>
                    <div>Operation Hours</div>
                    <p>${biz.hours || "Open / Call for Details"}</p>
                </div>
            </div>
        </div>
    </section>

    <section class="features">
        <h2 data-aos="fade-up">Designed For Ultimate Growth</h2>
        <div class="grid">
            <div class="card" data-aos="fade-up" data-aos-delay="100">
                <div class="icon-wrapper"><i class="fa-solid fa-bolt"></i></div>
                <h3>Ultra-Fast Performance</h3>
                <p>Lightning-fast load speeds engineered on global CDNs to secure high rankings and keep customers engaged instantly.</p>
            </div>
            <div class="card" data-aos="fade-up" data-aos-delay="200">
                <div class="icon-wrapper"><i class="fa-solid fa-mobile-screen"></i></div>
                <h3>100% Mobile Optimized</h3>
                <p>Flawless adaptive layout built specifically to lock in bookings and calls smoothly from any smartphone screen.</p>
            </div>
            <div class="card" data-aos="fade-up" data-aos-delay="300">
                <div class="icon-wrapper"><i class="fa-solid fa-magnifying-glass"></i></div>
                <h3>Local SEO Ready</h3>
                <p>Advanced structured metadata layouts designed to outpace competitors and dominate local maps organically.</p>
            </div>
        </div>
    </section>

    <footer>
        &copy; 2026 ${biz.name}. Crafted with SiteSprint Premium Framework. All Rights Reserved.
    </footer>

    <script src="https://unpkg.com/aos@next/dist/aos.js"></script>
    <script>
        AOS.init({ duration: 800, once: true });
    </script>
</body>
</html>`;
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

app.get("/", (_, res) => res.json({ ok: true, service: "SiteSprint High-Speed Local Engine" }));

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

app.post("/api/search", async (req, res) => {
  const { area } = req.body;
  if (!area) return res.status(400).json({ error: "area required" });

  const localMockData = [
    { id: 1001, name: `${area} Auto Glass Repair`, address: `${area}, Main St`, phone: "555-0192", category: "Auto Repair", rating: 4.7, review_count: 124, hours: "Mon-Sat 8AM-6PM", area_searched: area },
    { id: 1002, name: "The Local Grill & Bistro", address: `${area}, Pizza Boulevard`, phone: "555-0234", category: "Restaurant", rating: 4.5, review_count: 88, hours: "Everyday 11AM-10PM", area_searched: area },
    { id: 1003, name: "Elegance Hair & Nail Salon", address: `${area}, Beauty Lane`, phone: "555-0781", category: "Salon", rating: 4.9, review_count: 210, hours: "Tue-Sun 9AM-7PM", area_searched: area },
    { id: 1004, name: "Apex Commercial Cleaning", address: `${area}, Business District`, phone: "555-0432", category: "Cleaning Service", rating: 4.2, review_count: 35, hours: "Mon-Fri 7AM-8PM", area_searched: area },
    { id: 1005, name: "Green Thumb Landscaping", address: `${area}, Garden Way`, phone: "555-0901", category: "Landscaping", rating: 4.6, review_count: 54, hours: "Mon-Fri 7AM-5PM", area_searched: area }
  ];
  res.json(localMockData);
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
    // رندر سریع قالب لوکال بدون تاخیر و ارورهای خارجی هوش مصنوعی
    const html = generateLocalPremiumHTML(currentBiz);
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

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 Independent High-Speed Engine running on port ${PORT}`));
});