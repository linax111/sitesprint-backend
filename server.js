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

// ─── IMAGE BANK (انبار عکس‌های لوکس برای تزریق) ───────────────────────────────
function getIndustryImages(category) {
  const cat = (category || "business").toLowerCase();
  
  let imgs = {
    hero: "https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&w=1600&q=80",
    g1: "https://images.unsplash.com/photo-1460925895917-afdab827c52f?auto=format&fit=crop&w=800&q=80",
    g2: "https://images.unsplash.com/photo-1542744094-3a31f103e35f?auto=format&fit=crop&w=800&q=80",
    g3: "https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?auto=format&fit=crop&w=800&q=80"
  };

  if (cat.includes("salon") || cat.includes("beauty") || cat.includes("hair")) {
    imgs = {
      hero: "https://images.unsplash.com/photo-1562322140-8baeececf3df?auto=format&fit=crop&w=1600&q=80",
      g1: "https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=800&q=80",
      g2: "https://images.unsplash.com/photo-1605497746444-ac9da58480a8?auto=format&fit=crop&w=800&q=80",
      g3: "https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&w=800&q=80"
    };
  } else if (cat.includes("repair") || cat.includes("auto") || cat.includes("glass")) {
    imgs = {
      hero: "https://images.unsplash.com/photo-1619642751034-765dfdf7c58e?auto=format&fit=crop&w=1600&q=80",
      g1: "https://images.unsplash.com/photo-1486006920555-c77dce18193b?auto=format&fit=crop&w=800&q=80",
      g2: "https://images.unsplash.com/photo-1563720223185-11003d516935?auto=format&fit=crop&w=800&q=80",
      g3: "https://images.unsplash.com/photo-1517524206127-48bbd363f3d7?auto=format&fit=crop&w=800&q=80"
    };
  } else if (cat.includes("rest") || cat.includes("food") || cat.includes("grill")) {
    imgs = {
      hero: "https://images.unsplash.com/photo-1514933651103-005eec06c04b?auto=format&fit=crop&w=1600&q=80",
      g1: "https://images.unsplash.com/photo-1555396273-367ea4eb4db5?auto=format&fit=crop&w=800&q=80",
      g2: "https://images.unsplash.com/photo-1504674900247-0877df9cc836?auto=format&fit=crop&w=800&q=80",
      g3: "https://images.unsplash.com/photo-1606787366850-de6330128bfc?auto=format&fit=crop&w=800&q=80"
    };
  }
  return imgs;
}

