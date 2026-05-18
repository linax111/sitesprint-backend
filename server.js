require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const { Pool } = require("pg");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app  = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

app.use(cors({ origin: "*" }));
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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

// ─── IMAGE BANK (انبار عکس‌های لوکس و واقعی برای تزریق) ───────────────────────
function getIndustryImages(category) {
  const cat = (category || "business").toLowerCase();
  
  // دیفالت (شرکتی / عمومی)
  let imgs = {
    hero: "https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&w=1600&q=80",
    g1: "https://images.unsplash.com/photo-1460925895917-afdab827c52f?auto=format&fit=crop&w=800&q=80",
    g2: "https://images.unsplash.com/photo-1542744094-3a31f103e35f?auto=format&fit=crop&w=800&q=80",
    g3: "https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?auto=format&fit=crop&w=800&q=80"
  };

  if (cat.includes("salon") || cat.includes("beauty") || cat.includes("hair") || cat.includes("nail")) {
    imgs = {
      hero: "https://images.unsplash.com/photo-1562322140-8baeececf3df?auto=format&fit=crop&w=1600&q=80",
      g1: "https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=800&q=80",
      g2: "https://images.unsplash.com/photo-1605497746444-ac9da58480a8?auto=format&fit=crop&w=800&q=80",
      g3: "https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&w=800&q=80"
    };
  } else if (cat.includes("repair") || cat.includes("auto") || cat.includes("glass") || cat.includes("mechanic")) {
    imgs = {
      hero: "https://images.unsplash.com/photo-1619642751034-765dfdf7c58e?auto=format&fit=crop&w=1600&q=80",
      g1: "https://images.unsplash.com/photo-1486006920555-c77dce18193b?auto=format&fit=crop&w=800&q=80",
      g2: "https://images.unsplash.com/photo-1563720223185-11003d516935?auto=format&fit=crop&w=800&q=80",
      g3: "https://images.unsplash.com/photo-1517524206127-48bbd363f3d7?auto=format&fit=crop&w=800&q=80"
    };
  } else if (cat.includes("rest") || cat.includes("food") || cat.includes("grill") || cat.includes("cafe")) {
    imgs = {
      hero: "https://images.unsplash.com/photo-1514933651103-005eec06c04b?auto=format&fit=crop&w=1600&q=80",
      g1: "https://images.unsplash.com/photo-1555396273-367ea4eb4db5?auto=format&fit=crop&w=800&q=80",
      g2: "https://images.unsplash.com/photo-1504674900247-0877df9cc836?auto=format&fit=crop&w=800&q=80",
      g3: "https://images.unsplash.com/photo-1606787366850-de6330128bfc?auto=format&fit=crop&w=800&q=80"
    };
  } else if (cat.includes("clean") || cat.includes("wash") || cat.includes("maid")) {
    imgs = {
      hero: "https://images.unsplash.com/photo-1581578731548-c64695cc6952?auto=format&fit=crop&w=1600&q=80",
      g1: "https://images.unsplash.com/photo-1584622650111-993a426fbf0a?auto=format&fit=crop&w=800&q=80",
      g2: "https://images.unsplash.com/photo-1527515637-6742562d5395?auto=format&fit=crop&w=800&q=80",
      g3: "https://images.unsplash.com/photo-1628177142898-93e46e46284f?auto=format&fit=crop&w=800&q=80"
    };
  }
  return imgs;
}

// ─── ELITE LOCAL VISUAL ENGINE (سیستم بک‌آپ محلی) ─────────────────────────────
function generateLocalMasterpiece(biz) {
  const images = getIndustryImages(biz.category);
  const cat = (biz.category || "business").toLowerCase();
  
  let accent = "#6366f1"; 
  let gradient = "from-indigo-500 via-purple-500 to-pink-500";

  if (cat.includes("salon") || cat.includes("beauty")) {
    accent = "#ec4899"; gradient = "from-pink-500 via-rose-500 to-amber-500";
  } else if (cat.includes("repair") || cat.includes("auto")) {
    accent = "#0ea5e9"; gradient = "from-sky-500 via-blue-600 to-cyan-500";
  } else if (cat.includes("rest") || cat.includes("food")) {
    accent = "#f97316"; gradient = "from-amber-500 via-orange-500 to-red-600";
  }

  return `<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${biz.name} | Premium Presentation</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <link href="https://unpkg.com/aos@2.3.1/dist/aos.css" rel="stylesheet">
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Plus+Jakarta+Sans:wght@400;600;700&display=swap');
        body { font-family: 'Plus Jakarta Sans', sans-serif; background-color: #030307; color: #f8fafc; }
        .heading-font { font-family: 'Space Grotesk', sans-serif; }
        .glass-card { background: rgba(255, 255, 255, 0.03); backdrop-filter: blur(16px); border: 1px solid rgba(255,255,255,0.06); }
    </style>
</head>
<body class="antialiased">
    <section class="relative min-h-screen flex items-center justify-center pt-24 px-6">
        <div class="absolute inset-0 z-0">
            <div class="absolute inset-0 bg-gradient-to-b from-transparent via-[#030307]/80 to-[#030307]"></div>
            <img src="${images.hero}" class="w-full h-full object-cover opacity-60" alt="Hero Backdrop">
        </div>
        <div class="relative z-10 text-center max-w-4xl mx-auto">
            <h1 class="heading-font text-5xl md:text-7xl font-extrabold text-white mt-6 tracking-tight">
                Premium Solutions by <br><span class="text-transparent bg-clip-text bg-gradient-to-r ${gradient}">${biz.name}</span>
            </h1>
        </div>
    </section>
    
    <section class="py-24 px-6 max-w-7xl mx-auto grid md:grid-cols-3 gap-6 relative z-10">
        <img src="${images.g1}" class="rounded-2xl h-64 w-full object-cover shadow-2xl border border-white/10" alt="Gallery 1">
        <img src="${images.g2}" class="rounded-2xl h-64 w-full object-cover shadow-2xl border border-white/10" alt="Gallery 2">
        <img src="${images.g3}" class="rounded-2xl h-64 w-full object-cover shadow-2xl border border-white/10" alt="Gallery 3">
    </section>
</body>
</html>`;
}

