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

// ─── ELITE LOCAL VISUAL ENGINE (تزریق مستقیم شاهکارهای تصویری و مدرن فرانت‌اند) ───
function generateLocalMasterpiece(biz) {
  const cat = (biz.category || "business").toLowerCase();
  
  // دیتابیس تصاویر لوکس و عریض متناسب با صنف
  let imgs = {
    hero: "https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?auto=format&fit=crop&w=1600&q=80",
    thumb1: "https://images.unsplash.com/photo-1460925895917-afdab827c52f?auto=format&fit=crop&w=800&q=80",
    thumb2: "https://images.unsplash.com/photo-1542744094-3a31f103e35f?auto=format&fit=crop&w=800&q=80",
    thumb3: "https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?auto=format&fit=crop&w=800&q=80"
  };
  let accent = "#6366f1"; 
  let gradient = "from-indigo-500 via-purple-500 to-pink-500";
  let sub = "Next-Gen Professional Digital Solutions";

  if (cat.includes("salon") || cat.includes("beauty") || cat.includes("hair") || cat.includes("nail")) {
    imgs = {
      hero: "https://images.unsplash.com/photo-1562322140-8baeececf3df?auto=format&fit=crop&w=1600&q=80",
      thumb1: "https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=800&q=80",
      thumb2: "https://images.unsplash.com/photo-1605497746444-ac9da58480a8?auto=format&fit=crop&w=800&q=80",
      thumb3: "https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&w=800&q=80"
    };
    accent = "#ec4899";
    gradient = "from-pink-500 via-rose-500 to-amber-500";
    sub = "Luxury Hair, Nails & Executive Beauty Experience";
  } else if (cat.includes("repair") || cat.includes("auto") || cat.includes("glass") || cat.includes("mechanic")) {
    imgs = {
      hero: "https://images.unsplash.com/photo-1619642751034-765dfdf7c58e?auto=format&fit=crop&w=1600&q=80",
      thumb1: "https://images.unsplash.com/photo-1486006920555-c77dce18193b?auto=format&fit=crop&w=800&q=80",
      thumb2: "https://images.unsplash.com/photo-1563720223185-11003d516935?auto=format&fit=crop&w=800&q=80",
      thumb3: "https://images.unsplash.com/photo-1517524206127-48bbd363f3d7?auto=format&fit=crop&w=800&q=80"
    };
    accent = "#0ea5e9";
    gradient = "from-sky-500 via-blue-600 to-cyan-500";
    sub = "Elite Certified Automotive & Master Glass Restoration";
  } else if (cat.includes("rest") || cat.includes("food") || cat.includes("grill") || cat.includes("cafe") || cat.includes("bistro")) {
    imgs = {
      hero: "https://images.unsplash.com/photo-1514933651103-005eec06c04b?auto=format&fit=crop&w=1600&q=80",
      thumb1: "https://images.unsplash.com/photo-1555396273-367ea4eb4db5?auto=format&fit=crop&w=800&q=80",
      thumb2: "https://images.unsplash.com/photo-1504674900247-0877df9cc836?auto=format&fit=crop&w=800&q=80",
      thumb3: "https://images.unsplash.com/photo-1606787366850-de6330128bfc?auto=format&fit=crop&w=800&q=80"
    };
    accent = "#f97316";
    gradient = "from-amber-500 via-orange-500 to-red-600";
    sub = "Premium Culinary Arts & Immersive Dining Presentation";
  }

  return `<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${biz.name} | Exclusive Showcase</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <link href="https://unpkg.com/aos@2.3.1/dist/aos.css" rel="stylesheet">
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Plus+Jakarta+Sans:wght@400;600;700&display=swap');
        body { font-family: 'Plus Jakarta Sans', sans-serif; background-color: #030307; color: #f8fafc; }
        .heading-font { font-family: 'Space Grotesk', sans-serif; }
        .glass-nav { background: rgba(3, 3, 7, 0.7); backdrop-filter: blur(20px); border-bottom: 1px solid rgba(255,255,255,0.06); }
        .glass-card { background: rgba(255, 255, 255, 0.03); backdrop-filter: blur(16px); border: 1px solid rgba(255,255,255,0.06); }
        .glow-effect:hover { box-shadow: 0 0 40px ${accent}33; border-color: ${accent}88; }
    </style>
</head>
<body class="antialiased selection:bg-indigo-500 selection:text-white">

    <nav class="fixed top-0 left-0 right-0 z-50 glass-nav px-6 md:px-12 py-4 flex justify-between items-center">
        <span class="heading-font text-xl font-bold tracking-tight text-white flex items-center gap-2">
            <span class="w-3 h-3 rounded-full bg-gradient-to-r ${gradient}"></span> ${biz.name}
        </span>
        <div class="hidden md:flex items-center gap-8 text-sm font-semibold text-gray-400">
            <a href="#features" class="hover:text-white transition-colors">Features</a>
            <a href="#gallery" class="hover:text-white transition-colors">Gallery</a>
            <a href="#about" class="hover:text-white transition-colors">Location</a>
        </div>
        <a href="#contact" class="bg-gradient-to-r ${gradient} text-white px-6 py-2.5 rounded-full font-bold text-sm shadow-xl hover:opacity-90 transition-all transform hover:scale-105">Secure Booking</a>
    </nav>

    <section class="relative min-h-screen flex items-center justify-center pt-24 overflow-hidden px-6">
        <div class="absolute inset-0 z-0">
            <div class="absolute inset-0 bg-gradient-to-b from-transparent via-[#030307]/80 to-[#030307]"></div>
            <img src="${imgs.hero}" class="w-full h-full object-cover scale-105 animate-[pulse_8s_infinite]" alt="Hero Backdrop">
        </div>
        
        <div class="relative z-10 text-center max-w-4xl mx-auto" data-aos="zoom-out" data-aos-duration="1000">
            <span class="text-xs font-bold tracking-widest uppercase px-4 py-2 rounded-full glass-card text-gray-300 border border-white/10 inline-flex items-center gap-2">
                <i class="fa-solid fa-star text-amber-400 animate-spin"></i> Five Star Rated Premium Experience
            </span>
            <h1 class="heading-font text-5xl md:text-7xl font-extrabold text-white mt-6 leading-none tracking-tight">
                Luxury Solutions For <br><span class="text-transparent bg-clip-text bg-gradient-to-r ${gradient}">${biz.name}</span>
            </h1>
            <p class="text-gray-400 mt-6 text-lg md:text-xl max-w-2xl mx-auto font-medium">${sub}</p>
            
            <div class="mt-10 flex flex-wrap justify-center gap-5">
                <a href="#contact" class="bg-gradient-to-r ${gradient} text-white px-8 py-4 rounded-full font-bold shadow-2xl hover:brightness-110 transition-all">Schedule Appointment</a>
                <a href="#features" class="glass-card text-white px-8 py-4 rounded-full font-bold hover:bg-white/10 transition-colors border border-white/10">Explore Services</a>
            </div>

            <div class="grid grid-cols-3 gap-4 md:gap-8 mt-20 max-w-2xl mx-auto">
                <div class="glass-card p-4 md:p-6 rounded-2xl">
                    <div class="heading-font text-2xl md:text-3xl font-bold text-white">★ ${biz.rating || '4.9'}</div>
                    <div class="text-xs text-gray-500 mt-1 uppercase font-bold tracking-wider">Google Score</div>
                </div>
                <div class="glass-card p-4 md:p-6 rounded-2xl">
                    <div class="heading-font text-2xl md:text-3xl font-bold text-white">${biz.review_count || '150'}+</div>
                    <div class="text-xs text-gray-500 mt-1 uppercase font-bold tracking-wider">Top Reviews</div>
                </div>
                <div class="glass-card p-4 md:p-6 rounded-2xl">
                    <div class="heading-font text-2xl md:text-3xl font-bold text-white">100%</div>
                    <div class="text-xs text-gray-500 mt-1 uppercase font-bold tracking-wider">Guaranteed</div>
                </div>
            </div>
        </div>
    </section>

    <section id="features" class="py-32 px-6 max-w-7xl mx-auto relative">
        <div class="text-center max-w-2xl mx-auto mb-24" data-aos="fade-up">
            <h2 class="heading-font text-4xl md:text-5xl font-bold text-white">World-Class Services</h2>
            <p class="text-gray-400 mt-4 font-medium">Engineered for perfection, executed with ultimate care and premium equipment.</p>
        </div>
        
        <div class="grid md:grid-cols-3 gap-8 relative z-10">
            <div class="glass-card p-8 rounded-3xl transition-all duration-300 glow-effect group" data-aos="fade-up" data-aos-delay="100">
                <div class="w-14 h-14 rounded-2xl bg-white/5 flex items-center justify-center text-xl text-white mb-8 border border-white/10 group-hover:bg-white/10"><i class="fa-solid fa-crown text-amber-400"></i></div>
                <h3 class="heading-font text-xl font-bold text-white">Executive Package</h3>
                <p class="text-gray-400 mt-3 text-sm leading-relaxed font-medium">Our top-tier premium option built completely around your personal or commercial specifications with absolute mastery.</p>
            </div>
            <div class="glass-card p-8 rounded-3xl transition-all duration-300 glow-effect group" data-aos="fade-up" data-aos-delay="200">
                <div class="w-14 h-14 rounded-2xl bg-white/5 flex items-center justify-center text-xl text-white mb-8 border border-white/10 group-hover:bg-white/10"><i class="fa-solid fa-bolt text-cyan-400"></i></div>
                <h3 class="heading-font text-xl font-bold text-white">Instant Deployment</h3>
                <p class="text-gray-400 mt-3 text-sm leading-relaxed font-medium">Rapid diagnostic, prompt fulfillment, and comprehensive insurance when speed and quality are equally vital.</p>
            </div>
            <div class="glass-card p-8 rounded-3xl transition-all duration-300 glow-effect group" data-aos="fade-up" data-aos-delay="300">
                <div class="w-14 h-14 rounded-2xl bg-white/5 flex items-center justify-center text-xl text-white mb-8 border border-white/10 group-hover:bg-white/10"><i class="fa-solid fa-shield-halved text-emerald-400"></i></div>
                <h3 class="heading-font text-xl font-bold text-white">Lifetime Protection</h3>
                <p class="text-gray-400 mt-3 text-sm leading-relaxed font-medium">All specialized work is fully backed and verified by our modern elite agency satisfaction framework guarantee.</p>
            </div>
        </div>
    </section>

    <section id="gallery" class="py-24 bg-white/[0.01] border-y border-white/5 px-6">
        <div class="max-w-7xl mx-auto">
            <div class="flex flex-col md:flex-row justify-between items-start md:items-end mb-16" data-aos="fade-right">
                <div>
                    <h2 class="heading-font text-4xl font-bold text-white">Visual Immersive Gallery</h2>
                    <p class="text-gray-500 mt-2 font-medium">A glance into our custom tools, environment, and master craft standards.</p>
                </div>
            </div>
            
            <div class="grid md:grid-cols-3 gap-6" data-aos="fade-up" data-aos-duration="1000">
                <div class="relative h-80 rounded-2xl overflow-hidden group border border-white/5 shadow-2xl">
                    <img src="${imgs.thumb1}" class="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500" alt="Showcase 1">
                    <div class="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-6"><span class="font-bold text-white">Masterwork Detail</span></div>
                </div>
                <div class="relative h-80 rounded-2xl overflow-hidden group border border-white/5 shadow-2xl">
                    <img src="${imgs.thumb2}" class="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500" alt="Showcase 2">
                    <div class="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-6"><span class="font-bold text-white">Elite Standard Environment</span></div>
                </div>
                <div class="relative h-80 rounded-2xl overflow-hidden group border border-white/5 shadow-2xl">
                    <img src="${imgs.thumb3}" class="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500" alt="Showcase 3">
                    <div class="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-6"><span class="font-bold text-white">Premium Quality Fulfillment</span></div>
                </div>
            </div>
        </div>
    </section>

    <section id="about" class="py-32 px-6 max-w-7xl mx-auto grid md:grid-cols-2 gap-16 items-start">
        <div data-aos="fade-right">
            <h2 class="heading-font text-4xl font-bold text-white">Operational Hub</h2>
            <p class="text-gray-400 mt-4 leading-relaxed font-medium">Stop by our flagship office floor or dial in instantly. Our executive staff is fully available for scheduling consultation briefs.</p>
            
            <div class="mt-10 space-y-6 text-gray-300 font-medium">
                <div class="flex items-center gap-5 p-4 rounded-xl glass-card"><i class="fa-solid fa-location-dot text-2xl text-indigo-400"></i> <span>${biz.address || 'Premium Hub Area Location'}</span></div>
                <div class="flex items-center gap-5 p-4 rounded-xl glass-card"><i class="fa-solid fa-phone text-2xl text-pink-400"></i> <span>${biz.phone || 'Inquire through Dashboard'}</span></div>
                <div class="flex items-center gap-5 p-4 rounded-xl glass-card"><i class="fa-solid fa-clock text-2xl text-amber-400"></i> <span>${biz.hours || 'Mon-Sat: 8:00 AM - 7:00 PM'}</span></div>
            </div>
        </div>

        <div class="glass-card p-8 md:p-10 rounded-3xl border border-white/10 shadow-2xl relative" data-aos="fade-left">
            <h3 class="heading-font text-2xl font-bold text-white mb-2">Request Exclusive Access</h3>
            <p class="text-gray-400 text-sm mb-6">Drop your information secure layer to reserve booking priorities.</p>
            <form class="space-y-4" onsubmit="event.preventDefault(); alert('Booking parameters uploaded successfully!');">
                <input type="text" placeholder="Full Client Name" required class="w-full bg-[#161624]/40 border border-white/10 rounded-xl p-4 text-sm text-white focus:outline-none focus:border-indigo-500 transition-colors">
                <input type="email" placeholder="Corporate Email Address" required class="w-full bg-[#161624]/40 border border-white/10 rounded-xl p-4 text-sm text-white focus:outline-none focus:border-indigo-500 transition-colors">
                <textarea placeholder="Outline service details or consultation agenda..." rows="4" required class="w-full bg-[#161624]/40 border border-white/10 rounded-xl p-4 text-sm text-white focus:outline-none focus:border-indigo-500 transition-colors"></textarea>
                <button type="submit" class="w-full bg-gradient-to-r ${gradient} text-white font-bold p-4 rounded-xl shadow-lg hover:opacity-90 transition-opacity transform active:scale-95">Dispatch Secure Booking</button>
            </form>
        </div>
    </section>

    <footer class="border-t border-white/5 py-12 text-center text-xs text-gray-500 max-w-7xl mx-auto">
        <p>&copy; 2026 ${biz.name}. All rights reserved. Managed Premium Landing Platform.</p>
    </footer>

    <script src="https://unpkg.com/aos@2.3.1/dist/aos.js"></script>
    <script>
        AOS.init({ once: true });
    </script>
</body>
</html>`;
}

