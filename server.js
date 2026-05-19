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

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS businesses (
        id SERIAL PRIMARY KEY, name TEXT NOT NULL, address TEXT DEFAULT '',
        phone TEXT DEFAULT '', category TEXT DEFAULT '', rating NUMERIC(2,1) DEFAULT 0,
        review_count INT DEFAULT 0, hours TEXT DEFAULT '', website TEXT DEFAULT '',
        google_url TEXT DEFAULT '', status TEXT DEFAULT 'prospect', notes TEXT DEFAULT '',
        area_searched TEXT DEFAULT '', preview_slug TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      );`);
    await pool.query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS preview_slug TEXT DEFAULT '';`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS generated_sites (
        id SERIAL PRIMARY KEY, business_id INT REFERENCES businesses(id) ON DELETE CASCADE,
        slug TEXT UNIQUE NOT NULL, html TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW()
      );`);
    console.log("✅ DB ready");
  } catch (err) { console.error("❌ DB Init Error:", err); }
}

function getImages(category) {
  const cat = (category || "").toLowerCase();
  if (cat.includes("dental") || cat.includes("dentist")) return [
    "https://images.unsplash.com/photo-1606811841689-23dfddce3e66?w=1600&q=80",
    "https://images.unsplash.com/photo-1588776814546-1ffbb172a090?w=800&q=80",
    "https://images.unsplash.com/photo-1629909615184-74f495363b67?w=800&q=80",
    "https://images.unsplash.com/photo-1609840114035-3c981b782dfe?w=800&q=80",
    "https://images.unsplash.com/photo-1598256989800-fe5f95da9787?w=800&q=80",
  ];
  if (cat.includes("salon") || cat.includes("beauty") || cat.includes("hair")) return [
    "https://images.unsplash.com/photo-1562322140-8baeececf3df?w=1600&q=80",
    "https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?w=800&q=80",
    "https://images.unsplash.com/photo-1605497746444-ac9da58480a8?w=800&q=80",
    "https://images.unsplash.com/photo-1560066984-138dadb4c035?w=800&q=80",
    "https://images.unsplash.com/photo-1487412720507-e7ab37603c6f?w=800&q=80",
  ];
  if (cat.includes("auto") || cat.includes("repair") || cat.includes("mechanic")) return [
    "https://images.unsplash.com/photo-1619642751034-765dfdf7c58e?w=1600&q=80",
    "https://images.unsplash.com/photo-1486006920555-c77dce18193b?w=800&q=80",
    "https://images.unsplash.com/photo-1563720223185-11003d516935?w=800&q=80",
    "https://images.unsplash.com/photo-1517524206127-48bbd363f3d7?w=800&q=80",
    "https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?w=800&q=80",
  ];
  if (cat.includes("rest") || cat.includes("food") || cat.includes("cafe") || cat.includes("bistro")) return [
    "https://images.unsplash.com/photo-1514933651103-005eec06c04b?w=1600&q=80",
    "https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=800&q=80",
    "https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=800&q=80",
    "https://images.unsplash.com/photo-1414235077428-338989a2e8c0?w=800&q=80",
    "https://images.unsplash.com/photo-1559339352-11d035aa65de?w=800&q=80",
  ];
  if (cat.includes("gym") || cat.includes("fitness")) return [
    "https://images.unsplash.com/photo-1534438327276-14e5300c3a48?w=1600&q=80",
    "https://images.unsplash.com/photo-1571019614242-c5c5dee9f50b?w=800&q=80",
    "https://images.unsplash.com/photo-1517836357463-d25dfeac3438?w=800&q=80",
    "https://images.unsplash.com/photo-1583454110551-21f2fa2afe61?w=800&q=80",
    "https://images.unsplash.com/photo-1574680096145-d05b474e2155?w=800&q=80",
  ];
  return [
    "https://images.unsplash.com/photo-1497366216548-37526070297c?w=1600&q=80",
    "https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=800&q=80",
    "https://images.unsplash.com/photo-1542744094-3a31f103e35f?w=800&q=80",
    "https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?w=800&q=80",
    "https://images.unsplash.com/photo-1551836022-d5d88e9218df?w=800&q=80",
  ];
}

function getPalette(category) {
  const cat = (category || "").toLowerCase();
  if (cat.includes("salon") || cat.includes("beauty") || cat.includes("hair"))
    return { bg: "#0d0008", primary: "#C9748A", accent: "#F2A7B8", text: "#fdf0f4" };
  if (cat.includes("dental") || cat.includes("dentist"))
    return { bg: "#00061a", primary: "#00B4D8", accent: "#90E0EF", text: "#e8f8ff" };
  if (cat.includes("auto") || cat.includes("repair") || cat.includes("mechanic"))
    return { bg: "#050a10", primary: "#F77F00", accent: "#FCBF49", text: "#fff8ee" };
  if (cat.includes("rest") || cat.includes("food") || cat.includes("cafe") || cat.includes("bistro"))
    return { bg: "#0d0500", primary: "#E76F51", accent: "#F4A261", text: "#fff8f5" };
  if (cat.includes("gym") || cat.includes("fitness"))
    return { bg: "#080012", primary: "#F72585", accent: "#FF6B6B", text: "#fff0f8" };
  if (cat.includes("clean") || cat.includes("hvac") || cat.includes("plumb"))
    return { bg: "#00100a", primary: "#52B788", accent: "#95D5B2", text: "#f0fff8" };
  return { bg: "#07071a", primary: "#6366f1", accent: "#818cf8", text: "#f0f0ff" };
}

async function generateSite(biz) {
  const imgs = getImages(biz.category);
  const c = getPalette(biz.category);

  const SYSTEM = `You are a senior frontend engineer. Output ONLY raw HTML with no markdown, no backticks, no commentary. ALL CSS must be in <style> tags. Only use these external resources: Google Fonts and Font Awesome 6 from cdnjs.cloudflare.com. Never use Tailwind or Bootstrap CDN.`;

  const p1 = `Generate the first half of a premium dark landing page for:
