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
const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });
const GKEY = process.env.GOOGLE_API_KEY;

// ─── DB ───────────────────────────────────────────────────────────────────────
async function initDB() {
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
}

// ─── GOOGLE PLACES API ────────────────────────────────────────────────────────
async function gfetch(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  return r.json();
}

// Get place details by place_id
async function getPlaceDetails(placeId) {
  const fields = "name,formatted_address,formatted_phone_number,rating,user_ratings_total,opening_hours,website,types,reviews,editorial_summary,business_status";
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=${fields}&key=${GKEY}&language=en`;
  const data = await gfetch(url);
  if (data.status !== "OK") throw new Error(`Places API: ${data.status} — ${data.error_message || ""}`);
  return data.result;
}

// Search for a place by text query
async function searchPlace(query) {
  const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(query)}&inputtype=textquery&fields=place_id,name,formatted_address&key=${GKEY}`;
  const data = await gfetch(url);
  if (data.status !== "OK" && data.status !== "ZERO_RESULTS") throw new Error(`Search: ${data.status}`);
  return data.candidates?.[0] || null;
}

// Extract place_id from any Google Maps URL format
function extractPlaceIdFromUrl(url) {
  // Format: /maps/place/Name/@lat,lng/data=...!1sChIJ...!
  const cid1 = url.match(/!1s(ChIJ[A-Za-z0-9_-]+)/)?.[1];
  if (cid1) return cid1;
  // Format: place_id=XXX
  const cid2 = url.match(/[?&]place_id=([A-Za-z0-9_-]+)/)?.[1];
  if (cid2) return cid2;
  return null;
}

// Resolve any Google URL (follows redirects)
async function resolveUrl(url) {
  try {
    const r = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(8000)
    });
    return r.url;
  } catch { return url; }
}

// Main: Get real business data from Google
async function fetchFromGoogle(query, googleUrl) {
  if (!GKEY) throw new Error("GOOGLE_API_KEY not set in environment variables");

  let placeId = null;

  // If URL provided, try to extract place_id from it
  if (googleUrl) {
    // share.google and goo.gl need resolving
    if (googleUrl.includes("share.google") || googleUrl.includes("goo.gl") || googleUrl.includes("maps.app.goo.gl")) {
      console.log("⚠️ Short URL detected — cannot resolve from server. Using text search instead.");
    } else {
      const resolved = await resolveUrl(googleUrl);
      console.log("Resolved URL:", resolved);
      placeId = extractPlaceIdFromUrl(resolved);
      // Also try extracting business name from URL for fallback search
      if (!placeId) {
        const nameFromUrl = resolved.match(/maps\/place\/([^/@?]+)/)?.[1];
        if (nameFromUrl && !query) {
          query = decodeURIComponent(nameFromUrl.replace(/\+/g, " "));
        }
      }
    }
  }

  // If no place_id yet, use text search
  if (!placeId && query) {
    console.log("🔍 Searching for:", query);
    const candidate = await searchPlace(query);
    if (!candidate) throw new Error(`No results found for "${query}". Try a more specific search.`);
    placeId = candidate.place_id;
    console.log("Found:", candidate.name, candidate.formatted_address);
  }

  if (!placeId) throw new Error("Could not find this business. Please enter the business name and city.");

  // Get full details
  const p = await getPlaceDetails(placeId);
  console.log("✅ Got details for:", p.name, "| Phone:", p.formatted_phone_number, "| Rating:", p.rating);

  return {
    name:         p.name,
    address:      p.formatted_address || "",
    phone:        p.formatted_phone_number || "",
    rating:       p.rating || 4.5,
    review_count: p.user_ratings_total || 0,
    hours:        p.opening_hours?.weekday_text?.join(" | ") || "",
    hours_arr:    p.opening_hours?.weekday_text || [],
    website:      p.website || "",
    category:     mapTypes(p.types || []),
    description:  p.editorial_summary?.overview || "",
    real_reviews: (p.reviews || []).slice(0, 5).map(r => ({
      name:   r.author_name,
      rating: r.rating,
      text:   r.text?.slice(0, 200),
      time:   r.relative_time_description,
    })),
    place_id: placeId,
  };
}

function mapTypes(types) {
  const t = types.join(" ").toLowerCase();
  if (t.includes("hair") || t.includes("beauty") || t.includes("salon") || t.includes("nail") || t.includes("spa")) return "Salon";
  if (t.includes("dentist") || t.includes("dental")) return "Dental";
  if (t.includes("car_repair") || t.includes("car_wash")) return "Auto Repair";
  if (t.includes("restaurant") || t.includes("food") || t.includes("meal") || t.includes("bakery")) return "Restaurant";
  if (t.includes("gym") || t.includes("fitness")) return "Gym";
  if (t.includes("cafe") || t.includes("coffee")) return "Cafe";
  if (t.includes("lodging") || t.includes("hotel")) return "Hotel";
  if (t.includes("doctor") || t.includes("hospital") || t.includes("health")) return "Medical";
  if (t.includes("lawyer") || t.includes("legal")) return "Legal";
  if (t.includes("real_estate")) return "Real Estate";
  if (t.includes("school") || t.includes("university")) return "Education";
  return "Local Business";
}

