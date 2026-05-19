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

// ─── IMAGE BANKS ──────────────────────────────────────────────────────────────
const IMAGE_BANKS = {
  salon: [
    "https://images.unsplash.com/photo-1562322140-8baeececf3df?w=1600&q=85",
    "https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?w=900&q=85",
    "https://images.unsplash.com/photo-1605497746444-ac9da58480a8?w=900&q=85",
    "https://images.unsplash.com/photo-1560066984-138dadb4c035?w=900&q=85",
    "https://images.unsplash.com/photo-1487412720507-e7ab37603c6f?w=900&q=85",
    "https://images.unsplash.com/photo-1521590832167-7bcbfaa6381f?w=900&q=85",
  ],
  dental: [
    "https://images.unsplash.com/photo-1606811841689-23dfddce3e66?w=1600&q=85",
    "https://images.unsplash.com/photo-1588776814546-1ffbb172a090?w=900&q=85",
    "https://images.unsplash.com/photo-1629909615184-74f495363b67?w=900&q=85",
    "https://images.unsplash.com/photo-1609840114035-3c981b782dfe?w=900&q=85",
    "https://images.unsplash.com/photo-1598256989800-fe5f95da9787?w=900&q=85",
    "https://images.unsplash.com/photo-1576091160550-2173dba999ef?w=900&q=85",
  ],
  auto: [
    "https://images.unsplash.com/photo-1619642751034-765dfdf7c58e?w=1600&q=85",
    "https://images.unsplash.com/photo-1486006920555-c77dce18193b?w=900&q=85",
    "https://images.unsplash.com/photo-1563720223185-11003d516935?w=900&q=85",
    "https://images.unsplash.com/photo-1517524206127-48bbd363f3d7?w=900&q=85",
    "https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?w=900&q=85",
    "https://images.unsplash.com/photo-1568605117036-5fe5e7bab0b7?w=900&q=85",
  ],
  restaurant: [
    "https://images.unsplash.com/photo-1514933651103-005eec06c04b?w=1600&q=85",
    "https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=900&q=85",
    "https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=900&q=85",
    "https://images.unsplash.com/photo-1414235077428-338989a2e8c0?w=900&q=85",
    "https://images.unsplash.com/photo-1559339352-11d035aa65de?w=900&q=85",
    "https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=900&q=85",
  ],
  gym: [
    "https://images.unsplash.com/photo-1534438327276-14e5300c3a48?w=1600&q=85",
    "https://images.unsplash.com/photo-1571019614242-c5c5dee9f50b?w=900&q=85",
    "https://images.unsplash.com/photo-1517836357463-d25dfeac3438?w=900&q=85",
    "https://images.unsplash.com/photo-1583454110551-21f2fa2afe61?w=900&q=85",
    "https://images.unsplash.com/photo-1574680096145-d05b474e2155?w=900&q=85",
    "https://images.unsplash.com/photo-1526506118085-60ce8714f8c5?w=900&q=85",
  ],
  cleaning: [
    "https://images.unsplash.com/photo-1581578731548-c64695cc6952?w=1600&q=85",
    "https://images.unsplash.com/photo-1621905252507-b35492cc74b4?w=900&q=85",
    "https://images.unsplash.com/photo-1527515637-6742562d5395?w=900&q=85",
    "https://images.unsplash.com/photo-1584622650111-993a426fbf0a?w=900&q=85",
    "https://images.unsplash.com/photo-1556911220-bff31c812dba?w=900&q=85",
    "https://images.unsplash.com/photo-1628177142898-93e36e4e3a50?w=900&q=85",
  ],
  default: [
    "https://images.unsplash.com/photo-1497366216548-37526070297c?w=1600&q=85",
    "https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=900&q=85",
    "https://images.unsplash.com/photo-1542744094-3a31f103e35f?w=900&q=85",
    "https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?w=900&q=85",
    "https://images.unsplash.com/photo-1551836022-d5d88e9218df?w=900&q=85",
    "https://images.unsplash.com/photo-1497366811353-6870744d04b2?w=900&q=85",
  ],
};

function getCategory(cat) {
  const c = (cat || "").toLowerCase();
  if (c.includes("salon") || c.includes("beauty") || c.includes("hair") || c.includes("spa")) return "salon";
  if (c.includes("dental") || c.includes("dentist") || c.includes("orthodon")) return "dental";
  if (c.includes("auto") || c.includes("repair") || c.includes("mechanic") || c.includes("tire")) return "auto";
  if (c.includes("rest") || c.includes("food") || c.includes("cafe") || c.includes("bistro") || c.includes("pizza") || c.includes("sushi")) return "restaurant";
  if (c.includes("gym") || c.includes("fitness") || c.includes("yoga") || c.includes("crossfit")) return "gym";
  if (c.includes("clean") || c.includes("maid") || c.includes("hvac") || c.includes("plumb") || c.includes("roof") || c.includes("landscape")) return "cleaning";
  return "default";
}

function getImages(category) {
  return IMAGE_BANKS[getCategory(category)] || IMAGE_BANKS.default;
}

