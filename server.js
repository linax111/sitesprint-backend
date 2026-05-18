require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
const RAILWAY_URL = process.env.BASE_URL || "https://sitesprint-backend-production.up.railway.app";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

app.use(cors({ origin: "*" }));
app.use(express.json());

async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS businesses (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL, address TEXT DEFAULT '',
    phone TEXT DEFAULT '', category TEXT DEFAULT '', rating NUMERIC(2,1) DEFAULT 0,
    review_count INT DEFAULT 0, hours TEXT DEFAULT '', website TEXT DEFAULT '',
    google_url TEXT DEFAULT '', status TEXT DEFAULT 'prospect', notes TEXT DEFAULT '',
    area_searched TEXT DEFAULT '', preview_slug TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS generated_sites (
    id SERIAL PRIMARY KEY, business_id INT REFERENCES businesses(id) ON DELETE CASCADE,
    slug TEXT UNIQUE NOT NULL, html TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  console.log("DB ready");
}

async function generateHTML(biz) {
  const key = process.env.ANTHROPIC_KEY;
  if (!key) throw new Error("No ANTHROPIC_KEY set");
  const prompt = `Create a stunning modern single-page business website HTML for:
Name: ${biz.name}
Category: ${biz.category}
Address: ${biz.address}
Phone: ${biz.phone}
Rating: ${biz.rating} stars (${biz.review_count} reviews)
Hours: ${biz.hours}
Use dark modern design, Unsplash images, Google Fonts, FontAwesome via CDN.
Return ONLY raw HTML starting with <!DOCTYPE html>. No markdown, no explanation.`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-3-5-haiku-20241022", max_tokens: 4000, messages: [{ role: "user", content: prompt }] })
  });
  if (!resp.ok) throw new Error("API error: " + await resp.text());
  const data = await resp.json();
  let html = data.content[0].text.trim();
  return html.replace(/^```html\n?/, "").replace(/\n?```$/, "").trim();
}

app.get("/", (_, res) => res.json({ ok: true, service: "SiteSprint Backend" }));

app.post("/api/reset-db", async (req, res) => {
  try {
    await pool.query("DROP TABLE IF EXISTS generated_sites CASCADE");
    await pool.query("DROP TABLE IF EXISTS businesses CASCADE");
    await initDB();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/businesses", async (req, res) => {
  try {
    const { status, q } = req.query;
    let sql = "SELECT * FROM businesses WHERE 1=1";
    const params = [];
    if (status && status !== "all") { sql += ` AND status=$${params.length+1}`; params.push(status); }
    if (q) { sql += ` AND (name ILIKE $${params.length+1} OR category ILIKE $${params.length+2})`; params.push(`%${q}%`,`%${q}%`); }
    sql += " ORDER BY created_at DESC";
    const r = await pool.query(sql, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/businesses", async (req, res) => {
  try {
    const b = req.body;
    const r = await pool.query(
      `INSERT INTO businesses (name,address,phone,category,rating,review_count,hours,website,google_url,status,area_searched)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [b.name,b.address||"",b.phone||"",b.category||"",b.rating||0,b.review_count||0,b.hours||"",b.website||"",b.google_url||"",b.status||"prospect",b.area_searched||""]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/businesses/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const b = req.body;
    const allowed = ["name","address","phone","category","rating","review_count","hours","website","google_url","status","notes","preview_slug"];
    const sets = [], params = [];
    for (const col of allowed) { if (col in b) { sets.push(`${col}=$${params.length+1}`); params.push(b[col]); } }
    if (!sets.length) return res.json({ ok: true });
    sets.push("updated_at=NOW()"); params.push(id);
    await pool.query(`UPDATE businesses SET ${sets.join(",")} WHERE id=$${params.length}`, params);
    const r = await pool.query("SELECT * FROM businesses WHERE id=$1", [id]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/businesses/:id", async (req, res) => {
  try { await pool.query("DELETE FROM businesses WHERE id=$1",[req.params.id]); res.json({deleted:true}); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/search", async (req, res) => {
  const { area } = req.body;
  if (!area) return res.status(400).json({ error: "area required" });
  res.json([
    { name: `${area} Auto Glass Repair`, address: `${area}, Main St`, phone: "555-0192", category: "Auto Repair", rating: 4.7, review_count: 124, hours: "Mon-Sat 8AM-6PM", area_searched: area },
    { name: "The Local Grill & Bistro", address: `${area}, Pizza Blvd`, phone: "555-0234", category: "Restaurant", rating: 4.5, review_count: 88, hours: "Everyday 11AM-10PM", area_searched: area },
    { name: "Elegance Hair & Nail Salon", address: `${area}, Beauty Lane`, phone: "555-0781", category: "Salon", rating: 4.9, review_count: 210, hours: "Tue-Sun 9AM-7PM", area_searched: area },
    { name: "Apex Commercial Cleaning", address: `${area}, Business District`, phone: "555-0432", category: "Cleaning Service", rating: 4.2, review_count: 35, hours: "Mon-Fri 7AM-8PM", area_searched: area },
    { name: "Green Thumb Landscaping", address: `${area}, Garden Way`, phone: "555-0901", category: "Landscaping", rating: 4.6, review_count: 54, hours: "Mon-Fri 7AM-5PM", area_searched: area }
  ]);
});

app.post("/api/generate/:id", async (req, res) => {
  try {
    const { id } = req.params;
    let result = await pool.query("SELECT * FROM businesses WHERE id=$1", [id]);
    if (!result.rows.length) {
      const b = req.body;
      result = await pool.query(
        `INSERT INTO businesses (name,address,phone,category,rating,review_count,hours,status,area_searched) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [b.name||"Business",b.address||"",b.phone||"",b.category||"",b.rating||5,b.review_count||0,b.hours||"","prospect",b.area_searched||""]
      );
    }
    const biz = result.rows[0];
    const html = await generateHTML(biz);
    const slug = `${biz.id}-${Date.now()}`;
    await pool.query(`INSERT INTO generated_sites (business_id,slug,html) VALUES ($1,$2,$3) ON CONFLICT (slug) DO UPDATE SET html=EXCLUDED.html`,[biz.id,slug,html]);
    await pool.query("UPDATE businesses SET preview_slug=$1 WHERE id=$2",[slug,biz.id]);
    res.json({ url: `${RAILWAY_URL}/preview/${slug}`, slug });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.get("/preview/:slug", async (req, res) => {
  try {
    const r = await pool.query("SELECT html FROM generated_sites WHERE slug=$1",[req.params.slug]);
    if (!r.rows.length) return res.status(404).send("Site not found");
    res.setHeader("Content-Type","text/html; charset=utf-8");
    res.send(r.rows[0].html);
  } catch (e) { res.status(500).send(e.message); }
});

const PORT = process.env.PORT || 3001;
pool.query("SELECT 1").then(() => {
  initDB().then(() => app.listen(PORT, () => console.log(`Server on port ${PORT}`)));
}).catch(e => { console.error(e); process.exit(1); });