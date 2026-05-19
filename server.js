require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});
app.use(cors({ origin: "*" }));
app.use(express.json());
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });

async function initDB() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS businesses (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, address TEXT DEFAULT '',
      phone TEXT DEFAULT '', category TEXT DEFAULT '', rating NUMERIC(2,1) DEFAULT 0,
      review_count INT DEFAULT 0, hours TEXT DEFAULT '', website TEXT DEFAULT '',
      google_url TEXT DEFAULT '', status TEXT DEFAULT 'prospect', notes TEXT DEFAULT '',
      area_searched TEXT DEFAULT '', preview_slug TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());`);
    await pool.query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS preview_slug TEXT DEFAULT '';`);
    await pool.query(`CREATE TABLE IF NOT EXISTS generated_sites (
      id SERIAL PRIMARY KEY, business_id INT REFERENCES businesses(id) ON DELETE CASCADE,
      slug TEXT UNIQUE NOT NULL, html TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW());`);
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
    return { bg:"#0a0005", card:"#160a10", primary:"#D4888A", accent:"#F2C4C6", text:"#f5eaea", muted:"#b89898", glow:"212,136,138" };
  if (cat.includes("dental") || cat.includes("dentist"))
    return { bg:"#00040f", card:"#041020", primary:"#22C5E8", accent:"#7DDFEF", text:"#e8f6ff", muted:"#8ab8cc", glow:"34,197,232" };
  if (cat.includes("auto") || cat.includes("repair") || cat.includes("mechanic"))
    return { bg:"#080500", card:"#120c02", primary:"#F59E0B", accent:"#FCD34D", text:"#fff8e8", muted:"#c4a862", glow:"245,158,11" };
  if (cat.includes("rest") || cat.includes("food") || cat.includes("cafe") || cat.includes("bistro"))
    return { bg:"#080200", card:"#140800", primary:"#E8734A", accent:"#F4A57A", text:"#fff5f0", muted:"#c4926e", glow:"232,115,74" };
  if (cat.includes("gym") || cat.includes("fitness"))
    return { bg:"#050010", card:"#0d0520", primary:"#EC4899", accent:"#F472B6", text:"#fff0f8", muted:"#b878a0", glow:"236,72,153" };
  if (cat.includes("clean") || cat.includes("hvac") || cat.includes("plumb"))
    return { bg:"#000f08", card:"#041c10", primary:"#10B981", accent:"#6EE7B7", text:"#edfff6", muted:"#7ab898", glow:"16,185,129" };
  return { bg:"#050514", card:"#0d0d24", primary:"#6366F1", accent:"#A5B4FC", text:"#f0f0ff", muted:"#9090c0", glow:"99,102,241" };
}

