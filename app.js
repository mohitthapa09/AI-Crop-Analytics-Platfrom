/* AI Crop Assistant — application logic (frontend-only)
   No Python/FastAPI backend required. Loaded by index.html after the DOM
   and Chart.js are ready.

   Changes vs. the original:
     - /api/* calls removed — login/register/history persist in localStorage
     - analysis is computed fully in the browser (same formula path as the
       old client-side fallback) with live weather/soil from Open-Meteo
     - ad generator uses the local template engine instead of a server call
     - the only remaining network dependency is the free Open-Meteo API
       (no API key required) */

const GEOCODE_API_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_API_URL = "https://api.open-meteo.com/v1/forecast";

const LOCAL_USERS_KEY = "agri_local_users";
const HISTORY_KEY     = "agri_scan_history";

let chartInstance = null;
let lastYieldForecast = 4.3;
let selectedFile = null;
let lastAnalysisData = null;

// ---------------------------------------------------------------------------
// LOCAL PERSISTENCE HELPERS (replaces the SQLite database)
// ---------------------------------------------------------------------------
function getLocalUsers() {
    try { return JSON.parse(localStorage.getItem(LOCAL_USERS_KEY) || "[]"); }
    catch (err) { return []; }
}

function hashLocalPassword(password) {
    // Simple djb2-style hash so demo passwords aren't stored in plain text.
    // NOT cryptographically secure — this is demo-only, client-side auth.
    let hash = 5381;
    for (let i = 0; i < password.length; i++) {
        hash = ((hash << 5) + hash + password.charCodeAt(i)) >>> 0;
    }
    return `demo$${hash.toString(16)}`;
}

function getLocalScanHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); }
    catch (err) { return []; }
}

function addLocalScanHistory(result) {
    const history = getLocalScanHistory();
    history.unshift({
        crop: result.crop,
        diagnosis: result.diagnosis,
        healthScore: result.healthScore,
        city: result.city,
        state: result.state,
        country: result.country,
        createdAt: new Date().toISOString(),
    });
    // Keep the most recent 20 scans so localStorage doesn't grow forever.
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 20)));
}

// ---------------------------------------------------------------------------
// COUNTRY -> STATE/PROVINCE DATASET (for cascading location fields)
// ---------------------------------------------------------------------------
const COUNTRY_STATE_DATA = {
    "India": ["Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh", "Goa", "Gujarat", "Haryana", "Himachal Pradesh", "Jharkhand", "Karnataka", "Kerala", "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand", "West Bengal", "Andaman and Nicobar Islands", "Chandigarh", "Dadra and Nagar Haveli and Daman and Diu", "Delhi (NCT)", "Jammu and Kashmir", "Ladakh", "Lakshadweep", "Puducherry"],
    "United States": ["California", "Texas", "Iowa", "Illinois", "Nebraska", "Kansas", "Minnesota", "Indiana", "Ohio", "Florida"],
    "Brazil": ["Mato Grosso", "Parana", "Rio Grande do Sul", "Goias", "Sao Paulo", "Minas Gerais", "Bahia"],
    "Australia": ["New South Wales", "Victoria", "Queensland", "Western Australia", "South Australia", "Tasmania"],
    "Canada": ["Ontario", "Alberta", "Saskatchewan", "Manitoba", "British Columbia", "Quebec"],
    "China": ["Heilongjiang", "Henan", "Shandong", "Jiangsu", "Sichuan", "Hunan"],
    "Other": ["Other / Not Listed"]
};

// ---------------------------------------------------------------------------
// APPLICATION INIT
// ---------------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
    checkAuthSession();
    populateCountryDropdown();
    renderCropGallery();
});

// ---------------------------------------------------------------------------
// CROP VISUAL REFERENCE GALLERY
// ---------------------------------------------------------------------------
function wm(file, width) {
    return `https://commons.wikimedia.org/wiki/Special:FilePath/${file}?width=${width}`;
}

const CROP_GALLERY_DATA = [
    {
        name: "Wheat",
        icon: "fa-wheat-awn",
        img: wm("A_field_of_wheat.JPG", 500),
        img2: wm("A_wheat_field_(2609352959).jpg", 700),
        fact: "Rabi crop, ideal pH 6-7.5",
        role: "Wheat (Triticum aestivum) is the world's most widely grown cereal grass and India's principal Rabi (winter) crop, underpinning both household food security and the flour-milling and bakery industries.",
        season: "Rabi — sown Oct–Dec, harvested Mar–Apr",
        soil: "Well-drained loam or clay-loam, pH 6.0–7.5",
        water: "4–6 irrigations; moderate, avoid waterlogging",
        regions: "Punjab, Haryana, Uttar Pradesh, Madhya Pradesh",
        uses: "Flour (atta/maida), bread, pasta, animal feed, straw for fodder",
        factsheet: "A single wheat plant can produce 30–50 grains per head, and India is the world's second-largest wheat producer after China."
    },
    {
        name: "Rice",
        icon: "fa-seedling",
        img: wm("Paddy_Field_in_Palakkad.jpg", 500),
        img2: wm("China_Rice_field_with_farmer.jpg", 700),
        fact: "Needs standing water, clay-rich soil",
        role: "Rice (Oryza sativa) is a Kharif staple that feeds more than half the world's population daily, and is central to the livelihoods of smallholder farmers across South and Southeast Asia.",
        season: "Kharif — sown Jun–Jul, harvested Oct–Nov",
        soil: "Clay or clay-loam that retains standing water",
        water: "High — fields are kept flooded (puddled) for most of the growth cycle",
        regions: "West Bengal, Uttar Pradesh, Punjab, Andhra Pradesh",
        uses: "Staple grain, rice bran oil, straw for fodder and thatching",
        factsheet: "Rice cultivation uses roughly a third of the world's irrigation water, which is why water-saving methods like AWD (alternate wetting and drying) are gaining ground."
    },
    {
        name: "Maize",
        icon: "fa-corn",
        img: wm("Corn_field_in_Mexico.jpg", 500),
        img2: wm("A_Maize_Crop_with_beautiful_Corn.jpg", 700),
        fact: "Warm season, well-drained loam",
        role: "Maize (Zea mays), also called corn, is a versatile warm-season cereal used as food, poultry/livestock feed, and industrial feedstock (starch, ethanol) — making it one of the highest-value crops globally.",
        season: "Kharif (Jun–Sep) and Rabi (winter in some regions)",
        soil: "Well-drained sandy loam to loam, pH 5.5–7.5",
        water: "Moderate; sensitive to both drought and waterlogging at flowering",
        regions: "Karnataka, Madhya Pradesh, Bihar, Andhra Pradesh",
        uses: "Food (flour, popcorn), poultry/cattle feed, starch, ethanol",
        factsheet: "Maize yields more grain per hectare than almost any other cereal, and the U.S., China, and Brazil together grow over half the world's supply."
    },
    {
        name: "Cotton",
        icon: "fa-cloud",
        img: wm("Cotton_field.jpg", 500),
        img2: wm("Cotton_plant.jpg", 700),
        fact: "Thrives in Black (regur) soil",
        role: "Cotton (Gossypium spp.) is the world's leading natural fibre crop, forming the backbone of the textile industry and a major cash crop for farmers in semi-arid regions.",
        season: "Kharif — sown Apr–May (irrigated) or Jun–Jul (rainfed), harvested Oct–Jan",
        soil: "Deep, well-drained Black (regur/cotton) soil that retains moisture",
        water: "Moderate; needs a dry spell during boll opening/harvest",
        regions: "Gujarat, Maharashtra, Telangana, Andhra Pradesh",
        uses: "Textile fibre (lint), cottonseed oil, cattle-feed cake",
        factsheet: "India is the world's largest cotton producer by area sown, and one cotton boll opens into roughly 500,000 individual fibres."
    },
    {
        name: "Sugarcane",
        icon: "fa-leaf",
        img: wm("Ripe_sugarcane_crop_in_a_village_in_India.jpg", 500),
        img2: wm("Cut_sugarcane.jpg", 700),
        fact: "Heavy water needs, long duration",
        role: "Sugarcane (Saccharum officinarum) is a long-duration cash crop that supplies most of the world's sugar plus by-products like molasses, ethanol, and bone for paper and power generation.",
        season: "Year-round planting window; 10–18 month crop cycle",
        soil: "Deep, fertile loam with good drainage and organic matter",
        water: "Very high — needs frequent irrigation throughout its long cycle",
        regions: "Uttar Pradesh, Maharashtra, Karnataka, Tamil Nadu",
        uses: "Sugar, jaggery (gur), ethanol/biofuel, bagasse for paper & power",
        factsheet: "Sugarcane is one of the most efficient plants at converting sunlight into biomass, and Brazil and India together grow over half the world's cane."
    },
];