// ─── DESIGN SYSTEMS — each category gets unique layout + colors ───────────────
const DESIGN_SYSTEMS = {

  salon: {
    fonts: `@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;0,700;1,400;1,600&family=Jost:wght@300;400;500;600&display=swap');`,
    headingFont: "'Cormorant Garamond', serif",
    bodyFont: "'Jost', sans-serif",
    bg: "#0c0608", surface: "#160d10", card: "#1e1318",
    primary: "#C4956A", accent: "#E8C9A0", text: "#f5ede8",
    muted: "#9a8880", border: "rgba(196,149,106,0.15)", glow: "196,149,106",
    heroStyle: "split", // left text, right image
    accentShape: "organic",
    reviews: [
      { name:"Sophia L.", av:"SL", text:"This salon is pure artistry. I've never felt so understood — they transformed my hair into exactly what I envisioned.", role:"Loyal client since 2019" },
      { name:"Isabella M.", av:"IM", text:"The atmosphere is divine and the stylists are true professionals. Worth every penny and then some.", role:"Monthly visitor" },
      { name:"Charlotte R.", av:"CR", text:"I drive 40 minutes just to come here. There's nowhere else I'd trust with my hair.", role:"5-star reviewer" },
    ],
    services: [
      { icon:"fa-scissors", name:"Precision Cuts", desc:"Tailored cuts designed around your face shape, lifestyle, and personal aesthetic." },
      { icon:"fa-palette", name:"Color & Highlights", desc:"Balayage, ombré, and full-color transformations using premium organic dyes." },
      { icon:"fa-spa", name:"Luxury Treatments", desc:"Deep conditioning, keratin therapy, and scalp treatments for ultimate hair health." },
    ],
    stats: [ {n:"2,400+",l:"Happy Clients"}, {n:"98%",l:"Return Rate"}, {n:"8",l:"Expert Stylists"}, {n:"12yr",l:"In Business"} ],
    cta: "Book Your Transformation",
    headline1: "Where Beauty Becomes", headlineHL: "Art",
    sub: "Expert stylists dedicated to bringing your vision to life with precision and passion.",
    tagline: "Beauty elevated. Confidence restored.",
  },

  dental: {
    fonts: `@import url('https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500;600&display=swap');`,
    headingFont: "'DM Serif Display', serif",
    bodyFont: "'DM Sans', sans-serif",
    bg: "#010818", surface: "#03102a", card: "#061530",
    primary: "#4FC3F7", accent: "#B3E5FC", text: "#edf8ff",
    muted: "#7ab0cc", border: "rgba(79,195,247,0.12)", glow: "79,195,247",
    heroStyle: "center",
    accentShape: "geometric",
    reviews: [
      { name:"Mark T.", av:"MT", text:"I used to dread dentist visits. Now I actually look forward to them. The team here is genuinely caring and incredibly skilled.", role:"Patient since 2020" },
      { name:"Jennifer P.", av:"JP", text:"My smile makeover exceeded every expectation. The before and after photos are unbelievable.", role:"Smile transformation" },
      { name:"David R.", av:"DR", text:"Pain-free, professional, and they explain everything clearly. Best dental experience of my life.", role:"Family patient" },
    ],
    services: [
      { icon:"fa-tooth", name:"Smile Makeovers", desc:"Complete aesthetic transformations combining veneers, whitening, and contouring for your perfect smile." },
      { icon:"fa-shield-halved", name:"Preventive Care", desc:"Comprehensive checkups, cleanings, and X-rays to keep your teeth healthy for life." },
      { icon:"fa-wand-magic-sparkles", name:"Teeth Whitening", desc:"Professional-grade whitening treatments that deliver dramatic results in a single visit." },
    ],
    stats: [ {n:"5,000+",l:"Smiles Transformed"}, {n:"4.9★",l:"Patient Rating"}, {n:"15yr",l:"Experience"}, {n:"Zero",l:"Pain Policy"} ],
    cta: "Schedule Your Visit",
    headline1: "Your Dream Smile", headlineHL: "Starts Here",
    sub: "Advanced dental care delivered with compassion, precision, and a commitment to your comfort.",
    tagline: "Advanced care. Beautiful smiles. Zero anxiety.",
  },

  auto: {
    fonts: `@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Barlow:wght@300;400;500;600;700&display=swap');`,
    headingFont: "'Bebas Neue', sans-serif",
    bodyFont: "'Barlow', sans-serif",
    bg: "#060400", surface: "#0f0c02", card: "#181204",
    primary: "#F59E0B", accent: "#FDE68A", text: "#fff8e8",
    muted: "#b8a060", border: "rgba(245,158,11,0.15)", glow: "245,158,11",
    heroStyle: "fullbleed",
    accentShape: "angular",
    reviews: [
      { name:"James H.", av:"JH", text:"These guys saved my engine. Two other shops said I needed a full replacement — they fixed it for a fraction of the cost. Legends.", role:"Engine rebuild customer" },
      { name:"Mike S.", av:"MS", text:"Fast, honest, and they actually show you what's wrong before charging you a dime. I trust them completely.", role:"Regular customer" },
      { name:"Roberto C.", av:"RC", text:"Same-day service on a complex brake job. These are real pros. Best shop in the city.", role:"5-star reviewer" },
    ],
    services: [
      { icon:"fa-engine", name:"Engine Diagnostics", desc:"State-of-the-art computer diagnostics identifying issues before they become costly problems." },
      { icon:"fa-car-burst", name:"Collision Repair", desc:"Expert bodywork and paint matching that makes your car look factory-new again." },
      { icon:"fa-gear", name:"Full Mechanical", desc:"Brakes, suspension, transmission — every system serviced by certified master mechanics." },
    ],
    stats: [ {n:"10K+",l:"Vehicles Serviced"}, {n:"Same",l:"Day Service"}, {n:"$0",l:"Hidden Fees"}, {n:"20yr",l:"Experience"} ],
    cta: "Get Free Estimate",
    headline1: "YOUR CAR DESERVES", headlineHL: "THE BEST",
    sub: "Honest diagnostics, expert repairs, and fair pricing. Your vehicle is in expert hands.",
    tagline: "Trusted mechanics. Honest pricing. Fast turnaround.",
  },

  restaurant: {
    fonts: `@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;0,900;1,400&family=Lato:wght@300;400;700&display=swap');`,
    headingFont: "'Playfair Display', serif",
    bodyFont: "'Lato', sans-serif",
    bg: "#080300", surface: "#120800", card: "#1a0e02",
    primary: "#E8844A", accent: "#F4B87A", text: "#fff5ee",
    muted: "#c4926e", border: "rgba(232,132,74,0.15)", glow: "232,132,74",
    heroStyle: "moody",
    accentShape: "rounded",
    reviews: [
      { name:"Emily W.", av:"EW", text:"The best meal I've had in years. Every dish was a revelation — bold flavors, perfect execution, and service that made us feel like royalty.", role:"Food critic" },
      { name:"Thomas B.", av:"TB", text:"Our anniversary dinner was flawless. The chef personally came to our table. An experience we'll remember forever.", role:"Anniversary dinner" },
      { name:"Priya K.", av:"PK", text:"I've traveled the world and this kitchen holds its own with the finest. The passion in every plate is unmistakable.", role:"Food lover" },
    ],
    services: [
      { icon:"fa-utensils", name:"À La Carte Dining", desc:"Seasonal menus crafted from locally-sourced ingredients, reimagined with global inspiration." },
      { icon:"fa-champagne-glasses", name:"Private Events", desc:"Intimate dinners to grand celebrations — our team creates unforgettable experiences for every occasion." },
      { icon:"fa-wine-glass", name:"Wine & Cocktails", desc:"A curated cellar of 200+ labels paired with house-crafted cocktails by our mixology team." },
    ],
    stats: [ {n:"12yr",l:"Open Since"}, {n:"4.8★",l:"Dining Rating"}, {n:"200+",l:"Wine Labels"}, {n:"Chef",l:"Crafted Daily"} ],
    cta: "Reserve a Table",
    headline1: "An Experience", headlineHL: "Beyond the Plate",
    sub: "Where every ingredient tells a story and every meal becomes a memory worth keeping.",
    tagline: "Exceptional cuisine. Unforgettable moments.",
  },

  gym: {
    fonts: `@import url('https://fonts.googleapis.com/css2?family=Oswald:wght@400;600;700&family=Inter:wght@300;400;500;600&display=swap');`,
    headingFont: "'Oswald', sans-serif",
    bodyFont: "'Inter', sans-serif",
    bg: "#04000f", surface: "#0a0220", card: "#100530",
    primary: "#A855F7", accent: "#D946EF", text: "#f8f0ff",
    muted: "#9060b0", border: "rgba(168,85,247,0.15)", glow: "168,85,247",
    heroStyle: "dynamic",
    accentShape: "sharp",
    reviews: [
      { name:"Alex T.", av:"AT", text:"I've been to 6 gyms in this city. Nothing comes close. The trainers push you past what you think is possible while keeping you safe.", role:"Lost 40lbs in 5 months" },
      { name:"Maria G.", av:"MG", text:"The community here changed my life. Started as a beginner, now I'm competing. This gym does that to you.", role:"Member since 2021" },
      { name:"Derek L.", av:"DL", text:"State-of-the-art equipment, expert coaches, and an energy that gets you fired up every single session.", role:"Personal training client" },
    ],
    services: [
      { icon:"fa-dumbbell", name:"Personal Training", desc:"1-on-1 coaching with certified trainers who design programs around your exact goals and lifestyle." },
      { icon:"fa-people-group", name:"Group Classes", desc:"30+ weekly classes — HIIT, strength, yoga, spin — for every fitness level and schedule." },
      { icon:"fa-chart-line", name:"Nutrition Coaching", desc:"Personalized meal plans and ongoing support to fuel your transformation from the inside out." },
    ],
    stats: [ {n:"1,200+",l:"Active Members"}, {n:"35+",l:"Weekly Classes"}, {n:"15",l:"Elite Trainers"}, {n:"98%",l:"Goal Achievement"} ],
    cta: "Start Your Journey",
    headline1: "TRANSFORM YOUR", headlineHL: "LIMITS",
    sub: "Elite coaching, cutting-edge equipment, and a community that pushes you to your personal best.",
    tagline: "No limits. No excuses. Just results.",
  },

  cleaning: {
    fonts: `@import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800&family=Open+Sans:wght@300;400;600&display=swap');`,
    headingFont: "'Nunito', sans-serif",
    bodyFont: "'Open Sans', sans-serif",
    bg: "#010c08", surface: "#031810", card: "#051f14",
    primary: "#10B981", accent: "#6EE7B7", text: "#edfff6",
    muted: "#70a888", border: "rgba(16,185,129,0.15)", glow: "16,185,129",
    heroStyle: "clean",
    accentShape: "soft",
    reviews: [
      { name:"Rachel S.", av:"RS", text:"My house has never been this clean. They pay attention to details I didn't even think about. Absolute perfection every time.", role:"Weekly client" },
      { name:"Kevin M.", av:"KM", text:"After a construction project left our home a disaster, these pros made it spotless in one visit. Incredible.", role:"Post-construction clean" },
      { name:"Amy L.", av:"AL", text:"Reliable, thorough, and trustworthy. I've had the same team for 2 years and they never disappoint.", role:"Bi-weekly customer" },
    ],
    services: [
      { icon:"fa-house", name:"Residential Deep Clean", desc:"Top-to-bottom cleaning that covers every corner, surface, and detail of your home." },
      { icon:"fa-building", name:"Commercial Cleaning", desc:"Professional office and commercial space cleaning that maintains a spotless, productive environment." },
      { icon:"fa-sparkles", name:"Move In / Move Out", desc:"Complete cleaning packages that ensure every space is pristine for new occupants." },
    ],
    stats: [ {n:"800+",l:"Happy Clients"}, {n:"5★",l:"Average Rating"}, {n:"Eco",l:"Safe Products"}, {n:"100%",l:"Satisfaction"} ],
    cta: "Get Free Quote",
    headline1: "Spotlessly Clean,", headlineHL: "Guaranteed",
    sub: "Professional cleaning services that leave your space immaculate — every visit, without exception.",
    tagline: "Cleaner spaces. Happier lives. Every time.",
  },

  default: {
    fonts: `@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=Inter:wght@300;400;500;600;700&display=swap');`,
    headingFont: "'Playfair Display', serif",
    bodyFont: "'Inter', sans-serif",
    bg: "#05050f", surface: "#0c0c20", card: "#101028",
    primary: "#6366F1", accent: "#A5B4FC", text: "#f0f0ff",
    muted: "#8888cc", border: "rgba(99,102,241,0.15)", glow: "99,102,241",
    heroStyle: "center",
    accentShape: "geometric",
    reviews: [
      { name:"Chris L.", av:"CL", text:"Exceptional service from start to finish. Highly professional and the quality of work speaks for itself.", role:"Verified customer" },
      { name:"Sarah M.", av:"SM", text:"I've tried many providers and none come close to this level of care and expertise. Highly recommend.", role:"Long-term client" },
      { name:"James P.", av:"JP", text:"Reliable, skilled, and genuinely committed to customer satisfaction. 10 out of 10 every time.", role:"Regular customer" },
    ],
    services: [
      { icon:"fa-star", name:"Premium Service", desc:"Top-tier quality delivered with care, expertise, and attention to every detail." },
      { icon:"fa-shield-halved", name:"Trusted Expertise", desc:"Years of experience and a track record of excellence that speaks for itself." },
      { icon:"fa-handshake", name:"Customer First", desc:"Your satisfaction is our priority — we go above and beyond on every project." },
    ],
    stats: [ {n:"500+",l:"Happy Clients"}, {n:"5★",l:"Average Rating"}, {n:"10yr",l:"Experience"}, {n:"100%",l:"Satisfaction"} ],
    cta: "Get Started Today",
    headline1: "Excellence You Can", headlineHL: "Count On",
    sub: "Professional services delivered with expertise, integrity, and a commitment to your complete satisfaction.",
    tagline: "Quality. Integrity. Results.",
  },
};

