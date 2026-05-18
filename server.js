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
    console.log("✅ Database structure is ready.");
  } catch (err) {
    console.error("❌ DB Init Error:", err);
  }
}

// ─── IMAGE BANK (انبار تصاویر لوکس و باکیفیت برای هر صنف) ────────────────────────
function getIndustryImages(category) {
  const cat = (category || "business").toLowerCase();
  
  let imgs = {
    hero: "https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&w=1600&q=80",
    feature: "https://images.unsplash.com/photo-1460925895917-afdab827c52f?auto=format&fit=crop&w=1000&q=80",
    g1: "https://images.unsplash.com/photo-1542744094-3a31f103e35f?auto=format&fit=crop&w=800&q=80",
    g2: "https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?auto=format&fit=crop&w=800&q=80",
    g3: "https://images.unsplash.com/photo-1551836022-d5d88e9218df?auto=format&fit=crop&w=800&q=80"
  };

  if (cat.includes("salon") || cat.includes("beauty") || cat.includes("hair") || cat.includes("nail")) {
    imgs = {
      hero: "https://images.unsplash.com/photo-1562322140-8baeececf3df?auto=format&fit=crop&w=1600&q=80",
      feature: "https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=1000&q=80",
      g1: "https://images.unsplash.com/photo-1605497746444-ac9da58480a8?auto=format&fit=crop&w=800&q=80",
      g2: "https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&w=800&q=80",
      g3: "https://images.unsplash.com/photo-1487412720507-e7ab37603c6f?auto=format&fit=crop&w=800&q=80"
    };
  } else if (cat.includes("repair") || cat.includes("auto") || cat.includes("glass") || cat.includes("mechanic")) {
    imgs = {
      hero: "https://images.unsplash.com/photo-1619642751034-765dfdf7c58e?auto=format&fit=crop&w=1600&q=80",
      feature: "https://images.unsplash.com/photo-1486006920555-c77dce18193b?auto=format&fit=crop&w=1000&q=80",
      g1: "https://images.unsplash.com/photo-1563720223185-11003d516935?auto=format&fit=crop&w=800&q=80",
      g2: "https://images.unsplash.com/photo-1517524206127-48bbd363f3d7?auto=format&fit=crop&w=800&q=80",
      g3: "https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?auto=format&fit=crop&w=800&q=80"
    };
  } else if (cat.includes("rest") || cat.includes("food") || cat.includes("grill") || cat.includes("cafe")) {
    imgs = {
      hero: "https://images.unsplash.com/photo-1514933651103-005eec06c04b?auto=format&fit=crop&w=1600&q=80",
      feature: "https://images.unsplash.com/photo-1504674900247-0877df9cc836?auto=format&fit=crop&w=1000&q=80",
      g1: "https://images.unsplash.com/photo-1555396273-367ea4eb4db5?auto=format&fit=crop&w=800&q=80",
      g2: "https://images.unsplash.com/photo-1606787366850-de6330128bfc?auto=format&fit=crop&w=800&q=80",
      g3: "https://images.unsplash.com/photo-1414235077428-338989a2e8c0?auto=format&fit=crop&w=800&q=80"
    };
  } else if (cat.includes("clean") || cat.includes("wash") || cat.includes("maid") || cat.includes("roof")) {
    imgs = {
      hero: "https://images.unsplash.com/photo-1581578731548-c64695cc6952?auto=format&fit=crop&w=1600&q=80",
      feature: "https://images.unsplash.com/photo-1584622650111-993a426fbf0a?auto=format&fit=crop&w=1000&q=80",
      g1: "https://images.unsplash.com/photo-1527515637-6742562d5395?auto=format&fit=crop&w=800&q=80",
      g2: "https://images.unsplash.com/photo-1628177142898-93e46e46284f?auto=format&fit=crop&w=800&q=80",
      g3: "https://images.unsplash.com/photo-1545205597-3d9d02c29597?auto=format&fit=crop&w=800&q=80"
    };
  }
  return imgs;
}