function renderCropGallery() {
    const wrap = document.getElementById('cropGallery');
    if (!wrap) return;
    wrap.innerHTML = CROP_GALLERY_DATA.map((c, i) => `
        <button type="button" onclick="openCropDetail(${i})"
            class="crop-gallery-card group relative rounded-xl overflow-hidden border-2 border-transparent hover:border-agriGreen transition text-left focus:outline-none">
            <div class="relative h-24 w-full bg-slate-200">
                <img src="${c.img}" alt="${c.name} crop" loading="lazy"
                    onerror="this.style.display='none'; this.parentElement.classList.add('hero-fallback');"
                    class="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition duration-300">
                <div class="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent"></div>
                <span class="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-white/85 backdrop-blur flex items-center justify-center opacity-0 group-hover:opacity-100 transition">
                    <i class="fa-solid fa-circle-info text-agriGreen text-xs"></i>
                </span>
                <span class="absolute bottom-1.5 left-2 text-white text-xs font-bold">${c.name}</span>
            </div>
            <div class="px-2 py-1.5 bg-slate-50">
                <p class="text-[10px] text-slate-700 flush">${c.fact}</p>
            </div>
        </button>
    `).join('');
}

function selectCropFromGallery(cropName) {
    const select = document.getElementById('inputCrop');
    if (select) {
        select.value = cropName;
        showToast(`Selected crop: ${cropName}`, "info");
    }
}

// ---------------------------------------------------------------------------
// CROP DETAIL MODAL
// ---------------------------------------------------------------------------
function openCropDetail(index) {
    const c = CROP_GALLERY_DATA[index];
    if (!c) return;
    const modal = document.getElementById('cropDetailModal');
    const body = document.getElementById('cropDetailBody');
    body.innerHTML = `
        <div class="relative h-48 sm:h-56 w-full bg-slate-200">
            <img src="${c.img2}" alt="${c.name}" class="absolute inset-0 w-full h-full object-cover"
                onerror="this.src='${c.img}'">
            <div class="absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-transparent"></div>
            <button type="button" onclick="closeCropDetail()"
                class="absolute top-3 right-3 w-8 h-8 rounded-full bg-white/90 hover:bg-white flex items-center justify-center shadow">
                <i class="fa-solid fa-xmark text-slate-700"></i>
            </button>
            <div class="absolute bottom-3 left-4 flex items-center gap-2">
                <span class="w-9 h-9 rounded-full bg-agriGreen/90 flex items-center justify-center text-white">
                    <i class="fa-solid ${c.icon}"></i>
                </span>
                <h3 class="text-white text-xl font-bold drop-shadow">${c.name}</h3>
            </div>
        </div>
        <div class="p-5 space-y-4">
            <p class="text-sm text-slate-700 leading-relaxed">${c.role}</p>

            <div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                <div class="bg-slate-50 border border-slate-200 rounded-lg p-2.5">
                    <p class="text-[10px] uppercase tracking-wide text-slate-400 font-bold mb-0.5">Season</p>
                    <p class="text-xs text-slate-700">${c.season}</p>
                </div>
                <div class="bg-slate-50 border border-slate-200 rounded-lg p-2.5">
                    <p class="text-[10px] uppercase tracking-wide text-slate-400 font-bold mb-0.5">Soil</p>
                    <p class="text-xs text-slate-700">${c.soil}</p>
                </div>
                <div class="bg-slate-50 border border-slate-200 rounded-lg p-2.5">
                    <p class="text-[10px] uppercase tracking-wide text-slate-400 font-bold mb-0.5">Water Need</p>
                    <p class="text-xs text-slate-700">${c.water}</p>
                </div>
                <div class="bg-slate-50 border border-slate-200 rounded-lg p-2.5">
                    <p class="text-[10px] uppercase tracking-wide text-slate-400 font-bold mb-0.5">Top Regions</p>
                    <p class="text-xs text-slate-700">${c.regions}</p>
                </div>
            </div>

            <div class="bg-emerald-50 border border-emerald-200 rounded-lg p-3">
                <p class="text-[10px] uppercase tracking-wide text-emerald-600 font-bold mb-1"><i class="fa-solid fa-industry mr-1"></i>Common Uses</p>
                <p class="text-xs text-emerald-800">${c.uses}</p>
            </div>

            <div class="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg p-3">
                <i class="fa-solid fa-lightbulb text-amber-500 mt-0.5"></i>
                <p class="text-xs text-amber-800">${c.factwriter}</p>
            </div>

            <div class="flex gap-2 pt-1">
                <button type="button" onclick="selectCropFromGallery('${c.name}'); closeCropDetail();"
                    class="flex-1 bg-agriGreen hover:bg-emerald-700 text-white text-sm font-semibold py-2.5 rounded-lg transition">
                    <i class="fa-solid fa-check mr-1.5"></i>Use ${c.name} for Scan
                </button>
                <button type="button" onclick="closeCropDetail()"
                    class="px-4 bg-slate-100 hover:bg-slate-200 text-slate-600 text-sm font-semibold py-2.5 rounded-lg transition">
                    Close
                </button>
            </div>
        </div>
    `;
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
}

