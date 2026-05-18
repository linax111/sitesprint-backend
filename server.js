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
    console.log("✅ دیتابیس متصل و ساختار جدول‌ها تایید شد.");
  } catch (err) {
    console.error("❌ DB Init Error:", err);
  }
}

// ─── PREMIUM LOCAL ENGINE (موتور محلی فوق لوکس برای دگرگونی سایت‌ها در صورت خطای API) ───
function generateLocalMasterpiece(biz) {
  const cat = (biz.category || "business").toLowerCase();
  
  // انتخاب هوشمند تصاویر بر اساس صنف کسب‌وکار
  let heroImg = "https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?q=80&w=1200";
  let featureImg = "https://images.unsplash.com/photo-1460925895917-afdab827c52f?q=80&w=600";
  let accentColor = "#6366f1"; // ایندیگو پیش‌فرض
  let gradientAccent = "from-indigo-500 to-purple-600";

  if (cat.includes("salon") || cat.includes("beauty") || cat.includes("hair")) {
    heroImg = "https://images.unsplash.com/photo-1560066984-138dadb4c035?q=80&w=1200";
    featureImg = "https://images.unsplash.com/photo-1522335789203-aabd1fc54bc9?q=80&w=600";
    accentColor = "#ec4899"; // صورتی لوکس
    gradientAccent = "from-pink-500 to-rose-600";
  } else if (cat.includes("repair") || cat.includes("auto") || cat.includes("glass")) {
    heroImg = "https://images.unsplash.com/photo-1617886322168-72b886573c3c?q=80&w=1200";
    featureImg = "https://images.unsplash.com/photo-1486006920555-c77dce18193b?q=80&w=600";
    accentColor = "#0ea5e9"; // آبی الکتریک
    gradientAccent = "from-sky-500 to-cyan-600";
  } else if (cat.includes("rest") || cat.includes("food") || cat.includes("grill") || cat.includes("cafe")) {
    heroImg = "https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?q=80&w=1200";
    featureImg = "https://images.unsplash.com/photo-1504674900247-0877df9cc836?q=80&w=600";
    accentColor = "#f97316"; // نارنجی گرم یا زرشکی
    gradientAccent = "from-orange-500 to-red-600";
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${biz.name} | Premium Presentation</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <link href="https://unpkg.com/aos@2.3.1/dist/aos.css" rel="stylesheet">
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&family=Inter:wght@400;500;600&display=swap');
        body { font-family: 'Inter', sans-serif; background-color: #0b0b12; color: #e2e8f0; overflow-x: hidden; }
        .heading-font { font-family: 'Space Grotesk', sans-serif; }
        .glasscard { background: rgba(30, 30, 46, 0.4); backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.05); }
        .neon-glow:hover { box-shadow: 0 0 25px ${accentColor}44; }
    </style>
</head>
<body>
    <nav class="fixed top-0 left-0 right-0 z-50 glasscard px-6 py-4 flex justify-between items-center max-w-7xl mx-auto mt-4 rounded-2xl">
        <span class="heading-font text-xl font-bold tracking-tight text-white">${biz.name}</span>
        <a href="#contact" class="bg-gradient-to-r ${gradientAccent} text-white px-5 py-2.5 rounded-xl font-semibold text-sm shadow-lg transition-transform hover:scale-105">Book Now</a>
    </nav>

    <section class="relative min-h-screen flex items-center pt-24 px-6 max-w-7xl mx-auto">
        <div class="absolute inset-0 z-0 opacity-20">
            <div class="absolute inset-0 bg-gradient-to-b from-transparent to-[#0b0b12]"></div>
            <img src="${heroImg}" class="w-full h-full object-cover" alt="Hero background">
        </div>
        
        <div class="grid md:grid-cols-2 gap-12 items-center relative z-10 w-full">
            <div data-aos="fade-right" data-aos-duration="1000">
                <span class="text-xs font-bold tracking-widest uppercase px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-gray-400">Premium Presentation</span>
                <h1 class="heading-font text-5xl md:text-6xl font-bold text-white mt-4 leading-tight">We Take Care of <span class="text-transparent bg-clip-text bg-gradient-to-r ${gradientAccent}">Everything</span></h1>
                <p class="text-gray-400 mt-6 text-lg max-w-lg">Experience luxury service tailored specifically for you. High rating local trusted industry experts at your command.</p>
                <div class="mt-8 flex flex-wrap gap-4">
                    <a href="#services" class="bg-gradient-to-r ${gradientAccent} text-white px-8 py-4 rounded-xl font-bold shadow-lg hover:opacity-90 transition-opacity">Our Services</a>
                    <a href="#contact" class="glasscard text-white px-8 py-4 rounded-xl font-bold hover:bg-white/5 transition-colors border border-white/10">Contact Us</a>
                </div>
            </div>
            
            <div class="grid grid-cols-2 gap-6" data-aos="zoom-in-up" data-aos-duration="1200">
                <div class="glasscard p-6 rounded-2xl flex flex-col justify-center items-center text-center">
                    <span class="text-4xl text-transparent bg-clip-text bg-gradient-to-r ${gradientAccent} font-bold heading-font">★ ${biz.rating || '4.9'}</span>
                    <p class="text-sm text-gray-400 mt-2">Google Rating</p>
                </div>
                <div class="glasscard p-6 rounded-2xl flex flex-col justify-center items-center text-center">
                    <span class="text-4xl text-white font-bold heading-font">${biz.review_count || '120'}+</span>
                    <p class="text-sm text-gray-400 mt-2">Happy Reviews</p>
                </div>
                <div class="col-span-2 relative h-48 rounded-2xl overflow-hidden shadow-2xl">
                    <img src="${featureImg}" class="w-full h-full object-cover" alt="Featured work">
                </div>
            </div>
        </div>
    </section>

    <section id="services" class="py-32 px-6 max-w-7xl mx-auto">
        <div class="text-center max-w-xl mx-auto mb-20" data-aos="fade-up">
            <h2 class="heading-font text-4xl font-bold text-white">Elite Services Offered</h2>
            <p class="text-gray-400 mt-4">We combine technical excellence with premium customer care to deliver results that stand out.</p>
        </div>
        
        <div class="grid md:grid-cols-3 gap-8">
            <div class="glasscard p-8 rounded-3xl transition-all duration-3xl neon-glow group hover:-translate-y-2" data-aos="fade-up" data-aos-delay="100">
                <div class="w-12 h-12 rounded-xl bg-white/5 flex items-center justify-center text-xl text-transparent bg-clip-text bg-gradient-to-r ${gradientAccent} font-bold mb-6"><i class="fa-solid fa-crown"></i></div>
                <h3 class="heading-font text-xl font-bold text-white">Premium Package</h3>
                <p class="text-gray-400 mt-3 text-sm leading-relaxed">Our ultimate, full-service package tailored specifically to address your every requirement with extreme precision.</p>
            </div>
            <div class="glasscard p-8 rounded-3xl transition-all duration-3xl neon-glow group hover:-translate-y-2" data-aos="fade-up" data-aos-delay="200">
                <div class="w-12 h-12 rounded-xl bg-white/5 flex items-center justify-center text-xl text-transparent bg-clip-text bg-gradient-to-r ${gradientAccent} font-bold mb-6"><i class="fa-solid fa-bolt"></i></div>
                <h3 class="heading-font text-xl font-bold text-white">Express Care</h3>
                <p class="text-gray-400 mt-3 text-sm leading-relaxed">Fast, accurate, and completely guaranteed solutions when you are in a rush. Quality without compromises.</p>
            </div>
            <div class="glasscard p-8 rounded-3xl transition-all duration-3xl neon-glow group hover:-translate-y-2" data-aos="fade-up" data-aos-delay="300">
                <div class="w-12 h-12 rounded-xl bg-white/5 flex items-center justify-center text-xl text-transparent bg-clip-text bg-gradient-to-r ${gradientAccent} font-bold mb-6"><i class="fa-solid fa-shield-halved"></i></div>
                <h3 class="heading-font text-xl font-bold text-white">Full Guarantee</h3>
                <p class="text-gray-400 mt-3 text-sm leading-relaxed">Every service is fully covered under our agency backup protocol. Complete piece of mind for our clients.</p>
            </div>
        </div>
    </section>

    <section id="contact" class="py-24 px-6 max-w-7xl mx-auto grid md:grid-cols-2 gap-12 items-start bg-white/5 rounded-3xl border border-white/5 mb-24">
        <div data-aos="fade-right">
            <h2 class="heading-font text-3xl font-bold text-white">Business Location & Hours</h2>
            <p class="text-gray-400 mt-4 max-w-md">Stop by our location or give us a call today. We are fully prepared to answer any questions.</p>
            
            <div class="mt-8 space-y-4 text-sm text-gray-300">
                <div class="flex items-center gap-4"><i class="fa-solid fa-location-dot w-5 text-gray-500"></i> <span>${biz.address || 'Available upon request'}</span></div>
                <div class="flex items-center gap-4"><i class="fa-solid fa-phone w-5 text-gray-500"></i> <span>${biz.phone || 'Contact via Pipeline'}</span></div>
                <div class="flex items-center gap-4"><i class="fa-solid fa-clock w-5 text-gray-500"></i> <span>${biz.hours || 'Mon-Fri: 9AM - 6PM'}</span></div>
            </div>
        </div>

        <form class="space-y-4 w-full" data-aos="fade-left" onsubmit="event.preventDefault(); alert('Booking request sent successfully!');">
            <h3 class="heading-font text-xl font-bold text-white mb-2">Send Us an Instant Message</h3>
            <input type="text" placeholder="Your Full Name" required class="w-full bg-[#1e1e2e]/50 border border-white/10 rounded-xl p-3.5 text-sm text-white focus:outline-none focus:border-indigo-500 transition-colors">
            <input type="email" placeholder="Your Email Address" required class="w-full bg-[#1e1e2e]/50 border border-white/10 rounded-xl p-3.5 text-sm text-white focus:outline-none focus:border-indigo-500 transition-colors">
            <textarea placeholder="How can we help you today?" rows="4" required class="w-full bg-[#1e1e2e]/50 border border-white/10 rounded-xl p-3.5 text-sm text-white focus:outline-none focus:border-indigo-500 transition-colors"></textarea>
            <button type="submit" class="w-full bg-gradient-to-r ${gradientAccent} text-white font-bold p-4 rounded-xl shadow-lg hover:opacity-90 transition-opacity">Submit Secure Inquiry</button>
        </form>
    </section>

    <footer class="border-t border-white/5 py-8 text-center text-xs text-gray-500">
        <p>&copy; 2026 ${biz.name}. All rights reserved. Premium Landing Platform.</p>
    </footer>

    <script src="https://unpkg.com/aos@2.3.1/dist/aos.js"></script>
    <script>
        AOS.init({ once: true });
    </script>
</body>
</html>`;
}

// ─── AI PREMIUM HTML GENERATOR (اتصال به مدل جدید ۲۰۲۶ گوگل) ──────────────────────
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
1. Immersive Color Palette: Use a gorgeous dark mode experience tailored to the industry with neon/glowing accent colors (e.g., luxury deep dark champagne gold for salons; sleek obsidian black and electric cyan for auto glass/repair; rich charcoal and warm amber/crimson for premium restaurants). Use beautiful glassmorphic cards (backdrop-filter: blur) and subtle smooth gradients.
2. Jaw-Dropping Typography & Icons: Include FontAwesome icons CDN. Use elegant Google Fonts (e.g., Space Grotesk, Syne, or Playfair Display for headings; clean Inter or Montserrat for body).
3. Ultra High-Quality Real Visuals: Integrate stunning, high-resolution background and gallery images using source URLs from Unsplash that perfectly and realistically match the exact business type.
4. Fluid Animations: Include the AOS (Animate on Scroll) CSS and JS library via CDN. Apply 'data-aos="fade-up"' to layout containers, service boxes, and headers so the entire page animates beautifully as the user scrolls down.
5. Elite Layout Structure: Sticky navbar, jaw-dropping Hero section, floating Stats counter grid, Premium Services grid, customer Testimonials grid, and a custom functional Contact Form.

Return ONLY the raw HTML/CSS/JS code starting with <!DOCTYPE html>. Absolutely no explanations, no chat commentary, and no markdown code blocks.`;

  try {
    // 🚀 تغییر نام مدل به نسخه زنده و رسمی امسال برای حل نهایی ارور ۴۰۴
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
    console.error("⚠️ AI Failed, Triggering Local Masterpiece Engine:", error.message);
    // 💎 برگ برنده: اگر گوگل ارور داد، بلافاصله این لایوت اتوماتیک فوق‌العاده شیک لوکال رندر می‌شود
    return generateLocalMasterpiece(biz);
  }
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

app.get("/", (_, res) => res.json({ ok: true, service: "SiteSprint High-End Hybrid Production Engine" }));

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
  app.listen(PORT, () => console.log(`🚀 SiteSprint Premium Engine active on port ${PORT}`));
});