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
  if (cat.includes("clean") || cat.includes("hvac") || cat.includes("plumb")) return [
    "https://images.unsplash.com/photo-1581578731548-c64695cc6952?w=1600&q=80",
    "https://images.unsplash.com/photo-1621905252507-b35492cc74b4?w=800&q=80",
    "https://images.unsplash.com/photo-1527515637-6742562d5395?w=800&q=80",
    "https://images.unsplash.com/photo-1584622650111-993a426fbf0a?w=800&q=80",
    "https://images.unsplash.com/photo-1545205597-3d9d02c29597?w=800&q=80",
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
    return { bg: "#0a0005", card: "#160a10", primary: "#D4888A", accent: "#F2C4C6", text: "#f5eaea", muted: "#b89898", border: "rgba(212,136,138,0.15)", glow: "212,136,138" };
  if (cat.includes("dental") || cat.includes("dentist"))
    return { bg: "#00040f", card: "#041020", primary: "#22C5E8", accent: "#7DDFEF", text: "#e8f6ff", muted: "#8ab8cc", border: "rgba(34,197,232,0.15)", glow: "34,197,232" };
  if (cat.includes("auto") || cat.includes("repair") || cat.includes("mechanic"))
    return { bg: "#080500", card: "#120c02", primary: "#F59E0B", accent: "#FCD34D", text: "#fff8e8", muted: "#c4a862", border: "rgba(245,158,11,0.15)", glow: "245,158,11" };
  if (cat.includes("rest") || cat.includes("food") || cat.includes("cafe") || cat.includes("bistro"))
    return { bg: "#080200", card: "#140800", primary: "#E8734A", accent: "#F4A57A", text: "#fff5f0", muted: "#c4926e", border: "rgba(232,115,74,0.15)", glow: "232,115,74" };
  if (cat.includes("gym") || cat.includes("fitness"))
    return { bg: "#050010", card: "#0d0520", primary: "#EC4899", accent: "#F472B6", text: "#fff0f8", muted: "#b878a0", border: "rgba(236,72,153,0.15)", glow: "236,72,153" };
  if (cat.includes("clean") || cat.includes("hvac") || cat.includes("plumb"))
    return { bg: "#000f08", card: "#041c10", primary: "#10B981", accent: "#6EE7B7", text: "#edfff6", muted: "#7ab898", border: "rgba(16,185,129,0.15)", glow: "16,185,129" };
  return { bg: "#050514", card: "#0d0d24", primary: "#6366F1", accent: "#A5B4FC", text: "#f0f0ff", muted: "#9090c0", border: "rgba(99,102,241,0.15)", glow: "99,102,241" };
}

// ── FAKE REVIEWS ──────────────────────────────────────────────────────────────
function getFakeReviews(category, bizName) {
  const reviews = {
    salon: [
      { name: "Sarah M.", rating: 5, text: "Absolutely incredible experience. My hair has never looked better — the team truly listens to what you want.", avatar: "SM" },
      { name: "Jessica R.", rating: 5, text: "I've been going here for 2 years and I wouldn't trust anyone else with my hair. Pure talent.", avatar: "JR" },
      { name: "Amanda K.", rating: 5, text: "Walked in stressed, walked out feeling like a queen. The atmosphere alone is worth 5 stars.", avatar: "AK" },
    ],
    dental: [
      { name: "Michael T.", rating: 5, text: "Best dental experience I've ever had. Pain-free and professional — exactly what you want from a dentist.", avatar: "MT" },
      { name: "Linda P.", rating: 5, text: "My whole family comes here. The staff makes kids feel completely at ease. Highly recommend.", avatar: "LP" },
      { name: "David S.", rating: 5, text: "They transformed my smile in just a few visits. Worth every penny and more.", avatar: "DS" },
    ],
    auto: [
      { name: "James W.", rating: 5, text: "Honest, fast, and fairly priced. They fixed what two other shops couldn't figure out.", avatar: "JW" },
      { name: "Robert C.", rating: 5, text: "These guys are the real deal. No upselling, just straight-up expert work on my car.", avatar: "RC" },
      { name: "Tom B.", rating: 5, text: "Had my car back same day. The team communicated every step — this is how auto repair should be.", avatar: "TB" },
    ],
    default: [
      { name: "Chris L.", rating: 5, text: "Exceptional service from start to finish. I wouldn't go anywhere else — these people truly care.", avatar: "CL" },
      { name: "Maria G.", rating: 5, text: "Professional, friendly, and the quality of work is outstanding. Highly recommend to everyone.", avatar: "MG" },
      { name: "Kevin P.", rating: 5, text: "Exactly what you want — reliable, affordable, and they always deliver beyond expectations.", avatar: "KP" },
    ],
  };
  const cat = (category || "").toLowerCase();
  if (cat.includes("salon") || cat.includes("beauty") || cat.includes("hair")) return reviews.salon;
  if (cat.includes("dental") || cat.includes("dentist")) return reviews.dental;
  if (cat.includes("auto") || cat.includes("repair") || cat.includes("mechanic")) return reviews.auto;
  return reviews.default;
}