function getDesign(category) {
  return DESIGN_SYSTEMS[getCategory(category)] || DESIGN_SYSTEMS.default;
}

// ─── GET AI CONTENT (just text, not HTML) ─────────────────────────────────────
async function getAIContent(biz, ds) {
  const prompt = `Business: "${biz.name}" | Type: ${biz.category} | Rating: ${biz.rating}★ (${biz.review_count} reviews) | Phone: ${biz.phone} | Address: ${biz.address}

Return ONLY a JSON object (no markdown):
{
  "heroTag": "Location-based tagline for ${biz.category} in 5-7 words",
  "heroHL": "2-3 word italic headline highlight for ${biz.name}",
  "heroSub": "Compelling 15-word max value proposition specific to ${biz.name}",
  "svc1name": "Real service name for ${biz.category}", "svc1desc": "12-word specific description",
  "svc2name": "Real service name for ${biz.category}", "svc2desc": "12-word specific description",
  "svc3name": "Real service name for ${biz.category}", "svc3desc": "12-word specific description",
  "gal1": "Gallery photo label 1", "gal2": "Gallery photo label 2", "gal3": "Gallery photo label 3", "gal4": "Gallery photo label 4",
  "footerTag": "8-word inspirational tagline for ${biz.name}"
}`;

  try {
    const r = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 600,
      messages: [{ role: "user", content: prompt }],
    });
    let raw = r.content[0].text.trim().replace(/^```json?\n?/,"").replace(/```$/,"");
    return JSON.parse(raw);
  } catch(e) {
    console.error("AI content failed:", e.message);
    return null;
  }
}

