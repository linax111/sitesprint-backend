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
    CREATE TABLE IF NOT EXISTS generated_sites (
      id          SERIAL PRIMARY KEY,
      business_id INT REFERENCES businesses(id) ON DELETE CASCADE,
      slug        TEXT UNIQUE NOT NULL,
      html        TEXT NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log("✅ DB ready");
}

// ─── SITE GENERATOR ───────────────────────────────────────────────────────────
function generateHTML(biz) {
  const cat    = biz.category || "";
  const isAuto  = /auto|glass|windshield|car|repair|mechanic/i.test(cat);
  const isFood  = /restaurant|grill|food|cafe|pizza|sushi|bar|diner/i.test(cat);
  const isSalon = /salon|hair|beauty|spa|nail/i.test(cat);

  const theme = isAuto
    ? { bg:"#060d1a", ac:"#00cfff", card:"#0b1628", f1:"Syne", f2:"DM+Sans", tagline:"Fast. Precise. <em>Crystal Clear.</em>" }
    : isFood
    ? { bg:"#140800", ac:"#ff7043", card:"#1e0e00", f1:"Playfair+Display", f2:"Lato", tagline:"Authentic. Bold. <em>Unforgettable.</em>" }
    : isSalon
    ? { bg:"#0d0a14", ac:"#e879f9", card:"#150f20", f1:"Cormorant+Garamond", f2:"Nunito", tagline:"Beauty, <em>Redefined.</em>" }
    : { bg:"#0a0a0a", ac:"#a3e635", card:"#141414", f1:"Space+Grotesk", f2:"Inter", tagline:"Professional. Reliable. <em>Local.</em>" };

  const services = isAuto
    ? [["🪟","Windshield Replacement","OEM-quality glass installed with precision sealing and leak testing."],
       ["💧","Chip & Crack Repair","Stop cracks fast — resin injection done in under an hour."],
       ["🚗","Mobile Service","We come to you — home, office, or anywhere in the area."],
       ["🎯","ADAS Calibration","Post-install sensor recalibration for all modern safety systems."]]
    : isFood
    ? [["🍽️","Dine In","A warm atmosphere crafted for memorable meals."],
       ["📦","Takeout","Fresh orders ready on your schedule."],
       ["🚚","Delivery","Our flavors delivered straight to your door."],
       ["🎉","Catering","Bring the experience to your next event."]]
    : isSalon
    ? [["✂️","Cut & Style","Precision cuts tailored to your lifestyle."],
       ["🎨","Color & Highlights","Balayage and full color by certified stylists."],
       ["💆","Treatments","Deep conditioning and restorative care."],
       ["💅","Beauty Services","Full-service beauty and skincare."]]
    : [["⭐","Premium Quality","Top-rated service trusted by local customers."],
       ["⚡","Fast Turnaround","Efficient work that respects your time."],
       ["🛡️","Satisfaction Guaranteed","We stand behind every job."],
       ["📞","Always Available","We're here when you need us."]];

  const name    = (biz.name || "Business").replace(/</g,"&lt;");
  const address = (biz.address || "Charlotte, NC").replace(/</g,"&lt;");
  const phone   = (biz.phone || "").replace(/</g,"&lt;");
  const hours   = (biz.hours || "Mon–Sat 9AM–6PM").replace(/</g,"&lt;");
  const rating  = parseFloat(biz.rating || 5).toFixed(1);
  const reviews = parseInt(biz.review_count || 50);
  const stars   = "★".repeat(Math.round(parseFloat(rating)));

  const words = name.split(" ");
  const n1 = words.slice(0,-1).join(" ") || name;
  const n2 = words.length > 1 ? words[words.length-1] : "";

  const srvHTML = services.map(([ic,ti,de]) =>
    `<div class="sc"><div class="si">${ic}</div><h3>${ti}</h3><p>${de}</p></div>`
  ).join("");

  const placeholder = isAuto ? "Vehicle Make & Model" : isFood ? "Party size / Occasion" : "How can we help?";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${name} — ${address}</title>
<link href="https://fonts.googleapis.com/css2?family=${theme.f1.replace(/\+/g," ")}:wght@400;700;800&family=${theme.f2.replace(/\+/g," ")}:wght@300;400;500;600&display=swap" rel="stylesheet"/>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:${theme.bg};--ac:${theme.ac};--card:${theme.card};--txt:#f0f0f0;--dim:rgba(255,255,255,.45)}
html{scroll-behavior:smooth}
body{background:var(--bg);color:var(--txt);font-family:'${theme.f2.replace(/\+/g," ")}',sans-serif;overflow-x:hidden}
nav{position:sticky;top:0;z-index:99;display:flex;justify-content:space-between;align-items:center;padding:1.1rem 5%;border-bottom:1px solid rgba(255,255,255,.07);backdrop-filter:blur(20px);background:rgba(0,0,0,.45)}
.logo{font-family:'${theme.f1.replace(/\+/g," ")}',serif;font-weight:800;font-size:1.3rem}.logo em{color:var(--ac);font-style:normal}
.ncta{background:var(--ac);color:#000;padding:.5rem 1.4rem;border-radius:50px;font-weight:700;font-size:.82rem;text-decoration:none}
.hero{min-height:90vh;display:flex;flex-direction:column;justify-content:center;padding:6rem 5% 4rem;position:relative;overflow:hidden}
.hero::before{content:'';position:absolute;top:-20%;right:-5%;width:500px;height:500px;border-radius:50%;background:radial-gradient(circle,${theme.ac}1a 0%,transparent 70%);pointer-events:none}
.htag{display:inline-flex;align-items:center;gap:.5rem;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);padding:.38rem .9rem;border-radius:50px;font-size:.75rem;color:var(--ac);margin-bottom:1.8rem}
h1{font-family:'${theme.f1.replace(/\+/g," ")}',serif;font-size:clamp(2.6rem,6vw,4.8rem);font-weight:800;line-height:1.05;letter-spacing:-.03em;margin-bottom:1.2rem;max-width:680px}
h1 em{color:var(--ac);font-style:normal}
.hsub{font-size:1.05rem;color:var(--dim);max-width:460px;line-height:1.75;margin-bottom:2.6rem}
.hbtns{display:flex;gap:.9rem;flex-wrap:wrap}
.ba{background:var(--ac);color:#000;padding:.85rem 2rem;border-radius:50px;font-weight:700;font-size:.9rem;text-decoration:none}
.bb{border:1px solid rgba(255,255,255,.18);color:var(--txt);padding:.85rem 2rem;border-radius:50px;font-size:.9rem;text-decoration:none}
.stats{display:grid;grid-template-columns:repeat(3,1fr);max-width:860px;margin:4.5rem auto;gap:1px;background:rgba(255,255,255,.07);border-radius:16px;overflow:hidden}
.stat{background:var(--bg);padding:2.2rem 1.8rem;text-align:center}
.sn{font-family:'${theme.f1.replace(/\+/g," ")}',serif;font-size:2.4rem;font-weight:800;color:var(--ac)}
.sl{font-size:.8rem;color:var(--dim);margin-top:.35rem}
section{max-width:1080px;margin:0 auto;padding:4.5rem 5%}
.stag{font-size:.68rem;letter-spacing:.16em;text-transform:uppercase;color:var(--ac);margin-bottom:.7rem}
.sh{font-family:'${theme.f1.replace(/\+/g," ")}',serif;font-size:2.2rem;font-weight:800;letter-spacing:-.03em;margin-bottom:2.8rem}
.grid4{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:1px;background:rgba(255,255,255,.06);border-radius:18px;overflow:hidden}
.sc{background:var(--card);padding:2.2rem 1.8rem;transition:.3s}
.sc:hover{background:color-mix(in srgb,var(--card) 80%,var(--ac) 20%)}
.si{font-size:1.9rem;margin-bottom:1.3rem}
.sc h3{font-family:'${theme.f1.replace(/\+/g," ")}',serif;font-weight:700;font-size:1.05rem;margin-bottom:.55rem}
.sc p{font-size:.86rem;color:var(--dim);line-height:1.65}
.rb{background:var(--card);padding:4.5rem 5%;margin:1.5rem 0}
.rbi{max-width:1080px;margin:0 auto;display:flex;align-items:center;gap:3.5rem;flex-wrap:wrap}
.stars-big{color:var(--ac);font-size:1.4rem}
.rn{font-family:'${theme.f1.replace(/\+/g," ")}',serif;font-size:4rem;font-weight:800;color:var(--ac);line-height:1}
.rs{font-size:.8rem;color:var(--dim);margin-top:.35rem}
.rq{flex:1;min-width:240px;font-size:1rem;line-height:1.8;color:rgba(255,255,255,.55);font-style:italic;border-left:3px solid var(--ac);padding-left:1.4rem}
.cg{display:grid;grid-template-columns:1fr 1fr;gap:4.5rem;align-items:start}
.cg h2{font-family:'${theme.f1.replace(/\+/g," ")}',serif;font-size:2.2rem;font-weight:800;letter-spacing:-.03em;margin-bottom:1.8rem}
.ii{display:flex;gap:.9rem;margin-bottom:1.3rem;align-items:flex-start}
.ico{width:40px;height:40px;background:rgba(255,255,255,.05);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:1rem;flex-shrink:0}
.il{font-size:.7rem;color:var(--dim);margin-bottom:.2rem}
.iv{font-size:.92rem}
form{display:flex;flex-direction:column;gap:.85rem}
input,textarea{background:rgba(255,255,255,.05);border:1.5px solid rgba(255,255,255,.09);border-radius:11px;padding:.9rem 1.1rem;color:var(--txt);font-size:.9rem;width:100%;outline:none;transition:.2s}
input:focus,textarea:focus{border-color:var(--ac)}
textarea{resize:vertical;min-height:105px}
.fsub{background:var(--ac);color:#000;border:none;padding:.95rem;border-radius:50px;font-weight:700;font-size:.9rem;cursor:pointer;width:100%}
footer{border-top:1px solid rgba(255,255,255,.07);padding:1.8rem 5%;text-align:center;font-size:.75rem;color:rgba(255,255,255,.22)}
@media(max-width:768px){h1{font-size:2.3rem}.stats{grid-template-columns:1fr}.cg{grid-template-columns:1fr}}
</style>
</head>
<body>
<nav>
  <div class="logo">${n1}<em> ${n2}</em></div>
  <a href="#contact" class="ncta">Get a Quote</a>
</nav>
<div class="hero">
  <div class="htag">⚡ ${cat} &nbsp;·&nbsp; ${address}</div>
  <h1>${theme.tagline}</h1>
  <p class="hsub">${name} — rated ${rating}★ by ${reviews}+ happy customers.</p>
  <div class="hbtns">
    <a href="#contact" class="ba">Book Now</a>
    <a href="tel:${phone}" class="bb">📞 ${phone || "Call Us"}</a>
  </div>
</div>
<div class="stats">
  <div class="stat"><div class="sn">${rating}</div><div class="sl">Avg Rating</div></div>
  <div class="stat"><div class="sn">${reviews}+</div><div class="sl">Happy Customers</div></div>
  <div class="stat"><div class="sn">Same Day</div><div class="sl">Service Available</div></div>
</div>
<section>
  <div class="stag">What We Offer</div>
  <div class="sh">Our Services</div>
  <div class="grid4">${srvHTML}</div>
</section>
<div class="rb">
  <div class="rbi">
    <div><div class="stars-big">${stars}</div><div class="rn">${rating}</div><div class="rs">${reviews} Google Reviews</div></div>
    <div class="rq">"The best ${cat.toLowerCase()||"service"} experience I've had. Professional, fast, and completely transparent. I won't go anywhere else."
      <div style="margin-top:.9rem;font-size:.78rem;color:rgba(255,255,255,.3);font-style:normal">— Verified Google Review</div>
    </div>
  </div>
</div>
<section id="contact">
  <div class="cg">
    <div>
      <div class="stag">Get In Touch</div>
      <h2>Ready to get started?</h2>
      <div class="ii"><div class="ico">📍</div><div><div class="il">ADDRESS</div><div class="iv">${address}</div></div></div>
      <div class="ii"><div class="ico">📞</div><div><div class="il">PHONE</div><div class="iv">${phone || "Contact us"}</div></div></div>
      <div class="ii"><div class="ico">🕐</div><div><div class="il">HOURS</div><div class="iv">${hours}</div></div></div>
    </div>
    <form onsubmit="return false">
      <input type="text" placeholder="Your Name" required/>
      <input type="tel" placeholder="Your Phone Number"/>
      <input type="text" placeholder="${placeholder}"/>
      <textarea placeholder="Additional details..."></textarea>
      <button class="fsub" onclick="this.textContent='✅ Sent! We will be in touch soon.';this.style.background='#10b981'">Send Message</button>
    </form>
  </div>
</section>
<footer>© 2026 ${name} · All rights reserved</footer>
</body>
</html>`;
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

app.get("/", (_, res) => res.json({ ok: true, service: "SiteSprint Local API" }));

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
  const b = req.body;
  const r = await pool.query(
    `INSERT INTO businesses (name,address,phone,category,rating,review_count,hours,website,google_url,status,notes,area_searched)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [b.name,b.address||"",b.phone||"",b.category||"",b.rating||0,b.review_count||0,
     b.hours||"",b.website||"",b.google_url||"",b.status||"prospect",b.notes||"",b.area_searched||""]
  );
  res.status(201).json(r.rows[0]);
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

// ─── SEARCH (کاملاً دستی و بدون نیاز به کلید هوش مصنوعی) ───────────────────────
app.post("/api/search", async (req, res) => {
  const { area } = req.body;
  if (!area) return res.status(400).json({ error: "area required" });

  // این لیست نمونه به صورت کاملاً دستی و آفلاین بلافاصله لود می‌شود
  const localMockData = [
    { name: `${area} Auto Glass Repair`, address: `${area}, Main St`, phone: "555-0192", category: "Auto Repair", rating: 4.7, review_count: 124, hours: "Mon-Sat 8AM-6PM" },
    { name: "The Local Grill & Bistro", address: `${area}, Pizza Boulevard`, phone: "555-0234", category: "Restaurant", rating: 4.5, review_count: 88, hours: "Everyday 11AM-10PM" },
    { name: "Elegance Hair & Nail Salon", address: `${area}, Beauty Lane`, phone: "555-0781", category: "Salon", rating: 4.9, review_count: 210, hours: "Tue-Sun 9AM-7PM" },
    { name: "Apex Commercial Cleaning", address: `${area}, Business District`, phone: "555-0432", category: "Cleaning Service", rating: 4.2, review_count: 35, hours: "Mon-Fri 7AM-8PM" },
    { name: "Green Thumb Landscaping", address: `${area}, Garden Way`, phone: "555-0901", category: "Landscaping", rating: 4.6, review_count: 54, hours: "Mon-Fri 7AM-5PM" },
    { name: "Elite Math & Science Tutoring", address: `${area}, School St`, phone: "555-0654", category: "Tutoring", rating: 4.8, review_count: 67, hours: "Mon-Thu 3PM-8PM" },
    { name: "Downtown Dental Care", address: `${area}, Medical Hub`, phone: "555-0111", category: "Dentistry", rating: 4.4, review_count: 143, hours: "Mon-Fri 8AM-5PM" },
    { name: "Express Plumbing Experts", address: `${area}, Water St`, phone: "555-0555", category: "Plumbing", rating: 4.3, review_count: 92, hours: "24/7 Available" },
    { name: "Comfort First HVAC Contractors", address: `${area}, Airflow Ave`, phone: "555-0888", category: "HVAC Repair", rating: 4.7, review_count: 115, hours: "Mon-Sat 8AM-6PM" },
    { name: "Oriental Rug Restoration", address: `${area}, Luxury Row`, phone: "555-0333", category: "Rug Repair & Retail", rating: 5.0, review_count: 42, hours: "Mon-Sat 10AM-6PM" }
  ];

  res.json(localMockData);
});

app.post("/api/generate/:id", async (req, res) => {
  const { id } = req.params;
  const biz = await pool.query("SELECT * FROM businesses WHERE id=$1", [id]);
  if (!biz.rows.length) return res.status(404).json({ error: "Not found" });

  const html = generateHTML(biz.rows[0]);
  const slug = `${id}-${Date.now()}`;

  await pool.query(
    `INSERT INTO generated_sites (business_id, slug, html)
     VALUES ($1,$2,$3)
     ON CONFLICT (slug) DO UPDATE SET html=EXCLUDED.html`,
    [id, slug, html]
  );

  await pool.query("UPDATE businesses SET preview_slug=$1 WHERE id=$2", [slug, id]);

  const previewUrl = `${process.env.BASE_URL || ""}/preview/${slug}`;
  res.json({ url: previewUrl, slug });
});

app.get("/preview/:slug", async (req, res) => {
  const r = await pool.query("SELECT html FROM generated_sites WHERE slug=$1", [req.params.slug]);
  if (!r.rows.length) return res.status(404).send("Site not found");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(r.rows[0].html);
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 SiteSprint Local API running on port ${PORT}`));
});