// ─── FULL LOCAL BACKUP TEMPLATE (قالب فوق‌کامل و فول‌آپشن محلی) ───────────────
function generateLocalMasterpiece(biz) {
  const images = getIndustryImages(biz.category);
  const cat = (biz.category || "business").toLowerCase();
  
  let gradient = "from-indigo-500 to-blue-500";
  let btnColor = "bg-indigo-600 hover:bg-indigo-700";
  
  if (cat.includes("salon") || cat.includes("beauty")) {
    gradient = "from-pink-500 to-rose-500"; btnColor = "bg-rose-600 hover:bg-rose-700";
  } else if (cat.includes("repair") || cat.includes("auto")) {
    gradient = "from-cyan-500 to-blue-600"; btnColor = "bg-blue-600 hover:bg-blue-700";
  } else if (cat.includes("rest") || cat.includes("food")) {
    gradient = "from-orange-500 to-red-600"; btnColor = "bg-orange-600 hover:bg-orange-700";
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
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600;700&family=Inter:wght@400;500;600&display=swap');
        body { font-family: 'Inter', sans-serif; background-color: #050508; color: #f8fafc; }
        .heading-font { font-family: 'Space Grotesk', sans-serif; }
        .glass-nav { background: rgba(5,5,8,0.8); backdrop-filter: blur(12px); border-bottom: 1px solid rgba(255,255,255,0.05); }
        .glass-card { background: rgba(255,255,255,0.02); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.05); }
    </style>
</head>
<body class="antialiased">
    <nav class="fixed top-0 w-full z-50 glass-nav px-6 py-4 flex justify-between items-center">
        <div class="heading-font text-xl font-bold text-white tracking-tight">${biz.name}</div>
        <a href="#contact" class="${btnColor} text-white px-5 py-2 rounded-full font-medium transition-colors text-sm">Book Now</a>
    </nav>

    <section class="relative min-h-screen flex items-center justify-center pt-20 px-6">
        <div class="absolute inset-0 z-0">
            <div class="absolute inset-0 bg-gradient-to-b from-transparent via-[#050508]/80 to-[#050508]"></div>
            <img src="${images.hero}" class="w-full h-full object-cover opacity-50" alt="Hero">
        </div>
        <div class="relative z-10 text-center max-w-4xl mx-auto" data-aos="fade-up">
            <span class="inline-block py-1 px-3 rounded-full bg-white/10 border border-white/20 text-sm mb-6 text-gray-300">
                ★ ${biz.rating || '4.9'} Rating | ${biz.review_count || '100'}+ Reviews
            </span>
            <h1 class="heading-font text-5xl md:text-7xl font-extrabold text-white leading-tight">
                Experience Excellence at <br><span class="text-transparent bg-clip-text bg-gradient-to-r ${gradient}">${biz.name}</span>
            </h1>
            <p class="mt-6 text-lg text-gray-400 max-w-2xl mx-auto">We provide premium, industry-leading services tailored to your exact needs. Quality you can trust.</p>
            <div class="mt-8 flex gap-4 justify-center">
                <a href="#services" class="${btnColor} text-white px-8 py-4 rounded-full font-bold shadow-lg transition-transform hover:scale-105">Explore Services</a>
            </div>
        </div>
    </section>

    <section id="services" class="py-24 px-6 max-w-7xl mx-auto relative z-10">
        <div class="text-center mb-16" data-aos="fade-up">
            <h2 class="heading-font text-4xl font-bold">Our Premium Services</h2>
            <p class="text-gray-400 mt-4">Designed to deliver the best results.</p>
        </div>
        <div class="grid md:grid-cols-3 gap-6">
            <div class="glass-card p-8 rounded-2xl transition hover:-translate-y-2" data-aos="fade-up" data-aos-delay="100">
                <i class="fa-solid fa-gem text-3xl text-white mb-4"></i>
                <h3 class="text-xl font-bold mb-2 heading-font">Executive Service</h3>
                <p class="text-gray-400 text-sm">Top-tier customized solutions specifically handled by our master team.</p>
            </div>
            <div class="glass-card p-8 rounded-2xl transition hover:-translate-y-2" data-aos="fade-up" data-aos-delay="200">
                <i class="fa-solid fa-bolt text-3xl text-white mb-4"></i>
                <h3 class="text-xl font-bold mb-2 heading-font">Express Care</h3>
                <p class="text-gray-400 text-sm">Fast, reliable, and precise execution for clients requiring immediate results.</p>
            </div>
            <div class="glass-card p-8 rounded-2xl transition hover:-translate-y-2" data-aos="fade-up" data-aos-delay="300">
                <i class="fa-solid fa-shield-check text-3xl text-white mb-4"></i>
                <h3 class="text-xl font-bold mb-2 heading-font">Quality Guarantee</h3>
                <p class="text-gray-400 text-sm">Every service comes with our iron-clad satisfaction protection.</p>
            </div>
        </div>
    </section>

    <section class="py-20 px-6 max-w-7xl mx-auto relative z-10">
        <h2 class="heading-font text-3xl font-bold mb-10 text-center" data-aos="fade-up">Visual Showcase</h2>
        <div class="grid md:grid-cols-3 gap-6">
            <img src="${images.g1}" class="rounded-2xl h-72 w-full object-cover shadow-lg hover:scale-105 transition-transform duration-500" data-aos="zoom-in">
            <img src="${images.g2}" class="rounded-2xl h-72 w-full object-cover shadow-lg hover:scale-105 transition-transform duration-500" data-aos="zoom-in" data-aos-delay="100">
            <img src="${images.g3}" class="rounded-2xl h-72 w-full object-cover shadow-lg hover:scale-105 transition-transform duration-500" data-aos="zoom-in" data-aos-delay="200">
        </div>
    </section>

    <section id="contact" class="py-24 px-6 max-w-7xl mx-auto grid md:grid-cols-2 gap-12 relative z-10">
        <div data-aos="fade-right">
            <h2 class="heading-font text-4xl font-bold mb-6">Let's Get Started</h2>
            <div class="space-y-6 text-gray-300">
                <div class="flex items-center gap-4 glass-card p-4 rounded-xl"><i class="fa-solid fa-location-dot text-xl text-gray-100"></i> <span>${biz.address || 'Location available upon booking'}</span></div>
                <div class="flex items-center gap-4 glass-card p-4 rounded-xl"><i class="fa-solid fa-phone text-xl text-gray-100"></i> <span>${biz.phone || 'Contact us online'}</span></div>
                <div class="flex items-center gap-4 glass-card p-4 rounded-xl"><i class="fa-solid fa-clock text-xl text-gray-100"></i> <span>${biz.hours || 'Open Daily'}</span></div>
            </div>
        </div>
        <div class="glass-card p-8 rounded-2xl" data-aos="fade-left">
            <h3 class="heading-font text-2xl font-bold mb-6">Send a Message</h3>
            <form class="space-y-4" onsubmit="event.preventDefault(); alert('Request sent!');">
                <input type="text" placeholder="Name" required class="w-full bg-white/5 border border-white/10 rounded-lg p-3 text-white focus:outline-none focus:border-white/30">
                <input type="email" placeholder="Email" required class="w-full bg-white/5 border border-white/10 rounded-lg p-3 text-white focus:outline-none focus:border-white/30">
                <textarea placeholder="How can we help?" rows="4" required class="w-full bg-white/5 border border-white/10 rounded-lg p-3 text-white focus:outline-none focus:border-white/30"></textarea>
                <button type="submit" class="w-full ${btnColor} text-white font-bold p-3 rounded-lg transition-colors">Submit Request</button>
            </form>
        </div>
    </section>

    <footer class="border-t border-white/10 py-8 text-center text-gray-500 text-sm">
        <p>&copy; 2026 ${biz.name}. All rights reserved.</p>
    </footer>

    <script src="https://unpkg.com/aos@2.3.1/dist/aos.js"></script>
    <script>
        AOS.init({ once: true, duration: 800 });
    </script>
</body>
</html>`;
}

// ─── CLAUDE GENERATOR (قفل شده روی پایدارترین نسخه) ───────────────────────────
async function generatePremiumHTML(biz) {
  const images = getIndustryImages(biz.category);

  const prompt = `You are a world-class, elite UI/UX web designer.
Generate an incredibly stunning, high-end single-page landing page for this business:
Name: ${biz.name}
Category: ${biz.category}
Address: ${biz.address}
Phone: ${biz.phone}
Rating: ${biz.rating} (${biz.review_count} reviews)

STRICT DESIGN DIRECTION:
1. Use Tailwind CSS via CDN.
2. Immersive Color Palette: Dark mode glassmorphism with neon glowing accents tailored to the industry. Use beautiful gradients and blur backdrops.
3. Typography: Include FontAwesome icons. Use elegant Google Fonts (Space Grotesk or Syne for headings, Inter for body text).
4. Fluid Animations: Include AOS library (Animate on Scroll). Apply 'data-aos="fade-up"' to layout containers.
5. Elite Layout Structure: Sticky glassmorphic Navbar, jaw-dropping Hero section, floating Stats counter, Premium Services grid, Visual Gallery grid (3 items), and a high-converting Contact Form.

🚨 CRITICAL IMAGE RULE (CSS INJECTION TRICK):
Do NOT write any <img src="..."> tags for the hero or gallery to prevent broken 404 links. 
You MUST use exactly these predefined CSS classes on empty <div> elements to show images:
- For the Hero Section background container, add the class: 'bg-hero-img'
- For the 3 Visual Gallery grid items, use exactly this structure:
  <div class="gallery-img-1 rounded-2xl shadow-xl h-72 w-full" data-aos="zoom-in"></div>
  <div class="gallery-img-2 rounded-2xl shadow-xl h-72 w-full" data-aos="zoom-in" data-aos-delay="100"></div>
  <div class="gallery-img-3 rounded-2xl shadow-xl h-72 w-full" data-aos="zoom-in" data-aos-delay="200"></div>

Return ONLY the raw HTML/CSS/JS code starting with <!DOCTYPE html>. No markdown blocks.`;

  try {
    // 🚀 قفل شده روی پایدارترین، قوی‌ترین و مطمئن‌ترین نسخه کلاود ۳.۵
    const response = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20240620",
      max_tokens: 8000,
      messages: [{ role: "user", content: prompt }],
    });

    let htmlContent = response.content[0].text.trim();
    if (htmlContent.startsWith("```html")) htmlContent = htmlContent.replace(/```html/, "");
    if (htmlContent.endsWith("```")) htmlContent = htmlContent.slice(0, -3);
    
    // هاله تاریک هیرو شفاف‌تر شده تا سایت خفه نباشد
    const cssInjection = `
    <style>
      .bg-hero-img {
        background-image: linear-gradient(rgba(3, 3, 7, 0.4), rgba(3, 3, 7, 0.85)), url('${images.hero}');
        background-size: cover; background-position: center;
      }
      .gallery-img-1 { background-image: url('${images.g1}'); background-size: cover; background-position: center; transition: transform 0.5s; }
      .gallery-img-1:hover { transform: scale(1.05); }
      .gallery-img-2 { background-image: url('${images.g2}'); background-size: cover; background-position: center; transition: transform 0.5s; }
      .gallery-img-2:hover { transform: scale(1.05); }
      .gallery-img-3 { background-image: url('${images.g3}'); background-size: cover; background-position: center; transition: transform 0.5s; }
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
    console.error("🔴 Claude Sonnet Error:", error.message);
    // در صورت قطعی اینترنت، قالب فوقِ کامل محلی بالا می‌آید نه قالب نصفه‌نیمه
    return generateLocalMasterpiece(biz);
  }
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

app.get("/", (_, res) => res.json({ ok: true, service: "SiteSprint Ultimate Claude Engine" }));

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
    { id: 1002, name: "The Local Grill & Bistro", address: `${area}, Pizza Boulevard`, phone: "555-0234", category: "Restaurant", rating: 4.5, review_count: 88, hours: "Everyday 11AM-10PM", area_searched: area }
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