// ── GENERATE SITE ─────────────────────────────────────────────────────────────
async function generateSite(biz) {
  const imgs = getImages(biz.category);
  const c = getPalette(biz.category);
  const reviews = getFakeReviews(biz.category, biz.name);

  const SYSTEM = `You are a world-class frontend engineer specializing in ultra-premium dark landing pages.
Output ONLY raw HTML — no markdown, no backticks, no comments, no explanation.
ALL CSS must be written inside <style> tags in the <head>.
Only allowed external resources: Google Fonts + Font Awesome 6 from cdnjs.cloudflare.com.
Never use Tailwind, Bootstrap, or any CSS framework CDN.
Write modern, rich CSS with animations, gradients, and micro-interactions.`;

  // PASS 1 — structure + all CSS + navbar + hero + stats + services
  const p1 = `Create the first half of an ultra-premium dark landing page.

BUSINESS: ${biz.name}
CATEGORY: ${biz.category}
RATING: ${biz.rating} (${biz.review_count} reviews)
PHONE: ${biz.phone || "Call us today"}
ADDRESS: ${biz.address || "Visit our location"}
HOURS: ${biz.hours || "Mon-Sat 9AM-6PM"}

EXACT COLORS:
--bg: ${c.bg}
--card: ${c.card}
--primary: ${c.primary}
--accent: ${c.accent}
--text: ${c.text}
--muted: ${c.muted}
--border: ${c.border}
--glow-rgb: ${c.glow}

OUTPUT SECTIONS IN ORDER — STOP after services </section>, do NOT write </body> or </html>:

══ SECTION 1: FULL <head> ══
Include:
- <!DOCTYPE html><html lang="en"><head>
- charset + viewport metas
- <title>${biz.name} — Official Site</title>
- Google Fonts: @import url for "Playfair Display" (weights 400,700,900) and "Inter" (weights 300,400,500,600,700)
- Font Awesome 6: <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
- Full <style> block with ALL CSS for the ENTIRE page:

/* BASE */
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{background:${c.bg};color:${c.text};font-family:'Inter',sans-serif;overflow-x:hidden;line-height:1.6}
a{text-decoration:none;color:inherit}
img{max-width:100%}
::selection{background:${c.primary};color:#000}
::-webkit-scrollbar{width:6px}
::-webkit-scrollbar-track{background:${c.bg}}
::-webkit-scrollbar-thumb{background:${c.primary};border-radius:3px}

/* NAV */
nav{position:fixed;top:0;left:0;right:0;z-index:1000;display:flex;align-items:center;justify-content:space-between;padding:22px 6%;transition:all .4s}
nav.scrolled{background:rgba(0,0,0,0.92);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);padding:14px 6%;border-bottom:1px solid ${c.border}}
.nav-logo{display:flex;align-items:center;gap:12px;font-family:'Playfair Display',serif;font-size:1.25rem;font-weight:700;color:${c.text}}
.nav-logo-icon{width:38px;height:38px;background:${c.primary};border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:1rem;color:#fff;font-family:'Playfair Display',serif;font-weight:900;flex-shrink:0}
.nav-logo span{color:${c.primary}}
.nav-links{display:flex;list-style:none;gap:36px}
.nav-links a{font-size:.88rem;font-weight:500;letter-spacing:.5px;color:rgba(255,255,255,.65);transition:color .3s;text-transform:uppercase}
.nav-links a:hover{color:${c.accent}}
.nav-cta{background:${c.primary};color:#fff;padding:11px 28px;border-radius:50px;font-size:.88rem;font-weight:700;letter-spacing:.5px;transition:all .3s;border:none;cursor:pointer}
.nav-cta:hover{transform:translateY(-2px);box-shadow:0 8px 28px rgba(${c.glow},.4);filter:brightness(1.1)}

/* HERO */
.hero{position:relative;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;overflow:hidden}
.hero-bg{position:absolute;inset:0;background-size:cover;background-position:center;transform:scale(1.05);transition:transform 8s ease;background-image:url('${imgs[0]}')}
.hero:hover .hero-bg{transform:scale(1.0)}
.hero-overlay{position:absolute;inset:0;background:linear-gradient(160deg,${c.bg}f2 0%,${c.bg}99 40%,${c.bg}cc 80%,${c.bg}f5 100%)}
.hero-content{position:relative;z-index:2;max-width:860px;padding:140px 20px 80px}
.hero-badge{display:inline-flex;align-items:center;gap:10px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.18);backdrop-filter:blur(10px);border-radius:100px;padding:10px 24px;font-size:.85rem;font-weight:600;margin-bottom:32px;animation:fadeUp .8s ease forwards}
.hero-badge .stars{color:#FFD700;letter-spacing:1px}
.hero-tag{color:${c.accent};font-size:.78rem;font-weight:700;letter-spacing:5px;text-transform:uppercase;margin-bottom:20px;animation:fadeUp .8s .1s ease both}
.hero h1{font-family:'Playfair Display',serif;font-size:clamp(3rem,7vw,5.5rem);font-weight:900;line-height:1.06;margin-bottom:26px;animation:fadeUp .8s .2s ease both}
.hero h1 .hl{color:${c.primary};font-style:italic}
.hero-sub{font-size:1.1rem;color:${c.muted};max-width:560px;margin:0 auto 48px;font-weight:300;animation:fadeUp .8s .3s ease both}
.hero-btns{display:flex;gap:16px;justify-content:center;flex-wrap:wrap;animation:fadeUp .8s .4s ease both}
.btn-main{display:inline-flex;align-items:center;gap:10px;background:${c.primary};color:#fff;padding:16px 40px;border-radius:50px;font-weight:700;font-size:1rem;border:none;cursor:pointer;transition:all .35s;letter-spacing:.3px}
.btn-main:hover{transform:translateY(-3px);box-shadow:0 16px 48px rgba(${c.glow},.45);filter:brightness(1.1)}
.btn-ghost{display:inline-flex;align-items:center;gap:10px;background:rgba(255,255,255,.05);color:${c.text};padding:16px 40px;border-radius:50px;font-weight:600;font-size:1rem;border:1px solid rgba(255,255,255,.2);cursor:pointer;transition:all .35s;backdrop-filter:blur(8px)}
.btn-ghost:hover{border-color:${c.primary};color:${c.primary};transform:translateY(-3px)}
.scroll-hint{position:absolute;bottom:36px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:8px;font-size:.75rem;letter-spacing:3px;text-transform:uppercase;color:${c.muted};animation:bounce 2s infinite}
.scroll-hint i{font-size:1rem}

/* STATS BAR */
.stats-bar{padding:56px 6%;background:rgba(255,255,255,.025);border-top:1px solid ${c.border};border-bottom:1px solid ${c.border}}
.stats-inner{max-width:960px;margin:0 auto;display:grid;grid-template-columns:repeat(4,1fr);gap:32px;text-align:center}
.stat-num{font-family:'Playfair Display',serif;font-size:3rem;font-weight:900;color:${c.primary};line-height:1;background:linear-gradient(135deg,${c.primary},${c.accent});-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.stat-label{font-size:.78rem;letter-spacing:3px;text-transform:uppercase;color:${c.muted};margin-top:8px}

/* SERVICES */
.section{padding:110px 6%}
.section-header{text-align:center;margin-bottom:72px}
.eyebrow{color:${c.accent};font-size:.75rem;font-weight:700;letter-spacing:5px;text-transform:uppercase;margin-bottom:16px;display:block}
.section-title{font-family:'Playfair Display',serif;font-size:clamp(2.2rem,4vw,3.2rem);font-weight:900;line-height:1.15;margin-bottom:16px}
.section-sub{color:${c.muted};font-size:1rem;max-width:520px;margin:0 auto;font-weight:300}
.services-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:2px;background:${c.border};border:1px solid ${c.border};border-radius:20px;overflow:hidden}
.svc-card{background:${c.card};padding:44px 36px;transition:all .4s;position:relative;overflow:hidden}
.svc-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,${c.primary},transparent);transform:scaleX(0);transition:transform .4s}
.svc-card:hover::before{transform:scaleX(1)}
.svc-card:hover{background:${c.bg};transform:translateY(-4px)}
.svc-num{font-family:'Playfair Display',serif;font-size:3.5rem;font-weight:900;color:${c.primary};opacity:.12;position:absolute;top:20px;right:28px;line-height:1}
.svc-icon-wrap{width:56px;height:56px;background:rgba(${c.glow},.12);border:1px solid rgba(${c.glow},.2);border-radius:14px;display:flex;align-items:center;justify-content:center;margin-bottom:24px;transition:all .4s}
.svc-card:hover .svc-icon-wrap{background:rgba(${c.glow},.2);box-shadow:0 0 24px rgba(${c.glow},.25)}
.svc-icon-wrap i{font-size:1.4rem;color:${c.primary}}
.svc-card h3{font-family:'Playfair Display',serif;font-size:1.3rem;font-weight:700;margin-bottom:12px}
.svc-card p{font-size:.92rem;color:${c.muted};line-height:1.8}

/* GALLERY */
.gallery-section{padding:110px 6%;background:${c.card}}
.gallery-grid{display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:280px 280px;gap:16px;margin-top:64px}
.g-item{border-radius:16px;overflow:hidden;position:relative;cursor:pointer}
.g-item:first-child{grid-row:1/3;grid-column:1/2}
.g-item-img{width:100%;height:100%;background-size:cover;background-position:center;transition:transform .6s ease}
.g-item:hover .g-item-img{transform:scale(1.08)}
.g-overlay{position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,.7) 0%,transparent 60%);opacity:0;transition:opacity .4s;display:flex;align-items:flex-end;padding:24px}
.g-item:hover .g-overlay{opacity:1}
.g-label{font-family:'Playfair Display',serif;font-size:1rem;font-weight:700;color:#fff}

/* REVIEWS */
.reviews-section{padding:110px 6%}
.reviews-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;margin-top:64px}
.review-card{background:${c.card};border:1px solid ${c.border};border-radius:20px;padding:36px;position:relative;transition:all .4s}
.review-card:hover{border-color:rgba(${c.glow},.35);transform:translateY(-6px);box-shadow:0 20px 60px rgba(0,0,0,.4)}
.review-quote{font-size:3rem;color:${c.primary};opacity:.2;line-height:1;margin-bottom:12px;font-family:'Playfair Display',serif}
.review-text{font-size:.95rem;color:${c.muted};line-height:1.8;margin-bottom:28px;font-style:italic}
.review-stars{color:#FFD700;font-size:.85rem;letter-spacing:2px;margin-bottom:16px}
.reviewer{display:flex;align-items:center;gap:14px}
.reviewer-avatar{width:44px;height:44px;border-radius:50%;background:rgba(${c.glow},.15);border:2px solid rgba(${c.glow},.3);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:.8rem;color:${c.primary};flex-shrink:0}
.reviewer-name{font-weight:700;font-size:.9rem}
.reviewer-tag{font-size:.75rem;color:${c.muted}}

/* CONTACT */
.contact-section{padding:110px 6%;background:${c.card}}
.contact-inner{display:grid;grid-template-columns:1fr 1.4fr;gap:80px;max-width:1100px;margin:64px auto 0;align-items:start}
.contact-info-block h3{font-family:'Playfair Display',serif;font-size:1.8rem;font-weight:700;margin-bottom:12px}
.contact-info-block p{color:${c.muted};font-size:.95rem;margin-bottom:48px;line-height:1.8}
.c-item{display:flex;align-items:flex-start;gap:18px;margin-bottom:32px}
.c-icon-box{width:50px;height:50px;min-width:50px;background:rgba(${c.glow},.1);border:1px solid rgba(${c.glow},.2);border-radius:14px;display:flex;align-items:center;justify-content:center;transition:all .3s}
.c-item:hover .c-icon-box{background:rgba(${c.glow},.2);box-shadow:0 0 20px rgba(${c.glow},.2)}
.c-icon-box i{color:${c.primary};font-size:1rem}
.c-label{font-size:.72rem;letter-spacing:3px;text-transform:uppercase;color:${c.muted};margin-bottom:5px}
.c-val{font-weight:600;font-size:1rem}
.contact-form-wrap{background:${c.bg};border:1px solid ${c.border};border-radius:24px;padding:48px 44px}
.f-row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.f-group{margin-bottom:20px}
.f-label{display:block;font-size:.72rem;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:${c.muted};margin-bottom:10px}
.f-input{width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:15px 18px;color:${c.text};font-size:.97rem;font-family:'Inter',sans-serif;transition:all .3s;outline:none}
.f-input:focus{border-color:${c.primary};background:rgba(${c.glow},.06);box-shadow:0 0 0 3px rgba(${c.glow},.12)}
.f-input::placeholder{color:rgba(255,255,255,.25)}
textarea.f-input{min-height:130px;resize:vertical}
.f-submit{width:100%;padding:17px;font-size:1rem;font-weight:700;letter-spacing:.5px;margin-top:8px;font-family:'Inter',sans-serif}

/* FOOTER */
footer{padding:72px 6% 40px;border-top:1px solid ${c.border};text-align:center}
.footer-logo-wrap{display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:16px}
.footer-icon{width:44px;height:44px;background:${c.primary};border-radius:12px;display:flex;align-items:center;justify-content:center;font-family:'Playfair Display',serif;font-weight:900;font-size:1.1rem;color:#fff}
.footer-brand{font-family:'Playfair Display',serif;font-size:1.5rem;font-weight:700;color:${c.primary}}
.footer-tagline{color:${c.muted};font-size:.9rem;margin-bottom:40px}
.footer-links{display:flex;gap:32px;justify-content:center;list-style:none;margin-bottom:40px}
.footer-links a{font-size:.82rem;letter-spacing:1px;color:${c.muted};text-transform:uppercase;transition:color .3s}
.footer-links a:hover{color:${c.accent}}
.footer-copy{color:rgba(255,255,255,.2);font-size:.78rem}

/* ANIMATIONS */
@keyframes fadeUp{from{opacity:0;transform:translateY(32px)}to{opacity:1;transform:translateY(0)}}
@keyframes bounce{0%,100%{transform:translateX(-50%) translateY(0)}50%{transform:translateX(-50%) translateY(-8px)}}
.reveal{opacity:0;transform:translateY(28px);transition:opacity .7s ease,transform .7s ease}
.reveal.visible{opacity:1;transform:translateY(0)}
.reveal-delay-1{transition-delay:.1s}
.reveal-delay-2{transition-delay:.2s}
.reveal-delay-3{transition-delay:.3s}

/* RESPONSIVE */
@media(max-width:900px){
  .nav-links{display:none}
  .stats-inner{grid-template-columns:repeat(2,1fr)}
  .services-grid{grid-template-columns:1fr}
  .gallery-grid{grid-template-columns:1fr;grid-template-rows:auto}
  .g-item:first-child{grid-row:auto;grid-column:auto}
  .reviews-grid{grid-template-columns:1fr}
  .contact-inner{grid-template-columns:1fr;gap:48px}
  .f-row{grid-template-columns:1fr}
}
</style>
</head>

══ SECTION 2: BODY + NAV ══
<body>
<nav id="topnav">
  <div class="nav-logo">
    <div class="nav-logo-icon">[First letter of business name]</div>
    <span>[First word of name] <span>[rest of name]</span></span>
  </div>
  <ul class="nav-links">
    <li><a href="#services">Services</a></li>
    <li><a href="#gallery">Gallery</a></li>
    <li><a href="#reviews">Reviews</a></li>
    <li><a href="#contact">Contact</a></li>
  </ul>
  <a href="#contact" class="nav-cta">Book Now</a>
</nav>

══ SECTION 3: HERO ══
<section class="hero">
  <div class="hero-bg"></div>
  <div class="hero-overlay"></div>
  <div class="hero-content">
    <div class="hero-badge">
      <span class="stars">★★★★★</span>
      <span>${biz.rating} · ${biz.review_count} Verified Reviews</span>
    </div>
    <p class="hero-tag">[City/Location] · Est. 2018</p>
    <h1>[Powerful headline for ${biz.category} — 3-5 words with <span class="hl">italic highlighted phrase</span>]</h1>
    <p class="hero-sub">[One compelling sentence describing the value of ${biz.name} — max 20 words]</p>
    <div class="hero-btns">
      <a href="#contact" class="btn-main"><i class="fas fa-calendar-check"></i> Book Appointment</a>
      <a href="#services" class="btn-ghost"><i class="fas fa-arrow-right"></i> Explore Services</a>
    </div>
  </div>
  <div class="scroll-hint"><i class="fas fa-chevron-down"></i><span>Scroll</span></div>
</section>

══ SECTION 4: STATS BAR ══
<section class="stats-bar">
  <div class="stats-inner">
    [4 stats for ${biz.category}: e.g. "500+" clients, "${biz.rating}★" rating, "X" years, "100%" satisfaction — use stat-num + stat-label]
  </div>
</section>

══ SECTION 5: SERVICES ══
<section class="section" id="services">
  <div class="section-header">
    <span class="eyebrow">What We Offer</span>
    <h2 class="section-title">[Services heading for ${biz.category}]</h2>
    <p class="section-sub">[1 sentence describing service quality]</p>
  </div>
  <div class="services-grid">
    [3 .svc-card divs, each with: .svc-num (01/02/03), .svc-icon-wrap with relevant fas icon, h3 service name, p description — real services for ${biz.category}]
  </div>
</section>

STOP HERE. DO NOT write </body> or </html>.`;

  // PASS 2 — gallery + reviews + contact + footer + scripts
  const reviewsHTML = reviews.map(r => `
    <div class="review-card reveal">
      <div class="review-quote">"</div>
      <div class="review-stars">${'★'.repeat(r.rating)}</div>
      <p class="review-text">${r.text}</p>
      <div class="reviewer">
        <div class="reviewer-avatar">${r.avatar}</div>
        <div><div class="reviewer-name">${r.name}</div><div class="reviewer-tag">Verified Customer</div></div>
      </div>
    </div>`).join('');

  const p2 = `Continue the HTML for "${biz.name}". Start with the gallery section. End with </html>.

<section class="gallery-section" id="gallery">
  <div class="section-header">
    <span class="eyebrow">Our Work</span>
    <h2 class="section-title">[Gallery heading for ${biz.category}]</h2>
    <p class="section-sub">[1 sentence about the work quality]</p>
  </div>
  <div class="gallery-grid">
    <div class="g-item reveal">
      <div class="g-item-img" style="background-image:url('${imgs[2]}')"></div>
      <div class="g-overlay"><span class="g-label">[Label for ${biz.category} work 1]</span></div>
    </div>
    <div class="g-item reveal reveal-delay-1">
      <div class="g-item-img" style="background-image:url('${imgs[3]}')"></div>
      <div class="g-overlay"><span class="g-label">[Label for ${biz.category} work 2]</span></div>
    </div>
    <div class="g-item reveal reveal-delay-2">
      <div class="g-item-img" style="background-image:url('${imgs[4]}')"></div>
      <div class="g-overlay"><span class="g-label">[Label for ${biz.category} work 3]</span></div>
    </div>
    <div class="g-item reveal reveal-delay-1">
      <div class="g-item-img" style="background-image:url('${imgs[1]}')"></div>
      <div class="g-overlay"><span class="g-label">[Label for ${biz.category} work 4]</span></div>
    </div>
  </div>
</section>

<section class="reviews-section" id="reviews">
  <div class="section-header">
    <span class="eyebrow">Client Reviews</span>
    <h2 class="section-title">What Our Clients Say</h2>
    <p class="section-sub">Real reviews from real customers who trust us with what matters most.</p>
  </div>
  <div class="reviews-grid">
    ${reviewsHTML}
  </div>
</section>

<section class="contact-section" id="contact">
  <div class="section-header">
    <span class="eyebrow">Get In Touch</span>
    <h2 class="section-title">Book Your Appointment</h2>
    <p class="section-sub">Ready to experience the difference? We'd love to hear from you.</p>
  </div>
  <div class="contact-inner">
    <div class="contact-info-block">
      <h3>Let's connect</h3>
      <p>Reach out today and let our team take care of everything from start to finish.</p>
      <div class="c-item">
        <div class="c-icon-box"><i class="fas fa-phone"></i></div>
        <div><p class="c-label">Phone</p><p class="c-val">${biz.phone || "Call for pricing"}</p></div>
      </div>
      <div class="c-item">
        <div class="c-icon-box"><i class="fas fa-location-dot"></i></div>
        <div><p class="c-label">Address</p><p class="c-val">${biz.address || "Visit our location"}</p></div>
      </div>
      <div class="c-item">
        <div class="c-icon-box"><i class="fas fa-clock"></i></div>
        <div><p class="c-label">Hours</p><p class="c-val">${biz.hours || "Mon-Sat 9AM-6PM"}</p></div>
      </div>
    </div>
    <div class="contact-form-wrap">
      <form onsubmit="handleForm(event)">
        <div class="f-row">
          <div class="f-group"><label class="f-label">First Name</label><input class="f-input" type="text" placeholder="John" required></div>
          <div class="f-group"><label class="f-label">Last Name</label><input class="f-input" type="text" placeholder="Smith" required></div>
        </div>
        <div class="f-row">
          <div class="f-group"><label class="f-label">Email</label><input class="f-input" type="email" placeholder="you@email.com" required></div>
          <div class="f-group"><label class="f-label">Phone</label><input class="f-input" type="tel" placeholder="(555) 000-0000"></div>
        </div>
        <div class="f-group"><label class="f-label">Message</label><textarea class="f-input" placeholder="Tell us how we can help you..."></textarea></div>
        <button type="submit" class="btn-main f-submit">Send Message &nbsp;<i class="fas fa-arrow-right"></i></button>
      </form>
    </div>
  </div>
</section>

<footer>
  <div class="footer-logo-wrap">
    <div class="footer-icon">[First letter]</div>
    <div class="footer-brand">${biz.name}</div>
  </div>
  <p class="footer-tagline">[Short tagline for ${biz.category}]</p>
  <ul class="footer-links">
    <li><a href="#services">Services</a></li>
    <li><a href="#gallery">Gallery</a></li>
    <li><a href="#reviews">Reviews</a></li>
    <li><a href="#contact">Contact</a></li>
  </ul>
  <p class="footer-copy">&copy; 2025 ${biz.name}. All rights reserved. Premium website by SiteSprint.</p>
</footer>

<script>
  // Nav scroll effect
  window.addEventListener('scroll', () => {
    document.getElementById('topnav').classList.toggle('scrolled', window.scrollY > 80);
  });

  // Reveal on scroll
  const reveals = document.querySelectorAll('.reveal');
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => { if(e.isIntersecting) { e.target.classList.add('visible'); io.unobserve(e.target); } });
  }, { threshold: 0.12 });
  reveals.forEach(el => io.observe(el));

  // Form handler
  function handleForm(e) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    const orig = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-check"></i> Message Sent!';
    btn.style.background = '#22c55e';
    btn.disabled = true;
    setTimeout(() => { btn.innerHTML = orig; btn.style.background = ''; btn.disabled = false; e.target.reset(); }, 4000);
  }

  // Smooth scroll
  document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', e => {
      const target = document.querySelector(a.getAttribute('href'));
      if(target) { e.preventDefault(); target.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    });
  });
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
      max_tokens: 3000,
      system: SYSTEM,
      messages: [{ role: "user", content: p2 }],
    });
    let part2 = r2.content[0].text.trim().replace(/^```html?\n?/,"").replace(/^```\n?/,"").replace(/```$/,"");

    let html = part1 + "\n" + part2;
    if (!html.includes("</html>")) html += "\n</body>\n</html>";

    console.log(`✅ Done — ${html.length} chars`);
    return html;
  } catch (err) {
    console.error("🔴 Error:", err.message);
    return `<!DOCTYPE html><html><head><title>Error</title></head><body style="background:#080010;color:#ef4444;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;font-size:1.5rem;text-align:center;padding:20px;">Generation failed — please try again.</body></html>`;
  }
}