Name: ${biz.name} | Category: ${biz.category} | Rating: ${biz.rating}★ (${biz.review_count} reviews)
Phone: ${biz.phone || "Call us"} | Address: ${biz.address || ""} | Hours: ${biz.hours || "Mon-Sat 9AM-6PM"}
Colors — bg: ${c.bg} | primary: ${c.primary} | accent: ${c.accent} | text: ${c.text}

Output IN ORDER then STOP — do NOT write </body> or </html>:

1) <!DOCTYPE html><html lang="en"><head> with:
   - charset + viewport metas
   - <title>${biz.name}</title>
   - Google Fonts: import 2 fonts (one serif for headings, one sans for body)
   - Font Awesome: <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
   - Full <style> block covering the ENTIRE page:
     *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
     html { scroll-behavior: smooth; }
     body { background: ${c.bg}; color: ${c.text}; font-family: [your sans]; line-height: 1.6; }
     a { text-decoration: none; }
     .glass { background: rgba(255,255,255,0.06); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); border: 1px solid rgba(255,255,255,0.12); border-radius: 16px; }
     .btn-primary { display: inline-block; background: ${c.primary}; color: #fff; padding: 15px 38px; border-radius: 50px; font-weight: 700; font-size: 1rem; border: none; cursor: pointer; transition: all .3s; }
     .btn-primary:hover { filter: brightness(1.15); transform: translateY(-3px); box-shadow: 0 15px 40px ${c.primary}55; }
     .btn-ghost { display: inline-block; background: transparent; color: ${c.text}; padding: 15px 38px; border-radius: 50px; font-weight: 700; font-size: 1rem; border: 2px solid rgba(255,255,255,0.3); cursor: pointer; transition: all .3s; }
     .btn-ghost:hover { border-color: ${c.primary}; color: ${c.primary}; transform: translateY(-3px); }
     nav { position: fixed; top: 0; left: 0; right: 0; z-index: 1000; display: flex; align-items: center; justify-content: space-between; padding: 20px 6%; background: rgba(0,0,0,0.2); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border-bottom: 1px solid rgba(255,255,255,0.08); transition: background .4s; }
     nav.scrolled { background: rgba(0,0,0,0.92); }
     .nav-brand { font-family: [your serif]; font-size: 1.4rem; font-weight: 800; color: #fff; }
     .nav-brand em { color: ${c.primary}; font-style: normal; }
     .nav-links { display: flex; list-style: none; gap: 36px; }
     .nav-links a { color: rgba(255,255,255,0.75); font-size: 0.95rem; font-weight: 500; transition: color .3s; }
     .nav-links a:hover { color: ${c.accent}; }
     .hero { position: relative; min-height: 100vh; display: flex; align-items: center; justify-content: center; text-align: center; overflow: hidden; }
     .bg-hero-img { position: absolute; inset: 0; background-size: cover; background-position: center; }
     .hero-overlay { position: absolute; inset: 0; background: linear-gradient(160deg, ${c.bg}f0 0%, ${c.bg}88 60%, ${c.bg}f5 100%); }
     .hero-content { position: relative; z-index: 2; max-width: 820px; padding: 0 20px; padding-top: 100px; }
     .hero-badge { display: inline-flex; align-items: center; gap: 10px; background: rgba(255,255,255,0.09); border: 1px solid rgba(255,255,255,0.18); border-radius: 100px; padding: 10px 24px; font-size: 0.9rem; font-weight: 600; margin-bottom: 32px; }
     .hero-badge .stars { color: #FFD700; letter-spacing: 2px; }
     .hero h1 { font-family: [your serif]; font-size: clamp(2.8rem, 6vw, 5rem); font-weight: 900; line-height: 1.08; margin-bottom: 24px; }
     .hero h1 .highlight { color: ${c.primary}; }
     .hero p { font-size: 1.15rem; opacity: 0.8; max-width: 560px; margin: 0 auto 44px; }
     .hero-actions { display: flex; gap: 16px; justify-content: center; flex-wrap: wrap; }
     .trust-strip { padding: 52px 6%; background: rgba(255,255,255,0.025); border-top: 1px solid rgba(255,255,255,0.06); border-bottom: 1px solid rgba(255,255,255,0.06); }
     .trust-inner { max-width: 900px; margin: 0 auto; display: grid; grid-template-columns: repeat(3, 1fr); gap: 40px; text-align: center; }
     .trust-num { font-size: 2.8rem; font-weight: 900; color: ${c.primary}; font-family: [your serif]; line-height: 1; }
     .trust-lbl { font-size: 0.85rem; opacity: 0.6; margin-top: 6px; letter-spacing: 1px; text-transform: uppercase; }
     .section { padding: 100px 6%; }
     .section-eyebrow { color: ${c.accent}; font-size: 0.8rem; font-weight: 700; letter-spacing: 4px; text-transform: uppercase; margin-bottom: 14px; }
     .section-heading { font-family: [your serif]; font-size: clamp(2rem, 4vw, 3rem); font-weight: 800; line-height: 1.2; margin-bottom: 16px; }
     .section-sub { font-size: 1rem; opacity: 0.65; max-width: 520px; }
     .services-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 24px; margin-top: 60px; }
     .svc-card { padding: 38px 32px; transition: transform .3s, box-shadow .3s; }
     .svc-card:hover { transform: translateY(-10px); box-shadow: 0 30px 80px rgba(0,0,0,0.5); }
     .svc-icon { width: 60px; height: 60px; background: ${c.primary}20; border-radius: 14px; display: flex; align-items: center; justify-content: center; margin-bottom: 22px; }
     .svc-icon i { font-size: 1.5rem; color: ${c.primary}; }
     .svc-card h3 { font-family: [your serif]; font-size: 1.2rem; font-weight: 700; margin-bottom: 10px; }
     .svc-card p { font-size: 0.92rem; opacity: 0.65; line-height: 1.75; }
     .gallery-section { padding: 100px 6%; }
     .gallery-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; margin-top: 60px; }
     .gallery-img-1, .gallery-img-2, .gallery-img-3 { height: 300px; background-size: cover; background-position: center; border-radius: 16px; transition: transform .4s, box-shadow .4s; cursor: pointer; }
     .gallery-img-1:hover, .gallery-img-2:hover, .gallery-img-3:hover { transform: scale(1.05); box-shadow: 0 24px 80px rgba(0,0,0,0.6); }
     .contact-section { padding: 100px 6%; }
     .contact-inner { display: grid; grid-template-columns: 1fr 1.2fr; gap: 60px; max-width: 1100px; margin: 60px auto 0; align-items: start; }
     .contact-details { display: flex; flex-direction: column; gap: 28px; padding-top: 10px; }
     .contact-row { display: flex; align-items: flex-start; gap: 18px; }
     .c-icon { width: 50px; height: 50px; min-width: 50px; background: ${c.primary}20; border-radius: 12px; display: flex; align-items: center; justify-content: center; }
     .c-icon i { color: ${c.primary}; font-size: 1.1rem; }
     .c-label { font-size: 0.75rem; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; opacity: 0.55; margin-bottom: 5px; }
     .c-val { font-size: 1rem; font-weight: 600; }
     .contact-form { padding: 40px 38px; }
     .f-group { margin-bottom: 20px; }
     .f-label { display: block; font-size: 0.78rem; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; opacity: 0.7; margin-bottom: 8px; }
     .f-input { width: 100%; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.14); border-radius: 10px; padding: 14px 18px; color: ${c.text}; font-size: 0.97rem; font-family: inherit; transition: border-color .3s, background .3s; outline: none; }
     .f-input:focus { border-color: ${c.primary}; background: rgba(255,255,255,0.1); }
     .f-input::placeholder { opacity: 0.35; }
     textarea.f-input { min-height: 130px; resize: vertical; }
     .f-submit { width: 100%; padding: 16px; font-size: 1rem; font-weight: 700; letter-spacing: 1px; margin-top: 8px; }
     footer { padding: 64px 6% 36px; border-top: 1px solid rgba(255,255,255,0.07); text-align: center; }
     .footer-brand { font-family: [your serif]; font-size: 1.6rem; font-weight: 800; color: ${c.primary}; margin-bottom: 10px; }
     .footer-tag { opacity: 0.45; font-size: 0.9rem; margin-bottom: 36px; }
     .footer-copy { opacity: 0.3; font-size: 0.8rem; }
     @keyframes fadeUp { from { opacity:0; transform:translateY(28px); } to { opacity:1; transform:translateY(0); } }
     .fade-up { animation: fadeUp .9s ease forwards; }
     .delay-1 { animation-delay: .15s; opacity: 0; }
     .delay-2 { animation-delay: .3s; opacity: 0; }
     @media(max-width:768px) { .nav-links{display:none;} .gallery-grid{grid-template-columns:1fr;} .contact-inner{grid-template-columns:1fr;} .trust-inner{grid-template-columns:1fr;gap:28px;} }
   </style>
   </head>