// ─── BUILD FULL HTML — all CSS hardcoded, only text from AI ───────────────────
function buildHTML(biz, ds, imgs, ct) {
  const letter = (biz.name || "B")[0].toUpperCase();
  const nameParts = biz.name.split(" ");
  const firstName = nameParts[0];
  const restName = nameParts.slice(1).join(" ");

  // Merge AI content with design system defaults
  const heroHL  = ct?.heroHL  || ds.headlineHL;
  const heroSub = ct?.heroSub || ds.sub;
  const heroTag = ct?.heroTag || `Premium ${biz.category} Services`;
  const svc1name = ct?.svc1name || ds.services[0].name;
  const svc1desc = ct?.svc1desc || ds.services[0].desc;
  const svc2name = ct?.svc2name || ds.services[1].name;
  const svc2desc = ct?.svc2desc || ds.services[1].desc;
  const svc3name = ct?.svc3name || ds.services[2].name;
  const svc3desc = ct?.svc3desc || ds.services[2].desc;
  const gal1 = ct?.gal1 || "Featured Work";
  const gal2 = ct?.gal2 || "Our Process";
  const gal3 = ct?.gal3 || "Results";
  const gal4 = ct?.gal4 || "Behind the Scenes";
  const footerTag = ct?.footerTag || ds.tagline;
  const isCaps = ds.headingFont.includes("Bebas") || ds.headingFont.includes("Oswald");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${biz.name}</title>
<style>${ds.fonts}</style>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
<style>
/* ── RESET & BASE ── */
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{background:${ds.bg};color:${ds.text};font-family:${ds.bodyFont};overflow-x:hidden;line-height:1.6}
a{text-decoration:none;color:inherit}
img{max-width:100%}
::selection{background:${ds.primary};color:#000}
::-webkit-scrollbar{width:4px}
::-webkit-scrollbar-track{background:${ds.bg}}
::-webkit-scrollbar-thumb{background:${ds.primary};border-radius:2px}

/* ── TYPOGRAPHY ── */
h1,h2,h3,.heading{font-family:${ds.headingFont};${isCaps?"letter-spacing:2px;":""}line-height:1.1}

/* ── NAV ── */
nav{position:fixed;top:0;left:0;right:0;z-index:999;display:flex;align-items:center;justify-content:space-between;padding:20px 6%;transition:all .4s ease}
nav.s{background:rgba(0,0,0,0.94);backdrop-filter:blur(24px);padding:13px 6%;border-bottom:1px solid rgba(${ds.glow},.14)}
.nl{display:flex;align-items:center;gap:12px}
.li{width:36px;height:36px;background:${ds.primary};border-radius:9px;display:flex;align-items:center;justify-content:center;font-family:${ds.headingFont};font-weight:700;font-size:1rem;color:#fff;flex-shrink:0}
.ln{font-family:${ds.headingFont};font-size:1.1rem;font-weight:700}
.ln em{color:${ds.primary};font-style:normal}
.nm{display:flex;list-style:none;gap:32px}
.nm a{font-size:.8rem;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:rgba(255,255,255,.55);transition:color .3s}
.nm a:hover{color:${ds.accent}}
.nb{background:${ds.primary};color:#fff;padding:10px 24px;border-radius:50px;font-size:.82rem;font-weight:700;letter-spacing:.5px;transition:all .3s;border:none;cursor:pointer;display:inline-block}
.nb:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(${ds.glow},.4)}

/* ── HERO ── */
.hero{position:relative;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;overflow:hidden}
.hbg{position:absolute;inset:0;background-size:cover;background-position:center;transform:scale(1.05);transition:transform 10s ease}
.hero:hover .hbg{transform:scale(1.0)}
.hov{position:absolute;inset:0;background:linear-gradient(160deg,${ds.bg}f5 0%,${ds.bg}80 45%,${ds.bg}e8 100%)}
.hb{position:relative;z-index:2;max-width:880px;padding:140px 24px 80px}
.hbd{display:inline-flex;align-items:center;gap:10px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.16);backdrop-filter:blur(10px);border-radius:100px;padding:10px 22px;font-size:.82rem;font-weight:600;margin-bottom:28px}
.hbd .st{color:#FFD700}
.ht{color:${ds.accent};font-size:.72rem;font-weight:700;letter-spacing:5px;text-transform:uppercase;margin-bottom:16px}
.hero h1{font-family:${ds.headingFont};font-size:clamp(2.8rem,6.5vw,5.5rem);font-weight:900;line-height:1.06;margin-bottom:22px;${isCaps?"letter-spacing:3px;":""}color:${ds.text}}
.hero h1 .hl{color:${ds.primary};${isCaps?"":"font-style:italic;"}}
.hsb{font-size:1.05rem;color:${ds.muted};max-width:540px;margin:0 auto 44px;font-weight:300}
.hbtns{display:flex;gap:16px;justify-content:center;flex-wrap:wrap}
.bp{display:inline-flex;align-items:center;gap:10px;background:${ds.primary};color:#fff;padding:15px 38px;border-radius:50px;font-weight:700;font-size:.97rem;border:none;cursor:pointer;transition:all .35s}
.bp:hover{transform:translateY(-3px);box-shadow:0 16px 44px rgba(${ds.glow},.45)}
.bg{display:inline-flex;align-items:center;gap:10px;background:rgba(255,255,255,.05);color:${ds.text};padding:15px 38px;border-radius:50px;font-weight:600;font-size:.97rem;border:1px solid rgba(255,255,255,.2);cursor:pointer;transition:all .35s;backdrop-filter:blur(8px)}
.bg:hover{border-color:${ds.primary};color:${ds.primary};transform:translateY(-3px)}
.sc{position:absolute;bottom:28px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:5px;font-size:.65rem;letter-spacing:3px;text-transform:uppercase;color:${ds.muted};animation:bounce 2.5s infinite}

/* ── STATS ── */
.stats{padding:48px 6%;background:rgba(255,255,255,.022);border-top:1px solid rgba(${ds.glow},.1);border-bottom:1px solid rgba(${ds.glow},.1)}
.sg{display:grid;grid-template-columns:repeat(4,1fr);gap:28px;max-width:880px;margin:0 auto;text-align:center}
.sn{font-family:${ds.headingFont};font-size:2.7rem;font-weight:900;background:linear-gradient(135deg,${ds.primary},${ds.accent});-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;line-height:1}
.sl{font-size:.7rem;letter-spacing:3px;text-transform:uppercase;color:${ds.muted};margin-top:7px}

/* ── SERVICES ── */
.sec{padding:96px 6%}
.sh{text-align:center;margin-bottom:64px}
.eye{color:${ds.accent};font-size:.7rem;font-weight:700;letter-spacing:5px;text-transform:uppercase;display:block;margin-bottom:12px}
.st{font-family:${ds.headingFont};font-size:clamp(1.9rem,3.5vw,2.9rem);font-weight:900;margin-bottom:12px;${isCaps?"letter-spacing:2px;":""}color:${ds.text}}
.ss{color:${ds.muted};font-size:.95rem;max-width:480px;margin:0 auto;font-weight:300}
.svgg{display:grid;grid-template-columns:repeat(3,1fr);gap:0;border:1px solid rgba(${ds.glow},.12);border-radius:20px;overflow:hidden}
.svc{background:${ds.card};padding:44px 32px;position:relative;overflow:hidden;transition:background .4s;border-right:1px solid rgba(${ds.glow},.08)}
.svc:last-child{border-right:none}
.svc::before{content:'';position:absolute;inset:0;background:linear-gradient(135deg,rgba(${ds.glow},.06) 0%,transparent 60%);opacity:0;transition:opacity .4s}
.svc:hover::before{opacity:1}
.svc::after{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,transparent,${ds.primary},transparent);transform:scaleX(0);transition:transform .5s;transform-origin:left}
.svc:hover::after{transform:scaleX(1)}
.snn{font-family:${ds.headingFont};font-size:5rem;font-weight:900;color:${ds.primary};opacity:.06;position:absolute;top:12px;right:20px;line-height:1}
.sic{width:52px;height:52px;background:rgba(${ds.glow},.1);border:1px solid rgba(${ds.glow},.2);border-radius:14px;display:flex;align-items:center;justify-content:center;margin-bottom:20px;transition:all .4s}
.svc:hover .sic{background:rgba(${ds.glow},.22);box-shadow:0 0 22px rgba(${ds.glow},.25)}
.sic i{font-size:1.3rem;color:${ds.primary}}
.svc h3{font-family:${ds.headingFont};font-size:1.15rem;font-weight:700;margin-bottom:10px;${isCaps?"letter-spacing:1px;":""}color:${ds.text}}
.svc p{font-size:.88rem;color:${ds.muted};line-height:1.8}

/* ── GALLERY ── */
.gal{padding:96px 6%;background:${ds.surface}}
.gg{display:grid;grid-template-columns:2fr 1fr 1fr;grid-template-rows:260px 260px;gap:14px;margin-top:60px}
.gi{border-radius:14px;overflow:hidden;position:relative;cursor:pointer}
.gi:first-child{grid-row:1/3}
.gbg{width:100%;height:100%;background-size:cover;background-position:center;transition:transform .6s ease}
.gi:hover .gbg{transform:scale(1.07)}
.gov{position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,.78) 0%,transparent 55%);opacity:0;transition:opacity .4s;display:flex;align-items:flex-end;padding:20px}
.gi:hover .gov{opacity:1}
.glbl{font-family:${ds.headingFont};font-size:.95rem;font-weight:700;color:#fff;${isCaps?"letter-spacing:1px;":""}text-transform:${isCaps?"uppercase":"none"}}

/* ── REVIEWS ── */
.rev{padding:96px 6%}
.rg{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-top:60px}
.rc{background:${ds.card};border:1px solid rgba(${ds.glow},.1);border-radius:20px;padding:32px;transition:all .4s;position:relative;overflow:hidden}
.rc::before{content:'';position:absolute;bottom:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,${ds.primary},transparent);transform:scaleX(0);transition:transform .5s}
.rc:hover::before{transform:scaleX(1)}
.rc:hover{border-color:rgba(${ds.glow},.3);transform:translateY(-6px);box-shadow:0 20px 60px rgba(0,0,0,.4)}
.rq{font-size:3rem;color:${ds.primary};opacity:.15;line-height:1;font-family:${ds.headingFont};margin-bottom:4px}
.rs{color:#FFD700;font-size:.78rem;letter-spacing:2px;margin-bottom:12px}
.rt{font-size:.9rem;color:${ds.muted};line-height:1.85;font-style:italic;margin-bottom:24px}
.rw{display:flex;align-items:center;gap:12px}
.ra{width:40px;height:40px;border-radius:50%;background:rgba(${ds.glow},.15);border:2px solid rgba(${ds.glow},.3);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:.76rem;color:${ds.primary};flex-shrink:0}
.rn{font-weight:700;font-size:.87rem}
.rr{font-size:.7rem;color:${ds.muted}}

/* ── CONTACT ── */
.con{padding:96px 6%;background:${ds.surface}}
.ci{display:grid;grid-template-columns:1fr 1.4fr;gap:72px;max-width:1080px;margin:60px auto 0;align-items:start}
.cl h3{font-family:${ds.headingFont};font-size:1.7rem;font-weight:700;margin-bottom:10px;${isCaps?"letter-spacing:1px;":""}color:${ds.text}}
.cl p{color:${ds.muted};font-size:.92rem;margin-bottom:40px;line-height:1.8}
.cr{display:flex;align-items:flex-start;gap:16px;margin-bottom:26px}
.cic{width:46px;height:46px;min-width:46px;background:rgba(${ds.glow},.1);border:1px solid rgba(${ds.glow},.18);border-radius:12px;display:flex;align-items:center;justify-content:center;transition:all .3s}
.cr:hover .cic{background:rgba(${ds.glow},.2);box-shadow:0 0 16px rgba(${ds.glow},.2)}
.cic i{color:${ds.primary};font-size:.92rem}
.clbl{font-size:.67rem;letter-spacing:3px;text-transform:uppercase;color:${ds.muted};margin-bottom:4px}
.cv{font-weight:600;font-size:.95rem}
.cf{background:${ds.card};border:1px solid rgba(${ds.glow},.12);border-radius:20px;padding:40px 36px}
.fr{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.fg{margin-bottom:16px}
.fl{display:block;font-size:.67rem;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:${ds.muted};margin-bottom:7px}
.fi{width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.09);border-radius:10px;padding:13px 15px;color:${ds.text};font-size:.94rem;font-family:${ds.bodyFont};transition:all .3s;outline:none}
.fi:focus{border-color:${ds.primary};background:rgba(${ds.glow},.05);box-shadow:0 0 0 3px rgba(${ds.glow},.1)}
.fi::placeholder{color:rgba(255,255,255,.2)}
textarea.fi{min-height:115px;resize:vertical}
.fsb{width:100%;padding:15px;font-size:.95rem;font-weight:700;letter-spacing:.5px;margin-top:6px;font-family:${ds.bodyFont}}

/* ── FOOTER ── */
footer{padding:64px 6% 32px;border-top:1px solid rgba(${ds.glow},.1);text-align:center}
.fll{display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:12px}
.fic{width:40px;height:40px;background:${ds.primary};border-radius:10px;display:flex;align-items:center;justify-content:center;font-family:${ds.headingFont};font-weight:700;font-size:.95rem;color:#fff}
.fn{font-family:${ds.headingFont};font-size:1.4rem;font-weight:700;color:${ds.primary}}
.ftg{color:${ds.muted};font-size:.87rem;margin-bottom:32px}
.fls{display:flex;gap:24px;justify-content:center;list-style:none;margin-bottom:32px}
.fls a{font-size:.73rem;letter-spacing:1.5px;text-transform:uppercase;color:${ds.muted};transition:color .3s}
.fls a:hover{color:${ds.accent}}
.fc{color:rgba(255,255,255,.16);font-size:.73rem}

/* ── ANIMATIONS ── */
@keyframes fadeUp{from{opacity:0;transform:translateY(28px)}to{opacity:1;transform:translateY(0)}}
@keyframes bounce{0%,100%{transform:translateX(-50%) translateY(0)}50%{transform:translateX(-50%) translateY(-7px)}}
.hb>*{animation:fadeUp .9s ease both}
.hbd{animation-delay:.0s!important}
.ht{animation-delay:.1s!important}
.hero h1{animation-delay:.2s!important}
.hsb{animation-delay:.3s!important}
.hbtns{animation-delay:.4s!important}
.sc{animation:bounce 2.5s 1s infinite}
.an{opacity:0;transform:translateY(24px);transition:opacity .7s ease,transform .7s ease}
.an.in{opacity:1;transform:translateY(0)}
.d1{transition-delay:.12s}.d2{transition-delay:.24s}.d3{transition-delay:.36s}

/* ── RESPONSIVE ── */
@media(max-width:900px){
  .nm{display:none}
  .sg{grid-template-columns:repeat(2,1fr)}
  .svgg{grid-template-columns:1fr}
  .svc{border-right:none;border-bottom:1px solid rgba(${ds.glow},.08)}
  .svc:last-child{border-bottom:none}
  .gg{grid-template-columns:1fr;grid-template-rows:auto}
  .gi:first-child{grid-row:auto}.gi{height:220px}
  .rg{grid-template-columns:1fr}
  .ci{grid-template-columns:1fr;gap:44px}
  .fr{grid-template-columns:1fr}
}
</style>
</head>
<body>

<nav id="nav">
  <div class="nl">
    <div class="li">${letter}</div>
    <div class="ln"><em>${firstName}</em>${restName ? " " + restName : ""}</div>
  </div>
  <ul class="nm">
    <li><a href="#services">Services</a></li>
    <li><a href="#gallery">Gallery</a></li>
    <li><a href="#reviews">Reviews</a></li>
    <li><a href="#contact">Contact</a></li>
  </ul>
  <a href="#contact" class="nb">${ds.cta}</a>
</nav>

<section class="hero">
  <div class="hbg" style="background-image:url('${imgs[0]}')"></div>
  <div class="hov"></div>
  <div class="hb">
    <div class="hbd"><span class="st">★★★★★</span><span>${biz.rating} · ${biz.review_count} Verified Reviews</span></div>
    <p class="ht">${heroTag}</p>
    <h1>${ds.headline1} <span class="hl">${heroHL}</span></h1>
    <p class="hsb">${heroSub}</p>
    <div class="hbtns">
      <a href="#contact" class="bp"><i class="fas fa-calendar-check"></i> ${ds.cta}</a>
      <a href="#services" class="bg"><i class="fas fa-arrow-right"></i> Our Services</a>
    </div>
  </div>
  <div class="sc"><i class="fas fa-chevron-down"></i></div>
</section>

<section class="stats">
  <div class="sg">
    ${ds.stats.map(s=>`<div class="an"><div class="sn">${s.n}</div><div class="sl">${s.l}</div></div>`).join("")}
  </div>
</section>

<section class="sec" id="services">
  <div class="sh">
    <span class="eye">What We Offer</span>
    <h2 class="st">Our Premium Services</h2>
    <p class="ss">Exceptional quality and care delivered on every visit, guaranteed.</p>
  </div>
  <div class="svgg">
    <div class="svc an">
      <div class="snn">01</div>
      <div class="sic"><i class="fas ${ds.services[0].icon}"></i></div>
      <h3>${svc1name}</h3>
      <p>${svc1desc}</p>
    </div>
    <div class="svc an d1">
      <div class="snn">02</div>
      <div class="sic"><i class="fas ${ds.services[1].icon}"></i></div>
      <h3>${svc2name}</h3>
      <p>${svc2desc}</p>
    </div>
    <div class="svc an d2">
      <div class="snn">03</div>
      <div class="sic"><i class="fas ${ds.services[2].icon}"></i></div>
      <h3>${svc3name}</h3>
      <p>${svc3desc}</p>
    </div>
  </div>
</section>

<section class="gal" id="gallery">
  <div class="sh">
    <span class="eye">Our Work</span>
    <h2 class="st">Results That Speak</h2>
    <p class="ss">Real work from real projects — quality you can see.</p>
  </div>
  <div class="gg">
    <div class="gi an"><div class="gbg" style="background-image:url('${imgs[2]}')"></div><div class="gov"><span class="glbl">${gal1}</span></div></div>
    <div class="gi an d1"><div class="gbg" style="background-image:url('${imgs[3]}')"></div><div class="gov"><span class="glbl">${gal2}</span></div></div>
    <div class="gi an d2"><div class="gbg" style="background-image:url('${imgs[4]}')"></div><div class="gov"><span class="glbl">${gal3}</span></div></div>
    <div class="gi an d1"><div class="gbg" style="background-image:url('${imgs[5]}')"></div><div class="gov"><span class="glbl">${gal4}</span></div></div>
  </div>
</section>

<section class="rev" id="reviews">
  <div class="sh">
    <span class="eye">Client Reviews</span>
    <h2 class="st">What Our Clients Say</h2>
    <p class="ss">Real reviews from verified customers who trust us with what matters most.</p>
  </div>
  <div class="rg">
    ${ds.reviews.map((r,i)=>`
    <div class="rc an${i>0?" d"+i:""}">
      <div class="rq">"</div>
      <div class="rs">★★★★★</div>
      <p class="rt">${r.text}</p>
      <div class="rw">
        <div class="ra">${r.av}</div>
        <div><div class="rn">${r.name}</div><div class="rr">${r.role}</div></div>
      </div>
    </div>`).join("")}
  </div>
</section>

<section class="con" id="contact">
  <div class="sh">
    <span class="eye">Get In Touch</span>
    <h2 class="st">Book Your Appointment</h2>
    <p class="ss">Ready to get started? We'd love to hear from you today.</p>
  </div>
  <div class="ci">
    <div class="cl">
      <h3>Let's connect</h3>
      <p>Reach out and let our expert team handle everything from start to finish.</p>
      <div class="cr"><div class="cic"><i class="fas fa-phone"></i></div><div><p class="clbl">Phone</p><p class="cv">${biz.phone || "Call us today"}</p></div></div>
      <div class="cr"><div class="cic"><i class="fas fa-location-dot"></i></div><div><p class="clbl">Address</p><p class="cv">${biz.address || "Visit our location"}</p></div></div>
      <div class="cr"><div class="cic"><i class="fas fa-clock"></i></div><div><p class="clbl">Hours</p><p class="cv">${biz.hours || "Mon-Sat 9AM-6PM"}</p></div></div>
    </div>
    <div class="cf">
      <form onsubmit="hf(event)">
        <div class="fr">
          <div class="fg"><label class="fl">First Name</label><input class="fi" type="text" placeholder="John" required></div>
          <div class="fg"><label class="fl">Last Name</label><input class="fi" type="text" placeholder="Smith" required></div>
        </div>
        <div class="fr">
          <div class="fg"><label class="fl">Email</label><input class="fi" type="email" placeholder="you@email.com" required></div>
          <div class="fg"><label class="fl">Phone</label><input class="fi" type="tel" placeholder="(555) 000-0000"></div>
        </div>
        <div class="fg"><label class="fl">Message</label><textarea class="fi" placeholder="How can we help you?"></textarea></div>
        <button type="submit" class="bp fsb">Send Message <i class="fas fa-arrow-right"></i></button>
      </form>
    </div>
  </div>
</section>

<footer>
  <div class="fll"><div class="fic">${letter}</div><div class="fn">${biz.name}</div></div>
  <p class="ftg">${footerTag}</p>
  <ul class="fls">
    <li><a href="#services">Services</a></li>
    <li><a href="#gallery">Gallery</a></li>
    <li><a href="#reviews">Reviews</a></li>
    <li><a href="#contact">Contact</a></li>
  </ul>
  <p class="fc">&copy; 2025 ${biz.name}. All rights reserved.</p>
</footer>

<script>
window.addEventListener('scroll',()=>{document.getElementById('nav').classList.toggle('s',window.scrollY>70);});
const io=new IntersectionObserver(es=>{es.forEach(e=>{if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target);}});},{threshold:.1});
document.querySelectorAll('.an').forEach(el=>io.observe(el));
function hf(e){
  e.preventDefault();
  const b=e.target.querySelector('button[type=submit]');
  const o=b.innerHTML;
  b.innerHTML='<i class="fas fa-check"></i> Sent!';
  b.style.background='#22c55e';b.disabled=true;
  setTimeout(()=>{b.innerHTML=o;b.style.background='';b.disabled=false;e.target.reset();},4000);
}
document.querySelectorAll('a[href^="#"]').forEach(a=>{
  a.addEventListener('click',e=>{const t=document.querySelector(a.getAttribute('href'));if(t){e.preventDefault();t.scrollIntoView({behavior:'smooth'});}});
});
</script>
</body>
</html>`;
}

async function generateSite(biz) {
  const ds = getDesign(biz.category);
  const imgs = getImages(biz.category);
  console.log(`🎨 Generating for "${biz.name}" (${getCategory(biz.category)} design)...`);
  const ct = await getAIContent(biz, ds);
  const html = buildHTML(biz, ds, imgs, ct);
  console.log(`✅ Done — ${html.length} chars`);
  return html;
}

// ── ROUTES ────────────────────────────────────────────────────────────────────
app.get("/", (_, res) => res.json({ ok: true, service: "SiteSprint v6 — Unique per business" }));

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
    let biz = (await pool.query("SELECT * FROM businesses WHERE id=$1", [id])).rows[0];
    if (!biz) {
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
  } catch (err) { console.error("🔴", err); res.status(500).json({ error: err.message }); }
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
initDB().then(() => app.listen(PORT, () => console.log(`🚀 SiteSprint v6 on port ${PORT}`)));