// ─── IMAGE BANKS ──────────────────────────────────────────────────────────────
const IMGS = {
  salon:      ["https://images.unsplash.com/photo-1562322140-8baeececf3df?w=1600&q=85","https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?w=900&q=85","https://images.unsplash.com/photo-1605497746444-ac9da58480a8?w=900&q=85","https://images.unsplash.com/photo-1560066984-138dadb4c035?w=900&q=85","https://images.unsplash.com/photo-1487412720507-e7ab37603c6f?w=900&q=85","https://images.unsplash.com/photo-1521590832167-7bcbfaa6381f?w=900&q=85"],
  dental:     ["https://images.unsplash.com/photo-1606811841689-23dfddce3e66?w=1600&q=85","https://images.unsplash.com/photo-1588776814546-1ffbb172a090?w=900&q=85","https://images.unsplash.com/photo-1629909615184-74f495363b67?w=900&q=85","https://images.unsplash.com/photo-1609840114035-3c981b782dfe?w=900&q=85","https://images.unsplash.com/photo-1598256989800-fe5f95da9787?w=900&q=85","https://images.unsplash.com/photo-1576091160550-2173dba999ef?w=900&q=85"],
  auto:       ["https://images.unsplash.com/photo-1619642751034-765dfdf7c58e?w=1600&q=85","https://images.unsplash.com/photo-1486006920555-c77dce18193b?w=900&q=85","https://images.unsplash.com/photo-1563720223185-11003d516935?w=900&q=85","https://images.unsplash.com/photo-1517524206127-48bbd363f3d7?w=900&q=85","https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?w=900&q=85","https://images.unsplash.com/photo-1568605117036-5fe5e7bab0b7?w=900&q=85"],
  restaurant: ["https://images.unsplash.com/photo-1514933651103-005eec06c04b?w=1600&q=85","https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=900&q=85","https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=900&q=85","https://images.unsplash.com/photo-1414235077428-338989a2e8c0?w=900&q=85","https://images.unsplash.com/photo-1559339352-11d035aa65de?w=900&q=85","https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=900&q=85"],
  gym:        ["https://images.unsplash.com/photo-1534438327276-14e5300c3a48?w=1600&q=85","https://images.unsplash.com/photo-1571019614242-c5c5dee9f50b?w=900&q=85","https://images.unsplash.com/photo-1517836357463-d25dfeac3438?w=900&q=85","https://images.unsplash.com/photo-1583454110551-21f2fa2afe61?w=900&q=85","https://images.unsplash.com/photo-1574680096145-d05b474e2155?w=900&q=85","https://images.unsplash.com/photo-1526506118085-60ce8714f8c5?w=900&q=85"],
  cafe:       ["https://images.unsplash.com/photo-1501339847302-ac426a4a7cbb?w=1600&q=85","https://images.unsplash.com/photo-1442512595331-e89e73853f31?w=900&q=85","https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?w=900&q=85","https://images.unsplash.com/photo-1511081692775-05d0f180a065?w=900&q=85","https://images.unsplash.com/photo-1509042239860-f550ce710b93?w=900&q=85","https://images.unsplash.com/photo-1534040385115-33dcb3acba5b?w=900&q=85"],
  hotel:      ["https://images.unsplash.com/photo-1566073771259-6a8506099945?w=1600&q=85","https://images.unsplash.com/photo-1582719508461-905c673771fd?w=900&q=85","https://images.unsplash.com/photo-1611892440504-42a792e24d32?w=900&q=85","https://images.unsplash.com/photo-1631049307264-da0ec9d70304?w=900&q=85","https://images.unsplash.com/photo-1618773928121-c32242e63f39?w=900&q=85","https://images.unsplash.com/photo-1584132967334-10e028bd69f7?w=900&q=85"],
  medical:    ["https://images.unsplash.com/photo-1551076805-e1869033e561?w=1600&q=85","https://images.unsplash.com/photo-1559757148-5c350d0d3c56?w=900&q=85","https://images.unsplash.com/photo-1516549655169-df83a0774514?w=900&q=85","https://images.unsplash.com/photo-1530026405186-ed1f139313f3?w=900&q=85","https://images.unsplash.com/photo-1579684385127-1ef15d508118?w=900&q=85","https://images.unsplash.com/photo-1504813184591-01572f98c85f?w=900&q=85"],
  cleaning:   ["https://images.unsplash.com/photo-1581578731548-c64695cc6952?w=1600&q=85","https://images.unsplash.com/photo-1621905252507-b35492cc74b4?w=900&q=85","https://images.unsplash.com/photo-1527515637-6742562d5395?w=900&q=85","https://images.unsplash.com/photo-1584622650111-993a426fbf0a?w=900&q=85","https://images.unsplash.com/photo-1556911220-bff31c812dba?w=900&q=85","https://images.unsplash.com/photo-1628177142898-93e36e4e3a50?w=900&q=85"],
  default:    ["https://images.unsplash.com/photo-1497366216548-37526070297c?w=1600&q=85","https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=900&q=85","https://images.unsplash.com/photo-1542744094-3a31f103e35f?w=900&q=85","https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?w=900&q=85","https://images.unsplash.com/photo-1551836022-d5d88e9218df?w=900&q=85","https://images.unsplash.com/photo-1497366811353-6870744d04b2?w=900&q=85"],
};

function getCatKey(cat) {
  const c = (cat || "").toLowerCase();
  if (c.includes("salon")||c.includes("beauty")||c.includes("hair")||c.includes("spa")||c.includes("nail")) return "salon";
  if (c.includes("dental")||c.includes("dentist")) return "dental";
  if (c.includes("auto")||c.includes("repair")||c.includes("mechanic")||c.includes("tire")) return "auto";
  if (c.includes("rest")||c.includes("food")||c.includes("pizza")||c.includes("grill")||c.includes("bistro")||c.includes("kitchen")||c.includes("bakery")) return "restaurant";
  if (c.includes("gym")||c.includes("fitness")||c.includes("yoga")||c.includes("crossfit")) return "gym";
  if (c.includes("cafe")||c.includes("coffee")||c.includes("roast")) return "cafe";
  if (c.includes("hotel")||c.includes("inn")||c.includes("lodge")||c.includes("motel")) return "hotel";
  if (c.includes("medical")||c.includes("doctor")||c.includes("clinic")||c.includes("health")) return "medical";
  if (c.includes("clean")||c.includes("maid")||c.includes("hvac")||c.includes("plumb")||c.includes("roof")||c.includes("landscap")) return "cleaning";
  return "default";
}

