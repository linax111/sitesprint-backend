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

// ─── GOOGLE BUSINESS SCRAPER ─────────────────────────────────────────────────
async function resolveUrl(url) {
  // Follow redirects (for goo.gl short links)
  try {
    const r = await fetch(url, {
      method: "HEAD", redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0" }
    });
    return r.url;
  } catch { return url; }
}

async function scrapeGoogleBusiness(rawUrl) {
  console.log("🔍 Scraping:", rawUrl);

  // If Google Places API key exists — use it (most reliable)
  if (process.env.GOOGLE_API_KEY) {
    try {
      const resolved = await resolveUrl(rawUrl);
      // Extract place_id from URL
      const placeMatch = resolved.match(/place_id=([^&]+)/);
      const dataMatch  = resolved.match(/!1s([^!]+)!/);
      let placeId = placeMatch?.[1] || dataMatch?.[1];

      // If no place_id, use text search with business name from URL
      if (!placeId) {
        const nameMatch = resolved.match(/maps\/place\/([^/@]+)/);
        const query = nameMatch ? decodeURIComponent(nameMatch[1].replace(/\+/g," ")) : null;
        if (query) {
          const searchRes = await fetch(
            `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(query)}&inputtype=textquery&fields=place_id&key=${process.env.GOOGLE_API_KEY}`
          );
          const searchData = await searchRes.json();
          placeId = searchData?.candidates?.[0]?.place_id;
        }
      }

      if (placeId) {
        const fields = "name,formatted_address,formatted_phone_number,rating,user_ratings_total,opening_hours,website,types";
        const detailRes = await fetch(
          `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=${fields}&key=${process.env.GOOGLE_API_KEY}`
        );
        const detail = await detailRes.json();
        const p = detail?.result;
        if (p?.name) {
          return {
            name: p.name,
            address: p.formatted_address || "",
            phone: p.formatted_phone_number || "",
            rating: p.rating || 4.5,
            review_count: p.user_ratings_total || 100,
            hours: p.opening_hours?.weekday_text?.join(" | ") || "Mon-Sat 9AM-6PM",
            website: p.website || "",
            category: mapGoogleTypes(p.types || []),
            google_url: rawUrl,
          };
        }
      }
    } catch(e) { console.log("Places API error:", e.message); }
  }

  // Fallback: scrape the HTML page directly
  try {
    const resolved = await resolveUrl(rawUrl);
    const res = await fetch(resolved, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      }
    });
    const html = await res.text();

    // Extract business name from title
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    let name = titleMatch?.[1]
      ?.replace(/\s*-\s*Google Maps.*$/i,"")
      ?.replace(/\s*·\s*Google Maps.*$/i,"")
      ?.trim() || null;

    // Try JSON-LD structured data
    let ldData = null;
    const ldMatches = html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
    for (const m of ldMatches) {
      try {
        const parsed = JSON.parse(m[1]);
        if (parsed["@type"] && (parsed.name || parsed.address)) { ldData = parsed; break; }
      } catch {}
    }

    // Extract from meta tags
    const ogTitle   = html.match(/property="og:title"\s+content="([^"]+)"/)?.[1];
    const ogDesc    = html.match(/property="og:description"\s+content="([^"]+)"/)?.[1];

    // Extract rating from page content (Google embeds it in various places)
    const ratingMatch = html.match(/(\d+\.\d+)\s*\(\s*[\d,]+\s*reviews?\s*\)/i)
      || html.match(/"ratingValue"\s*:\s*"?(\d+\.?\d*)"/i)
      || html.match(/class="[^"]*rating[^"]*"[^>]*>(\d+\.\d+)/i);
    const rating = parseFloat(ratingMatch?.[1]) || ldData?.aggregateRating?.ratingValue || 4.5;

    const reviewMatch = html.match(/([\d,]+)\s*reviews?/i)
      || html.match(/"reviewCount"\s*:\s*"?(\d+)"/i);
    const review_count = parseInt((reviewMatch?.[1] || "").replace(/,/g,"")) || ldData?.aggregateRating?.reviewCount || 100;

    // Extract phone
    const phoneMatch = html.match(/\+?[\d\s\-\(\)]{10,}/g)?.find(p => p.trim().length >= 10)
      || ldData?.telephone || "";

    // Extract address
    const addressMatch = ldData?.address
      ? `${ldData.address.streetAddress||""} ${ldData.address.addressLocality||""} ${ldData.address.addressRegion||""}`.trim()
      : "";

    // Determine category from URL, meta, or LD type
    const urlCat = resolved.match(/maps\/place\/([^/@]+)/)?.[1]?.replace(/\+/g," ") || "";
    const category = ldData?.["@type"] || guessCategoryFromText(urlCat + " " + (ogDesc||"") + " " + (name||""));

    const bizName = name || ogTitle?.replace(/\s*-\s*Google.*$/i,"")?.trim() || "Local Business";

    if (bizName && bizName !== "Local Business") {
      return {
        name: bizName,
        address: addressMatch || "",
        phone: phoneMatch || "",
        rating: Math.min(Math.max(rating, 1), 5),
        review_count: Math.max(review_count, 1),
        hours: ldData?.openingHours || "Mon-Sat 9AM-6PM",
        website: ldData?.url || "",
        category: friendlyCategory(category),
        google_url: rawUrl,
      };
    }
  } catch(e) { console.log("Scrape HTML error:", e.message); }

  return null;
}

function mapGoogleTypes(types) {
  const t = types.join(" ").toLowerCase();
  if (t.includes("hair") || t.includes("beauty") || t.includes("salon")) return "Salon";
  if (t.includes("dentist") || t.includes("dental")) return "Dental";
  if (t.includes("car_repair") || t.includes("auto")) return "Auto Repair";
  if (t.includes("restaurant") || t.includes("food") || t.includes("meal")) return "Restaurant";
  if (t.includes("gym") || t.includes("fitness")) return "Gym";
  if (t.includes("cleaning") || t.includes("plumber") || t.includes("hvac") || t.includes("roofing")) return "Cleaning";
  if (t.includes("cafe") || t.includes("coffee")) return "Cafe";
  if (t.includes("lawyer") || t.includes("legal")) return "Legal";
  if (t.includes("doctor") || t.includes("health") || t.includes("medical")) return "Medical";
  return "Local Business";
}