2) <body>

3) <nav id="topnav">
     <span class="nav-brand"><em>[First word]</em> [Rest of name]</span>
     <ul class="nav-links">
       <li><a href="#services">Services</a></li>
       <li><a href="#gallery">Gallery</a></li>
       <li><a href="#contact">Contact</a></li>
     </ul>
     <a href="#contact" class="btn-primary">Get Free Quote</a>
   </nav>

4) <section class="hero">
     <div class="bg-hero-img"></div>
     <div class="hero-overlay"></div>
     <div class="hero-content">
       <div class="hero-badge fade-up"><span class="stars">★★★★★</span> ${biz.rating} · ${biz.review_count} Reviews</div>
       <h1 class="fade-up delay-1">[Compelling headline for ${biz.category} with <span class="highlight">key phrase</span>]</h1>
       <p class="fade-up delay-2">[One strong value proposition sentence]</p>
       <div class="hero-actions fade-up delay-2">
         <a href="#contact" class="btn-primary">[Main CTA for ${biz.category}]</a>
         <a href="#services" class="btn-ghost">Our Services</a>
       </div>
     </div>
   </section>

5) Trust strip with 3 stats relevant to ${biz.category}

6) <section class="section" id="services">
     Eyebrow + heading + 3 .svc-card.glass cards with FontAwesome icons and descriptions for ${biz.category}
   </section>