// ─── AI PREMIUM HTML GENERATOR (مجهز به سیستم تزریق مستقیم عکس) ──────────────
async function generatePremiumHTML(biz) {
  const images = getIndustryImages(biz.category);

  const prompt = `You are a world-class award-winning UI/UX web designer.
Generate an incredibly stunning, ultra-modern single-page landing page for:
Name: ${biz.name}
Category: ${biz.category}
Address: ${biz.address}
Phone: ${biz.phone}
Rating: ${biz.rating} (${biz.review_count} reviews)

STRICT DESIGN DIRECTION:
1. Dark mode glassmorphism with neon glowing accents based on industry.
2. Fluid Animations: Use AOS library (data-aos="fade-up").
3. Elite Layout: Sticky Navbar, Hero section, Services grid, Visual Gallery, Testimonials, Contact Form. Include FontAwesome icons.

🚨 CRITICAL IMAGE RULE (DO NOT WRITE IMAGE URLS!):
To prevent broken links, I have already pre-loaded the high-res images into CSS classes. YOU MUST NOT write any <img src="..."> tags.
You MUST use these exact predefined CSS classes on <div> elements to show images:
- For the Hero Section background container, you MUST add the class: 'bg-hero-img'
- For the 3 Visual Gallery grid items, use exactly this structure:
  <div class="gallery-img-1 rounded-2xl shadow-xl h-64 w-full"></div>
  <div class="gallery-img-2 rounded-2xl shadow-xl h-64 w-full"></div>
  <div class="gallery-img-3 rounded-2xl shadow-xl h-64 w-full"></div>

Return ONLY the raw HTML/CSS/JS starting with <!DOCTYPE html>. No markdown blocks.`;

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await model.generateContent(prompt);
    let htmlContent = result.response.text().trim();

    if (!htmlContent) throw new Error("Empty response layer");

    if (htmlContent.startsWith("```html")) htmlContent = htmlContent.replace(/```html/, "");
    if (htmlContent.endsWith("```")) htmlContent = htmlContent.slice(0, -3);
    
    // 💥 تزریق مستقیم تصاویر به استایل‌های هوش مصنوعی
    const cssInjection = `
    <style>
      .bg-hero-img {
        background-image: linear-gradient(rgba(3, 3, 7, 0.7), rgba(3, 3, 7, 0.95)), url('${images.hero}');
        background-size: cover; 
        background-position: center;
      }
      .gallery-img-1 { background-image: url('${images.g1}'); background-size: cover; background-position: center; }
      .gallery-img-2 { background-image: url('${images.g2}'); background-size: cover; background-position: center; }
      .gallery-img-3 { background-image: url('${images.g3}'); background-size: cover; background-position: center; }
    </style>
    </head>`;

    if (htmlContent.includes("</head>")) {
      htmlContent = htmlContent.replace("</head>", cssInjection);
    } else {
      // در صورتی که جمینای تگ head را به شکل دیگری بست
      htmlContent += cssInjection.replace("</head>", ""); 
    }
    
    return htmlContent.trim();
  } catch (error) {
    console.error("⚠️ AI Engine Error:", error.message);
    return generateLocalMasterpiece(biz);
  }
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

app.get("/", (_, res) => res.json({ ok: true, service: "SiteSprint High-End Visual Engine" }));

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
  app.listen(PORT, () => console.log(`🚀 SiteSprint Production Engine active on port ${PORT}`));
});