function closeCropDetail() {
    const modal = document.getElementById('cropDetailModal');
    modal.classList.add('hidden');
    document.body.style.overflow = '';
}

// ---------------------------------------------------------------------------
// WEATHER CODE -> ICON / LABEL MAPPING (Open-Meteo WMO codes)
// ---------------------------------------------------------------------------
const WEATHER_CODE_MAP = {
    0: { icon: "fa-sun", label: "Clear" }, 1: { icon: "fa-cloud-sun", label: "Mostly Clear" },
    2: { icon: "fa-cloud-sun", label: "Partly Cloud" }, 3: { icon: "fa-cloud", label: "Overcast" },
    45: { icon: "fa-smog", label: "Fog" }, 48: { icon: "fa-smog", label: "Fog" },
    51: { icon: "fa-cloud-rain", label: "Drizzle" }, 53: { icon: "fa-cloud-rain", label: "Drizzle" },
    55: { icon: "fa-cloud-rain", label: "Drizzle" }, 61: { icon: "fa-cloud-showers-heavy", label: "Light Rain" },
    63: { icon: "fa-cloud-showers-heavy", label: "Rain" }, 65: { icon: "fa-cloud-showers-heavy", label: "Heavy Rain" },
    71: { icon: "fa-snowflake", label: "Snow" }, 73: { icon: "fa-snowflake", label: "Snow" },
    75: { icon: "fa-snowflake", label: "Heavy Snow" }, 80: { icon: "fa-cloud-showers-heavy", label: "Showers" },
    81: { icon: "fa-cloud-showers-heavy", label: "Showers" }, 82: { icon: "fa-cloud-showers-heavy", label: "Violent Showers" },
    95: { icon: "fa-bolt", label: "Storm" }, 96: { icon: "fa-bolt", label: "Storm + Hail" }, 99: { icon: "fa-bolt", label: "Severe Storm" },
};
function weatherCodeMeta(code) {
    return WEATHER_CODE_MAP[code] || { icon: "fa-cloud-sun", label: "Variable" };
}

function populateCountryDropdown() {
    const countrySelect = document.getElementById('inputCountry');
    if (!countrySelect) return;
    Object.keys(COUNTRY_STATE_DATA).forEach(country => {
        const opt = document.createElement('option');
        opt.value = country;
        opt.textContent = country;
        countrySelect.appendChild(opt);
    });
    countrySelect.value = "India";
    handleCountryChange();
}

function handleCountryChange() {
    const country = document.getElementById('inputCountry').value;
    const stateSelect = document.getElementById('inputState');
    stateSelect.innerHTML = '<option value="">Select State...</option>';

    const states = COUNTRY_STATE_DATA[country] || [];
    states.forEach(state => {
        const opt = document.createElement('option');
        opt.value = state;
        opt.textContent = state;
        stateSelect.appendChild(opt);
    });
}

// ---------------------------------------------------------------------------
// AUTH — local-only (localStorage)
// ---------------------------------------------------------------------------
function checkAuthSession() {
    const user = JSON.parse(localStorage.getItem('agri_user'));
    if (user && user.token) {
        document.getElementById('authOverlay').classList.add('hidden');
        document.getElementById('appContainer').classList.remove('hidden');
        document.getElementById('userNameDisplay').textContent = user.name || "Farmer";
        document.getElementById('userEmailDisplay').textContent = user.email;
        document.getElementById('userAvatar').textContent = (user.name || user.email).charAt(0).toUpperCase();
    } else {
        document.getElementById('authOverlay').classList.remove('hidden');
        document.getElementById('appContainer').classList.add('hidden');
    }
}

function toggleAuthMode(mode) {
    if (mode === 'register') {
        document.getElementById('loginCard').classList.add('hidden');
        document.getElementById('registerCard').classList.remove('hidden');
    } else {
        document.getElementById('registerCard').classList.add('hidden');
        document.getElementById('loginCard').classList.remove('hidden');
    }
}