STOP after services </section>. Do NOT write </body> or </html>.`;

  const p2 = `Continue the HTML for "${biz.name}" (${biz.category}). Start with <section class="gallery-section"> and end with </html>.

Output exactly:

<section class="gallery-section" id="gallery">
  <div style="text-align:center">
    <p class="section-eyebrow">Our Work</p>
    <h2 class="section-heading">[Gallery heading for ${biz.category}]</h2>
  </div>
  <div class="gallery-grid">
    <div class="gallery-img-1"></div>
    <div class="gallery-img-2"></div>
    <div class="gallery-img-3"></div>
  </div>
</section>

<section class="contact-section" id="contact">
  <div style="text-align:center;margin-bottom:0">
    <p class="section-eyebrow">Get In Touch</p>
    <h2 class="section-heading">Let's Talk</h2>
  </div>
  <div class="contact-inner">
    <div class="contact-details">
      <div class="contact-row">
        <div class="c-icon"><i class="fas fa-phone"></i></div>
        <div><p class="c-label">Phone</p><p class="c-val">${biz.phone || "Call for pricing"}</p></div>
      </div>
      <div class="contact-row">
        <div class="c-icon"><i class="fas fa-location-dot"></i></div>
        <div><p class="c-label">Address</p><p class="c-val">${biz.address || "Visit our location"}</p></div>
      </div>
      <div class="contact-row">
        <div class="c-icon"><i class="fas fa-clock"></i></div>
        <div><p class="c-label">Hours</p><p class="c-val">${biz.hours || "Mon-Sat 9AM-6PM"}</p></div>
      </div>
    </div>
    <div class="contact-form glass">
      <form onsubmit="handleForm(event)">
        <div class="f-group"><label class="f-label">Full Name</label><input class="f-input" type="text" placeholder="Your full name" required></div>
        <div class="f-group"><label class="f-label">Email</label><input class="f-input" type="email" placeholder="your@email.com" required></div>
        <div class="f-group"><label class="f-label">Phone</label><input class="f-input" type="tel" placeholder="(555) 000-0000"></div>
        <div class="f-group"><label class="f-label">Message</label><textarea class="f-input" placeholder="How can we help you?" required></textarea></div>
        <button type="submit" class="btn-primary f-submit">Send Message &rarr;</button>
      </form>
    </div>
  </div>