// ─── DESIGN SYSTEMS ───────────────────────────────────────────────────────────
const DS = {
  salon:      { fonts:`@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;0,700;1,400;1,700&family=Jost:wght@300;400;500;600&display=swap');`, hf:"'Cormorant Garamond',serif", bf:"'Jost',sans-serif", bg:"#0a0506", sf:"#160b0e", card:"#1e1115", pr:"#C4956A", ac:"#E8C9A0", tx:"#f5ede8", mu:"#9a7a6a", gl:"196,149,106", caps:false, cta:"Book Your Transformation", stats:[{n:"2,400+",l:"Happy Clients"},{n:"98%",l:"Return Rate"},{n:"8",l:"Expert Stylists"},{n:"12yr",l:"Est."}], svcs:[{ic:"fa-scissors",n:"Precision Cuts",d:"Tailored cuts designed around your face shape and personal style."},{ic:"fa-palette",n:"Color & Highlights",d:"Balayage, ombré, and full-color transformations with premium dyes."},{ic:"fa-spa",n:"Luxury Treatments",d:"Keratin therapy and scalp treatments for ultimate hair health."}], h1a:"Where Beauty Becomes", h1b:"Art" },
  dental:     { fonts:`@import url('https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500;600&display=swap');`, hf:"'DM Serif Display',serif", bf:"'DM Sans',sans-serif", bg:"#010919", sf:"#041228", card:"#071a36", pr:"#38BDF8", ac:"#BAE6FD", tx:"#edf8ff", mu:"#6aaccc", gl:"56,189,248", caps:false, cta:"Schedule Your Visit", stats:[{n:"5,000+",l:"Smiles Transformed"},{n:"4.9★",l:"Rating"},{n:"15yr",l:"Experience"},{n:"Zero",l:"Pain Policy"}], svcs:[{ic:"fa-tooth",n:"Smile Makeovers",d:"Complete aesthetic transformations with veneers, whitening, and contouring."},{ic:"fa-shield-halved",n:"Preventive Care",d:"Comprehensive checkups keeping your teeth healthy for life."},{ic:"fa-wand-magic-sparkles",n:"Teeth Whitening",d:"Professional whitening delivering dramatic results in one visit."}], h1a:"Your Dream Smile", h1b:"Starts Here" },
  auto:       { fonts:`@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Barlow:wght@300;400;500;600;700&display=swap');`, hf:"'Bebas Neue',sans-serif", bf:"'Barlow',sans-serif", bg:"#060400", sf:"#0f0b02", card:"#181205", pr:"#F59E0B", ac:"#FDE68A", tx:"#fff8e8", mu:"#b89848", gl:"245,158,11", caps:true, cta:"Get Free Estimate", stats:[{n:"10K+",l:"Vehicles Serviced"},{n:"Same",l:"Day Service"},{n:"$0",l:"Hidden Fees"},{n:"20yr",l:"Experience"}], svcs:[{ic:"fa-magnifying-glass",n:"Full Diagnostics",d:"Computer diagnostics identifying every issue fast and accurately."},{ic:"fa-car-burst",n:"Collision & Body",d:"Expert bodywork and paint matching for a factory-new finish."},{ic:"fa-gear",n:"Full Mechanical",d:"Brakes, suspension, transmission — certified master mechanics."}], h1a:"YOUR CAR DESERVES", h1b:"THE BEST" },
  restaurant: { fonts:`@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;0,900;1,400&family=Lato:wght@300;400;700&display=swap');`, hf:"'Playfair Display',serif", bf:"'Lato',sans-serif", bg:"#080200", sf:"#120700", card:"#1a0e03", pr:"#E8844A", ac:"#F4B87A", tx:"#fff5ee", mu:"#c4926e", gl:"232,132,74", caps:false, cta:"Reserve a Table", stats:[{n:"12yr",l:"Open Since"},{n:"4.8★",l:"Dining Rating"},{n:"200+",l:"Wine Labels"},{n:"Chef",l:"Crafted Daily"}], svcs:[{ic:"fa-utensils",n:"À La Carte Dining",d:"Seasonal menus from locally-sourced ingredients with global inspiration."},{ic:"fa-champagne-glasses",n:"Private Events",d:"Intimate dinners to grand celebrations — unforgettable for every occasion."},{ic:"fa-wine-glass",n:"Wine & Cocktails",d:"Curated cellar of 200+ labels paired with house-crafted cocktails."}], h1a:"An Experience", h1b:"Beyond the Plate" },
  gym:        { fonts:`@import url('https://fonts.googleapis.com/css2?family=Oswald:wght@400;600;700&family=Inter:wght@300;400;500;600&display=swap');`, hf:"'Oswald',sans-serif", bf:"'Inter',sans-serif", bg:"#04000f", sf:"#090220", card:"#100530", pr:"#A855F7", ac:"#D946EF", tx:"#f8f0ff", mu:"#8855c0", gl:"168,85,247", caps:true, cta:"Start Your Journey", stats:[{n:"1,200+",l:"Active Members"},{n:"35+",l:"Weekly Classes"},{n:"15",l:"Elite Trainers"},{n:"98%",l:"Goal Achievement"}], svcs:[{ic:"fa-dumbbell",n:"Personal Training",d:"1-on-1 coaching with certified trainers around your exact goals."},{ic:"fa-people-group",n:"Group Classes",d:"30+ weekly classes — HIIT, strength, yoga, spin — every level."},{ic:"fa-chart-line",n:"Nutrition Coaching",d:"Personalized meal plans to fuel your transformation inside out."}], h1a:"TRANSFORM YOUR", h1b:"LIMITS" },
  cafe:       { fonts:`@import url('https://fonts.googleapis.com/css2?family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&family=Nunito:wght@300;400;600&display=swap');`, hf:"'Libre Baskerville',serif", bf:"'Nunito',sans-serif", bg:"#0a0600", sf:"#160f03", card:"#1e1606", pr:"#D97706", ac:"#FBD38D", tx:"#fff8ed", mu:"#c4a464", gl:"217,119,6", caps:false, cta:"Visit Us Today", stats:[{n:"5★",l:"Avg Rating"},{n:"20+",l:"Blends"},{n:"Daily",l:"Fresh Roasted"},{n:"8yr",l:"Est."}], svcs:[{ic:"fa-mug-hot",n:"Specialty Coffee",d:"Single-origin beans roasted in-house for peak flavor every day."},{ic:"fa-bowl-food",n:"Fresh Food",d:"House-made pastries, sandwiches, and seasonal plates."},{ic:"fa-bag-shopping",n:"Retail Beans",d:"Take home your favorite blends — whole bean or ground."}], h1a:"Every Cup", h1b:"Tells a Story" },
  hotel:      { fonts:`@import url('https://fonts.googleapis.com/css2?family=Cormorant:ital,wght@0,400;0,600;0,700;1,400&family=Inter:wght@300;400;500;600&display=swap');`, hf:"'Cormorant',serif", bf:"'Inter',sans-serif", bg:"#060404", sf:"#100a08", card:"#180e0c", pr:"#B7935A", ac:"#D4B896", tx:"#fdf6f0", mu:"#a08870", gl:"183,147,90", caps:false, cta:"Book Your Room", stats:[{n:"200+",l:"Rooms"},{n:"4.9★",l:"Guest Rating"},{n:"24/7",l:"Concierge"},{n:"15yr",l:"Est."}], svcs:[{ic:"fa-bed",n:"Luxury Rooms",d:"Meticulously appointed rooms with premium bedding and views."},{ic:"fa-utensils",n:"Fine Dining",d:"Award-winning restaurant serving breakfast, lunch, and dinner."},{ic:"fa-dumbbell",n:"Spa & Wellness",d:"Full-service spa, pool, and fitness center for total relaxation."}], h1a:"Luxury Stays", h1b:"Redefined" },
  medical:    { fonts:`@import url('https://fonts.googleapis.com/css2?family=Merriweather:ital,wght@0,400;0,700;1,400&family=Source+Sans+3:wght@300;400;600&display=swap');`, hf:"'Merriweather',serif", bf:"'Source Sans 3',sans-serif", bg:"#010810", sf:"#031420", card:"#051a2c", pr:"#0EA5E9", ac:"#7DD3FC", tx:"#eef8ff", mu:"#6096b4", gl:"14,165,233", caps:false, cta:"Book Appointment", stats:[{n:"10K+",l:"Patients Served"},{n:"4.9★",l:"Rating"},{n:"20yr",l:"Experience"},{n:"Same",l:"Day Appointments"}], svcs:[{ic:"fa-stethoscope",n:"Primary Care",d:"Comprehensive health services for individuals and families."},{ic:"fa-heart-pulse",n:"Preventive Medicine",d:"Screenings and wellness plans to keep you at your healthiest."},{ic:"fa-syringe",n:"Specialized Care",d:"Expert specialty services tailored to your unique health needs."}], h1a:"Your Health,", h1b:"Our Priority" },
  cleaning:   { fonts:`@import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800&family=Open+Sans:wght@300;400;600&display=swap');`, hf:"'Nunito',sans-serif", bf:"'Open Sans',sans-serif", bg:"#010d08", sf:"#031a10", card:"#052018", pr:"#10B981", ac:"#6EE7B7", tx:"#edfff6", mu:"#60a880", gl:"16,185,129", caps:false, cta:"Get Free Quote", stats:[{n:"800+",l:"Happy Clients"},{n:"5★",l:"Avg Rating"},{n:"Eco",l:"Safe Products"},{n:"100%",l:"Satisfaction"}], svcs:[{ic:"fa-house",n:"Residential Deep Clean",d:"Top-to-bottom cleaning covering every corner of your home."},{ic:"fa-building",n:"Commercial Cleaning",d:"Professional office cleaning maintaining a spotless environment."},{ic:"fa-sparkles",n:"Move In / Move Out",d:"Complete packages ensuring every space is pristine."}], h1a:"Spotlessly Clean,", h1b:"Guaranteed" },
  default:    { fonts:`@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=Inter:wght@300;400;500;600;700&display=swap');`, hf:"'Playfair Display',serif", bf:"'Inter',sans-serif", bg:"#05050f", sf:"#0c0c20", card:"#101028", pr:"#6366F1", ac:"#A5B4FC", tx:"#f0f0ff", mu:"#8080c0", gl:"99,102,241", caps:false, cta:"Get Started Today", stats:[{n:"500+",l:"Happy Clients"},{n:"5★",l:"Avg Rating"},{n:"10yr",l:"Experience"},{n:"100%",l:"Satisfaction"}], svcs:[{ic:"fa-star",n:"Premium Service",d:"Top-tier quality delivered with care and expertise."},{ic:"fa-shield-halved",n:"Trusted Expertise",d:"Years of experience and a track record of excellence."},{ic:"fa-handshake",n:"Customer First",d:"Your satisfaction is our priority — we go above and beyond."}], h1a:"Excellence You Can", h1b:"Count On" },
};