// ─── AI PREMIUM HTML GENERATOR (اتصال به اندپوینت رسمی و ۲.۵ گوگل) ──────────────
async function generatePremiumHTML(biz) {
  const prompt = `You are a world-class award-winning UI/UX web designer and front-end developer.
Generate an incredibly stunning, ultra-modern, elite single-page landing page for this local business:
Name: ${biz.name}
Category: ${biz.category}
Address: ${biz.address}
Phone: ${biz.phone}
Rating: ${biz.rating} (${biz.review_count} reviews)
Hours: ${biz.hours}

STRICT DESIGN DIRECTION (Make it look like a $5,000 custom agency website):
1. Immersive Color Palette: Dark mode experience tailored to the industry with neon glowing accents (luxury gold/rose for salons, electric cyan/midnight blue for auto repair, charcoal amber/crimson for restaurants). Use glassmorphic cards (backdrop-filter: blur) and subtle smooth gradients.
2. Jaw-Dropping Typography & Icons: Include FontAwesome icons CDN. Use elite Google Fonts (Space Grotesk or Syne for headings, Inter for body).
3. Ultra High-Quality Real Visuals: Integrate multiple high-resolution, un-cropped background and gallery images using direct working source URLs from Unsplash that perfectly and realistically match the exact business type. Do not use abstract text links.
4. Fluid Animations: Include the AOS (Animate on Scroll) CSS and JS library via CDN. Apply 'data-aos="fade-up"' to layout containers so the entire page animates beautifully as the user scrolls down.
5. Elite Layout Structure: Sticky navigation bar, jaw-dropping Hero section with bold headline, floating trust metrics, detailed Premium Services grid, immersive customer Testimonials showcase, custom functional Contact Form, and an elegant footer.

Return ONLY the raw HTML/CSS/JS code starting with <!DOCTYPE html>. Absolutely no explanations, no chat commentary, and no markdown code blocks.`;

  try {
    // 🚀 سوییچ نهایی به مدل برتر جمینای ۲.۵ فلش برای بیلد کدهای زنده و حجیم فرانت‌اند
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    let htmlContent = response.text();

    if (!htmlContent) throw new Error("Empty response layer");

    htmlContent = htmlContent.trim();
    if (htmlContent.startsWith("```html")) htmlContent = htmlContent.replace(/```html/, "");
    if (htmlContent.endsWith("```")) htmlContent = htmlContent.slice(0, -3);
    
    return htmlContent.trim();
  } catch (error) {
    console.error("⚠️ AI Engine Error, Triggering Premium Local Masterpiece Engine:", error.message);
    // دپلووی لایوت فوق لوکس محلی با عکس‌های واقعی متناسب با صنف کسب‌وکار
    return generateLocalMasterpiece(biz);
  }
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

app.get("/", (_, res) => res.json({ ok: true, service: "SiteSprint High-End Hybrid Visual Engine" }));

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

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 SiteSprint Production Engine active on port ${PORT}`));
});