// ── ROUTES ────────────────────────────────────────────────────────────────────
app.get("/", (_, res) => res.json({ ok: true, service: "SiteSprint v4" }));

app.get("/api/businesses", async (req, res) => {
  try {
    const { status, q } = req.query;
    let sql = "SELECT * FROM businesses WHERE 1=1";
    const params = [];
    if (status && status !== "all") { sql += ` AND status=$${params.length+1}`; params.push(status); }
    if (q) {
      sql += ` AND (name ILIKE $${params.length+1} OR category ILIKE $${params.length+2} OR address ILIKE $${params.length+3})`;
      params.push(`%${q}%`,`%${q}%`,`%${q}%`);
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
      [b.name,b.address||"",b.phone||"",b.category||"",b.rating||0,b.review_count||0,
       b.hours||"",b.website||"",b.google_url||"",b.status||"prospect",b.area_searched||""]
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
      { cat: "Auto Repair", name: "Motors & Glass" },{ cat: "Restaurant", name: "Grill & Bistro" },
      { cat: "Salon", name: "Beauty Studio" },{ cat: "Plumbing", name: "Rooter Services" },
      { cat: "Dental", name: "Family Dentistry" },{ cat: "Gym", name: "Fitness Center" },
      { cat: "Landscaping", name: "Lawn & Garden" },{ cat: "Roofing", name: "Roofing Experts" },
      { cat: "Cafe", name: "Coffee Roasters" },{ cat: "Cleaning", name: "Commercial Cleaners" }
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
        [b.name||"Business",b.address||"",b.phone||"",b.category||"",
         b.rating||5,b.review_count||50,b.hours||"","prospect",b.area_searched||""]
      );
      biz = ins.rows[0];
    }
    const html = await generateSite(biz);
    const slug = `${biz.id}-${Date.now()}`;
    await pool.query(
      `INSERT INTO generated_sites (business_id,slug,html) VALUES ($1,$2,$3)
       ON CONFLICT (slug) DO UPDATE SET html=EXCLUDED.html`,
      [biz.id, slug, html]
    );
    await pool.query(
      "UPDATE businesses SET preview_slug=$1,status='site shown',updated_at=NOW() WHERE id=$2",
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
initDB().then(() => app.listen(PORT, () => console.log(`🚀 SiteSprint v4 on port ${PORT}`)));