function getDS(cat) { return DS[getCatKey(cat)] || DS.default; }

// ─── AI CONTENT GENERATOR ─────────────────────────────────────────────────────
async function genContent(biz, realReviews) {
  const revTxt = (realReviews||[]).slice(0,3).map((r,i)=>
    `Review ${i+1} by ${r.name}: "${r.text?.slice(0,150)}"`
  ).join("\n");

  const prompt = `You are writing content for "${biz.name}" — a real ${biz.category} business.

REAL BUSINESS DATA (use exactly as-is, never make up):
- Name: ${biz.name}
- Address: ${biz.address}
- Phone: ${biz.phone}
- Rating: ${biz.rating}★ based on ${biz.review_count} reviews
- Hours: ${biz.hours_arr?.slice(0,3).join(", ") || biz.hours || "check website"}
- Description: ${biz.description || "N/A"}
${revTxt ? "\nREAL CUSTOMER REVIEWS:\n"+revTxt : ""}

Output ONLY this JSON (no markdown, no extra text):
{
  "heroTag": "tagline using city name from address, max 7 words",
  "heroHL": "2-3 word italic highlight, specific to ${biz.name}",
  "heroSub": "one sentence, max 18 words, use the real business name",
  "svc1": "real service for ${biz.category}", "d1": "12-word description",
  "svc2": "real service for ${biz.category}", "d2": "12-word description",
  "svc3": "real service for ${biz.category}", "d3": "12-word description",
  "g1": "gallery caption", "g2": "gallery caption", "g3": "gallery caption", "g4": "gallery caption",
  "r1n": "${realReviews?.[0]?.name||"Sarah M."}", "r1t": "${(realReviews?.[0]?.text||"Exceptional service every visit.").slice(0,150)}", "r1role": "Verified Customer",
  "r2n": "${realReviews?.[1]?.name||"James R."}", "r2t": "${(realReviews?.[1]?.text||"Highly recommend to everyone.").slice(0,150)}", "r2role": "Verified Customer",
  "r3n": "${realReviews?.[2]?.name||"Maria L."}", "r3t": "${(realReviews?.[2]?.text||"Best in the area, hands down.").slice(0,150)}", "r3role": "Verified Customer",
  "footerTag": "inspiring 7-word tagline for ${biz.name}"
}`;

  try {
    const r = await ai.messages.create({ model:"claude-sonnet-4-6", max_tokens:700, messages:[{role:"user",content:prompt}] });
    const raw = r.content[0].text.trim().replace(/^```json?\n?/,"").replace(/```$/,"").trim();
    const parsed = JSON.parse(raw);
    console.log("✅ AI content generated for:", biz.name);
    return parsed;
  } catch(e) { console.error("AI content err:", e.message); return null; }
}