</section>

<footer>
  <div class="footer-brand">${biz.name}</div>
  <p class="footer-tag">[Short tagline for ${biz.category}]</p>
  <p class="footer-copy">&copy; 2025 ${biz.name}. All rights reserved.</p>
</footer>

<script>
  window.addEventListener('scroll', () => {
    document.getElementById('topnav').classList.toggle('scrolled', window.scrollY > 60);
  });
  function handleForm(e) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    btn.textContent = 'Message Sent!';
    btn.style.background = '#22c55e';
    setTimeout(() => { btn.textContent = 'Send Message \u2192'; btn.style.background = ''; e.target.reset(); }, 3000);
  }
</script>
</body>
</html>`;

  try {
    console.log(`🎨 Pass 1 — ${biz.name}`);
    const r1 = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 5000,
      system: SYSTEM,
      messages: [{ role: "user", content: p1 }],
    });
    let part1 = r1.content[0].text.trim().replace(/^```html?\n?/,"").replace(/^```\n?/,"").replace(/```$/,"");

    console.log(`🎨 Pass 2 — ${biz.name}`);
    const r2 = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2500,
      system: SYSTEM,
      messages: [{ role: "user", content: p2 }],
    });
    let part2 = r2.content[0].text.trim().replace(/^```html?\n?/,"").replace(/^```\n?/,"").replace(/```$/,"");

    let html = part1 + "\n" + part2;

    const imgCSS = `<style>
  .bg-hero-img { background-image: url('${imgs[0]}') !important; }
  .gallery-img-1 { background-image: url('${imgs[2]}') !important; }
  .gallery-img-2 { background-image: url('${imgs[3]}') !important; }
  .gallery-img-3 { background-image: url('${imgs[4]}') !important; }
</style>`;

    html = html.includes("</head>")
      ? html.replace("</head>", imgCSS + "\n</head>")
      : imgCSS + html;

    if (!html.includes("</html>")) html += "\n</body>\n</html>";
    console.log(`✅ Done — ${html.length} chars`);
    return html;
  } catch (err) {
    console.error("🔴 Error:", err.message);
    return `<!DOCTYPE html><html><head><title>Error</title></head><body style="background:#0f0f13;color:#ef4444;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;font-size:1.5rem;text-align:center;padding:20px;">Generation failed — please try again.</body></html>`;
  }
}

app.get("/", (_, res) => res.json({ ok: true, service: "SiteSprint v3" }));

app.get("/api/businesses", async (req, res) => {
  try {
    const { status, q } = req.query;
    let sql = "SELECT * FROM businesses WHERE 1=1";
    const params = [];
    if (status && status !== "all") { sql += ` AND status=$${params.length+1}`; params.push(status); }
    if (q) {
      sql += ` AND (name ILIKE $${params.length+1} OR category ILIKE $${params.length+2} OR address ILIKE $${params.length+3})`;
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    sql += " ORDER BY created_at DESC";
    res.json((await pool.query(sql, params)).rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/api/businesses/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const b = req.body;
    const allowed = ["name","address","phone","category","rating","review_count","hours","website","google_url","status","notes","preview_slug"];
    const sets = [], params = [];
    for (const col of allowed) {
      if (col in b) { sets.push(`${col}=$${params.length+1}`); params.push(b[col]); }
    }
    if (!sets.length) return res.json({ ok: true });
    sets.push("updated_at=NOW()");
    params.push(id);
    await pool.query(`UPDATE businesses SET ${sets.join(",")} WHERE id=$${params.length}`, params);
    res.json((await pool.query("SELECT * FROM businesses WHERE id=$1", [id])).rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/businesses/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM businesses WHERE id=$1", [req.params.id]);
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/search", async (req, res) => {
  try {
    const { area } = req.body;
    if (!area) return res.status(400).json({ error: "area required" });
    const categories = [
      { cat: "Auto Repair", name: "Motors & Glass" }, { cat: "Restaurant", name: "Grill & Bistro" },
      { cat: "Salon", name: "Beauty Studio" }, { cat: "Plumbing", name: "Rooter Services" },
      { cat: "Dental", name: "Family Dentistry" }, { cat: "Gym", name: "Fitness Center" },
      { cat: "Landscaping", name: "Lawn & Garden" }, { cat: "Roofing", name: "Roofing Experts" },
      { cat: "Cafe", name: "Coffee Roasters" }, { cat: "Cleaning", name: "Commercial Cleaners" }
    ];
    const results = [];
    for (let i = 1; i <= 20; i++) {
      const type = categories[i % categories.length];
      results.push({
        id: 1000+i, name: `${area} Elite ${type.name}`,
        address: `${100+i*15} Commerce Blvd, ${area}`,
        phone: `(555) 019-${(i*123).toString().padStart(4,"0")}`,
        category: type.cat,
        rating: parseFloat((4+Math.random()).toFixed(1)),
        review_count: Math.floor(Math.random()*400)+45,
        hours: "Mon-Sat 8AM - 6PM", area_searched: area
      });
    }
    res.json(results);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const generateHandler = async (req, res) => {
  try {
    const { id } = req.params;
    let bizResult = await pool.query("SELECT * FROM businesses WHERE id=$1", [id]);
    let biz;
    if (bizResult.rows.length) {
      biz = bizResult.rows[0];
    } else {
      const b = req.body;
      const ins = await pool.query(
        `INSERT INTO businesses (name,address,phone,category,rating,review_count,hours,status,area_searched)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [b.name||"Business", b.address||"", b.phone||"", b.category||"",
         b.rating||5, b.review_count||50, b.hours||"", "prospect", b.area_searched||""]
      );
      biz = ins.rows[0];
    }
    const html = await generateSite(biz);
    const slug = `${biz.id}-${Date.now()}`;
    await pool.query(
      `INSERT INTO generated_sites (business_id, slug, html) VALUES ($1,$2,$3)
       ON CONFLICT (slug) DO UPDATE SET html=EXCLUDED.html`,
      [biz.id, slug, html]
    );
    await pool.query(
      "UPDATE businesses SET preview_slug=$1, status='site shown', updated_at=NOW() WHERE id=$2",
      [slug, biz.id]
    );
    res.json({ url: `/preview/${slug}`, slug });
  } catch (err) {
    console.error("🔴 Generate error:", err);
    res.status(500).json({ error: err.message });
  }
};

app.post("/api/generate/:id", generateHandler);
app.post("/generate/:id", generateHandler);

app.get("/preview/:slug", async (req, res) => {
  try {
    const r = await pool.query("SELECT html FROM generated_sites WHERE slug=$1", [req.params.slug]);
    if (!r.rows.length) return res.status(404).send("<h1>Site not found</h1>");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(r.rows[0].html);
  } catch (err) { res.status(500).send(err.message); }
});

const PORT = process.env.PORT || 3001;
initDB().then(() => app.listen(PORT, () => console.log(`🚀 SiteSprint v3 on port ${PORT}`)));