// ─── MASTERPIECE LOCAL ENGINE (موتور محلی فوق لوکس ۷ بخشی - تضمین فروش به مشتری) ───
function generateLocalMasterpiece(biz) {
  const images = getIndustryImages(biz.category);
  const cat = (biz.category || "business").toLowerCase();
  
  let accentColor = "#6366f1"; 
  let gradientAccent = "from-indigo-500 via-purple-500 to-pink-500";
  let btnStyle = "bg-gradient-to-r from-indigo-500 to-purple-600 hover:shadow-indigo-500/30";
  let tagline = "EXCLUSIVE ELITE SERVICES";

  if (cat.includes("salon") || cat.includes("beauty") || cat.includes("hair")) {
    accentColor = "#ec4899";
    gradientAccent = "from-pink-500 via-rose-500 to-amber-500";
    btnStyle = "bg-gradient-to-r from-pink-500 to-rose-600 hover:shadow-rose-500/30";
    tagline = "LUXURY BEAUTY & WELLNESS EXPERIENCE";
  } else if (cat.includes("repair") || cat.includes("auto") || cat.includes("glass")) {
    accentColor = "#0ea5e9";
    gradientAccent = "from-sky-500 via-blue-600 to-cyan-500";
    btnStyle = "bg-gradient-to-r from-sky-500 to-blue-600 hover:shadow-blue-500/30";
    tagline = "CERTIFIED MASTER AUTO & GLASS RESTORATION";
  } else if (cat.includes("rest") || cat.includes("food") || cat.includes("grill")) {
    accentColor = "#f97316";
    gradientAccent = "from-amber-500 via-orange-500 to-red-600";
    btnStyle = "bg-gradient-to-r from-amber-500 to-orange-600 hover:shadow-orange-500/30";
    tagline = "PREMIUM CULINARY ARTS & IMMERSIVE DINING";
  } else if (cat.includes("clean") || cat.includes("wash") || cat.includes("maid")) {
    accentColor = "#10b981";
    gradientAccent = "from-emerald-400 via-teal-500 to-cyan-500";
    btnStyle = "bg-gradient-to-r from-emerald-500 to-teal-600 hover:shadow-emerald-500/30";
    tagline = "PROFESSIONAL ELITE CLEANING & SANITIZATION";
  }

  return `<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${biz.name} | Exclusive Presentation</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <link href="https://unpkg.com/aos@2.3.1/dist/aos.css" rel="stylesheet">
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap');
        body { font-family: 'Plus Jakarta Sans', sans-serif; background-color: #04040a; color: #f1f5f9; overflow-x: hidden; }
        .heading-font { font-family: 'Space Grotesk', sans-serif; }
        .glass-nav { background: rgba(4, 4, 10, 0.75); backdrop-filter: blur(20px); border-bottom: 1px solid rgba(255,255,255,0.06); }
        .glass-card { background: rgba(255, 255, 255, 0.02); backdrop-filter: blur(16px); border: 1px solid rgba(255,255,255,0.06); }
        .glow-hover:hover { box-shadow: 0 0 35px ${accentColor}33; border-color: ${accentColor}66; }
    </style>
</head>
<body class="antialiased">

    <nav class="fixed top-0 left-0 right-0 z-50 glass-nav px-6 md:px-12 py-4 flex justify-between items-center rounded-b-2xl max-w-7xl mx-auto">
        <span class="heading-font text-xl font-bold tracking-tight text-white flex items-center gap-2">
            <span class="w-3 h-3 rounded-full bg-gradient-to-r ${gradientAccent} animate-pulse"></span> ${biz.name}
        </span>
        <div class="hidden md:flex items-center gap-8 text-sm font-semibold text-gray-400">
            <a href="#services" class="hover:text-white transition-colors">Services</a>
            <a href="#showcase" class="hover:text-white transition-colors">Showcase</a>
            <a href="#about" class="hover:text-white transition-colors">Location</a>
        </div>
        <a href="#contact" class="${btnStyle} text-white px-6 py-2.5 rounded-full font-bold text-sm shadow-xl transition-all transform hover:scale-105">Book Appointment</a>
    </nav>

    <section class="relative min-h-screen flex items-center justify-center pt-24 overflow-hidden px-6">
        <div class="absolute inset-0 z-0">
            <div class="absolute inset-0 bg-gradient-to-b from-transparent via-[#04040a]/80 to-[#04040a]"></div>
            <img src="${images.hero}" class="w-full h-full object-cover opacity-45 scale-105 animate-[pulse_10s_infinite]" alt="Hero Backdrop">
        </div>
        
        <div class="absolute top-1/4 left-1/4 w-96 h-96 bg-purple-500/10 blur-[120px] rounded-full pointer-events-none"></div>
        <div class="absolute bottom-1/3 right-1/4 w-96 h-96 bg-indigo-500/10 blur-[120px] rounded-full pointer-events-none"></div>

        <div class="relative z-10 text-center max-w-4xl mx-auto" data-aos="zoom-out" data-aos-duration="900">
            <span class="text-xs font-bold tracking-widest uppercase px-4 py-2 rounded-full glass-card text-gray-300 border border-white/10 inline-flex items-center gap-2">
                <i class="fa-solid fa-circle-check text-emerald-400"></i> Verified Local Business Hub
            </span>
            <h1 class="heading-font text-5xl md:text-7xl font-extrabold text-white mt-6 leading-tight tracking-tight">
                The Pinnacle of Luxury <br><span class="text-transparent bg-clip-text bg-gradient-to-r ${gradientAccent}">${biz.name}</span>
            </h1>
            <p class="text-gray-400 mt-6 text-lg md:text-xl max-w-2xl mx-auto font-medium">${tagline}</p>
            
            <div class="mt-10 flex flex-wrap justify-center gap-5">
                <a href="#contact" class="${btnStyle} text-white px-8 py-4 rounded-full font-bold shadow-2xl transition-all transform hover:scale-105">Schedule VIP Booking</a>
                <a href="#services" class="glass-card text-white px-8 py-4 rounded-full font-bold hover:bg-white/5 transition-colors border border-white/10">Explore Services</a>
            </div>

            <div class="grid grid-cols-3 gap-4 md:gap-8 mt-20 max-w-2xl mx-auto">
                <div class="glass-card p-4 md:p-6 rounded-2xl">
                    <div class="heading-font text-2xl md:text-3xl font-bold text-white flex items-center justify-center gap-1">★ ${biz.rating || '4.9'}</div>
                    <div class="text-[10px] md:text-xs text-gray-500 mt-1 uppercase font-bold tracking-wider">Google Rating</div>
                </div>
                <div class="glass-card p-4 md:p-6 rounded-2xl">
                    <div class="heading-font text-2xl md:text-3xl font-bold text-white">${biz.review_count || '145'}+</div>
                    <div class="text-[10px] md:text-xs text-gray-500 mt-1 uppercase font-bold tracking-wider">Active Reviews</div>
                </div>
                <div class="glass-card p-4 md:p-6 rounded-2xl">
                    <div class="heading-font text-2xl md:text-3xl font-bold text-white">100%</div>
                    <div class="text-[10px] md:text-xs text-gray-500 mt-1 uppercase font-bold tracking-wider">Satisfaction</div>
                </div>
            </div>
        </div>
    </section>

    <section id="services" class="py-32 px-6 max-w-7xl mx-auto relative">
        <div class="text-center max-w-2xl mx-auto mb-24" data-aos="fade-up">
            <h2 class="heading-font text-4xl md:text-5xl font-bold text-white">Our Masterwork Services</h2>
            <p class="text-gray-400 mt-4 font-medium">Engineered for extreme performance, delivered with pristine customer hospitality frameworks.</p>
        </div>
        
        <div class="grid md:grid-cols-3 gap-8">
            <div class="glass-card p-8 rounded-3xl transition-all duration-300 glow-hover group hover:-translate-y-2" data-aos="fade-up" data-aos-delay="100">
                <div class="w-14 h-14 rounded-2xl bg-white/5 flex items-center justify-center text-xl text-white mb-8 border border-white/10"><i class="fa-solid fa-crown text-amber-400"></i></div>
                <h3 class="heading-font text-xl font-bold text-white">Executive Tier Package</h3>
                <p class="text-gray-400 mt-3 text-sm leading-relaxed font-medium">Our all-inclusive, custom service block managed exclusively by senior enterprise specialists built completely around your criteria.</p>
            </div>
            <div class="glass-card p-8 rounded-3xl transition-all duration-300 glow-hover group hover:-translate-y-2" data-aos="fade-up" data-aos-delay="200">
                <div class="w-14 h-14 rounded-2xl bg-white/5 flex items-center justify-center text-xl text-white mb-8 border border-white/10"><i class="fa-solid fa-bolt text-cyan-400"></i></div>
                <h3 class="heading-font text-xl font-bold text-white">Express Rapid Priority</h3>
                <p class="text-gray-400 mt-3 text-sm leading-relaxed font-medium">Instant diagnostic matrix, ultra-fast turnarounds, and full guarantee overlays when your operational scheduling is tight.</p>
            </div>
            <div class="glass-card p-8 rounded-3xl transition-all duration-300 glow-hover group hover:-translate-y-2" data-aos="fade-up" data-aos-delay="300">
                <div class="w-14 h-14 rounded-2xl bg-white/5 flex items-center justify-center text-xl text-white mb-8 border border-white/10"><i class="fa-solid fa-shield-halved text-emerald-400"></i></div>
                <h3 class="heading-font text-xl font-bold text-white">Iron-Clad Protection</h3>
                <p class="text-gray-400 mt-3 text-sm leading-relaxed font-medium">Every parameter is fully logged and verified under our warranty schema, providing elite post-service support.</p>
            </div>
        </div>
    </section>

    <section class="py-24 max-w-7xl mx-auto px-6 grid md:grid-cols-2 gap-12 items-center border-t border-white/5">
        <div data-aos="fade-right">
            <span class="text-xs font-bold uppercase tracking-widest text-transparent bg-clip-text bg-gradient-to-r ${gradientAccent}">Why We Dominate The Industry</span>
            <h2 class="heading-font text-3xl md:text-4xl font-bold text-white mt-2">Uncompromising Quality & Standards</h2>
            <p class="text-gray-400 mt-6 leading-relaxed font-medium">We do not believe in shortcuts. Every client interaction and asset deployment follows elite international quality control guidelines, making us the premier local provider.</p>
            <ul class="mt-8 space-y-3 font-semibold text-sm text-gray-300">
                <li class="flex items-center gap-3"><i class="fa-solid fa-check text-emerald-400"></i> 100% Certified Elite Technicians & Craftsmen</li>
                <li class="flex items-center gap-3"><i class="fa-solid fa-check text-emerald-400"></i> State-Of-The-Art Custom Analytical Tools</li>
                <li class="flex items-center gap-3"><i class="fa-solid fa-check text-emerald-400"></i> Full Multi-Year Guarantee Architecture</li>
            </ul>
        </div>
        <div class="relative h-96 rounded-3xl overflow-hidden shadow-2xl border border-white/10" data-aos="fade-left">
            <img src="${images.feature}" class="w-full h-full object-cover" alt="Featured standard">
        </div>
    </section>

    <section id="showcase" class="py-24 bg-white/[0.01] border-y border-white/5 px-6">
        <div class="max-w-7xl mx-auto">
            <div class="text-center mb-16" data-aos="fade-up">
                <h2 class="heading-font text-4xl font-bold text-white">Visual Operation Portfolio</h2>
                <p class="text-gray-500 mt-2 font-medium">A microscopic look into our pristine environment, luxury toolkits, and client deliveries.</p>
            </div>
            
            <div class="grid md:grid-cols-3 gap-6">
                <div class="relative h-80 rounded-2xl overflow-hidden group border border-white/5 shadow-2xl" data-aos="zoom-in">
                    <img src="${images.g1}" class="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500" alt="Showcase 1">
                    <div class="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-6"><span class="font-bold text-white">Masterwork Phase Precision</span></div>
                </div>
                <div class="relative h-80 rounded-2xl overflow-hidden group border border-white/5 shadow-2xl" data-aos="zoom-in" data-aos-delay="100">
                    <img src="${images.g2}" class="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500" alt="Showcase 2">
                    <div class="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-6"><span class="font-bold text-white">Premium Material Infrastructure</span></div>
                </div>
                <div class="relative h-80 rounded-2xl overflow-hidden group border border-white/5 shadow-2xl" data-aos="zoom-in" data-aos-delay="200">
                    <img src="${images.g3}" class="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500" alt="Showcase 3">
                    <div class="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-6"><span class="font-bold text-white">Pristine Quality Fulfillment</span></div>
                </div>
            </div>
        </div>
    </section>

    <section id="about" class="py-32 px-6 max-w-7xl mx-auto grid md:grid-cols-2 gap-16 items-start">
        <div data-aos="fade-right">
            <h2 class="heading-font text-4xl font-bold text-white">Our Operational Flagship Hub</h2>
            <p class="text-gray-400 mt-4 leading-relaxed font-medium">Connect with our executive dispatch team instantly. We are fully structured to handle urgent consultations, active client briefings, and priority bookings.</p>
            
            <div class="mt-10 space-y-4 text-gray-300 font-medium">
                <div class="flex items-center gap-5 p-4 rounded-2xl glass-card"><i class="fa-solid fa-location-dot text-2xl text-indigo-400"></i> <span>${biz.address || 'Premium Operational Hub Location'}</span></div>
                <div class="flex items-center gap-5 p-4 rounded-2xl glass-card"><i class="fa-solid fa-phone text-2xl text-pink-400"></i> <span>${biz.phone || 'Inquire via Dispatch System'}</span></div>
                <div class="flex items-center gap-5 p-4 rounded-2xl glass-card"><i class="fa-solid fa-clock text-2xl text-amber-400"></i> <span>${biz.hours || 'Mon-Sat: 8:00 AM - 7:00 PM'}</span></div>
            </div>
        </div>

        <div class="glass-card p-8 md:p-10 rounded-3xl border border-white/10 shadow-2xl relative" data-aos="fade-left">
            <h3 class="heading-font text-2xl font-bold text-white mb-2">Request Priority Client Slot</h3>
            <p class="text-gray-400 text-sm mb-6">Input your parameters below to route data through our client dispatch pipeline.</p>
            <form class="space-y-4" onsubmit="event.preventDefault(); alert('Booking request transmitted successfully!');">
                <input type="text" placeholder="Full Client Name" required class="w-full bg-[#0e0e1a]/60 border border-white/10 rounded-xl p-4 text-sm text-white focus:outline-none focus:border-indigo-500 transition-colors">
                <input type="email" placeholder="Corporate Email Address" required class="w-full bg-[#0e0e1a]/60 border border-white/10 rounded-xl p-4 text-sm text-white focus:outline-none focus:border-indigo-500 transition-colors">
                <textarea placeholder="Outline your project specifications, active issues, or schedule criteria..." rows="4" required class="w-full bg-[#0e0e1a]/60 border border-white/10 rounded-xl p-4 text-sm text-white focus:outline-none focus:border-indigo-500 transition-colors"></textarea>
                <button type="submit" class="w-full ${btnStyle} text-white font-bold p-4 rounded-xl shadow-lg transition-all transform active:scale-95">Dispatch Secure Reservation</button>
            </form>
        </div>
    </section>

    <footer class="border-t border-white/5 py-12 text-center text-xs text-gray-500 max-w-7xl mx-auto">
        <p>&copy; 2026 ${biz.name}. Engineered by Danabak Agency Frameworks. All rights reserved.</p>
    </footer>

    <script src="https://unpkg.com/aos@2.3.1/dist/aos.js"></script>
    <script>
        AOS.init({ once: true, duration: 800 });
    </script>
</body>
</html>`;
}