function getFakeReviews(category) {
  const cat = (category || "").toLowerCase();
  if (cat.includes("salon") || cat.includes("beauty") || cat.includes("hair")) return [
    { name:"Sarah M.", avatar:"SM", text:"Absolutely incredible. My hair has never looked better — they truly listen to what you want." },
    { name:"Jessica R.", avatar:"JR", text:"Been coming here 2 years and I wouldn't trust anyone else. Pure talent every single time." },
    { name:"Amanda K.", avatar:"AK", text:"Walked in stressed, walked out feeling like a queen. The atmosphere alone is worth 5 stars." },
  ];
  if (cat.includes("dental") || cat.includes("dentist")) return [
    { name:"Michael T.", avatar:"MT", text:"Best dental experience I've ever had. Pain-free and professional — exactly what you want." },
    { name:"Linda P.", avatar:"LP", text:"My whole family comes here. The staff makes kids feel completely at ease. Highly recommend." },
    { name:"David S.", avatar:"DS", text:"They transformed my smile in just a few visits. Worth every penny and more." },
  ];
  if (cat.includes("auto") || cat.includes("repair") || cat.includes("mechanic")) return [
    { name:"James W.", avatar:"JW", text:"Honest, fast, and fairly priced. Fixed what two other shops couldn't figure out." },
    { name:"Robert C.", avatar:"RC", text:"These guys are the real deal. No upselling, just straight-up expert work on my car." },
    { name:"Tom B.", avatar:"TB", text:"Had my car back same day. They communicated every step — this is how auto repair should be." },
  ];
  if (cat.includes("gym") || cat.includes("fitness")) return [
    { name:"Chris L.", avatar:"CL", text:"Best gym I've ever been to. The trainers actually care about your progress and push you." },
    { name:"Maria G.", avatar:"MG", text:"Clean, modern, great equipment and the community here is incredibly supportive." },
    { name:"Kevin P.", avatar:"KP", text:"Lost 30 pounds in 4 months with their program. Couldn't be happier with the results." },
  ];
  return [
    { name:"Chris L.", avatar:"CL", text:"Exceptional service from start to finish. I wouldn't go anywhere else — they truly care." },
    { name:"Maria G.", avatar:"MG", text:"Professional, friendly, and the quality of work is outstanding. Highly recommend." },
    { name:"Kevin P.", avatar:"KP", text:"Reliable, affordable, and they always deliver beyond expectations. 10/10." },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE: Build the CSS + skeleton in Node.js — Claude ONLY writes the content
// ─────────────────────────────────────────────────────────────────────────────
function buildCSS(c) {
  return `<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{background:${c.bg};color:${c.text};font-family:'Inter',sans-serif;overflow-x:hidden;line-height:1.6}
a{text-decoration:none;color:inherit}
::selection{background:${c.primary};color:#000}
::-webkit-scrollbar{width:5px}
::-webkit-scrollbar-track{background:${c.bg}}
::-webkit-scrollbar-thumb{background:${c.primary};border-radius:3px}

/* NAV */
nav{position:fixed;top:0;left:0;right:0;z-index:1000;display:flex;align-items:center;justify-content:space-between;padding:22px 6%;transition:all .4s}
nav.scrolled{background:rgba(0,0,0,0.93);backdrop-filter:blur(20px);padding:14px 6%;border-bottom:1px solid rgba(${c.glow},.15)}
.nav-logo{display:flex;align-items:center;gap:12px;font-family:'Playfair Display',serif;font-size:1.2rem;font-weight:700}
.logo-icon{width:38px;height:38px;background:${c.primary};border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:1rem;color:#fff;flex-shrink:0}
.logo-txt em{color:${c.primary};font-style:normal}
.nav-links{display:flex;list-style:none;gap:36px}
.nav-links a{font-size:.82rem;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:rgba(255,255,255,.6);transition:color .3s}
.nav-links a:hover{color:${c.accent}}
.nav-btn{background:${c.primary};color:#fff;padding:11px 26px;border-radius:50px;font-size:.85rem;font-weight:700;letter-spacing:.5px;transition:all .3s;border:none;cursor:pointer;display:inline-block}
.nav-btn:hover{transform:translateY(-2px);box-shadow:0 8px 28px rgba(${c.glow},.4)}

/* HERO */
.hero{position:relative;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;overflow:hidden}
.hero-bg{position:absolute;inset:0;background-size:cover;background-position:center;transition:transform 8s ease;transform:scale(1.06)}
.hero:hover .hero-bg{transform:scale(1.0)}
.hero-ov{position:absolute;inset:0;background:linear-gradient(150deg,${c.bg}f0 0%,${c.bg}88 45%,${c.bg}dd 100%)}
.hero-body{position:relative;z-index:2;max-width:860px;padding:130px 24px 80px}
.h-badge{display:inline-flex;align-items:center;gap:10px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.17);backdrop-filter:blur(10px);border-radius:100px;padding:10px 24px;font-size:.83rem;font-weight:600;margin-bottom:28px}
.h-badge .stars{color:#FFD700}
.h-eye{color:${c.accent};font-size:.72rem;font-weight:700;letter-spacing:5px;text-transform:uppercase;margin-bottom:18px}
.hero h1{font-family:'Playfair Display',serif;font-size:clamp(2.8rem,6.5vw,5.2rem);font-weight:900;line-height:1.08;margin-bottom:24px}
.hero h1 .hl{color:${c.primary};font-style:italic}
.hero-sub{font-size:1.05rem;color:${c.muted};max-width:520px;margin:0 auto 44px;font-weight:300}
.hero-btns{display:flex;gap:16px;justify-content:center;flex-wrap:wrap}
.btn-p{display:inline-flex;align-items:center;gap:10px;background:${c.primary};color:#fff;padding:15px 38px;border-radius:50px;font-weight:700;font-size:.97rem;border:none;cursor:pointer;transition:all .35s}
.btn-p:hover{transform:translateY(-3px);box-shadow:0 16px 44px rgba(${c.glow},.45)}
.btn-g{display:inline-flex;align-items:center;gap:10px;background:rgba(255,255,255,.05);color:${c.text};padding:15px 38px;border-radius:50px;font-weight:600;font-size:.97rem;border:1px solid rgba(255,255,255,.2);cursor:pointer;transition:all .35s;backdrop-filter:blur(8px)}
.btn-g:hover{border-color:${c.primary};color:${c.primary};transform:translateY(-3px)}
.scroll-cue{position:absolute;bottom:32px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:6px;font-size:.68rem;letter-spacing:3px;text-transform:uppercase;color:${c.muted}}

/* STATS */
.stats{padding:52px 6%;background:rgba(255,255,255,.022);border-top:1px solid rgba(${c.glow},.1);border-bottom:1px solid rgba(${c.glow},.1)}
.stats-g{display:grid;grid-template-columns:repeat(4,1fr);gap:32px;max-width:900px;margin:0 auto;text-align:center}
.s-num{font-family:'Playfair Display',serif;font-size:2.8rem;font-weight:900;background:linear-gradient(135deg,${c.primary},${c.accent});-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;line-height:1}
.s-lbl{font-size:.72rem;letter-spacing:3px;text-transform:uppercase;color:${c.muted};margin-top:8px}

/* SERVICES */
.sec{padding:100px 6%}
.sec-hd{text-align:center;margin-bottom:68px}
.eyebrow{color:${c.accent};font-size:.72rem;font-weight:700;letter-spacing:5px;text-transform:uppercase;display:block;margin-bottom:14px}
.sec-title{font-family:'Playfair Display',serif;font-size:clamp(2rem,4vw,3rem);font-weight:900;line-height:1.15;margin-bottom:14px}
.sec-sub{color:${c.muted};font-size:.97rem;max-width:500px;margin:0 auto;font-weight:300}
.svc-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:2px;background:rgba(${c.glow},.1);border:1px solid rgba(${c.glow},.12);border-radius:20px;overflow:hidden}
.svc-card{background:${c.card};padding:44px 34px;position:relative;overflow:hidden;transition:all .4s}
.svc-card::after{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,transparent,${c.primary},transparent);transform:scaleX(0);transition:transform .5s}
.svc-card:hover::after{transform:scaleX(1)}
.svc-card:hover{background:rgba(${c.glow},.04)}
.svc-n{font-family:'Playfair Display',serif;font-size:4rem;font-weight:900;color:${c.primary};opacity:.08;position:absolute;top:16px;right:24px;line-height:1}
.svc-ic{width:54px;height:54px;background:rgba(${c.glow},.1);border:1px solid rgba(${c.glow},.2);border-radius:14px;display:flex;align-items:center;justify-content:center;margin-bottom:22px;transition:all .4s}
.svc-card:hover .svc-ic{background:rgba(${c.glow},.2);box-shadow:0 0 20px rgba(${c.glow},.25)}
.svc-ic i{font-size:1.35rem;color:${c.primary}}
.svc-card h3{font-family:'Playfair Display',serif;font-size:1.2rem;font-weight:700;margin-bottom:10px}
.svc-card p{font-size:.88rem;color:${c.muted};line-height:1.8}

/* GALLERY */
.gal-sec{padding:100px 6%;background:${c.card}}
.gal-grid{display:grid;grid-template-columns:2fr 1fr 1fr;grid-template-rows:240px 240px;gap:14px;margin-top:64px}
.g-it{border-radius:16px;overflow:hidden;position:relative;cursor:pointer}
.g-it:first-child{grid-row:1/3}
.g-bg{width:100%;height:100%;background-size:cover;background-position:center;transition:transform .6s}
.g-it:hover .g-bg{transform:scale(1.08)}
.g-ov{position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,.75) 0%,transparent 55%);opacity:0;transition:opacity .4s;display:flex;align-items:flex-end;padding:20px}
.g-it:hover .g-ov{opacity:1}
.g-lbl{font-family:'Playfair Display',serif;font-size:.97rem;font-weight:700;color:#fff}

/* REVIEWS */
.rev-sec{padding:100px 6%}
.rev-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:22px;margin-top:64px}
.rev-card{background:${c.card};border:1px solid rgba(${c.glow},.1);border-radius:20px;padding:34px;transition:all .4s}
.rev-card:hover{border-color:rgba(${c.glow},.3);transform:translateY(-6px);box-shadow:0 20px 60px rgba(0,0,0,.4)}
.rev-q{font-size:3.5rem;color:${c.primary};opacity:.15;line-height:1;font-family:'Playfair Display',serif;margin-bottom:4px}
.rev-stars{color:#FFD700;font-size:.8rem;letter-spacing:2px;margin-bottom:14px}
.rev-txt{font-size:.9rem;color:${c.muted};line-height:1.85;font-style:italic;margin-bottom:26px}
.rev-who{display:flex;align-items:center;gap:12px}
.rev-av{width:42px;height:42px;border-radius:50%;background:rgba(${c.glow},.15);border:2px solid rgba(${c.glow},.3);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:.78rem;color:${c.primary};flex-shrink:0}
.rev-name{font-weight:700;font-size:.88rem}
.rev-tag{font-size:.72rem;color:${c.muted}}

/* CONTACT */
.con-sec{padding:100px 6%;background:${c.card}}
.con-in{display:grid;grid-template-columns:1fr 1.4fr;gap:72px;max-width:1080px;margin:64px auto 0;align-items:start}
.con-lft h3{font-family:'Playfair Display',serif;font-size:1.7rem;font-weight:700;margin-bottom:10px}
.con-lft p{color:${c.muted};font-size:.92rem;margin-bottom:44px;line-height:1.8}
.c-row{display:flex;align-items:flex-start;gap:16px;margin-bottom:28px}
.c-ico{width:48px;height:48px;min-width:48px;background:rgba(${c.glow},.1);border:1px solid rgba(${c.glow},.2);border-radius:12px;display:flex;align-items:center;justify-content:center;transition:all .3s}
.c-row:hover .c-ico{background:rgba(${c.glow},.2);box-shadow:0 0 18px rgba(${c.glow},.2)}
.c-ico i{color:${c.primary};font-size:.95rem}
.c-lbl{font-size:.68rem;letter-spacing:3px;text-transform:uppercase;color:${c.muted};margin-bottom:4px}
.c-val{font-weight:600;font-size:.97rem}
.con-form{background:${c.bg};border:1px solid rgba(${c.glow},.12);border-radius:22px;padding:44px 40px}
.f-row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.f-g{margin-bottom:18px}
.f-lbl{display:block;font-size:.68rem;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:${c.muted};margin-bottom:8px}
.f-in{width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.09);border-radius:11px;padding:14px 16px;color:${c.text};font-size:.95rem;font-family:'Inter',sans-serif;transition:all .3s;outline:none}
.f-in:focus{border-color:${c.primary};background:rgba(${c.glow},.05);box-shadow:0 0 0 3px rgba(${c.glow},.1)}
.f-in::placeholder{color:rgba(255,255,255,.22)}
textarea.f-in{min-height:120px;resize:vertical}
.f-btn{width:100%;padding:16px;font-size:.97rem;font-weight:700;letter-spacing:.5px;margin-top:6px;font-family:'Inter',sans-serif}

/* FOOTER */
footer{padding:68px 6% 36px;border-top:1px solid rgba(${c.glow},.1);text-align:center}
.ft-logo{display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:14px}
.ft-ic{width:42px;height:42px;background:${c.primary};border-radius:11px;display:flex;align-items:center;justify-content:center;font-family:'Playfair Display',serif;font-weight:900;font-size:1rem;color:#fff}
.ft-name{font-family:'Playfair Display',serif;font-size:1.4rem;font-weight:700;color:${c.primary}}
.ft-tag{color:${c.muted};font-size:.88rem;margin-bottom:36px}
.ft-links{display:flex;gap:28px;justify-content:center;list-style:none;margin-bottom:36px}
.ft-links a{font-size:.75rem;letter-spacing:1.5px;text-transform:uppercase;color:${c.muted};transition:color .3s}
.ft-links a:hover{color:${c.accent}}
.ft-copy{color:rgba(255,255,255,.18);font-size:.75rem}

/* ANIMATIONS */
@keyframes fadeUp{from{opacity:0;transform:translateY(30px)}to{opacity:1;transform:translateY(0)}}
@keyframes bounce{0%,100%{transform:translateX(-50%) translateY(0)}50%{transform:translateX(-50%) translateY(-7px)}}
.anim{opacity:0;transform:translateY(26px);transition:opacity .7s ease,transform .7s ease}
.anim.in{opacity:1;transform:translateY(0)}
.d1{transition-delay:.1s}.d2{transition-delay:.2s}.d3{transition-delay:.3s}
.hero-body *{animation:fadeUp .8s ease both}
.h-badge{animation-delay:.0s!important}
.h-eye{animation-delay:.1s!important}
.hero h1{animation-delay:.2s!important}
.hero-sub{animation-delay:.3s!important}
.hero-btns{animation-delay:.4s!important}
.scroll-cue{animation:bounce 2.5s infinite}

@media(max-width:900px){
  .nav-links{display:none}
  .stats-g{grid-template-columns:repeat(2,1fr)}
  .svc-grid{grid-template-columns:1fr}
  .gal-grid{grid-template-columns:1fr;grid-template-rows:auto}
  .g-it:first-child{grid-row:auto}
  .g-it{height:220px}
  .rev-grid{grid-template-columns:1fr}
  .con-in{grid-template-columns:1fr;gap:44px}
  .f-row{grid-template-columns:1fr}
}
</style>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude writes ONLY the content — short focused prompt
// ─────────────────────────────────────────────────────────────────────────────
async function getContent(biz, c) {
  const letter = (biz.name || "B")[0].toUpperCase();
  const prompt = `You are writing content for a premium landing page.
Business: "${biz.name}" | Type: ${biz.category} | Rating: ${biz.rating}★ (${biz.review_count} reviews)
Primary color: ${c.primary}

Return ONLY a valid JSON object (no markdown, no backticks) with these exact keys:

{
  "heroTag": "City name · Premium [category] · Est. 2018",
  "heroH1Part1": "First part of headline (3-4 words)",
  "heroH1Highlight": "highlighted italic phrase (2-3 words)",
  "heroH1Part2": "ending of headline (optional, 1-3 words or empty string)",
  "heroSub": "One compelling sentence, max 18 words",
  "heroCTA": "Primary button text (2-3 words)",
  "stat1num": "500+", "stat1lbl": "Happy Clients",
  "stat2num": "${biz.rating}★", "stat2lbl": "Average Rating",
  "stat3num": "12+", "stat3lbl": "Years Experience",
  "stat4num": "100%", "stat4lbl": "Satisfaction Rate",
  "svcTitle": "Services section heading (4-6 words)",
  "svc1icon": "fa-solid fa-[relevant icon name]", "svc1name": "Service name", "svc1desc": "One sentence description",
  "svc2icon": "fa-solid fa-[relevant icon name]", "svc2name": "Service name", "svc2desc": "One sentence description",
  "svc3icon": "fa-solid fa-[relevant icon name]", "svc3name": "Service name", "svc3desc": "One sentence description",
  "galTitle": "Gallery heading (3-5 words)",
  "galSub": "One sentence about work quality",
  "gal1lbl": "Gallery label 1", "gal2lbl": "Gallery label 2", "gal3lbl": "Gallery label 3", "gal4lbl": "Gallery label 4",
  "footerTagline": "Short inspirational tagline (5-8 words)"
}`;

  const r = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 900,
    messages: [{ role: "user", content: prompt }],
  });

  let raw = r.content[0].text.trim().replace(/^```json?\n?/,"").replace(/^```\n?/,"").replace(/```$/,"");
  return JSON.parse(raw);
}

// ─────────────────────────────────────────────────────────────────────────────
// BUILD THE FULL HTML IN NODE.JS using content from Claude
// ─────────────────────────────────────────────────────────────────────────────
async function generateSite(biz) {
  const imgs = getImages(biz.category);
  const c = getPalette(biz.category);
  const reviews = getFakeReviews(biz.category);
  const letter = (biz.name || "B")[0].toUpperCase();

  console.log(`🎨 Getting content for "${biz.name}"...`);
  let ct;
  try {
    ct = await getContent(biz, c);
  } catch(e) {
    console.error("Content JSON parse failed:", e.message);
    ct = {
      heroTag: `Premium ${biz.category}`,
      heroH1Part1: "Excellence You Can", heroH1Highlight: "Trust", heroH1Part2: "",
      heroSub: `${biz.name} delivers world-class ${biz.category} services with unmatched quality.`,
      heroCTA: "Book Now",
      stat1num:"500+", stat1lbl:"Happy Clients", stat2num:`${biz.rating}★`, stat2lbl:"Rating",
      stat3num:"12+", stat3lbl:"Years Experience", stat4num:"100%", stat4lbl:"Satisfaction",
      svcTitle: "Our Premium Services",
      svc1icon:"fa-solid fa-star", svc1name:"Premium Service", svc1desc:"Top quality service delivered with care and expertise.",
      svc2icon:"fa-solid fa-shield", svc2name:"Expert Care", svc2desc:"Professional team dedicated to your satisfaction.",
      svc3icon:"fa-solid fa-thumbs-up", svc3name:"Guaranteed Results", svc3desc:"We stand behind everything we do.",
      galTitle:"Our Work Speaks", galSub:"Real results from real clients.",
      gal1lbl:"Featured Work", gal2lbl:"Our Process", gal3lbl:"Results", gal4lbl:"Behind the Scenes",
      footerTagline:"Quality. Excellence. Trust."
    };
  }

  const reviewsHTML = reviews.map(r => `
    <div class="rev-card anim">
      <div class="rev-q">"</div>
      <div class="rev-stars">★★★★★</div>
      <p class="rev-txt">${r.text}</p>
      <div class="rev-who">
        <div class="rev-av">${r.avatar}</div>
        <div><div class="rev-name">${r.name}</div><div class="rev-tag">Verified Customer</div></div>
      </div>
    </div>`).join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${biz.name} — Official Site</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;0,900;1,700&family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
${buildCSS(c)}
</head>
<body>

<nav id="nav">
  <div class="nav-logo">
    <div class="logo-icon">${letter}</div>
    <div class="logo-txt"><em>${biz.name.split(" ")[0]}</em> ${biz.name.split(" ").slice(1).join(" ")}</div>
  </div>
  <ul class="nav-links">
    <li><a href="#services">Services</a></li>
    <li><a href="#gallery">Gallery</a></li>
    <li><a href="#reviews">Reviews</a></li>
    <li><a href="#contact">Contact</a></li>
  </ul>
  <a href="#contact" class="nav-btn">Book Now</a>
</nav>

<section class="hero">
  <div class="hero-bg" style="background-image:url('${imgs[0]}')"></div>
  <div class="hero-ov"></div>
  <div class="hero-body">
    <div class="h-badge"><span class="stars">★★★★★</span><span>${biz.rating} · ${biz.review_count} Verified Reviews</span></div>
    <p class="h-eye">${ct.heroTag}</p>
    <h1>${ct.heroH1Part1} <span class="hl">${ct.heroH1Highlight}</span>${ct.heroH1Part2 ? " " + ct.heroH1Part2 : ""}</h1>
    <p class="hero-sub">${ct.heroSub}</p>
    <div class="hero-btns">
      <a href="#contact" class="btn-p"><i class="fas fa-calendar-check"></i> ${ct.heroCTA}</a>
      <a href="#services" class="btn-g"><i class="fas fa-arrow-right"></i> Our Services</a>
    </div>
  </div>
  <div class="scroll-cue"><i class="fas fa-chevron-down"></i><span>Scroll</span></div>
</section>

<section class="stats">
  <div class="stats-g">
    <div><div class="s-num">${ct.stat1num}</div><div class="s-lbl">${ct.stat1lbl}</div></div>
    <div><div class="s-num">${ct.stat2num}</div><div class="s-lbl">${ct.stat2lbl}</div></div>
    <div><div class="s-num">${ct.stat3num}</div><div class="s-lbl">${ct.stat3lbl}</div></div>
    <div><div class="s-num">${ct.stat4num}</div><div class="s-lbl">${ct.stat4lbl}</div></div>
  </div>
</section>

<section class="sec" id="services">
  <div class="sec-hd">
    <span class="eyebrow">What We Offer</span>
    <h2 class="sec-title">${ct.svcTitle}</h2>
    <p class="sec-sub">Premium quality with every service, guaranteed.</p>
  </div>
  <div class="svc-grid">
    <div class="svc-card anim">
      <div class="svc-n">01</div>
      <div class="svc-ic"><i class="${ct.svc1icon}"></i></div>
      <h3>${ct.svc1name}</h3>
      <p>${ct.svc1desc}</p>
    </div>
    <div class="svc-card anim d1">
      <div class="svc-n">02</div>
      <div class="svc-ic"><i class="${ct.svc2icon}"></i></div>
      <h3>${ct.svc2name}</h3>
      <p>${ct.svc2desc}</p>
    </div>
    <div class="svc-card anim d2">
      <div class="svc-n">03</div>
      <div class="svc-ic"><i class="${ct.svc3icon}"></i></div>
      <h3>${ct.svc3name}</h3>
      <p>${ct.svc3desc}</p>
    </div>
  </div>
</section>

<section class="gal-sec" id="gallery">
  <div class="sec-hd">
    <span class="eyebrow">Our Work</span>
    <h2 class="sec-title">${ct.galTitle}</h2>
    <p class="sec-sub">${ct.galSub}</p>
  </div>
  <div class="gal-grid">
    <div class="g-it anim">
      <div class="g-bg" style="background-image:url('${imgs[2]}')"></div>
      <div class="g-ov"><span class="g-lbl">${ct.gal1lbl}</span></div>
    </div>
    <div class="g-it anim d1">
      <div class="g-bg" style="background-image:url('${imgs[3]}')"></div>
      <div class="g-ov"><span class="g-lbl">${ct.gal2lbl}</span></div>
    </div>
    <div class="g-it anim d2">
      <div class="g-bg" style="background-image:url('${imgs[4]}')"></div>
      <div class="g-ov"><span class="g-lbl">${ct.gal3lbl}</span></div>
    </div>
    <div class="g-it anim d1">
      <div class="g-bg" style="background-image:url('${imgs[1]}')"></div>
      <div class="g-ov"><span class="g-lbl">${ct.gal4lbl}</span></div>
    </div>
  </div>
</section>

<section class="rev-sec" id="reviews">
  <div class="sec-hd">
    <span class="eyebrow">Client Reviews</span>
    <h2 class="sec-title">What Our Clients Say</h2>
    <p class="sec-sub">Real reviews from verified customers who trust us.</p>
  </div>
  <div class="rev-grid">${reviewsHTML}</div>
</section>

<section class="con-sec" id="contact">
  <div class="sec-hd">
    <span class="eyebrow">Get In Touch</span>
    <h2 class="sec-title">Book Your Appointment</h2>
    <p class="sec-sub">Ready to get started? We'd love to hear from you.</p>
  </div>
  <div class="con-in">
    <div class="con-lft">
      <h3>Let's connect</h3>
      <p>Reach out and let our expert team take care of everything from start to finish.</p>
      <div class="c-row"><div class="c-ico"><i class="fas fa-phone"></i></div><div><p class="c-lbl">Phone</p><p class="c-val">${biz.phone || "Call us today"}</p></div></div>
      <div class="c-row"><div class="c-ico"><i class="fas fa-location-dot"></i></div><div><p class="c-lbl">Address</p><p class="c-val">${biz.address || "Visit our location"}</p></div></div>
      <div class="c-row"><div class="c-ico"><i class="fas fa-clock"></i></div><div><p class="c-lbl">Hours</p><p class="c-val">${biz.hours || "Mon-Sat 9AM-6PM"}</p></div></div>
    </div>
    <div class="con-form">
      <form onsubmit="handleForm(event)">
        <div class="f-row">
          <div class="f-g"><label class="f-lbl">First Name</label><input class="f-in" type="text" placeholder="John" required></div>
          <div class="f-g"><label class="f-lbl">Last Name</label><input class="f-in" type="text" placeholder="Smith" required></div>
        </div>
        <div class="f-row">
          <div class="f-g"><label class="f-lbl">Email</label><input class="f-in" type="email" placeholder="you@email.com" required></div>
          <div class="f-g"><label class="f-lbl">Phone</label><input class="f-in" type="tel" placeholder="(555) 000-0000"></div>
        </div>
        <div class="f-g"><label class="f-lbl">Message</label><textarea class="f-in" placeholder="How can we help you?"></textarea></div>
        <button type="submit" class="btn-p f-btn">Send Message &nbsp;<i class="fas fa-arrow-right"></i></button>
      </form>
    </div>
  </div>
</section>

<footer>
  <div class="ft-logo">
    <div class="ft-ic">${letter}</div>
    <div class="ft-name">${biz.name}</div>
  </div>
  <p class="ft-tag">${ct.footerTagline}</p>
  <ul class="ft-links">
    <li><a href="#services">Services</a></li>
    <li><a href="#gallery">Gallery</a></li>
    <li><a href="#reviews">Reviews</a></li>
    <li><a href="#contact">Contact</a></li>
  </ul>
  <p class="ft-copy">&copy; 2025 ${biz.name}. All rights reserved.</p>
</footer>

<script>
  window.addEventListener('scroll',()=>{ document.getElementById('nav').classList.toggle('scrolled',window.scrollY>70); });
  const io=new IntersectionObserver((es)=>{es.forEach(e=>{if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target);}});},{threshold:.12});
  document.querySelectorAll('.anim').forEach(el=>io.observe(el));
  function handleForm(e){
    e.preventDefault();
    const btn=e.target.querySelector('button[type=submit]');
    const orig=btn.innerHTML;
    btn.innerHTML='<i class="fas fa-check"></i> Message Sent!';
    btn.style.background='#22c55e';btn.disabled=true;
    setTimeout(()=>{btn.innerHTML=orig;btn.style.background='';btn.disabled=false;e.target.reset();},4000);
  }
  document.querySelectorAll('a[href^="#"]').forEach(a=>{
    a.addEventListener('click',e=>{const t=document.querySelector(a.getAttribute('href'));if(t){e.preventDefault();t.scrollIntoView({behavior:'smooth',block:'start'});}});
  });