async function handleLogin(e) {
    e.preventDefault();
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;

    const users = getLocalUsers();
    const match = users.find(u => u.email.toLowerCase() === email.toLowerCase());

    if (match && match.passwordHash === hashLocalPassword(password)) {
        const userData = {
            name: match.name,
            email: match.email,
            token: `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
        };
        localStorage.setItem('agri_user', JSON.stringify(userData));
        showToast(`Signed in as ${match.name}`, "success");
        checkAuthSession();
    } else if (match) {
        showToast("Incorrect password — try again.", "error");
    } else {
        showToast(`No account found for ${email} — please register first.`, "error");
    }
}

async function handleRegister(e) {
    e.preventDefault();
    const name = document.getElementById('regName').value.trim();
    const email = document.getElementById('regEmail').value.trim();
    const password = document.getElementById('regPassword').value;
    const regBtn = document.getElementById('regBtn');
    const originalHtml = regBtn.innerHTML;
    regBtn.disabled = true;
    regBtn.innerHTML = `<i class="fa-solid fa-spinner animate-spin"></i> Creating...`;

    if (!name || !email || !password) {
        showToast("Name, email, and password are all required.", "error");
        regBtn.disabled = false;
        regBtn.innerHTML = originalHtml;
        return;
    }

    const users = getLocalUsers();
    if (users.some(u => u.email.toLowerCase() === email.toLowerCase())) {
        showToast("An account with this email already exists — try signing in.", "error");
        regBtn.disabled = false;
        regBtn.innerHTML = originalHtml;
        return;
    }

    users.push({
        name, email,
        passwordHash: hashLocalPassword(password),
        createdAt: new Date().toISOString(),
    });
    localStorage.setItem(LOCAL_USERS_KEY, JSON.stringify(users));

    const userData = { name, email, token: `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}` };
    localStorage.setItem('agri_user', JSON.stringify(userData));
    showToast("Account created — saved in this browser.", "success");
    checkAuthSession();

    regBtn.disabled = false;
    regBtn.innerHTML = originalHtml;
}

function handleLogout() {
    localStorage.removeItem('agri_user');
    showToast("Logged out", "info");
    checkAuthSession();
}

// ---------------------------------------------------------------------------
// VIEW NAVIGATION
// ---------------------------------------------------------------------------
const VIEW_IDS = ['searchView', 'resultsView', 'historyView'];
const NAV_IDS = { searchView: 'navSearch', resultsView: 'navResults', historyView: 'navHistory' };
const ACTIVE_NAV_CLASS = "nav-btn w-full flex items-center space-x-3 px-4 py-3 rounded-xl font-medium transition text-white bg-agriGreen";
const INACTIVE_NAV_CLASS = "nav-btn w-full flex items-center space-x-3 px-4 py-3 rounded-xl font-medium transition text-slate-400 hover:bg-slate-800 hover:text-white";

function switchView(viewId) {
    VIEW_IDS.forEach(id => document.getElementById(id).classList.add('hidden'));
    document.getElementById(viewId).classList.remove('hidden');

    VIEW_IDS.forEach(id => {
        document.getElementById(NAV_IDS[id]).className = (id === viewId) ? ACTIVE_NAV_CLASS : INACTIVE_NAV_CLASS;
    });

    if (viewId === 'resultsView') {
        renderChart();
    } else if (viewId === 'historyView') {
        loadScanHistory();
    }
}

// ---------------------------------------------------------------------------
// SCAN HISTORY — from localStorage (was the /api/history endpoint)
// ---------------------------------------------------------------------------
function loadScanHistory() {
    const statusEl = document.getElementById('historyStatus');
    const listEl = document.getElementById('historyList');
    const history = getLocalScanHistory();

    if (!history.length) {
        statusEl.innerHTML = 'No saved scans yet — run an analysis from Search &amp; Scan, and it will be saved in this browser (localStorage).';
        listEl.innerHTML = '';
        return;
    }

    statusEl.textContent = `${history.length} scan${history.length === 1 ? '' : 's'} saved in this browser`;
    listEl.innerHTML = history.map(r => `
        <div class="flex items-center justify-between gap-3 p-3 rounded-xl border border-slate-200 hover:border-agriGreen transition">
            <div class="flex items-center gap-3 min-w-0">
                <div class="w-10 h-10 rounded-lg bg-emerald-50 text-agriGreen flex items-center justify-center shrink-0">
                    <i class="fa-solid fa-seedling"></i>
                </div>
                <div class="min-w-0">
                    <p class="text-sm font-semibold text-slate-800 truncate">${r.crop} — ${r.diagnosis || 'n/a'}</p>
                    <p class="text-xs text-slate-500 truncate">${[r.city, r.state, r.country].filter(Boolean).join(', ') || 'Location not set'} · ${new Date(r.createdAt).toLocaleString()}</p>
                </div>
            </div>
            <span class="shrink-0 text-xs font-bold px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-700">${r.healthScore || 'n/a'}</span>
        </div>
    `).join('');
}

// ---------------------------------------------------------------------------
// MOBILE MENU
// ---------------------------------------------------------------------------
document.getElementById('mobileMenuBtn').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('hidden');
});

// ---------------------------------------------------------------------------
// SOIL TYPE SELECTOR (Soil DataSet: Alluvial / Black / Cinder / Red)
// ---------------------------------------------------------------------------
function selectSoilType(btn) {
    document.getElementById('inputSoilType').value = btn.dataset.soil;
    document.querySelectorAll('.soil-swatch-btn').forEach(b => {
        b.classList.remove('selected', 'border-agriGreen');
        b.classList.add('border-transparent');
        b.querySelector('.soil-check').classList.add('opacity-0');
    });
    btn.classList.add('selected', 'border-agriGreen');
    btn.classList.remove('border-transparent');
    btn.querySelector('.soil-check').classList.remove('opacity-0');
}

// ---------------------------------------------------------------------------
// IMAGE HANDLERS
// ---------------------------------------------------------------------------
function prevNewImage(event) {
    const file = event.target.files[0];
    if (file) {
        setLeafImageFile(file);
    }
}

function setLeafImageFile(file) {
    selectedFile = file;
    const reader = new FileReader();
    reader.onload = function(e) {
        const imgEl = document.getElementById('imagePreview');
        imgEl.src = e.target.result;
        document.getElementById('uploadPrompt').classList.add('hidden');
        document.getElementById('imagePreviewContainer').classList.remove('hidden');
        runQuickPixelPreScan(imgEl);
    }
    reader.readAsString(file);
}

function removeImage() {
    selectedFile = null;
    document.getElementById('imageInput').value = '';
    document.getElementById('uploadPrompt').classList.remove('hidden');
    document.getElementById('imagePreviewContainer').classList.add('hidden');
    document.getElementById('quickScanPanel').classList.add('hidden');
}

// ---------------------------------------------------------------------------
// INSTANT PIXEL PRE-SCAN — client-side color analysis of the actual image
// ---------------------------------------------------------------------------
function runQuickPixelPreScan(imgEl) {
    const overlay = document.getElementById('scanLineOverlay');
    const panel = document.getElementById('quickScanPanel');
    overlay.classList.remove('hidden');
    panel.classList.add('hidden');

    const analyze = () => {
        try {
            const canvas = document.createElement('canvas');
            const size = 80;
            canvas.width = size;
            canvas.height = size;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(imgEl, 0, 0, size, size);
            const { data } = ctx.getImageData(0, 0, size, size);

            let greenPixels = 0, stressPixels = 0, counted = 0;
            for (let i = 0; i < data.length; i += 4) {
                const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
                if (a < 10) continue;
                counted++;
                if (g > r && g > b && g > 60) {
                    greenPixels++;
                } else if (r > 100 && g > 70 && b < Math.min(r, g) * 0.75) {
                    stressPixels++;
                }
            }
            const greenPct = counted ? Math.round((greenPixels / counted) * 100) : 0;
            const stressPct = counted ? Math.round((stressPixels / counted) * 100) : 0;
            renderQuickPixelPreScan(greenPct, stressPct);
        } catch (err) {
            panel.classList.add('hidden');
        } finally {
            overlay.classList.add('hidden');
        }
    };

    if (imgEl.complete) {
        setTimeout(analyze, 900);
    } else {
        imgEl.onload = () => setTimeout(analyze, 900);
    }
}

function renderQuickPixelPreScan(greenPct, stressPct) {
    document.getElementById('qsGreenPct').textContent = `${greenPct}%`;
    document.getElementById('qsStressPct').textContent = `${stressPct}%`;
    document.getElementById('qsGreenBar').style.width = `${greenPct}%`;
    document.getElementById('qsStressBar').style.width = `${stressPct}%`;

    const badge = document.getElementById('quickScanVerdictBadge');
    let verdict, cls;
    if (stressPct >= 25) {
        verdict = 'Possible Stress Detected'; cls = 'bg-amber-100 text-amber-700';
    } else if (greenPct >= 40) {
        verdict = 'Looks Mostly Healthy'; cls = 'bg-emerald-100 text-agriGreen';
    } else {
        verdict = 'Inconclusive — Run Full Scan'; cls = 'bg-slate-100 text-slate-600';
    }
    badge.textContent = verdict;
    badge.className = `text-[10px] font-semibold px-2 py-0.5 rounded-full ${cls}`;
    document.getElementById('quickScanPanel').classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// LIVE CAMERA CAPTURE
// ---------------------------------------------------------------------------
let cameraStream = null;

async function openLeafCamera() {
    const modal = document.getElementById('cameraModal');
    const errEl = document.getElementById('cameraError');
    errEl.classList.add('hidden');
    modal.classList.remove('hidden');
    try {
        cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        document.getElementById('cameraVideo').srcObject = cameraStream;
    } catch (err) {
        errEl.textContent = 'Camera access denied or unavailable. Please allow camera permission, or upload a photo instead.';
        errEl.classList.remove('hidden');
    }
}

function closeLeafCamera() {
    document.getElementById('cameraModal').classList.add('hidden');
    if (cameraStream) {
        cameraStream.getTracks().forEach(t => t.stop());
        cameraStream = null;
    }
}

function captureLeafPhoto() {
    const video = document.getElementById('cameraVideo');
    if (!video.videoWidth) return;
    const canvas = document.getElementById('cameraCanvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    canvas.toBlob((blob) => {
        if (!blob) return;
        const file = new File([blob], `leaf-scan-${Date.now()}.jpg`, { type: 'image/jpeg' });
        setLeafImageFile(file);
        closeLeafCamera();
        showToast('Photo captured — running instant pixel pre-scan', 'success');
    }, 'image/jpeg', 0.92);
}

// ---------------------------------------------------------------------------
// FORM SUBMIT HANDLER — fully client-side now
// ---------------------------------------------------------------------------
async function handleFormSubmit(event) {
    event.preventDefault();
    console.log('[AgriVision] Run AI Analysis clicked');
    const submitBtn = document.getElementById('submitBtn');
    const originalBtnHtml = submitBtn.innerHTML;

    const requiredFields = [
        ['inputCountry', 'Country'],
        ['inputState', 'State / Province'],
        ['inputCity', 'City'],
        ['inputCrop', 'Crop Variety'],
        ['inputPh', 'Soil pH'],
        ['inputMoisture', 'Moisture'],
    ];
    const missing = requiredFields.filter(([id]) => !document.getElementById(id).value.trim());
    if (missing.length) {
        showToast(`Please fill in: ${missing.map(m => m[1]).join(', ')}`, "error");
        document.getElementById(missing[0][0])?.focus();
        console.warn('[Form] Blocked: missing required fields ->', missing.map(m => m[1]));
        return;
    }

    submitBtn.disabled = true;
    submitBtn.innerHTML = `<i class="fa-solid fa-spinner animate-spin"></i> Processing...`;

    try {
        const data = await generateLiveResults(
            document.getElementById('inputCrop').value,
            document.getElementById('inputPh').value,
            document.getElementById('inputMoisture').value,
            document.getElementById('inputCountry').value,
            document.getElementById('inputState').value,
            document.getElementById('inputCity').value,
            document.getElementById('inputFarmSize').value
        );

        populateResults(data);
        addLocalScanHistory(data);
        switchView('resultsView');
        showToast('Analysis complete — computed in your browser', 'success');
    } catch (err) {
        console.error('[Form] Analysis failed:', err);
        showToast(`Something went wrong: ${err.message}`, "error");
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = originalBtnHtml;
    }
}

// ---------------------------------------------------------------------------
// SOIL PROFILES + LIVE ENVIRONMENT (Open-Meteo, no API key)
// ---------------------------------------------------------------------------
const SOIL_PROFILES_JS = {
    "Alluvial Soil": { retention: "high", note: "fertile, fine-grained; retains moisture well and suits rice, wheat, and sugarcane", optimalMoisture: 55 },
    "Black Soil": { retention: "very high", note: "high clay/moisture retention (regur soil); well suited to cotton but drains slowly", optimalMoisture: 60 },
    "Cinder Soil": { retention: "low", note: "porous, volcanic-derived; drains fast, so irrigate more frequently and in smaller amounts", optimalMoisture: 35 },
    "Red Soil": { retention: "low-to-moderate", note: "lower nitrogen/organic content; benefits from added organic matter and split fertilizer doses", optimalMoisture: 40 }
};

// Plain fetch() never times out by itself — wrap all network calls so they
// always settle within a bounded time, even if the API endpoint stalls.
async function fetchWithTimeout(url, options = {}, ms = 8001) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new Error(`Request to ${url} timed out after ${ms / 1000}s`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

async function fetchLiveEnvironment(city, state, country) {
    const query = [city, state, country].filter(Boolean).join(", ");
    if (!query) return { available: false, reason: "No location provided" };
    try {
        const geoResp = await fetchWithTimeout(`${GEOCODE_API_URL}?name=${encodeURIComponent(query)}&count=1`, {}, 8001);
        const geoData = await geoResp.json();
        const place = geoData.results && geoData.results[0];
        if (!place) return { available: false, reason: `Could not geocode '${query}'` };

        const weatherResp = await fetchWithTimeout(
            `${FORECAST_API_URL}?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,relative_humidity_2m,precipitation,weather_code&hourly=soil_moisture_0_to_1cm&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum&forecast_days=5&timezone=auto`,
            {}, 8001
        );
        if (!weatherResp.ok) {
            const errBody = await weatherResp.json().catch(() => ({}));
            return { available: false, reason: errBody.reason || `Weather API error (${weatherResp.status})` };
        }
        const weather = await weatherResp.json();
        const soilSeries = (weather.hourly && weather.hourly.soil_moisture_0_to_1cm) || [];
        const liveSoilMoisturePct = soilSeries.length ? Math.round(soilSeries[0] * 1000) / 10 : null;

        const daily = weather.daily || {};
        const dates = daily.time || [];
        const forecast = dates.map((d, i) => ({
            date: d,
            weatherCode: (daily.weather_code || [])[i],
            tempMaxC: (daily.temperature_2m_max || [])[i],
            tempMinC: (daily.temperature_2m_min || [])[i],
            precipitationMm: (daily.precipitation_sum || [])[i],
        }));

        return {
            available: true,
            resolvedPlace: place.name,
            admin1: place.admin1,
            country: place.country,
            temperatureC: weather.current && weather.current.temperature_2m,
            humidityPct: weather.current && weather.current.relative_humidity_2m,
            liveSoilMoisturePct,
            forecast
        };
    } catch (err) {
        return { available: false, reason: err.message };
    }
}

function computeHealthScoreJS(ph, moisturePct, soilProfile, diagnosisConfidence, isHealthy) {
    const phScore = Math.max(0, 100 - Math.abs(ph - 6.5) * 18);
    const optimalMoisture = soilProfile.optimalMoisture;
    const moistureScore = Math.max(0, 100 - Math.abs(moisturePct - optimalMoisture) * 1.6);
    const diseaseScore = isHealthy ? 95 : Math.max(10, 100 - diagnosisConfidence);
    const score = (phScore * 0.3) + (moistureScore * 0.35) + (diseaseScore * 0.35);
    return Math.round(Math.min(Math.max(score, 0), 100) * 10) / 10;
}

function computeYieldForecastJS(healthScore, soilProfile) {
    const retentionMultiplier = { "low": 0.85, "low-to-moderate": 0.95, "high": 1.05, "very high": 1.1 };
    const multiplier = retentionMultiplier[soilProfile.retention] || 1.0;
    const base = 3.0 + (healthScore / 100) * 2.5;
    return Math.round(base * multiplier * 10) / 10;
}

// Reads the real pixel pre-scan already rendered from the uploaded image.
function pixelScanSnapshot() {
    const panel = document.getElementById('quickScanPanel');
    if (!panel || panel.classList.contains('hidden')) return null;
    const greenPct = parseInt((document.getElementById('qsGreenPct')?.textContent || '0'), 10) || 0;
    const stressPct = parseInt((document.getElementById('qsStressPct')?.textContent || '0'), 10) || 0;
    return { greenPct, stressPct };
}

async function generateLiveResults(crop, phRaw, moistureRaw, country, state, city, farmSizeRaw) {
    const soilType = document.getElementById('inputSoilType').value;
    const profile = SOIL_PROFILES_JS[soilType] || SOIL_PROFILES_JS["Alluvial Soil"];
    const ph = parseFloat(phRaw) || 6.5;
    const manualMoisture = parseFloat(moistureRaw) || 50;
    const farmSize = parseFloat(farmSizeRaw) || 1;

    const env = await fetchLiveEnvironment(city, state, country);
    const effectiveMoisture = env.available && env.liveSoilMoisturePct !== null ? env.liveSoilMoisturePct : manualMoisture;

    // Leaf-image diagnosis from the client-side pixel pre-scan
    // (no backend vision model available, so honesty about it).
    const hasImage = !!selectedFile;
    let diagnosis, diagnosisSource, confidence, isHealthy;
    if (!hasImage) {
        diagnosis = "Healthy Crop";
        confidence = 90;
        isHealthy = true;
        diagnosisSource = "no-image-provided";
    } else {
        const pixel = pixelScanSnapshot();
        if (pixel && pixel.stressPct >= 25) {
            diagnosis = "Possible leaf stress (pixel pre-scan)";
            confidence = Math.min(80, 40 + pixel.stressPct);
            isHealthy = false;
        } else if (pixel && pixel.greenPct >= 40) {
            diagnosis = "Likely Healthy (pixel pre-scan)";
            confidence = Math.min(75, 50 + Math.round(pixel.greenPct / 4));
            isHealthy = true;
        } else {
            diagnosis = "Inconclusive — review the image manually";
            confidence = 0;
            isHealthy = true;
            diagnosisSource = "pixel-scan-inconclusive";
        }
    }

    const healthScore = computeHealthScoreJS(ph, effectiveMoisture, profile, confidence, isHealthy);
    const yieldForecast = computeYieldForecastJS(healthScore, profile);
    const totalYieldForecast = Math.round(yieldForecast * farmSize * 10) / 10;

    const recommendations = [
        `Apply nitrogen fertilizer suited for pH ${ph}.`,
        `Schedule irrigation based on ${effectiveMoisture}% soil moisture (${soilType}, ${profile.retention} retention).`,
        `Soil note: ${profile.note}.`
    ];
    if (hasImage) {
        recommendations.splice(1, 0, "Leaf image uploaded — local mode runs the pixel pre-scan, not a server AI vision model.");
    }
    recommendations.push(env.available
        ? `Live conditions in ${env.resolvedPlace}: ${env.temperatureC}°C, ${env.humidityPct}% humidity.`
        : `Live weather/soil data unavailable: ${env.reason}.`);

    return {
        crop: crop || "Wheat",
        country: country || "India",
        state: state || "",
        city: city || "",
        soilType: soilType,
        healthScore: `${healthScore}%`,
        diagnosis,
        diagnosisSource,
        confidence: `${confidence}%`,
        yieldForecast: String(yieldForecast),
        farmSize: farmSize,
        totalYieldForecast: String(totalYieldForecast),
        moisture: `${effectiveMoisture}%`,
        forecast: env.available ? env.forecast : [],
        recommendations
    };
}

// ---------------------------------------------------------------------------
// RESULTS RENDERING
// ---------------------------------------------------------------------------
function populateResults(data) {
    lastYieldForecast = parseFloat(data.yieldForecast) || lastYieldForecast;
    lastAnalysisData = data;
    resetAdPanel();
    document.getElementById('resCropBadge').textContent = data.crop;
    const soilLabel = data.soilType ? ` | Soil: ${data.soilType}` : '';
    const placeParts = [data.city, data.state, data.country].filter(Boolean);
    const placeLabel = placeParts.length ? placeParts.join(', ') : 'Not set';
    const sourceTag = data.diagnosisSource === 'claude-vision' ? ' | AI Vision: Live'
        : data.diagnosisSource === 'unconfigured' ? ' | AI Vision: Not Configured'
        : data.diagnosisSource === 'pixel-scan-inconclusive' ? ' | Pixel Pre-Scan: Inconclusive'
        : '';
    document.getElementById('resMetaText').textContent = `Location: ${placeLabel}${soilLabel}${sourceTag} | Processed: ${new Date().toLocaleTimeString()}`;
    document.getElementById('resHealthScore').textContent = data.healthScore;
    document.getElementById('resCondition').textContent = data.diagnosis;
    document.getElementById('resConfidence').textContent = data.confidence;
    document.getElementById('resYield').textContent = data.yieldForecast;
    document.getElementById('resMoisture').textContent = data.moisture;

    const healthPct = Math.max(0, Math.min(100, parseFloat(data.healthScore) || 0));
    const circumference = 326.7;
    const offset = circumference - (healthPct / 100) * circumference;
    const ring = document.getElementById('healthGaugeRing');
    ring.setAttribute('stroke-dashoffset', offset.toFixed(1));
    const gaugeColor = healthPct >= 75 ? '#16a34a' : healthPct >= 50 ? '#d97706' : '#dc2626';
    ring.setAttribute('stroke', gaugeColor);
    const healthLabelEl = document.getElementById('resHealthLabel');
    const healthLabel = healthPct >= 75 ? 'Good' : healthPct >= 50 ? 'Fair' : 'Needs Attention';
    const healthIcon = healthPct >= 75 ? 'fa-arrow-up' : healthPct >= 50 ? 'fa-minus' : 'fa-arrow-down';
    healthLabelEl.className = `mt-2 text-xs font-semibold flex items-center gap-1 ${healthPct >= 75 ? 'text-emerald-600' : healthPct >= 50 ? 'text-amber-600' : 'text-red-600'}`;
    healthLabelEl.innerHTML = `<i class="fa-solid ${healthIcon}"></i> ${healthLabel}`;

    const farmSize = parseFloat(data.farmSize) || 1;
    const totalYield = data.totalYieldForecast || (lastYieldForecast * farmSize).toFixed(1);
    document.getElementById('resTotalYield').innerHTML = `${totalYield} <span class="text-sm font-medium">tons</span>`;
    document.getElementById('resFarmSizeLabel').textContent = `Across ${farmSize} acre${farmSize === 1 ? '' : 's'}`;

    const forecastEl = document.getElementById('forecastStrip');
    const forecast = data.forecast || [];
    if (forecast.length) {
        forecastEl.innerHTML = forecast.slice(0, 5).map(d => {
            const meta = weatherCodeMeta(d.weatherCode);
            const dayLabel = d.date ? new Date(d.date).toLocaleDateString(undefined, { weekday: 'short' }) : '--';
            return `
                <div class="bg-slate-50 rounded-xl py-3 px-1 border border-slate-100">
                    <p class="text-[10px] font-semibold text-slate-500 uppercase">${dayLabel}</p>
                    <i class="fa-solid ${meta.icon} text-blue-500 text-lg my-1.5"></i>
                    <p class="text-xs font-bold text-slate-800">${d.tempMaxC ?? '--'}°<span class="text-slate-400 font-normal">/${d.tempMinC ?? '--'}°</span></p>
                    <p class="text-[9px] text-slate-400">${(d.precipitationMm ?? 0)}mm</p>
                </div>
            `;
        }).join('');
    } else {
        forecastEl.innerHTML = `<div class="col-span-5 text-center text-xs text-slate-400 py-4">Forecast unavailable — add a city to see live weather.</div>`;
    }

    const recList = document.getElementById('recommendationsList');
    recList.innerHTML = '';
    data.recommendations.forEach(rec => {
        recList.innerHTML += `
            <li class="flex items-start gap-2">
                <i class="fa-solid fa-circle-check text-emerald-500 mt-1"></i>
                <span>${rec}</span>
            </li>
        `;
    });
}

function renderChart() {
    const ctx = document.getElementById('yieldChart').getContext('2d');
    if (chartInstance) chartInstance.destroy();

    const historicalRatios = [0.721, 0.814, 0.791, 0.907, 1.0];
    const scaledData = historicalRatios.map(r => Math.round(r * lastYieldForecast * 100) / 100);

    chartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: ['2022', '2023', '2024', '2025', '2026 (Forecast)'],
            datasets: [{
                label: 'Crop Yield (Tons/Acre)',
                data: scaledData,
                borderColor: '#16a34a',
                backgroundColor: 'rgba(22, 163, 74, 0.1)',
                fill: true,
                tension: 0.3,
                pointRadius: 5,
                pointBackgroundColor: '#16a34a'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                y: { beginAtZero: false, grid: { color: '#f1f5f9' } },
                x: { grid: { display: false } }
            }
        }
    });
}

// ---------------------------------------------------------------------------
// AI MARKETPLACE AD GENERATOR — local fallback always (was /api/generate-ad)
// ---------------------------------------------------------------------------
let adState = null;
let adSelectedVariantIdx = 0;
let adSelectedChannel = 'whatsapp';

function resetAdPanel() {
    adState = null;
    adSelectedVariantIdx = 0;
    adSelectedChannel = 'whatsapp';
    const empty = document.getElementById('adEmptyState');
    const out = document.getElementById('adOutputWrap');
    if (empty) empty.classList.remove('hidden');
    if (out) out.classList.add('hidden');
}

function cleanAdNumber(value) {
    if (value === null || value === undefined) return null;
    const n = parseFloat(String(value).replace('%', '').trim());
    return isNaN(n) ? null : n;
}

const AD_VARIANT_TONES_JS = [
    { key: 'wholesale', tone: 'Wholesale / Bulk Buyer' },
    { key: 'premium', tone: 'Premium / Export Quality' },
    { key: 'local', tone: 'Quick Local Sale' },
];

function computeQualityGradeJS(healthScore) {
    if (healthScore === null) return { grade: 'Standard', label: 'Standard Grade', bandMultiplier: [0.95, 1.05] };
    if (healthScore >= 85) return { grade: 'A', label: 'Good Grade (A)', bandMultiplier: [1.05, 1.20] };
    if (healthScore >= 65) return { grade: 'B', label: 'Standard Grade (B)', bandMultiplier: [0.95, 1.08] };
    return { grade: 'C', label: 'Economy / Needs-Review Grade (C)', bandMultiplier: [0.75, 0.92] };
}

function computePriceBandJS(pricePerTon, quality) {
    if (!pricePerTon) {
        return { available: false, note: 'Enter your local price per ton to see a suggested listing range for this grade.' };
    }
    const [lowMult, highMult] = quality.bandMultiplier;
    return {
        available: true,
        suggestedLow: Math.round(pricePerTon * lowMult * 100) / 100,
        suggestedHigh: Math.round(pricePerTon * highMult * 100) / 100,
        basis: `${quality.label} typical range vs. your entered price`,
    };
}

function templateAdVariantJS(data, quality, location, toneSpec) {
    const qty = data.totalYieldForecast || data.yieldForecast || '';
    return {
        key: toneSpec.key,
        tone: toneSpec.tone,
        title: `${data.crop} — ${qty ? qty + ' Tons ' : ''}${quality.label} (${location})`.trim(),
        description: `${quality.label} ${data.crop} harvest from ${location}. AI health score ${data.healthScore || 'n/a'}, diagnosis: ${data.diagnosis || 'n/a'}. Grown on ${data.soilType || 'quality'} soil. Contact for pricing.`,
        tags: [data.crop, data.soilType, 'farm-direct', toneSpec.key].filter(Boolean),
        highlights: [
            `Yield forecast: ${data.yieldForecast || 'n/a'} tons/acre across ${data.farmSize || 'n/a'} acres`,
            `Soil moisture: ${data.moisture || 'n/a'}`,
        ],
        source: 'template',
        note: 'Local template — no backend AI writer connected.',
    };
}

function buildChannelTemplatesJS(data, ad, priceBand) {
    const location = [data.city, data.state, data.country].filter(Boolean).join(', ');
    const qty = data.totalYieldForecast || data.yieldForecast || 'available quantity';
    const priceLine = priceBand.available
        ? `Asking price range: ${priceBand.suggestedLow}–${priceBand.suggestedHigh} USD/ton`
        : 'Price: contact for quote';
    const whatsapp = `*${ad.title}*\n${ad.description}\n\n📍 ${location || 'Location on request'}\n📦 Quantity: ${qty} tons\n💰 ${priceLine}\n\nReply here for photos & sample details.`;
    const sms = `${data.crop} for sale, ${qty} tons, ${location}. ${priceLine}. Reply for details.`;
    const email = `Subject: ${ad.title}\n\nHello,\n\n${ad.description}\n\nQuantity available: ${qty} tons\nLocation: ${location || 'On request'}\n${priceLine}\n\nHappy to share the full report and arrange a sample. Let me know if you're interested.`;
    return { whatsapp, sms, email };
}

function buildCsvDumpJS(data, ad, priceBand) {
    const totalYield = cleanAdNumber(data.totalYieldForecast) ?? cleanAdNumber(data.yieldForecast) ?? '';
    const price = priceBand.available ? `${priceBand.suggestedLow} USD` : '';
    const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const header = 'id,title,description,availability,price,quantity,condition,google_product_category';
    const id = `${(data.crop || 'crop').toLowerCase().replace(/\s+/g, '-')}-${data.city || data.state || 'listing'}`;
    const row = [esc(id), esc(ad.title), esc(ad.description), esc('in stock'), esc(price), esc(totalYield), esc('new'), esc('Food, Beverages & Tobacco > Food Items > Produce')].join(',');
    return `${header}\n${row}`;
}

async function generateMarketplaceAd() {
    if (!lastAnalysisData) {
        showToast('Run an AI analysis first, then generate a listing.', 'error');
        return;
    }
    const btn = document.getElementById('generateAdBtn');
    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner animate-spin"></i> Generating...`;

    try {
        const priceRaw = document.getElementById('adPricePerTon').value;
        const pricePerTon = priceRaw ? parseFloat(priceRaw) : null;

        const data = lastAnalysisData;
        const location = [data.city, data.state, data.country].filter(Boolean).join(', ') || 'an undisclosed location';
        const healthScore = cleanAdNumber(data.healthScore);
        const quality = computeQualityGradeJS(healthScore);
        const priceBand = computePriceBandJS(pricePerTon, quality);
        const variants = AD_VARIANT_TONES_JS.map(v => templateAdVariantJS(data, quality, location, v));
        const primary = variants[0];

        adState = {
            qualityGrade: quality,
            priceBand,
            variants,
            channelTemplates: buildChannelTemplatesJS(data, primary, priceBand),
            csvFeedRow: buildCsvDumpJS(data, primary, priceBand),
        };
        adSelectedVariantIdx = 0;
        adSelectedChannel = 'whatsapp';
        renderAdState();
        showToast('Generated 3 listing templates locally', 'info');
    } catch (err) {
        console.error('[AgriVision] Ad generation failed:', err);
        showToast(`Listing generation failed: ${err.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
    }
}

function renderAdState() {
    if (!adState) return;
    document.getElementById('adEmptyState').classList.add('hidden');
    document.getElementById('adOutputWrap').classList.remove('hidden');

    const gradeColors = { A: 'bg-emerald-100 text-agriGreen', B: 'bg-amber-100 text-amber-700', C: 'bg-red-100 text-red-700', Standard: 'bg-slate-100 text-slate-600' };
    const q = adState.qualityGrade || {};
    const gradeBadge = document.getElementById('adQualityBadge');
    gradeBadge.textContent = `Grade ${q.grade || '—'} · ${q.label || ''}`;
    gradeBadge.className = `text-xs font-bold px-3 py-1.5 rounded-full ${gradeColors[q.grade] || 'bg-slate-100 text-slate-600'}`;

    const pb = adState.priceBand || {};
    document.getElementById('adPriceBand').textContent = pb.available
        ? `Suggested listing range: $${pb.suggestedLow} – $${pb.suggestedHigh} / ton (${pb.basis})`
        : (pb.note || '');

    renderAdVariant();
    renderAdChannel();
}

function renderAdVariant() {
    const ad = (adState.variants || [])[adSelectedVariantIdx] || {};

    document.getElementById('adTitle').textContent = ad.title || '';
    document.getElementById('adDescription').textContent = ad.description || '';

    const sourceBadge = document.getElementById('adSourceBadge');
    const sourceLabels = {
        'claude-ai': ['AI-Written · Live', 'bg-emerald-100 text-agriGreen'],
        'unconfigured': ['Template (Offline)', 'bg-amber-100 text-amber-700'],
        'template': ['Template · Local', 'bg-amber-100 text-amber-700'],
        'error': ['Template (AI Error)', 'bg-red-100 text-red-700'],
    };
    const [label, cls] = sourceLabels[ad.source] || ['Generated', 'bg-slate-100 text-slate-500'];
    sourceBadge.textContent = label;
    sourceBadge.className = `text-[10px] font-semibold px-2 py-0.5 rounded-full ${cls}`;

    document.getElementById('adHighlights').innerHTML = (ad.highlights || []).map(h => `
        <li class="flex items-start gap-2"><i class="fa-solid fa-circle-check text-agriGreen mt-0.5 text-[10px]"></i><span>${h}</span></li>
    `).join('');

    document.getElementById('adTags').innerHTML = (ad.tags || []).map(t => `
        <span class="text-[10px] font-medium px-2 py-1 bg-slate-100 text-slate-600 rounded-full">#${t}</span>
    `).join('');

    document.getElementById('adNote').textContent = ad.note || '';
}

function switchAdChannel(channel) {
    adSelectedChannel = channel;
    renderAdChannel();
}

function renderAdChannel() {
    document.querySelectorAll('.ad-channel-btn').forEach(btn => {
        const active = btn.id === `chBtn-${adSelectedChannel}`;
        btn.className = `ad-channel-btn px-3 py-1.5 text-xs font-semibold rounded-lg ${active ? 'bg-agriGreen text-white' : 'bg-slate-100 text-slate-600'}`;
    });
    const ct = adState.channelTemplates || {};
    let text = '';
    if (adSelectedChannel === 'whatsapp') text = ct.whatsapp || '';
    else if (adSelectedChannel === 'sms') text = ct.sms || '';
    else if (adSelectedChannel === 'email') text = typeof ct.email === 'object' ? `Subject: ${ct.email.subject}\n\n${ct.email.body}` : (ct.email || '');
    else if (adSelectedChannel === 'csv') text = adState.csvFeedRow || '';
    document.getElementById('adChannelBlock').textContent = text;
}

function copyAdBlock() {
    if (!adState) return;
    const text = document.getElementById('adChannelBlock').textContent;
    if (!text) return;
    navigator.clipboard.writeText(text)
        .then(() => showToast('Export copied to clipboard', 'success'))
        .catch(() => showToast('Copy failed — select and copy manually', 'error'));
}

function showToast(message, type = "info") {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    const bgClass = type === 'success' ? 'bg-emerald-800' : type === 'error' ? 'bg-red-800' : 'bg-slate-800';

    toast.className = `${bgClass} text-white px-4 py-3 rounded-xl shadow-lg text-sm flex items-center gap-3 transition-all duration-300 transform translate-y-2`;
    toast.innerHTML = `<i class="fa-solid fa-circle-info text-agriGreen"></i> <span>${message}</span>`;

    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('opacity-0');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}