// ─── CLAUDE GENERATOR (قفل شده روی نسخه رسمی و پایدار) ───────────────────────────
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
    // استفاده از نسخه معتبر و تست شده بدون خطای ۴۰۴
    const response = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20240620",
      max_tokens: 8000,
      messages: [{ role: "user", content: prompt }],
    });

    let htmlContent = response.content[0].text.trim();
    if (htmlContent.startsWith("```html")) htmlContent = htmlContent.replace(/```html/, "");
    if (htmlContent.endsWith("```")) htmlContent = htmlContent.slice(0, -3);
    
    const cssInjection = `
    <style>
      .bg-hero-img {
        background-image: linear-gradient(rgba(4, 4, 10, 0.4), rgba(4, 4, 10, 0.9)), url('${images.hero}');
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
    // در صورت خطای هوش مصنوعی، موتور لوکس جدید ۷ بخشی رندر می‌شود
    return generateLocalMasterpiece(biz);
  }
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

app.get("/", (_, res) => res.json({ ok: true, service: "SiteSprint Ultimate Claude Engine" }));

app.get("/api/businesses", async (req, res) => {
  const { status, q } = req.query;
  let sql = "SELECT * FROM businesses WHERE 1=1";
  const params = [];
  if (status && status !== "all") { sql += ` Vand status=$${params.length+1}`; params.push(status); }
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