</script>
</body>
</html>`;

  console.log(`✅ Site built — ${html.length} chars`);
  return html;
}

// ── ROUTES ────────────────────────────────────────────────────────────────────
app.get("/", (_, res) => res.json({ ok: true, service: "SiteSprint v5" }));

app.get("/api/businesses", async (req, res) => {
  try {
    const { status, q } = req.query;
    let sql = "SELECT * FROM businesses WHERE 1=1"; const params = [];
    if (status && status !== "all") { sql += ` AND status=$${params.length+1}`; params.push(status); }
    if (q) { sql += ` AND (name ILIKE $${params.length+1} OR category ILIKE $${params.length+2} OR address ILIKE $${params.length+3})`; params.push(`%${q}%`,`%${q}%`,`%${q}%`); }
    sql += " ORDER BY created_at DESC";
    res.json((await pool.query(sql, params)).rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/businesses", async (req, res) => {
  try {
    const b = req.body;
    const r = await pool.query(
      `INSERT INTO businesses (name,address,phone,category,rating,review_count,hours,website,google_url,status,area_searched) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [b.name,b.address||"",b.phone||"",b.category||"",b.rating||0,b.review_count||0,b.hours||"",b.website||"",b.google_url||"",b.status||"prospect",b.area_searched||""]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/api/businesses/:id", async (req, res) => {
  try {
    const { id } = req.params; const b = req.body;
    const allowed = ["name","address","phone","category","rating","review_count","hours","website","google_url","status","notes","preview_slug"];
    const sets = [], params = [];
    for (const col of allowed) { if (col in b) { sets.push(`${col}=$${params.length+1}`); params.push(b[col]); } }
    if (!sets.length) return res.json({ ok: true });
    sets.push("updated_at=NOW()"); params.push(id);
    await pool.query(`UPDATE businesses SET ${sets.join(",")} WHERE id=$${params.length}`, params);
    res.json((await pool.query("SELECT * FROM businesses WHERE id=$1", [id])).rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/businesses/:id", async (req, res) => {
  try { await pool.query("DELETE FROM businesses WHERE id=$1", [req.params.id]); res.json({ deleted: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/search", async (req, res) => {
  try {
    const { area } = req.body; if (!area) return res.status(400).json({ error: "area required" });
    const cats = [
      {cat:"Auto Repair",name:"Motors & Glass"},{cat:"Restaurant",name:"Grill & Bistro"},
      {cat:"Salon",name:"Beauty Studio"},{cat:"Plumbing",name:"Rooter Services"},
      {cat:"Dental",name:"Family Dentistry"},{cat:"Gym",name:"Fitness Center"},
      {cat:"Landscaping",name:"Lawn & Garden"},{cat:"Roofing",name:"Roofing Experts"},
      {cat:"Cafe",name:"Coffee Roasters"},{cat:"Cleaning",name:"Commercial Cleaners"}
    ];
    const results = [];
    for (let i = 1; i <= 20; i++) {
      const t = cats[i % cats.length];
      results.push({ id:1000+i, name:`${area} Elite ${t.name}`, address:`${100+i*15} Commerce Blvd, ${area}`,
        phone:`(555) 019-${(i*123).toString().padStart(4,"0")}`, category:t.cat,
        rating:parseFloat((4+Math.random()).toFixed(1)), review_count:Math.floor(Math.random()*400)+45,
        hours:"Mon-Sat 8AM - 6PM", area_searched:area });
    }
    res.json(results);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const generateHandler = async (req, res) => {
  try {
    const { id } = req.params;
    let bizResult = await pool.query("SELECT * FROM businesses WHERE id=$1", [id]);
    let biz;
    if (bizResult.rows.length) { biz = bizResult.rows[0]; }
    else {
      const b = req.body;
      biz = (await pool.query(
        `INSERT INTO businesses (name,address,phone,category,rating,review_count,hours,status,area_searched) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [b.name||"Business",b.address||"",b.phone||"",b.category||"",b.rating||5,b.review_count||50,b.hours||"","prospect",b.area_searched||""]
      )).rows[0];
    }
    const html = await generateSite(biz);
    const slug = `${biz.id}-${Date.now()}`;
    await pool.query(`INSERT INTO generated_sites (business_id,slug,html) VALUES ($1,$2,$3) ON CONFLICT (slug) DO UPDATE SET html=EXCLUDED.html`, [biz.id,slug,html]);
    await pool.query("UPDATE businesses SET preview_slug=$1,status='site shown',updated_at=NOW() WHERE id=$2", [slug,biz.id]);
    res.json({ url:`/preview/${slug}`, slug });
  } catch (err) { console.error("🔴 Generate error:", err); res.status(500).json({ error: err.message }); }
};

app.post("/api/generate/:id", generateHandler);
app.post("/generate/:id", generateHandler);

app.get("/preview/:slug", async (req, res) => {
  try {
    const r = await pool.query("SELECT html FROM generated_sites WHERE slug=$1", [req.params.slug]);
    if (!r.rows.length) return res.status(404).send("<h1>Not found</h1>");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(r.rows[0].html);
  } catch (err) { res.status(500).send(err.message); }
});

const PORT = process.env.PORT || 3001;
initDB().then(() => app.listen(PORT, () => console.log(`🚀 SiteSprint v5 on port ${PORT}`)));