function guessCategoryFromText(text) {
  const t = (text || "").toLowerCase();
  if (t.includes("hair") || t.includes("beauty") || t.includes("salon") || t.includes("spa")) return "Salon";
  if (t.includes("dentist") || t.includes("dental") || t.includes("orthodon")) return "Dental";
  if (t.includes("auto") || t.includes("car") || t.includes("mechanic") || t.includes("repair")) return "Auto Repair";
  if (t.includes("restaurant") || t.includes("pizza") || t.includes("sushi") || t.includes("grill") || t.includes("bistro")) return "Restaurant";
  if (t.includes("gym") || t.includes("fitness") || t.includes("crossfit") || t.includes("yoga")) return "Gym";
  if (t.includes("clean") || t.includes("maid") || t.includes("hvac") || t.includes("plumb") || t.includes("roof")) return "Cleaning";
  if (t.includes("cafe") || t.includes("coffee") || t.includes("roast")) return "Cafe";
  return "Local Business";
}

function friendlyCategory(raw) {
  if (!raw || typeof raw !== "string") return "Local Business";
  const t = raw.toLowerCase();
  if (t.includes("Salon") || t.includes("beauty") || t.includes("hair")) return "Salon";
  if (t.includes("Dental") || t.includes("dentist")) return "Dental";
  if (t.includes("Auto") || t.includes("car") || t.includes("repair")) return "Auto Repair";
  if (t.includes("Restaurant") || t.includes("food")) return "Restaurant";
  if (t.includes("Gym") || t.includes("fitness")) return "Gym";
  if (t.includes("LegalService") || t.includes("lawyer")) return "Legal";
  if (t.includes("Physician") || t.includes("MedicalBusiness")) return "Medical";
  return raw;
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

function getCatKey(cat) {
  const c = (cat || "").toLowerCase();
  if (c.includes("salon")||c.includes("beauty")||c.includes("hair")||c.includes("spa")) return "salon";
  if (c.includes("dental")||c.includes("dentist")||c.includes("orthodon")) return "dental";
  if (c.includes("auto")||c.includes("repair")||c.includes("mechanic")||c.includes("tire")) return "auto";
  if (c.includes("rest")||c.includes("food")||c.includes("cafe")||c.includes("bistro")||c.includes("pizza")||c.includes("sushi")||c.includes("grill")||c.includes("roast")) return "restaurant";
  if (c.includes("gym")||c.includes("fitness")||c.includes("yoga")||c.includes("crossfit")) return "gym";
  if (c.includes("clean")||c.includes("maid")||c.includes("hvac")||c.includes("plumb")||c.includes("roof")||c.includes("landscape")||c.includes("lawn")) return "cleaning";
  return "default";
}

function getImages(cat) { return IMAGE_BANKS[getCatKey(cat)] || IMAGE_BANKS.default; }

// ─── UNIQUE DESIGN SYSTEMS (1 per industry) ───────────────────────────────────
const DS = {
  salon: {
    fonts:`@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;0,700;1,400;1,700&family=Jost:wght@300;400;500;600&display=swap');`,
    hf:"'Cormorant Garamond',serif", bf:"'Jost',sans-serif",
    bg:"#0a0506",sf:"#160b0e",card:"#1e1115",
    pr:"#C4956A",ac:"#E8C9A0",tx:"#f5ede8",mu:"#9a7a6a",gl:"196,149,106",
    stats:[{n:"2,400+",l:"Happy Clients"},{n:"98%",l:"Return Rate"},{n:"8",l:"Expert Stylists"},{n:"12yr",l:"Est."} ],
    svcs:[{ic:"fa-scissors",n:"Precision Cuts",d:"Tailored cuts designed around your face shape, lifestyle, and vision."},{ic:"fa-palette",n:"Color & Highlights",d:"Balayage, ombré, and full-color transformations using premium organic dyes."},{ic:"fa-spa",n:"Luxury Treatments",d:"Deep conditioning, keratin therapy, and scalp treatments for hair health."}],
    revs:[{n:"Sophia L.",av:"SL",t:"This salon is pure artistry. They transformed my hair into exactly what I envisioned.",r:"Loyal client since 2019"},{n:"Isabella M.",av:"IM",t:"The stylists are true professionals. Worth every penny and then some.",r:"Monthly visitor"},{n:"Charlotte R.",av:"CR",t:"I drive 40 minutes just to come here. There's nowhere else I'd trust with my hair.",r:"5-star reviewer"}],
    h1a:"Where Beauty Becomes",h1b:"Art",sub:"Expert stylists dedicated to bringing your vision to life with precision and passion.",cta:"Book Your Transformation",tag:"Beauty elevated. Confidence restored.",caps:false,
  },
  dental: {
    fonts:`@import url('https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500;600&display=swap');`,
    hf:"'DM Serif Display',serif", bf:"'DM Sans',sans-serif",
    bg:"#010919",sf:"#041228",card:"#071a36",
    pr:"#38BDF8",ac:"#BAE6FD",tx:"#edf8ff",mu:"#6aaccc",gl:"56,189,248",
    stats:[{n:"5,000+",l:"Smiles Transformed"},{n:"4.9★",l:"Patient Rating"},{n:"15yr",l:"Experience"},{n:"Zero",l:"Pain Policy"}],
    svcs:[{ic:"fa-tooth",n:"Smile Makeovers",d:"Complete aesthetic transformations combining veneers, whitening, and contouring."},{ic:"fa-shield-halved",n:"Preventive Care",d:"Comprehensive checkups and cleanings to keep your teeth healthy for life."},{ic:"fa-wand-magic-sparkles",n:"Teeth Whitening",d:"Professional whitening that delivers dramatic results in a single visit."}],
    revs:[{n:"Mark T.",av:"MT",t:"I used to dread dentist visits. Now I look forward to them. The team is genuinely caring and incredibly skilled.",r:"Patient since 2020"},{n:"Jennifer P.",av:"JP",t:"My smile makeover exceeded every expectation. The before and after is unbelievable.",r:"Smile transformation"},{n:"David R.",av:"DR",t:"Pain-free, professional, and they explain everything clearly. Best dental experience of my life.",r:"Family patient"}],
    h1a:"Your Dream Smile",h1b:"Starts Here",sub:"Advanced dental care delivered with compassion, precision, and a commitment to your comfort.",cta:"Schedule Your Visit",tag:"Advanced care. Beautiful smiles. Zero anxiety.",caps:false,
  },
  auto: {
    fonts:`@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Barlow:wght@300;400;500;600;700&display=swap');`,
    hf:"'Bebas Neue',sans-serif", bf:"'Barlow',sans-serif",
    bg:"#060400",sf:"#0f0b02",card:"#181205",
    pr:"#F59E0B",ac:"#FDE68A",tx:"#fff8e8",mu:"#b89848",gl:"245,158,11",
    stats:[{n:"10K+",l:"Vehicles Serviced"},{n:"Same",l:"Day Service"},{n:"$0",l:"Hidden Fees"},{n:"20yr",l:"Experience"}],
    svcs:[{ic:"fa-magnifying-glass",n:"Full Diagnostics",d:"State-of-the-art computer diagnostics identifying every issue fast and accurately."},{ic:"fa-car-burst",n:"Collision & Body",d:"Expert bodywork and paint matching that makes your car look factory-new again."},{ic:"fa-gear",n:"Full Mechanical",d:"Brakes, suspension, transmission — every system by certified master mechanics."}],
    revs:[{n:"James H.",av:"JH",t:"These guys saved my engine. Fixed it for a fraction of what other shops quoted. Legends.",r:"Engine rebuild customer"},{n:"Mike S.",av:"MS",t:"Honest, fast, and they actually show you what's wrong before charging you a dime.",r:"Regular customer"},{n:"Roberto C.",av:"RC",t:"Same-day service on a complex brake job. Best shop in the city, no contest.",r:"5-star reviewer"}],
    h1a:"YOUR CAR DESERVES",h1b:"THE BEST",sub:"Honest diagnostics, expert repairs, and fair pricing — your vehicle is in expert hands.",cta:"Get Free Estimate",tag:"Trusted mechanics. Honest pricing. Fast turnaround.",caps:true,
  },
  restaurant: {
    fonts:`@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;0,900;1,400&family=Lato:wght@300;400;700&display=swap');`,
    hf:"'Playfair Display',serif", bf:"'Lato',sans-serif",
    bg:"#080200",sf:"#120700",card:"#1a0e03",
    pr:"#E8844A",ac:"#F4B87A",tx:"#fff5ee",mu:"#c4926e",gl:"232,132,74",
    stats:[{n:"12yr",l:"Open Since"},{n:"4.8★",l:"Dining Rating"},{n:"200+",l:"Wine Labels"},{n:"Chef",l:"Crafted Daily"}],
    svcs:[{ic:"fa-utensils",n:"À La Carte Dining",d:"Seasonal menus crafted from locally-sourced ingredients with global inspiration."},{ic:"fa-champagne-glasses",n:"Private Events",d:"Intimate dinners to grand celebrations — unforgettable experiences for every occasion."},{ic:"fa-wine-glass",n:"Wine & Cocktails",d:"A curated cellar of 200+ labels paired with house-crafted cocktails."}],
    revs:[{n:"Emily W.",av:"EW",t:"The best meal I've had in years. Bold flavors, perfect execution, and service that made us feel like royalty.",r:"Food critic"},{n:"Thomas B.",av:"TB",t:"Our anniversary dinner was flawless. The chef personally came to our table. Unforgettable.",r:"Anniversary dinner"},{n:"Priya K.",av:"PK",t:"I've traveled the world and this kitchen holds its own with the finest. Passion in every plate.",r:"Food lover"}],
    h1a:"An Experience",h1b:"Beyond the Plate",sub:"Where every ingredient tells a story and every meal becomes a memory worth keeping.",cta:"Reserve a Table",tag:"Exceptional cuisine. Unforgettable moments.",caps:false,
  },
  gym: {
    fonts:`@import url('https://fonts.googleapis.com/css2?family=Oswald:wght@400;600;700&family=Inter:wght@300;400;500;600&display=swap');`,
    hf:"'Oswald',sans-serif", bf:"'Inter',sans-serif",
    bg:"#04000f",sf:"#090220",card:"#100530",
    pr:"#A855F7",ac:"#D946EF",tx:"#f8f0ff",mu:"#8855c0",gl:"168,85,247",
    stats:[{n:"1,200+",l:"Active Members"},{n:"35+",l:"Weekly Classes"},{n:"15",l:"Elite Trainers"},{n:"98%",l:"Goal Achievement"}],
    svcs:[{ic:"fa-dumbbell",n:"Personal Training",d:"1-on-1 coaching with certified trainers designing programs around your exact goals."},{ic:"fa-people-group",n:"Group Classes",d:"30+ weekly classes — HIIT, strength, yoga, spin — for every fitness level."},{ic:"fa-chart-line",n:"Nutrition Coaching",d:"Personalized meal plans and ongoing support to fuel your transformation."}],
    revs:[{n:"Alex T.",av:"AT",t:"I've been to 6 gyms in this city. Nothing comes close. The trainers push you past what you think is possible.",r:"Lost 40lbs in 5 months"},{n:"Maria G.",av:"MG",t:"The community here changed my life. Started as a beginner, now I'm competing. This gym does that.",r:"Member since 2021"},{n:"Derek L.",av:"DL",t:"State-of-the-art equipment, expert coaches, and an energy that fires you up every single session.",r:"Personal training client"}],
    h1a:"TRANSFORM YOUR",h1b:"LIMITS",sub:"Elite coaching, cutting-edge equipment, and a community that pushes you to your personal best.",cta:"Start Your Journey",tag:"No limits. No excuses. Just results.",caps:true,
  },
  cleaning: {
    fonts:`@import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800&family=Open+Sans:wght@300;400;600&display=swap');`,
    hf:"'Nunito',sans-serif", bf:"'Open Sans',sans-serif",
    bg:"#010d08",sf:"#031a10",card:"#052018",
    pr:"#10B981",ac:"#6EE7B7",tx:"#edfff6",mu:"#60a880",gl:"16,185,129",
    stats:[{n:"800+",l:"Happy Clients"},{n:"5★",l:"Average Rating"},{n:"Eco",l:"Safe Products"},{n:"100%",l:"Satisfaction"}],
    svcs:[{ic:"fa-house",n:"Residential Deep Clean",d:"Top-to-bottom cleaning covering every corner, surface, and detail of your home."},{ic:"fa-building",n:"Commercial Cleaning",d:"Professional office and commercial space cleaning maintaining a spotless environment."},{ic:"fa-sparkles",n:"Move In / Move Out",d:"Complete cleaning packages ensuring every space is pristine for new occupants."}],
    revs:[{n:"Rachel S.",av:"RS",t:"My house has never been this clean. They pay attention to details I didn't even think about.",r:"Weekly client"},{n:"Kevin M.",av:"KM",t:"After construction left our home a disaster, these pros made it spotless in one visit.",r:"Post-construction clean"},{n:"Amy L.",av:"AL",t:"Reliable, thorough, and trustworthy. Same team for 2 years and they never disappoint.",r:"Bi-weekly customer"}],
    h1a:"Spotlessly Clean,",h1b:"Guaranteed",sub:"Professional cleaning services that leave your space immaculate — every visit, no exceptions.",cta:"Get Free Quote",tag:"Cleaner spaces. Happier lives. Every time.",caps:false,
  },
  default: {
    fonts:`@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=Inter:wght@300;400;500;600;700&display=swap');`,
    hf:"'Playfair Display',serif", bf:"'Inter',sans-serif",
    bg:"#05050f",sf:"#0c0c20",card:"#101028",
    pr:"#6366F1",ac:"#A5B4FC",tx:"#f0f0ff",mu:"#8080c0",gl:"99,102,241",
    stats:[{n:"500+",l:"Happy Clients"},{n:"5★",l:"Average Rating"},{n:"10yr",l:"Experience"},{n:"100%",l:"Satisfaction"}],
    svcs:[{ic:"fa-star",n:"Premium Service",d:"Top-tier quality delivered with care, expertise, and attention to every detail."},{ic:"fa-shield-halved",n:"Trusted Expertise",d:"Years of experience and a track record of excellence that speaks for itself."},{ic:"fa-handshake",n:"Customer First",d:"Your satisfaction is our priority — we go above and beyond on every project."}],
    revs:[{n:"Chris L.",av:"CL",t:"Exceptional service from start to finish. Highly professional and quality that speaks for itself.",r:"Verified customer"},{n:"Sarah M.",av:"SM",t:"I've tried many providers and none come close to this level of care and expertise.",r:"Long-term client"},{n:"James P.",av:"JP",t:"Reliable, skilled, and genuinely committed to customer satisfaction. 10 out of 10.",r:"Regular customer"}],
    h1a:"Excellence You Can",h1b:"Count On",sub:"Professional services delivered with expertise, integrity, and a commitment to your satisfaction.",cta:"Get Started Today",tag:"Quality. Integrity. Results.",caps:false,
  },
};

function getDS(cat) { return DS[getCatKey(cat)] || DS.default; }

// ─── AI: short content only ───────────────────────────────────────────────────
async function getAIContent(biz) {
  const prompt = `Business: "${biz.name}" | Type: ${biz.category} | Rating: ${biz.rating}★ (${biz.review_count} reviews) | Location: ${biz.address||""}

Return ONLY this JSON (no markdown, no extra text):
{"tag":"5-word location tagline","hl":"2-3 word italic headline highlight","sub":"15-word max value proposition","s1":"service name","d1":"10-word desc","s2":"service name","d2":"10-word desc","s3":"service name","d3":"10-word desc","g1":"gallery label","g2":"gallery label","g3":"gallery label","g4":"gallery label","ftag":"6-word footer tagline"}`;
  try {
    const r = await anthropic.messages.create({ model:"claude-sonnet-4-6", max_tokens:500, messages:[{role:"user",content:prompt}] });
    const raw = r.content[0].text.trim().replace(/^```json?\n?/,"").replace(/```$/,"").trim();
    return JSON.parse(raw);
  } catch(e) { console.error("AI content err:", e.message); return null; }
}

// ─── BUILD HTML (CSS fully hardcoded) ─────────────────────────────────────────
function buildHTML(biz, ds, imgs, ct) {
  const ltr = (biz.name||"B")[0].toUpperCase();
  const words = biz.name.split(" ");
  const nm1 = words[0], nm2 = words.slice(1).join(" ");
  const hl   = ct?.hl  || ds.h1b;
  const sub  = ct?.sub || ds.sub;
  const tag  = ct?.tag || ds.tag;
  const htag = ct?.tag || `Premium ${biz.category} · ${biz.address?.split(",")[0]||"Local"}`;
  const ftag = ct?.ftag|| ds.tag;
  const s1n=ct?.s1||ds.svcs[0].n, s1d=ct?.d1||ds.svcs[0].d;
  const s2n=ct?.s2||ds.svcs[1].n, s2d=ct?.d2||ds.svcs[1].d;
  const s3n=ct?.s3||ds.svcs[2].n, s3d=ct?.d3||ds.svcs[2].d;
  const g1=ct?.g1||"Featured Work", g2=ct?.g2||"Our Process", g3=ct?.g3||"Results", g4=ct?.g4||"Portfolio";
  const caps = ds.caps;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${biz.name}</title>
<style>${ds.fonts}</style>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{background:${ds.bg};color:${ds.tx};font-family:${ds.bf};overflow-x:hidden;line-height:1.6}
a{text-decoration:none;color:inherit}
::selection{background:${ds.pr};color:#000}
::-webkit-scrollbar{width:4px}
::-webkit-scrollbar-track{background:${ds.bg}}
::-webkit-scrollbar-thumb{background:${ds.pr};border-radius:2px}
h1,h2,h3{font-family:${ds.hf};${caps?"letter-spacing:2px;":""}}

/* NAV */
nav{position:fixed;top:0;left:0;right:0;z-index:999;display:flex;align-items:center;justify-content:space-between;padding:20px 6%;transition:all .4s}
nav.s{background:rgba(0,0,0,.94);backdrop-filter:blur(24px);padding:13px 6%;border-bottom:1px solid rgba(${ds.gl},.14)}
.nl{display:flex;align-items:center;gap:12px}
.li{width:36px;height:36px;min-width:36px;background:${ds.pr};border-radius:9px;display:flex;align-items:center;justify-content:center;font-family:${ds.hf};font-weight:700;font-size:1.1rem;color:#fff}
.ln{font-family:${ds.hf};font-size:1.1rem;font-weight:700;${caps?"letter-spacing:1px;":""}}
.ln em{color:${ds.pr};font-style:normal}
.nm{display:flex;list-style:none;gap:32px}
.nm a{font-size:.78rem;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:rgba(255,255,255,.55);transition:color .3s}
.nm a:hover{color:${ds.ac}}
.nb{background:${ds.pr};color:#fff;padding:10px 24px;border-radius:50px;font-size:.8rem;font-weight:700;letter-spacing:.5px;transition:all .3s;display:inline-block}
.nb:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(${ds.gl},.45)}

/* HERO */
.hero{position:relative;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;overflow:hidden}
.hbg{position:absolute;inset:0;background-size:cover;background-position:center;transform:scale(1.05);transition:transform 10s ease}
.hero:hover .hbg{transform:scale(1.0)}
.hov{position:absolute;inset:0;background:linear-gradient(155deg,${ds.bg}f5 0%,${ds.bg}80 45%,${ds.bg}e8 100%)}
.hb{position:relative;z-index:2;max-width:880px;padding:138px 24px 80px}
.hbd{display:inline-flex;align-items:center;gap:10px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.16);backdrop-filter:blur(10px);border-radius:100px;padding:10px 22px;font-size:.8rem;font-weight:600;margin-bottom:26px}
.hbd .st{color:#FFD700}
.ht{color:${ds.ac};font-size:.7rem;font-weight:700;letter-spacing:5px;text-transform:uppercase;margin-bottom:16px}
.hero h1{font-family:${ds.hf};font-size:clamp(2.8rem,6.5vw,5.5rem);font-weight:900;line-height:1.06;margin-bottom:22px;${caps?"letter-spacing:3px;":""}color:${ds.tx}}
.hero h1 .hl{color:${ds.pr};${caps?"":"font-style:italic;"}}
.hsb{font-size:1.05rem;color:${ds.mu};max-width:540px;margin:0 auto 44px;font-weight:300}
.hbtns{display:flex;gap:16px;justify-content:center;flex-wrap:wrap}
.bp{display:inline-flex;align-items:center;gap:10px;background:${ds.pr};color:#fff;padding:15px 38px;border-radius:50px;font-weight:700;font-size:.97rem;border:none;cursor:pointer;transition:all .35s}
.bp:hover{transform:translateY(-3px);box-shadow:0 16px 44px rgba(${ds.gl},.45)}
.bg2{display:inline-flex;align-items:center;gap:10px;background:rgba(255,255,255,.05);color:${ds.tx};padding:15px 38px;border-radius:50px;font-weight:600;font-size:.97rem;border:1px solid rgba(255,255,255,.2);cursor:pointer;transition:all .35s;backdrop-filter:blur(8px)}
.bg2:hover{border-color:${ds.pr};color:${ds.pr};transform:translateY(-3px)}
.sc{position:absolute;bottom:28px;left:50%;transform:translateX(-50%);font-size:.65rem;letter-spacing:3px;text-transform:uppercase;color:${ds.mu};animation:bounce 2.5s infinite;display:flex;flex-direction:column;align-items:center;gap:5px}

/* STATS */
.stats{padding:48px 6%;background:rgba(255,255,255,.022);border-top:1px solid rgba(${ds.gl},.1);border-bottom:1px solid rgba(${ds.gl},.1)}
.sg{display:grid;grid-template-columns:repeat(4,1fr);gap:28px;max-width:880px;margin:0 auto;text-align:center}
.sn{font-family:${ds.hf};font-size:2.7rem;font-weight:900;background:linear-gradient(135deg,${ds.pr},${ds.ac});-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;line-height:1}
.sl{font-size:.68rem;letter-spacing:3px;text-transform:uppercase;color:${ds.mu};margin-top:7px}

/* SERVICES */
.sec{padding:96px 6%}
.sh{text-align:center;margin-bottom:64px}
.ey{color:${ds.ac};font-size:.7rem;font-weight:700;letter-spacing:5px;text-transform:uppercase;display:block;margin-bottom:12px}
.st2{font-family:${ds.hf};font-size:clamp(1.9rem,3.5vw,2.9rem);font-weight:900;margin-bottom:12px;${caps?"letter-spacing:2px;":""}color:${ds.tx}}
.ss{color:${ds.mu};font-size:.95rem;max-width:480px;margin:0 auto;font-weight:300}
.svgg{display:grid;grid-template-columns:repeat(3,1fr);gap:0;border:1px solid rgba(${ds.gl},.12);border-radius:20px;overflow:hidden}
.svc{background:${ds.card};padding:44px 32px;position:relative;overflow:hidden;transition:background .4s;border-right:1px solid rgba(${ds.gl},.08)}
.svc:last-child{border-right:none}
.svc::before{content:'';position:absolute;inset:0;background:linear-gradient(135deg,rgba(${ds.gl},.06) 0%,transparent 60%);opacity:0;transition:opacity .4s}
.svc:hover::before{opacity:1}
.svc::after{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,transparent,${ds.pr},transparent);transform:scaleX(0);transition:transform .5s}
.svc:hover::after{transform:scaleX(1)}
.svn{font-family:${ds.hf};font-size:5rem;font-weight:900;color:${ds.pr};opacity:.06;position:absolute;top:12px;right:20px;line-height:1}
.sic{width:52px;height:52px;background:rgba(${ds.gl},.1);border:1px solid rgba(${ds.gl},.2);border-radius:14px;display:flex;align-items:center;justify-content:center;margin-bottom:20px;transition:all .4s}
.svc:hover .sic{background:rgba(${ds.gl},.22);box-shadow:0 0 22px rgba(${ds.gl},.25)}
.sic i{font-size:1.3rem;color:${ds.pr}}
.svc h3{font-family:${ds.hf};font-size:1.15rem;font-weight:700;margin-bottom:10px;${caps?"letter-spacing:1px;":""}color:${ds.tx}}
.svc p{font-size:.88rem;color:${ds.mu};line-height:1.8}

/* GALLERY */
.gal{padding:96px 6%;background:${ds.sf}}
.gg{display:grid;grid-template-columns:2fr 1fr 1fr;grid-template-rows:260px 260px;gap:14px;margin-top:60px}
.gi{border-radius:14px;overflow:hidden;position:relative;cursor:pointer}
.gi:first-child{grid-row:1/3}
.gbg{width:100%;height:100%;background-size:cover;background-position:center;transition:transform .6s}
.gi:hover .gbg{transform:scale(1.07)}
.gov{position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,.78) 0%,transparent 55%);opacity:0;transition:opacity .4s;display:flex;align-items:flex-end;padding:20px}
.gi:hover .gov{opacity:1}
.glbl{font-family:${ds.hf};font-size:.95rem;font-weight:700;color:#fff;${caps?"letter-spacing:1px;text-transform:uppercase;":""}text-shadow:0 1px 4px rgba(0,0,0,.5)}

/* REVIEWS */
.rev{padding:96px 6%}
.rg{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-top:60px}
.rc{background:${ds.card};border:1px solid rgba(${ds.gl},.1);border-radius:20px;padding:32px;transition:all .4s;position:relative;overflow:hidden}
.rc::before{content:'';position:absolute;bottom:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,${ds.pr},transparent);transform:scaleX(0);transition:transform .5s}
.rc:hover::before{transform:scaleX(1)}
.rc:hover{border-color:rgba(${ds.gl},.3);transform:translateY(-6px);box-shadow:0 20px 60px rgba(0,0,0,.4)}
.rq{font-size:3rem;color:${ds.pr};opacity:.15;line-height:1;font-family:${ds.hf};margin-bottom:4px}
.rs{color:#FFD700;font-size:.78rem;letter-spacing:2px;margin-bottom:12px}
.rt{font-size:.9rem;color:${ds.mu};line-height:1.85;font-style:italic;margin-bottom:24px}
.rw{display:flex;align-items:center;gap:12px}
.ra{width:40px;height:40px;border-radius:50%;background:rgba(${ds.gl},.15);border:2px solid rgba(${ds.gl},.3);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:.76rem;color:${ds.pr};flex-shrink:0}
.rn{font-weight:700;font-size:.87rem}
.rr{font-size:.7rem;color:${ds.mu}}

/* CONTACT */
.con{padding:96px 6%;background:${ds.sf}}
.ci{display:grid;grid-template-columns:1fr 1.4fr;gap:72px;max-width:1080px;margin:60px auto 0;align-items:start}
.cl h3{font-family:${ds.hf};font-size:1.7rem;font-weight:700;margin-bottom:10px;color:${ds.tx}}
.cl p{color:${ds.mu};font-size:.92rem;margin-bottom:40px;line-height:1.8}
.cr{display:flex;align-items:flex-start;gap:16px;margin-bottom:26px}
.cic{width:46px;height:46px;min-width:46px;background:rgba(${ds.gl},.1);border:1px solid rgba(${ds.gl},.18);border-radius:12px;display:flex;align-items:center;justify-content:center;transition:all .3s}
.cr:hover .cic{background:rgba(${ds.gl},.2);box-shadow:0 0 16px rgba(${ds.gl},.2)}
.cic i{color:${ds.pr};font-size:.92rem}
.clbl{font-size:.67rem;letter-spacing:3px;text-transform:uppercase;color:${ds.mu};margin-bottom:4px}
.cv{font-weight:600;font-size:.95rem}
.cf{background:${ds.card};border:1px solid rgba(${ds.gl},.12);border-radius:20px;padding:40px 36px}
.fr2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.fg{margin-bottom:16px}
.fl{display:block;font-size:.67rem;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:${ds.mu};margin-bottom:7px}
.fi{width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.09);border-radius:10px;padding:13px 15px;color:${ds.tx};font-size:.94rem;font-family:${ds.bf};transition:all .3s;outline:none}
.fi:focus{border-color:${ds.pr};background:rgba(${ds.gl},.05);box-shadow:0 0 0 3px rgba(${ds.gl},.1)}
.fi::placeholder{color:rgba(255,255,255,.2)}
textarea.fi{min-height:115px;resize:vertical}
.fsb{width:100%;padding:15px;font-size:.95rem;font-weight:700;letter-spacing:.5px;margin-top:6px;font-family:${ds.bf}}

/* FOOTER */
footer{padding:64px 6% 32px;border-top:1px solid rgba(${ds.gl},.1);text-align:center}
.fll{display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:12px}
.fic{width:40px;height:40px;background:${ds.pr};border-radius:10px;display:flex;align-items:center;justify-content:center;font-family:${ds.hf};font-weight:700;font-size:.95rem;color:#fff}
.fn{font-family:${ds.hf};font-size:1.4rem;font-weight:700;color:${ds.pr}}
.ftg{color:${ds.mu};font-size:.87rem;margin-bottom:32px}
.fls{display:flex;gap:24px;justify-content:center;list-style:none;margin-bottom:32px}
.fls a{font-size:.73rem;letter-spacing:1.5px;text-transform:uppercase;color:${ds.mu};transition:color .3s}
.fls a:hover{color:${ds.ac}}
.fc{color:rgba(255,255,255,.16);font-size:.73rem}

/* ANIM */
@keyframes fadeUp{from{opacity:0;transform:translateY(28px)}to{opacity:1;transform:translateY(0)}}
@keyframes bounce{0%,100%{transform:translateX(-50%) translateY(0)}50%{transform:translateX(-50%) translateY(-7px)}}
.hb>*{animation:fadeUp .9s ease both}
.hbd{animation-delay:.0s!important}.ht{animation-delay:.1s!important}
.hero h1{animation-delay:.2s!important}.hsb{animation-delay:.3s!important}.hbtns{animation-delay:.4s!important}
.sc{animation:bounce 2.5s 1s infinite}
.an{opacity:0;transform:translateY(24px);transition:opacity .7s,transform .7s}
.an.in{opacity:1;transform:translateY(0)}
.d1{transition-delay:.12s}.d2{transition-delay:.24s}.d3{transition-delay:.36s}
@media(max-width:900px){
  .nm{display:none}
  .sg{grid-template-columns:repeat(2,1fr)}
  .svgg{grid-template-columns:1fr}
  .svc{border-right:none;border-bottom:1px solid rgba(${ds.gl},.08)}
  .svc:last-child{border-bottom:none}
  .gg{grid-template-columns:1fr;grid-template-rows:auto}
  .gi:first-child{grid-row:auto}.gi{height:220px}
  .rg{grid-template-columns:1fr}
  .ci{grid-template-columns:1fr;gap:44px}
  .fr2{grid-template-columns:1fr}
}
</style>
</head>
<body>

<nav id="nav">
  <div class="nl">
    <div class="li">${ltr}</div>
    <div class="ln"><em>${nm1}</em>${nm2?" "+nm2:""}</div>
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
    <p class="ht">${htag}</p>
    <h1>${ds.h1a} <span class="hl">${hl}</span></h1>
    <p class="hsb">${sub}</p>
    <div class="hbtns">
      <a href="#contact" class="bp"><i class="fas fa-calendar-check"></i> ${ds.cta}</a>
      <a href="#services" class="bg2"><i class="fas fa-arrow-right"></i> Our Services</a>
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
    <span class="ey">What We Offer</span>
    <h2 class="st2">Our Premium Services</h2>
    <p class="ss">Exceptional quality and care delivered on every visit, guaranteed.</p>
  </div>
  <div class="svgg">
    <div class="svc an"><div class="svn">01</div><div class="sic"><i class="fas ${ds.svcs[0].ic}"></i></div><h3>${s1n}</h3><p>${s1d}</p></div>
    <div class="svc an d1"><div class="svn">02</div><div class="sic"><i class="fas ${ds.svcs[1].ic}"></i></div><h3>${s2n}</h3><p>${s2d}</p></div>
    <div class="svc an d2"><div class="svn">03</div><div class="sic"><i class="fas ${ds.svcs[2].ic}"></i></div><h3>${s3n}</h3><p>${s3d}</p></div>
  </div>
</section>

<section class="gal" id="gallery">
  <div class="sh">
    <span class="ey">Our Work</span>
    <h2 class="st2">Results That Speak</h2>
    <p class="ss">Real work from real projects — quality you can see.</p>
  </div>
  <div class="gg">
    <div class="gi an"><div class="gbg" style="background-image:url('${imgs[2]}')"></div><div class="gov"><span class="glbl">${g1}</span></div></div>
    <div class="gi an d1"><div class="gbg" style="background-image:url('${imgs[3]}')"></div><div class="gov"><span class="glbl">${g2}</span></div></div>
    <div class="gi an d2"><div class="gbg" style="background-image:url('${imgs[4]}')"></div><div class="gov"><span class="glbl">${g3}</span></div></div>
    <div class="gi an d1"><div class="gbg" style="background-image:url('${imgs[5]}')"></div><div class="gov"><span class="glbl">${g4}</span></div></div>
  </div>
</section>

<section class="rev" id="reviews">
  <div class="sh">
    <span class="ey">Client Reviews</span>
    <h2 class="st2">What Our Clients Say</h2>
    <p class="ss">Real reviews from verified customers who trust us with what matters most.</p>
  </div>
  <div class="rg">
    ${ds.revs.map((r,i)=>`<div class="rc an${i?" d"+i:""}"><div class="rq">"</div><div class="rs">★★★★★</div><p class="rt">${r.t}</p><div class="rw"><div class="ra">${r.av}</div><div><div class="rn">${r.n}</div><div class="rr">${r.r}</div></div></div></div>`).join("")}
  </div>
</section>

<section class="con" id="contact">
  <div class="sh">
    <span class="ey">Get In Touch</span>
    <h2 class="st2">Book Your Appointment</h2>
    <p class="ss">Ready to get started? We'd love to hear from you today.</p>
  </div>
  <div class="ci">
    <div class="cl">
      <h3>Let's connect</h3>
      <p>Reach out and let our expert team handle everything from start to finish.</p>
      <div class="cr"><div class="cic"><i class="fas fa-phone"></i></div><div><p class="clbl">Phone</p><p class="cv">${biz.phone||"Call us today"}</p></div></div>
      <div class="cr"><div class="cic"><i class="fas fa-location-dot"></i></div><div><p class="clbl">Address</p><p class="cv">${biz.address||"Visit our location"}</p></div></div>
      <div class="cr"><div class="cic"><i class="fas fa-clock"></i></div><div><p class="clbl">Hours</p><p class="cv">${biz.hours||"Mon-Sat 9AM-6PM"}</p></div></div>
    </div>
    <div class="cf">
      <form onsubmit="hf(event)">
        <div class="fr2"><div class="fg"><label class="fl">First Name</label><input class="fi" type="text" placeholder="John" required></div><div class="fg"><label class="fl">Last Name</label><input class="fi" type="text" placeholder="Smith" required></div></div>
        <div class="fr2"><div class="fg"><label class="fl">Email</label><input class="fi" type="email" placeholder="you@email.com" required></div><div class="fg"><label class="fl">Phone</label><input class="fi" type="tel" placeholder="(555) 000-0000"></div></div>
        <div class="fg"><label class="fl">Message</label><textarea class="fi" placeholder="How can we help you?"></textarea></div>
        <button type="submit" class="bp fsb">Send Message <i class="fas fa-arrow-right"></i></button>
      </form>
    </div>
  </div>
</section>

<footer>
  <div class="fll"><div class="fic">${ltr}</div><div class="fn">${biz.name}</div></div>
  <p class="ftg">${ftag}</p>
  <ul class="fls"><li><a href="#services">Services</a></li><li><a href="#gallery">Gallery</a></li><li><a href="#reviews">Reviews</a></li><li><a href="#contact">Contact</a></li></ul>
  <p class="fc">&copy; 2025 ${biz.name}. All rights reserved.</p>
</footer>

<script>
window.addEventListener('scroll',()=>{document.getElementById('nav').classList.toggle('s',window.scrollY>70);});
const io=new IntersectionObserver(es=>{es.forEach(e=>{if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target);}});},{threshold:.1});
document.querySelectorAll('.an').forEach(el=>io.observe(el));
function hf(e){e.preventDefault();const b=e.target.querySelector('button[type=submit]');const o=b.innerHTML;b.innerHTML='<i class="fas fa-check"></i> Sent!';b.style.background='#22c55e';b.disabled=true;setTimeout(()=>{b.innerHTML=o;b.style.background='';b.disabled=false;e.target.reset();},4000);}
document.querySelectorAll('a[href^="#"]').forEach(a=>{a.addEventListener('click',e=>{const t=document.querySelector(a.getAttribute('href'));if(t){e.preventDefault();t.scrollIntoView({behavior:'smooth'});}});});
</script>
</body></html>`;
}

async function generateSite(biz) {
  const ds = getDS(biz.category);
  const imgs = getImages(biz.category);
  console.log(`🎨 Building "${biz.name}" [${getCatKey(biz.category)} design]`);
  const ct = await getAIContent(biz);
  return buildHTML(biz, ds, imgs, ct);
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.get("/", (_, res) => res.json({ ok:true, service:"SiteSprint v7" }));

// 🆕 BUILD FROM GOOGLE URL
app.post("/api/from-google", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "Google Maps URL required" });

    const bizData = await scrapeGoogleBusiness(url);
    if (!bizData) return res.status(422).json({ error: "Could not extract business info from this URL. Try a direct Google Maps link." });

    // Save to DB
    const saved = (await pool.query(
      `INSERT INTO businesses (name,address,phone,category,rating,review_count,hours,website,google_url,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'prospect') RETURNING *`,
      [bizData.name,bizData.address,bizData.phone,bizData.category,bizData.rating,bizData.review_count,bizData.hours,bizData.website,url]
    )).rows[0];

    // Generate site immediately
    const html = await generateSite(saved);
    const slug = `${saved.id}-${Date.now()}`;
    await pool.query(`INSERT INTO generated_sites (business_id,slug,html) VALUES ($1,$2,$3)`, [saved.id,slug,html]);
    await pool.query("UPDATE businesses SET preview_slug=$1,status='site shown' WHERE id=$2", [slug,saved.id]);

    res.json({ business: saved, slug, previewUrl: `/preview/${slug}`, bizData });
  } catch(err) {
    console.error("🔴 from-google error:", err);
    res.status(500).json({ error: err.message });
  }
});

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
    const sets=[], params=[];
    for (const col of allowed) { if(col in b){sets.push(`${col}=$${params.length+1}`);params.push(b[col]);} }
    if (!sets.length) return res.json({ ok:true });
    sets.push("updated_at=NOW()"); params.push(id);
    await pool.query(`UPDATE businesses SET ${sets.join(",")} WHERE id=$${params.length}`, params);
    res.json((await pool.query("SELECT * FROM businesses WHERE id=$1",[id])).rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/businesses/:id", async (req, res) => {
  try { await pool.query("DELETE FROM businesses WHERE id=$1",[req.params.id]); res.json({deleted:true}); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/search", async (req, res) => {
  try {
    const { area } = req.body; if (!area) return res.status(400).json({ error:"area required" });
    const cats = [
      {cat:"Auto Repair",name:"Motors & Glass"},{cat:"Restaurant",name:"Grill & Bistro"},
      {cat:"Salon",name:"Beauty Studio"},{cat:"Plumbing",name:"Rooter Services"},
      {cat:"Dental",name:"Family Dentistry"},{cat:"Gym",name:"Fitness Center"},
      {cat:"Landscaping",name:"Lawn & Garden"},{cat:"Roofing",name:"Roofing Experts"},
      {cat:"Cafe",name:"Coffee Roasters"},{cat:"Cleaning",name:"Commercial Cleaners"}
    ];
    const results=[];
    for(let i=1;i<=20;i++){const t=cats[i%cats.length];results.push({id:1000+i,name:`${area} Elite ${t.name}`,address:`${100+i*15} Commerce Blvd, ${area}`,phone:`(555) 019-${(i*123).toString().padStart(4,"0")}`,category:t.cat,rating:parseFloat((4+Math.random()).toFixed(1)),review_count:Math.floor(Math.random()*400)+45,hours:"Mon-Sat 8AM-6PM",area_searched:area});}
    res.json(results);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const generateHandler = async (req, res) => {
  try {
    const { id } = req.params;
    let biz = (await pool.query("SELECT * FROM businesses WHERE id=$1",[id])).rows[0];
    if (!biz) {
      const b = req.body;
      biz = (await pool.query(`INSERT INTO businesses (name,address,phone,category,rating,review_count,hours,status,area_searched) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[b.name||"Business",b.address||"",b.phone||"",b.category||"",b.rating||5,b.review_count||50,b.hours||"","prospect",b.area_searched||""])).rows[0];
    }
    const html = await generateSite(biz);
    const slug = `${biz.id}-${Date.now()}`;
    await pool.query(`INSERT INTO generated_sites (business_id,slug,html) VALUES ($1,$2,$3) ON CONFLICT (slug) DO UPDATE SET html=EXCLUDED.html`,[biz.id,slug,html]);
    await pool.query("UPDATE businesses SET preview_slug=$1,status='site shown',updated_at=NOW() WHERE id=$2",[slug,biz.id]);
    res.json({ url:`/preview/${slug}`, slug });
  } catch (err) { console.error("🔴",err); res.status(500).json({ error: err.message }); }
};
app.post("/api/generate/:id", generateHandler);
app.post("/generate/:id", generateHandler);

app.get("/preview/:slug", async (req, res) => {
  try {
    const r = await pool.query("SELECT html FROM generated_sites WHERE slug=$1",[req.params.slug]);
    if (!r.rows.length) return res.status(404).send("<h1>Not found</h1>");
    res.setHeader("Content-Type","text/html; charset=utf-8");
    res.send(r.rows[0].html);
  } catch (err) { res.status(500).send(err.message); }
});

const PORT = process.env.PORT || 3001;
initDB().then(()=>app.listen(PORT,()=>console.log(`🚀 SiteSprint v7 on port ${PORT}`)));