// ─── HTML BUILDER ─────────────────────────────────────────────────────────────
function buildHTML(biz, ds, imgs, ct) {
  const ltr  = (biz.name||"B")[0].toUpperCase();
  const wds  = (biz.name||"Business").split(" ");
  const nm1  = wds[0], nm2 = wds.slice(1).join(" ");
  const caps = ds.caps;
  const av   = n => (n||"??").split(" ").map(w=>w[0]||"").join("").slice(0,2).toUpperCase();

  const htag  = ct?.heroTag  || `Premium ${biz.category}`;
  const hl    = ct?.heroHL   || ds.h1b;
  const sub   = ct?.heroSub  || `${biz.name} — exceptional ${biz.category} services.`;
  const ftag  = ct?.footerTag|| `Quality you can count on.`;
  const s1n=ct?.svc1||ds.svcs[0].n, s1d=ct?.d1||ds.svcs[0].d;
  const s2n=ct?.svc2||ds.svcs[1].n, s2d=ct?.d2||ds.svcs[1].d;
  const s3n=ct?.svc3||ds.svcs[2].n, s3d=ct?.d3||ds.svcs[2].d;
  const g1=ct?.g1||"Featured Work", g2=ct?.g2||"Our Process", g3=ct?.g3||"Results", g4=ct?.g4||"Portfolio";

  const revs = [
    {n:ct?.r1n||"Sarah M.", t:ct?.r1t||"Exceptional service every visit.", r:ct?.r1role||"Verified Customer"},
    {n:ct?.r2n||"James R.", t:ct?.r2t||"Highly recommend to everyone.", r:ct?.r2role||"Verified Customer"},
    {n:ct?.r3n||"Maria L.", t:ct?.r3t||"Best in the area, hands down.", r:ct?.r3role||"Verified Customer"},
  ];

  // Format hours nicely (show first 3 days)
  const hoursDisplay = biz.hours_arr?.length
    ? biz.hours_arr.slice(0,3).map(h=>`<div style="font-size:.85rem;margin-bottom:4px">${h}</div>`).join("")
    : biz.hours || "Mon-Sat 9AM-6PM";

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
::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:${ds.bg}}::-webkit-scrollbar-thumb{background:${ds.pr};border-radius:2px}
h1,h2,h3{font-family:${ds.hf};${caps?"letter-spacing:2px;":""}}
nav{position:fixed;top:0;left:0;right:0;z-index:999;display:flex;align-items:center;justify-content:space-between;padding:20px 6%;transition:all .4s}
nav.s{background:rgba(0,0,0,.95);backdrop-filter:blur(24px);padding:13px 6%;border-bottom:1px solid rgba(${ds.gl},.2)}
.nl{display:flex;align-items:center;gap:12px}
.li{width:38px;height:38px;min-width:38px;background:${ds.pr};border-radius:10px;display:flex;align-items:center;justify-content:center;font-family:${ds.hf};font-weight:700;font-size:1.1rem;color:#fff;box-shadow:0 4px 14px rgba(${ds.gl},.4)}
.ln{font-family:${ds.hf};font-size:1.1rem;font-weight:700;${caps?"letter-spacing:1px;":""}}
.ln em{color:${ds.pr};font-style:normal}
.nm{display:flex;list-style:none;gap:32px}
.nm a{font-size:.78rem;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:rgba(255,255,255,.55);transition:color .3s}
.nm a:hover{color:${ds.ac}}
.nb{background:${ds.pr};color:#fff;padding:10px 24px;border-radius:50px;font-size:.8rem;font-weight:700;letter-spacing:.5px;transition:all .3s;display:inline-block;box-shadow:0 4px 14px rgba(${ds.gl},.3)}
.nb:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(${ds.gl},.5)}
.hero{position:relative;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;overflow:hidden}
.hbg{position:absolute;inset:0;background-size:cover;background-position:center;transform:scale(1.05);transition:transform 12s ease}
.hero:hover .hbg{transform:scale(1.0)}
.hov{position:absolute;inset:0;background:linear-gradient(155deg,${ds.bg}f8 0%,${ds.bg}85 45%,${ds.bg}f0 100%)}
.hb{position:relative;z-index:2;max-width:900px;padding:140px 28px 80px}
.hbd{display:inline-flex;align-items:center;gap:10px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.18);backdrop-filter:blur(14px);border-radius:100px;padding:11px 24px;font-size:.82rem;font-weight:600;margin-bottom:28px}
.hbd .st{color:#FFD700;letter-spacing:1px}
.ht{color:${ds.ac};font-size:.72rem;font-weight:700;letter-spacing:5px;text-transform:uppercase;margin-bottom:18px}
.hero h1{font-family:${ds.hf};font-size:clamp(2.8rem,6.5vw,5.5rem);font-weight:900;line-height:1.06;margin-bottom:24px;${caps?"letter-spacing:3px;":""}color:${ds.tx}}
.hero h1 .hl{color:${ds.pr};${caps?"":"font-style:italic;"}}
.hsb{font-size:1.08rem;color:${ds.mu};max-width:560px;margin:0 auto 48px;font-weight:300}
.hbtns{display:flex;gap:16px;justify-content:center;flex-wrap:wrap}
.bp{display:inline-flex;align-items:center;gap:10px;background:${ds.pr};color:#fff;padding:15px 40px;border-radius:50px;font-weight:700;font-size:1rem;border:none;cursor:pointer;transition:all .35s;box-shadow:0 8px 24px rgba(${ds.gl},.3)}
.bp:hover{transform:translateY(-3px);box-shadow:0 18px 48px rgba(${ds.gl},.5)}
.bg2{display:inline-flex;align-items:center;gap:10px;background:rgba(255,255,255,.06);color:${ds.tx};padding:15px 40px;border-radius:50px;font-weight:600;font-size:1rem;border:1px solid rgba(255,255,255,.22);cursor:pointer;transition:all .35s;backdrop-filter:blur(10px)}
.bg2:hover{border-color:${ds.pr};color:${ds.pr};transform:translateY(-3px)}
.sc{position:absolute;bottom:28px;left:50%;transform:translateX(-50%);font-size:.65rem;letter-spacing:3px;text-transform:uppercase;color:${ds.mu};display:flex;flex-direction:column;align-items:center;gap:5px}
.stats{padding:52px 6%;background:rgba(255,255,255,.025);border-top:1px solid rgba(${ds.gl},.12);border-bottom:1px solid rgba(${ds.gl},.12)}
.sg{display:grid;grid-template-columns:repeat(4,1fr);gap:28px;max-width:900px;margin:0 auto;text-align:center}
.sn{font-family:${ds.hf};font-size:2.8rem;font-weight:900;background:linear-gradient(135deg,${ds.pr},${ds.ac});-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;line-height:1}
.sl{font-size:.68rem;letter-spacing:3px;text-transform:uppercase;color:${ds.mu};margin-top:8px}
.sec{padding:100px 6%}
.sh{text-align:center;margin-bottom:68px}
.ey{color:${ds.ac};font-size:.7rem;font-weight:700;letter-spacing:5px;text-transform:uppercase;display:block;margin-bottom:14px}
.st2{font-family:${ds.hf};font-size:clamp(2rem,3.8vw,3rem);font-weight:900;margin-bottom:14px;${caps?"letter-spacing:2px;":""}color:${ds.tx}}
.ss{color:${ds.mu};font-size:.97rem;max-width:500px;margin:0 auto;font-weight:300}
.svgg{display:grid;grid-template-columns:repeat(3,1fr);gap:0;border:1px solid rgba(${ds.gl},.14);border-radius:22px;overflow:hidden}
.svc{background:${ds.card};padding:48px 36px;position:relative;overflow:hidden;transition:background .4s;border-right:1px solid rgba(${ds.gl},.1)}
.svc:last-child{border-right:none}
.svc::before{content:'';position:absolute;inset:0;background:linear-gradient(135deg,rgba(${ds.gl},.07) 0%,transparent 60%);opacity:0;transition:opacity .4s}
.svc:hover::before{opacity:1}
.svc::after{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,transparent,${ds.pr},transparent);transform:scaleX(0);transition:transform .6s}
.svc:hover::after{transform:scaleX(1)}
.svn{font-family:${ds.hf};font-size:5.5rem;font-weight:900;color:${ds.pr};opacity:.06;position:absolute;top:10px;right:20px;line-height:1}
.sic{width:56px;height:56px;background:rgba(${ds.gl},.1);border:1px solid rgba(${ds.gl},.22);border-radius:15px;display:flex;align-items:center;justify-content:center;margin-bottom:22px;transition:all .4s}
.svc:hover .sic{background:rgba(${ds.gl},.22);box-shadow:0 0 24px rgba(${ds.gl},.3)}
.sic i{font-size:1.35rem;color:${ds.pr}}
.svc h3{font-family:${ds.hf};font-size:1.2rem;font-weight:700;margin-bottom:12px;${caps?"letter-spacing:1px;":""}color:${ds.tx}}
.svc p{font-size:.9rem;color:${ds.mu};line-height:1.8}
.gal{padding:100px 6%;background:${ds.sf}}
.gg{display:grid;grid-template-columns:2fr 1fr 1fr;grid-template-rows:270px 270px;gap:16px;margin-top:64px}
.gi{border-radius:16px;overflow:hidden;position:relative;cursor:pointer}
.gi:first-child{grid-row:1/3}
.gbg{width:100%;height:100%;background-size:cover;background-position:center;transition:transform .7s ease}
.gi:hover .gbg{transform:scale(1.08)}
.gov{position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,.8) 0%,transparent 55%);opacity:0;transition:opacity .4s;display:flex;align-items:flex-end;padding:22px}
.gi:hover .gov{opacity:1}
.glbl{font-family:${ds.hf};font-size:1rem;font-weight:700;color:#fff;${caps?"letter-spacing:1px;text-transform:uppercase;":""}text-shadow:0 2px 8px rgba(0,0,0,.5)}
.rev{padding:100px 6%}
.rg{display:grid;grid-template-columns:repeat(3,1fr);gap:22px;margin-top:64px}
.rc{background:${ds.card};border:1px solid rgba(${ds.gl},.12);border-radius:22px;padding:36px;transition:all .4s;position:relative;overflow:hidden}
.rc::before{content:'';position:absolute;bottom:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,${ds.pr},transparent);transform:scaleX(0);transition:transform .6s}
.rc:hover::before{transform:scaleX(1)}
.rc:hover{border-color:rgba(${ds.gl},.35);transform:translateY(-7px);box-shadow:0 24px 64px rgba(0,0,0,.45)}
.rq{font-size:3.5rem;color:${ds.pr};opacity:.14;line-height:1;font-family:${ds.hf};margin-bottom:4px}
.rs{color:#FFD700;font-size:.8rem;letter-spacing:2px;margin-bottom:14px}
.rt{font-size:.92rem;color:${ds.mu};line-height:1.85;font-style:italic;margin-bottom:26px}
.rw{display:flex;align-items:center;gap:14px}
.ra{width:42px;height:42px;border-radius:50%;background:rgba(${ds.gl},.15);border:2px solid rgba(${ds.gl},.32);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:.76rem;color:${ds.pr};flex-shrink:0}
.rn{font-weight:700;font-size:.88rem}
.rr2{font-size:.72rem;color:${ds.mu}}
.con{padding:100px 6%;background:${ds.sf}}
.ci{display:grid;grid-template-columns:1fr 1.4fr;gap:80px;max-width:1100px;margin:64px auto 0;align-items:start}
.cl h3{font-family:${ds.hf};font-size:1.8rem;font-weight:700;margin-bottom:12px;color:${ds.tx}}
.cl>p{color:${ds.mu};font-size:.94rem;margin-bottom:44px;line-height:1.8}
.cr{display:flex;align-items:flex-start;gap:18px;margin-bottom:28px}
.cic{width:48px;height:48px;min-width:48px;background:rgba(${ds.gl},.1);border:1px solid rgba(${ds.gl},.2);border-radius:13px;display:flex;align-items:center;justify-content:center;transition:all .3s}
.cr:hover .cic{background:rgba(${ds.gl},.22);box-shadow:0 0 18px rgba(${ds.gl},.22)}
.cic i{color:${ds.pr};font-size:.95rem}
.clbl{font-size:.68rem;letter-spacing:3px;text-transform:uppercase;color:${ds.mu};margin-bottom:5px}
.cv{font-weight:600;font-size:.97rem}
.cf{background:${ds.card};border:1px solid rgba(${ds.gl},.14);border-radius:22px;padding:44px 40px}
.fr2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.fg{margin-bottom:18px}
.fl{display:block;font-size:.68rem;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:${ds.mu};margin-bottom:8px}
.fi{width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:11px;padding:14px 17px;color:${ds.tx};font-size:.95rem;font-family:${ds.bf};transition:all .3s;outline:none}
.fi:focus{border-color:${ds.pr};background:rgba(${ds.gl},.06);box-shadow:0 0 0 3px rgba(${ds.gl},.12)}
.fi::placeholder{color:rgba(255,255,255,.22)}
textarea.fi{min-height:120px;resize:vertical}
.fsb{width:100%;padding:16px;font-size:1rem;font-weight:700;letter-spacing:.5px;margin-top:8px;font-family:${ds.bf}}
footer{padding:68px 6% 36px;border-top:1px solid rgba(${ds.gl},.12);text-align:center}
.fll{display:flex;align-items:center;justify-content:center;gap:14px;margin-bottom:14px}
.fic{width:42px;height:42px;background:${ds.pr};border-radius:11px;display:flex;align-items:center;justify-content:center;font-family:${ds.hf};font-weight:700;font-size:1rem;color:#fff}
.fn{font-family:${ds.hf};font-size:1.5rem;font-weight:700;color:${ds.pr}}
.ftg{color:${ds.mu};font-size:.9rem;margin-bottom:36px}
.fls{display:flex;gap:28px;justify-content:center;list-style:none;margin-bottom:36px}
.fls a{font-size:.74rem;letter-spacing:1.5px;text-transform:uppercase;color:${ds.mu};transition:color .3s}
.fls a:hover{color:${ds.ac}}
.fc{color:rgba(255,255,255,.17);font-size:.74rem}
@keyframes fadeUp{from{opacity:0;transform:translateY(30px)}to{opacity:1;transform:translateY(0)}}
@keyframes bounce{0%,100%{transform:translateX(-50%) translateY(0)}50%{transform:translateX(-50%) translateY(-8px)}}
.hb>*{animation:fadeUp .9s ease both}
.hbd{animation-delay:.0s!important}.ht{animation-delay:.1s!important}
.hero h1{animation-delay:.2s!important}.hsb{animation-delay:.3s!important}.hbtns{animation-delay:.45s!important}
.sc{animation:bounce 2.5s 1s infinite}
.an{opacity:0;transform:translateY(26px);transition:opacity .75s,transform .75s}
.an.in{opacity:1;transform:translateY(0)}
.d1{transition-delay:.13s}.d2{transition-delay:.26s}.d3{transition-delay:.39s}
@media(max-width:900px){.nm{display:none}.sg{grid-template-columns:repeat(2,1fr)}.svgg{grid-template-columns:1fr}.svc{border-right:none;border-bottom:1px solid rgba(${ds.gl},.1)}.svc:last-child{border-bottom:none}.gg{grid-template-columns:1fr;grid-template-rows:auto}.gi:first-child{grid-row:auto}.gi{height:230px}.rg{grid-template-columns:1fr}.ci{grid-template-columns:1fr;gap:48px}.fr2{grid-template-columns:1fr}}
</style>
</head>
<body>
<nav id="nav">
  <div class="nl">
    <div class="li">${ltr}</div>
    <div class="ln"><em>${nm1}</em>${nm2?" "+nm2:""}</div>
  </div>
  <ul class="nm">
    <li><a href="#services">Services</a></li><li><a href="#gallery">Gallery</a></li>
    <li><a href="#reviews">Reviews</a></li><li><a href="#contact">Contact</a></li>
  </ul>
  <a href="#contact" class="nb">${ds.cta}</a>
</nav>
<section class="hero">
  <div class="hbg" style="background-image:url('${imgs[0]}')"></div>
  <div class="hov"></div>
  <div class="hb">
    <div class="hbd"><span class="st">★★★★★</span><span>${biz.rating}${biz.review_count>0?" · "+biz.review_count.toLocaleString()+" Verified Reviews":""}</span></div>
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
  <div class="sg">${ds.stats.map(s=>`<div class="an"><div class="sn">${s.n}</div><div class="sl">${s.l}</div></div>`).join("")}</div>
</section>
<section class="sec" id="services">
  <div class="sh"><span class="ey">What We Offer</span><h2 class="st2">Our Premium Services</h2><p class="ss">Exceptional quality delivered on every visit — guaranteed.</p></div>
  <div class="svgg">
    <div class="svc an"><div class="svn">01</div><div class="sic"><i class="fas ${ds.svcs[0].ic}"></i></div><h3>${s1n}</h3><p>${s1d}</p></div>
    <div class="svc an d1"><div class="svn">02</div><div class="sic"><i class="fas ${ds.svcs[1].ic}"></i></div><h3>${s2n}</h3><p>${s2d}</p></div>
    <div class="svc an d2"><div class="svn">03</div><div class="sic"><i class="fas ${ds.svcs[2].ic}"></i></div><h3>${s3n}</h3><p>${s3d}</p></div>
  </div>
</section>
<section class="gal" id="gallery">
  <div class="sh"><span class="ey">Our Work</span><h2 class="st2">Results That Speak</h2><p class="ss">Real work, real results — quality you can see.</p></div>
  <div class="gg">
    <div class="gi an"><div class="gbg" style="background-image:url('${imgs[2]}')"></div><div class="gov"><span class="glbl">${g1}</span></div></div>
    <div class="gi an d1"><div class="gbg" style="background-image:url('${imgs[3]}')"></div><div class="gov"><span class="glbl">${g2}</span></div></div>
    <div class="gi an d2"><div class="gbg" style="background-image:url('${imgs[4]}')"></div><div class="gov"><span class="glbl">${g3}</span></div></div>
    <div class="gi an d1"><div class="gbg" style="background-image:url('${imgs[5]}')"></div><div class="gov"><span class="glbl">${g4}</span></div></div>
  </div>
</section>
<section class="rev" id="reviews">
  <div class="sh"><span class="ey">Client Reviews</span><h2 class="st2">What Our Clients Say</h2><p class="ss">Real reviews from verified customers.</p></div>
  <div class="rg">${revs.map((r,i)=>`<div class="rc an${i?" d"+i:""}"><div class="rq">"</div><div class="rs">★★★★★</div><p class="rt">${r.t}</p><div class="rw"><div class="ra">${av(r.n)}</div><div><div class="rn">${r.n}</div><div class="rr2">${r.r}</div></div></div></div>`).join("")}</div>
</section>
<section class="con" id="contact">
  <div class="sh"><span class="ey">Get In Touch</span><h2 class="st2">Book Your Appointment</h2><p class="ss">Ready to get started? We'd love to hear from you.</p></div>
  <div class="ci">
    <div class="cl">
      <h3>Let's connect</h3>
      <p>Reach out and let our expert team handle everything.</p>
      ${biz.phone?`<div class="cr"><div class="cic"><i class="fas fa-phone"></i></div><div><p class="clbl">Phone</p><p class="cv">${biz.phone}</p></div></div>`:""}
      ${biz.address?`<div class="cr"><div class="cic"><i class="fas fa-location-dot"></i></div><div><p class="clbl">Address</p><p class="cv">${biz.address}</p></div></div>`:""}
      <div class="cr"><div class="cic"><i class="fas fa-clock"></i></div><div><p class="clbl">Hours</p><div class="cv">${hoursDisplay}</div></div></div>
      ${biz.website?`<div class="cr"><div class="cic"><i class="fas fa-globe"></i></div><div><p class="clbl">Website</p><p class="cv">${biz.website}</p></div></div>`:""}
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
  const ds   = getDS(biz.category);
  const imgs = IMGS[getCatKey(biz.category)] || IMGS.default;
  const realReviews = biz.real_reviews || [];
  console.log(`🎨 Building "${biz.name}" [${getCatKey(biz.category)}] — ${realReviews.length} real reviews`);
  const ct = await genContent(biz, realReviews);
  return buildHTML(biz, ds, imgs, ct);
}

async function saveAndBuild(bizData) {
  const saved = (await pool.query(
    `INSERT INTO businesses (name,address,phone,category,rating,review_count,hours,website,google_url,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'prospect') RETURNING *`,
    [bizData.name, bizData.address||"", bizData.phone||"", bizData.category||"Local Business",
     bizData.rating||4.5, bizData.review_count||0,
     Array.isArray(bizData.hours_arr) ? bizData.hours_arr.join(" | ") : (bizData.hours||""),
     bizData.website||"", bizData.google_url||""]
  )).rows[0];

  saved.real_reviews = bizData.real_reviews || [];
  saved.hours_arr    = bizData.hours_arr || [];
  saved.description  = bizData.description || "";

  const html = await generateSite(saved);
  const slug = `${saved.id}-${Date.now()}`;
  await pool.query(`INSERT INTO generated_sites (business_id,slug,html) VALUES ($1,$2,$3)`, [saved.id,slug,html]);
  await pool.query("UPDATE businesses SET preview_slug=$1,status='site shown' WHERE id=$2", [slug,saved.id]);
  return { business:saved, slug, previewUrl:`/preview/${slug}` };
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.get("/", (_, res) => res.json({ ok:true, service:"SiteSprint v8", google_api: !!GKEY }));

// ★ SEARCH BY NAME + CITY (main way to get real Google data)
app.post("/api/search-google", async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error:"Query required (e.g. 'Mike\\'s Auto Repair Charlotte NC')" });
    if (!GKEY)  return res.status(400).json({ error:"GOOGLE_API_KEY not configured on server" });

    const bizData = await fetchFromGoogle(query, null);
    const result  = await saveAndBuild(bizData);
    res.json({ ...result, scraped: { name:bizData.name, phone:bizData.phone, address:bizData.address, rating:bizData.rating, category:bizData.category, reviewsFound:bizData.real_reviews?.length||0 } });
  } catch(err) {
    console.error("🔴 search-google:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ★ FROM GOOGLE URL (works with maps.google.com URLs — NOT share.google)
app.post("/api/from-google", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error:"URL required" });
    if (!GKEY) return res.status(400).json({ error:"GOOGLE_API_KEY not configured" });

    // Reject share.google URLs upfront — they can't be scraped from server
    if (url.includes("share.google")) {
      return res.status(422).json({
        error:"share.google links cannot be read from a server.",
        hint:"Please use the 'Search by Name' option instead — enter the business name + city."
      });
    }

    const bizData = await fetchFromGoogle(null, url);
    const result  = await saveAndBuild(bizData);
    res.json({ ...result, scraped: { name:bizData.name, phone:bizData.phone, address:bizData.address, rating:bizData.rating, category:bizData.category, reviewsFound:bizData.real_reviews?.length||0 } });
  } catch(err) {
    console.error("🔴 from-google:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/businesses", async (req, res) => {
  try {
    const { status, q } = req.query;
    let sql="SELECT * FROM businesses WHERE 1=1"; const p=[];
    if(status&&status!=="all"){sql+=` AND status=$${p.length+1}`;p.push(status);}
    if(q){sql+=` AND (name ILIKE $${p.length+1} OR category ILIKE $${p.length+2} OR address ILIKE $${p.length+3})`;p.push(`%${q}%`,`%${q}%`,`%${q}%`);}
    sql+=" ORDER BY created_at DESC";
    res.json((await pool.query(sql,p)).rows);
  } catch(e){res.status(500).json({error:e.message});}
});

app.post("/api/businesses", async (req, res) => {
  try {
    const b=req.body;
    const r=await pool.query(`INSERT INTO businesses (name,address,phone,category,rating,review_count,hours,website,google_url,status,area_searched) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[b.name,b.address||"",b.phone||"",b.category||"",b.rating||0,b.review_count||0,b.hours||"",b.website||"",b.google_url||"",b.status||"prospect",b.area_searched||""]);
    res.status(201).json(r.rows[0]);
  } catch(e){res.status(500).json({error:e.message});}
});

app.put("/api/businesses/:id", async (req, res) => {
  try {
    const {id}=req.params; const b=req.body;
    const allowed=["name","address","phone","category","rating","review_count","hours","website","google_url","status","notes","preview_slug"];
    const sets=[],p=[];
    for(const col of allowed){if(col in b){sets.push(`${col}=$${p.length+1}`);p.push(b[col]);}}
    if(!sets.length)return res.json({ok:true});
    sets.push("updated_at=NOW()");p.push(id);
    await pool.query(`UPDATE businesses SET ${sets.join(",")} WHERE id=$${p.length}`,p);
    res.json((await pool.query("SELECT * FROM businesses WHERE id=$1",[id])).rows[0]);
  } catch(e){res.status(500).json({error:e.message});}
});

app.delete("/api/businesses/:id", async (req, res) => {
  try{await pool.query("DELETE FROM businesses WHERE id=$1",[req.params.id]);res.json({deleted:true});}
  catch(e){res.status(500).json({error:e.message});}
});

app.post("/api/search", async (req, res) => {
  try {
    const {area}=req.body; if(!area)return res.status(400).json({error:"area required"});
    const cats=[{cat:"Auto Repair",name:"Motors & Glass"},{cat:"Restaurant",name:"Grill & Bistro"},{cat:"Salon",name:"Beauty Studio"},{cat:"Plumbing",name:"Rooter Services"},{cat:"Dental",name:"Family Dentistry"},{cat:"Gym",name:"Fitness Center"},{cat:"Landscaping",name:"Lawn & Garden"},{cat:"Roofing",name:"Roofing Experts"},{cat:"Cafe",name:"Coffee Roasters"},{cat:"Cleaning",name:"Commercial Cleaners"}];
    const results=[];
    for(let i=1;i<=20;i++){const t=cats[i%cats.length];results.push({id:1000+i,name:`${area} Elite ${t.name}`,address:`${100+i*15} Commerce Blvd, ${area}`,phone:`(555) 019-${(i*123).toString().padStart(4,"0")}`,category:t.cat,rating:parseFloat((4+Math.random()).toFixed(1)),review_count:Math.floor(Math.random()*400)+45,hours:"Mon-Sat 8AM-6PM",area_searched:area});}
    res.json(results);
  } catch(e){res.status(500).json({error:e.message});}
});

const generateHandler = async (req, res) => {
  try {
    const {id}=req.params;
    let biz=(await pool.query("SELECT * FROM businesses WHERE id=$1",[id])).rows[0];
    if(!biz){const b=req.body;biz=(await pool.query(`INSERT INTO businesses (name,address,phone,category,rating,review_count,hours,status,area_searched) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[b.name||"Business",b.address||"",b.phone||"",b.category||"",b.rating||5,b.review_count||50,b.hours||"","prospect",b.area_searched||""])).rows[0];}
    const html=await generateSite(biz);
    const slug=`${biz.id}-${Date.now()}`;
    await pool.query(`INSERT INTO generated_sites (business_id,slug,html) VALUES ($1,$2,$3) ON CONFLICT (slug) DO UPDATE SET html=EXCLUDED.html`,[biz.id,slug,html]);
    await pool.query("UPDATE businesses SET preview_slug=$1,status='site shown',updated_at=NOW() WHERE id=$2",[slug,biz.id]);
    res.json({url:`/preview/${slug}`,slug});
  } catch(e){console.error("🔴",e);res.status(500).json({error:e.message});}
};
app.post("/api/generate/:id", generateHandler);
app.post("/generate/:id", generateHandler);

app.get("/preview/:slug", async (req, res) => {
  try {
    const r=await pool.query("SELECT html FROM generated_sites WHERE slug=$1",[req.params.slug]);
    if(!r.rows.length)return res.status(404).send("<h1>Not found</h1>");
    res.setHeader("Content-Type","text/html; charset=utf-8");
    res.send(r.rows[0].html);
  } catch(e){res.status(500).send(e.message);}
});

const PORT = process.env.PORT || 3001;
initDB().then(()=>app.listen(PORT,()=>console.log(`🚀 SiteSprint v8 — Google API: ${GKEY?"✅ enabled":"❌ not set"}`))).catch(console.error);