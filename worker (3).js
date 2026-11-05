// Recipe Registry: protected Claude proxy + web page reader (Cloudflare Worker)
//
// Secrets (Worker > Settings > Variables and Secrets, type "Secret"):
//   ANTHROPIC_API_KEY, SUPABASE_SECRET_KEY
// Plain variables (type "Text"):
//   SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, ALLOWED_ORIGINS,
//   FREE_DAILY_LIMIT, PREMIUM_DAILY_LIMIT, FREE_ANALYSIS_LIMIT, PREMIUM_ANALYSIS_LIMIT,
//   FREE_VOICE_SECONDS, PREMIUM_VOICE_SECONDS, QUOTA_TZ   (all optional)
// Binding (Worker > Settings > Bindings > Add > Workers AI): variable name  AI   (needed only for voice and video recipes)
//
// Routes:  POST /       Claude proxy (counts against the daily limit)
//          POST /page   read a recipe from a web page link (free when the page has standard recipe markup)
//          POST /analyze  rough nutrition + diet tags for one recipe (own daily limit, separate from extractions)
//          POST /shopping-list  merge the ingredients of several recipes into one shopping list (uses the same limit as /analyze)
//          POST /transcribe  turn a short WAV clip of speech into text (needs the Workers AI binding named AI; daily limit in seconds)
//          GET  /quota  how many extractions are left today

const MAX_BODY_CHARS = 12_000_000;
const MAX_IMAGES = 6;
const MAX_TEXT_CHARS = 60_000;
const MAX_PAGE_BYTES = 2_500_000;
const UA = "Mozilla/5.0 (compatible; RecipeRegistry/1.0; +https://troymd123.github.io/Recipe-book/)";
const SOCIAL = /(^|\.)(facebook\.com|fb\.com|fb\.watch|instagram\.com|tiktok\.com|youtube\.com|youtu\.be)$/i;
const PAGE_ERRORS = {
  bad_url: "That doesn't look like a web page link.",
  social: "That site can't be read directly.",
  unreachable: "Couldn't open that page.",
  blocked: "That site didn't allow the app to read it.",
  not_html: "That link isn't a web page.",
  no_recipe: "Couldn't find a recipe on that page.",
};

/* ───────────── request checking ───────────── */

function sanitize(body, env) {
  const models = (env.ALLOWED_MODELS || "claude-sonnet-4-5").split(",").map(s => s.trim());
  if (!body || typeof body !== "object") return { error: "Bad request." };
  if (!models.includes(body.model)) return { error: "That model isn't available." };
  const msgs = body.messages;
  if (!Array.isArray(msgs) || msgs.length !== 1 || !msgs[0] || msgs[0].role !== "user") return { error: "Bad request." };
  const content = typeof msgs[0].content === "string" ? [{ type: "text", text: msgs[0].content }] : msgs[0].content;
  if (!Array.isArray(content) || content.length === 0 || content.length > MAX_IMAGES + 4) return { error: "Bad request." };
  let images = 0, chars = 0;
  const clean = [];
  for (const b of content) {
    if (b && b.type === "text" && typeof b.text === "string") {
      chars += b.text.length;
      clean.push({ type: "text", text: b.text });
    } else if (b && b.type === "image" && b.source && b.source.type === "base64" &&
               /^image\/(jpeg|png|gif|webp)$/.test(b.source.media_type) && typeof b.source.data === "string") {
      images++;
      clean.push({ type: "image", source: { type: "base64", media_type: b.source.media_type, data: b.source.data } });
    } else {
      return { error: "Unsupported content." };
    }
  }
  if (images > MAX_IMAGES || chars > MAX_TEXT_CHARS) return { error: "That request is too large." };
  const max = Math.min(Math.max(parseInt(body.max_tokens, 10) || 1000, 1), 2000);
  return { clean: { model: body.model, max_tokens: max, messages: [{ role: "user", content: clean }] } };
}

/* ───────────── database + Claude helpers ───────────── */

const rpc = (env, fn, args) => fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
  method: "POST",
  headers: { apikey: env.SUPABASE_SECRET_KEY, "Content-Type": "application/json" },
  body: JSON.stringify(args),
});
async function consume(env, userId, day) {
  const q = await rpc(env, "consume_extraction", {
    p_user: userId, p_day: day,
    p_free_limit: Number(env.FREE_DAILY_LIMIT ?? 3),
    p_premium_limit: Number(env.PREMIUM_DAILY_LIMIT ?? 100),
  });
  if (!q.ok) { console.error("quota check failed", q.status); return null; }
  return (await q.json())[0] || null;
}
const refund = (env, userId, day) => rpc(env, "refund_extraction", { p_user: userId, p_day: day }).catch(() => {});
async function callClaude(env, clean) {
  try {
    const up = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(clean),
    });
    const data = await up.json();
    if (!up.ok || !data || !data.content) {
      console.error("claude call failed", up.status, data && data.error ? JSON.stringify(data.error) : "");
      return null;
    }
    return data;
  } catch (e) {
    console.error("claude call failed", "network");
    return null;
  }
}
async function readQuota(env, userId, day) {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return { used: 0, limit: 0, plan: "free" };
  const h = { apikey: env.SUPABASE_SECRET_KEY };
  const [pr, ur] = await Promise.all([
    fetch(`${env.SUPABASE_URL}/rest/v1/entitlements?user_id=eq.${userId}&select=plan`, { headers: h }),
    fetch(`${env.SUPABASE_URL}/rest/v1/usage_daily?user_id=eq.${userId}&day=eq.${day}&select=extractions,bonus`, { headers: h }),
  ]);
  const plan = (pr.ok && (await pr.json())[0]?.plan) || "free";
  const u = (ur.ok && (await ur.json())[0]) || { extractions: 0, bonus: 0 };
  const base = plan === "premium" ? Number(env.PREMIUM_DAILY_LIMIT ?? 100) : Number(env.FREE_DAILY_LIMIT ?? 3);
  return { used: u.extractions, limit: base + u.bonus, plan };
}

/* ───────────── reading a recipe from a web page ───────────── */

function checkUrl(str) {
  let u;
  try { u = new URL(str); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.port && u.port !== "80" && u.port !== "443") return null;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return null;
  if (h.includes(":")) return null;                       // IPv6 addresses
  if (!h.includes(".")) return null;                      // bare names like "intranet"
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {                   // IPv4 addresses: only public ones
    const [a, b] = h.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return null;
  }
  return u;
}

async function fetchPage(u) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    let res;
    try {
      res = await fetch(u.href, { redirect: "follow", signal: ctrl.signal, headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml", "Accept-Language": "en" } });
    } catch { return { error: "unreachable" }; }
    if (res.url && !checkUrl(res.url)) return { error: "bad_url" };      // redirected somewhere private
    if (!res.ok) return { error: [401, 403, 429].includes(res.status) ? "blocked" : "unreachable" };
    const ct = res.headers.get("content-type") || "";
    if (!/html|xml/i.test(ct)) return { error: "not_html" };
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); size += value.length;
      if (size > MAX_PAGE_BYTES) { await reader.cancel().catch(() => {}); break; }
    }
    const all = new Uint8Array(size);
    let off = 0;
    for (const c of chunks) { all.set(c, off); off += c.length; }
    let dec;
    try { const cs = /charset=([\w-]+)/i.exec(ct); dec = new TextDecoder(cs ? cs[1] : "utf-8"); } catch { dec = new TextDecoder("utf-8"); }
    return { html: dec.decode(all) };
  } finally { clearTimeout(timer); }
}

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  ndash: "–", mdash: "—", hellip: "…", deg: "°", frac12: "½", frac14: "¼", frac34: "¾", times: "×" };
const codePoint = n => { try { return String.fromCodePoint(n); } catch { return ""; } };
const decode = s => String(s).replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z0-9]+));/gi, (m, d, h, n) =>
  d ? codePoint(+d) : h ? codePoint(parseInt(h, 16)) : (ENT[n.toLowerCase()] ?? m));
const tidy = s => decode(String(s).replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|li|div)>/gi, "\n").replace(/<[^>]*>/g, ""))
  .replace(/[ \t\u00a0]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();

function findRecipeNode(node) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) { for (const n of node) { const r = findRecipeNode(n); if (r) return r; } return null; }
  const t = node["@type"];
  if (t === "Recipe" || (Array.isArray(t) && t.includes("Recipe"))) return node;
  return node["@graph"] ? findRecipeNode(node["@graph"]) : null;
}
function duration(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/i.exec(String(iso || ""));
  if (!m) return "";
  const p = [];
  if (m[1] && +m[1]) p.push(`${+m[1]} day${+m[1] > 1 ? "s" : ""}`);
  if (m[2] && +m[2]) p.push(`${+m[2]} hr`);
  if (m[3] && +m[3]) p.push(`${+m[3]} min`);
  return p.join(" ");
}
function stepsFrom(ins) {
  const out = [];
  const walk = n => {
    if (!n) return;
    if (typeof n === "string") {
      tidy(n).split(/\n+/).forEach(l => { l = l.replace(/^\s*(?:step\s*)?\d+[.)]\s+/i, "").trim(); if (l) out.push(l); });
    } else if (Array.isArray(n)) n.forEach(walk);
    else if (typeof n === "object") { if (n.itemListElement) walk(n.itemListElement); else walk(n.text || n.name); }
  };
  walk(ins);
  return out;
}
function normalizeRecipe(r) {
  const str = (v, max) => (typeof v === "string" ? v : "").slice(0, max);
  const arr = (v, max, each) => (Array.isArray(v) ? v : []).map(x => str(x, each).trim()).filter(Boolean).slice(0, max);
  return { name: str(r.name, 120).trim() || "Untitled recipe", ingredients: arr(r.ingredients, 200, 300), directions: arr(r.directions, 200, 1500), notes: str(r.notes, 500).trim() };
}
function recipeFromJsonLd(html) {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let node = null;
    try { node = findRecipeNode(JSON.parse(m[1].trim().replace(/^<!\[CDATA\[|\]\]>$/g, ""))); } catch { continue; }
    if (!node) continue;
    const ing = [].concat(node.recipeIngredient || []).map(x => tidy(x).replace(/\n+/g, " ")).filter(Boolean);
    const dirs = stepsFrom(node.recipeInstructions);
    if (!ing.length && !dirs.length) continue;
    const y = [].concat(node.recipeYield || [])[0];
    const notes = [
      y ? (/^\d+$/.test(String(y).trim()) ? `Serves ${String(y).trim()}` : tidy(y)) : "",
      duration(node.prepTime) && `Prep ${duration(node.prepTime)}`,
      duration(node.cookTime) && `Cook ${duration(node.cookTime)}`,
      duration(node.totalTime) && `Total ${duration(node.totalTime)}`,
    ].filter(Boolean).join(" · ");
    return normalizeRecipe({ name: tidy(node.name || ""), ingredients: ing, directions: dirs, notes });
  }
  return null;
}
function pageText(html) {
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [, ""])[1];
  let t = html.replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, " ")
              .replace(/<!--[\s\S]*?-->/g, " ")
              .replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, " ")
              .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n");
  t = tidy(t);
  // Recipe cards list ingredients and then instructions close together; the last such spot is usually the card.
  let start = 0, m;
  const re = /ingredients/gi;
  while ((m = re.exec(t))) { if (/(instructions|directions|method)/i.test(t.slice(m.index, m.index + 3000))) start = Math.max(0, m.index - 600); }
  return `Page title: ${tidy(title)}\n\n` + t.slice(start, start + 14000);
}
function parseModelJson(data) {
  const text = (data.content || []).map(b => (b.type === "text" ? b.text : "")).join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

async function handlePage(request, env, user, day, reply) {
  let body;
  try { body = await request.json(); } catch { return reply({ error: "Bad request." }, 400); }
  const u = checkUrl(typeof body.url === "string" ? body.url.trim().slice(0, 2000) : "");
  if (!u) return reply({ error: PAGE_ERRORS.bad_url, code: "bad_url" }, 422);
  if (SOCIAL.test(u.hostname)) return reply({ error: PAGE_ERRORS.social, code: "social" }, 422);

  const page = await fetchPage(u);
  if (page.error) return reply({ error: PAGE_ERRORS[page.error], code: page.error }, 422);

  // 1. Most recipe sites publish the recipe in a standard format. Reading it costs nothing.
  const structured = recipeFromJsonLd(page.html);
  if (structured) return reply({ recipe: structured, via: "schema" });

  // 2. Otherwise ask Claude to find the recipe in the page text (counts as an extraction).
  const text = pageText(page.html);
  if (text.length < 300) return reply({ error: PAGE_ERRORS.no_recipe, code: "no_recipe" }, 422);
  const row = await consume(env, user.id, day);
  if (!row) return reply({ error: "Couldn't check your daily limit. Try again." }, 502);
  const quota = { used: row.r_used, limit: row.r_limit, plan: row.r_plan };
  if (!row.r_allowed) {
    return reply({ error: `That page isn't in a standard recipe format, and you've used all ${row.r_limit} extractions for today.`, quota, code: "limit_reached" }, 429);
  }
  const model = (env.ALLOWED_MODELS || "claude-sonnet-4-5").split(",")[0].trim();
  const prompt = `You are a recipe extraction specialist. Below is the text of a web page. Extract the main recipe: its name, every ingredient with quantities exactly as written, and the numbered cooking steps. Ignore comments, ads, and unrelated text.\n\n${text}\n\nRespond ONLY in this exact JSON (no markdown):\n{"name":"Recipe Name","ingredients":["1 cup flour"],"directions":["Step one."],"notes":""}\nIf the page has no recipe: {"error":"No recipe found"}`;
  const data = await callClaude(env, { model, max_tokens: 1500, messages: [{ role: "user", content: [{ type: "text", text: prompt }] }] });
  if (!data) {
    await refund(env, user.id, day);
    return reply({ error: "The recipe reader is unavailable right now. Please try again." }, 502);
  }
  const parsed = parseModelJson(data);
  const recipe = parsed && !parsed.error ? normalizeRecipe(parsed) : null;
  if (!recipe || (!recipe.ingredients.length && !recipe.directions.length)) {
    await refund(env, user.id, day);
    return reply({ error: PAGE_ERRORS.no_recipe, code: "no_recipe", quota: { ...quota, used: Math.max(quota.used - 1, 0) } }, 422);
  }
  return reply({ recipe, via: "ai", quota });
}

/* ───────────── nutrition estimates and diet tags ───────────── */

const consumeAnalysis = async (env, userId, day) => {
  const q = await rpc(env, "consume_analysis", {
    p_user: userId, p_day: day,
    p_free_limit: Number(env.FREE_ANALYSIS_LIMIT ?? 20),
    p_premium_limit: Number(env.PREMIUM_ANALYSIS_LIMIT ?? 300),
  });
  if (!q.ok) { console.error("analysis quota check failed", q.status); return null; }
  return (await q.json())[0] || null;
};
const refundAnalysis = (env, userId, day) => rpc(env, "refund_analysis", { p_user: userId, p_day: day }).catch(() => {});

function sanitizeAnalyze(b) {
  if (!b || typeof b !== "object") return null;
  const str = (v, max) => (typeof v === "string" ? v : "").replace(/\s+/g, " ").trim().slice(0, max);
  const list = (v, n, each) => (Array.isArray(v) ? v : []).map(x => str(x, each)).filter(Boolean).slice(0, n);
  const name = str(b.name, 120), ingredients = list(b.ingredients, 100, 300);
  if (!name || !ingredients.length) return null;
  const sv = parseInt(b.servings, 10);
  return { name, ingredients, directions: list(b.directions, 20, 400), servings: sv >= 1 && sv <= 100 ? sv : null };
}
const num = (v, max) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n) : null; };

// Turn the model's raw answer into clean numbers and tags. The low carb / high protein rules are fixed here, not left to the model.
function buildAnalysis(parsed, servingsGiven) {
  const p = parsed && typeof parsed === "object" ? parsed.per_serving : null;
  if (!p) return null;
  const nutrition = { calories: num(p.calories, 5000), carbs: num(p.carbs_g, 500), protein: num(p.protein_g, 300), fat: num(p.fat_g, 400), fiber: num(p.fiber_g, 100), sugar: num(p.sugar_g, 300) };
  if (nutrition.calories === null || nutrition.carbs === null || nutrition.protein === null || nutrition.fat === null) return null;
  const d = parsed.diet && typeof parsed.diet === "object" ? parsed.diet : {};
  const vegan = d.vegan === true;
  const flags = { vegan, vegetarian: vegan || d.vegetarian === true, dairy_free: vegan || d.dairy_free === true, gluten_free: d.gluten_free === true, nut_free: d.nut_free === true };
  const tags = ["vegan", "vegetarian", "gluten_free", "dairy_free", "nut_free"].filter(k => flags[k]);
  if (nutrition.carbs <= 20) tags.push("low_carb");
  if (nutrition.protein >= 25) tags.push("high_protein");
  const sv = parseInt(parsed.servings, 10);
  return { servings: servingsGiven || (sv >= 1 && sv <= 100 ? sv : 4), nutrition, tags };
}

async function handleAnalyze(request, env, user, day, reply) {
  let body;
  try { body = await request.json(); } catch { return reply({ error: "Bad request." }, 400); }
  const r = sanitizeAnalyze(body);
  if (!r) return reply({ error: "That recipe has no ingredients to look at.", code: "bad_recipe" }, 422);
  const row = await consumeAnalysis(env, user.id, day);
  if (!row) return reply({ error: "Couldn't check your daily limit. Try again." }, 502);
  const quota = { used: row.r_used, limit: row.r_limit, plan: row.r_plan };
  if (!row.r_allowed) return reply({ error: "You've used all " + row.r_limit + " nutrition estimates for today.", quota, code: "limit_reached" }, 429);

  const model = (env.ALLOWED_MODELS || "claude-sonnet-4-5").split(",")[0].trim();
  const lines = [
    "You are a careful nutrition assistant. Estimate the nutrition per serving for this recipe, and judge its dietary suitability from the INGREDIENT LIST.",
    "",
    "Recipe: " + r.name,
    "Servings: " + (r.servings ? r.servings : "not stated (choose a sensible number)"),
    "Ingredients:",
  ];
  r.ingredients.forEach(i => lines.push("- " + i));
  if (r.directions.length) {
    lines.push("", "Steps (for context only):");
    r.directions.forEach((d, i) => lines.push((i + 1) + ". " + d));
  }
  lines.push(
    "",
    "Respond ONLY with this JSON (no markdown):",
    '{"servings":4,"per_serving":{"calories":0,"carbs_g":0,"protein_g":0,"fat_g":0,"fiber_g":0,"sugar_g":0},"diet":{"vegetarian":false,"vegan":false,"gluten_free":false,"dairy_free":false,"nut_free":false}}',
    "",
    "Rules:",
    "- Numbers are rough estimates per single serving. If quantities are missing, assume typical amounts.",
    '- Be conservative with "diet": set a flag true ONLY if you are confident that EVERY ingredient complies. Treat unclear items (stock or broth, sauces, seasoning blends, "to taste" extras, store-bought mixes) as NOT compliant unless the ingredient says otherwise, for example "vegetable broth" or "gluten-free soy sauce".',
    "- vegan implies vegetarian and dairy_free. nut_free means no tree nuts or peanuts."
  );
  const prompt = lines.join("\n");
  const data = await callClaude(env, { model, max_tokens: 600, messages: [{ role: "user", content: [{ type: "text", text: prompt }] }] });
  if (!data) {
    await refundAnalysis(env, user.id, day);
    return reply({ error: "The estimator is unavailable right now. Please try again." }, 502);
  }
  const result = buildAnalysis(parseModelJson(data), r.servings);
  if (!result) {
    await refundAnalysis(env, user.id, day);
    return reply({ error: "Couldn't estimate that recipe.", code: "analysis_failed", quota: { ...quota, used: Math.max(quota.used - 1, 0) } }, 422);
  }
  return reply({ ...result, quota });
}

/* ───────────── shopping lists ───────────── */

const AISLES = ["Produce", "Meat & seafood", "Dairy & eggs", "Bakery", "Pantry", "Frozen", "Drinks", "Household", "Other"];
const clip = (v, max) => (typeof v === "string" ? v : "").replace(/\s+/g, " ").trim().slice(0, max);

function sanitizeShop(b) {
  if (!b || !Array.isArray(b.recipes)) return null;
  let total = 0;
  const recipes = [];
  for (const r of b.recipes.slice(0, 40)) {
    if (!r || typeof r !== "object") continue;
    const name = clip(r.name, 120);
    const ingredients = (Array.isArray(r.ingredients) ? r.ingredients : []).map(x => clip(x, 300)).filter(Boolean).slice(0, 120);
    const times = Math.min(Math.max(parseInt(r.times, 10) || 1, 1), 14);
    if (!name || !ingredients.length) continue;
    total += ingredients.length;
    if (total > 600) break;
    recipes.push({ name, times, ingredients });
  }
  return recipes.length ? recipes : null;
}

function buildShopItems(parsed) {
  const arr = parsed && Array.isArray(parsed.items) ? parsed.items : null;
  if (!arr) return null;
  const out = [], seen = new Set();
  for (const it of arr.slice(0, 250)) {
    if (!it || typeof it !== "object") continue;
    const name = clip(it.name, 120);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({
      name,
      quantity: clip(it.quantity, 60),
      aisle: AISLES.includes(it.aisle) ? it.aisle : "Other",
      staple: it.staple === true,
      from: (Array.isArray(it.from) ? it.from : []).map(x => clip(x, 60)).filter(Boolean).slice(0, 6).join(", ").slice(0, 300),
    });
  }
  return out.length ? out : null;
}

async function handleShoppingList(request, env, user, day, reply) {
  let body;
  try { body = await request.json(); } catch { return reply({ error: "Bad request." }, 400); }
  const recipes = sanitizeShop(body);
  if (!recipes) return reply({ error: "There are no recipes with ingredients to build a list from.", code: "no_recipes" }, 422);
  const row = await consumeAnalysis(env, user.id, day);
  if (!row) return reply({ error: "Couldn't check your daily limit. Try again." }, 502);
  const quota = { used: row.r_used, limit: row.r_limit, plan: row.r_plan };
  if (!row.r_allowed) return reply({ error: "You've used all " + row.r_limit + " estimates and list builds for today.", quota, code: "limit_reached" }, 429);

  const lines = [
    "You are helping someone build a grocery shopping list. Merge the recipes below into ONE shopping list.",
    "",
    "Rules:",
    "- Combine duplicate ingredients. Add quantities together when the units are the same or easy to convert (for example 2 tbsp + 1/4 cup).",
    "- Multiply a recipe's amounts by its \"times cooked\".",
    "- Give each item a plain grocery name with no preparation words (write \"onion\", not \"1 large onion, finely chopped\").",
    "- quantity is short and plain, such as \"3 cups\", \"2 lb\", \"1 bunch\", \"4\". Use \"\" if it is only to taste.",
    "- aisle must be exactly one of: " + AISLES.join(", ") + ".",
    "- staple is true for basics most kitchens already have: salt, pepper, water, cooking oil, and common dried spices. Otherwise false.",
    "- from lists the recipe names that need the item.",
    "",
    "Recipes:",
  ];
  recipes.forEach(r => {
    lines.push("", r.name + " (times cooked: " + r.times + ")");
    r.ingredients.forEach(i => lines.push("- " + i));
  });
  lines.push("", "Respond ONLY with this JSON (no markdown):", '{"items":[{"name":"onion","quantity":"2","aisle":"Produce","staple":false,"from":["Recipe name"]}]}');
  const model = (env.ALLOWED_MODELS || "claude-sonnet-4-5").split(",")[0].trim();
  const data = await callClaude(env, { model, max_tokens: 3500, messages: [{ role: "user", content: [{ type: "text", text: lines.join("\n") }] }] });
  if (!data) {
    await refundAnalysis(env, user.id, day);
    return reply({ error: "The list builder is unavailable right now. Please try again." }, 502);
  }
  const items = buildShopItems(parseModelJson(data));
  if (!items) {
    await refundAnalysis(env, user.id, day);
    return reply({ error: "Couldn't build that list.", code: "list_failed", quota: { ...quota, used: Math.max(quota.used - 1, 0) } }, 422);
  }
  return reply({ items, quota });
}

/* ───────────── voice and video recipes: speech to text ───────────── */

function wavSeconds(u8) {
  if (u8.length < 44) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tag = o => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let off = 12, rate = 0, ch = 0, bits = 0, dataBytes = 0;
  while (off + 8 <= u8.length) {
    const id = tag(off), size = dv.getUint32(off + 4, true);
    if (id === "fmt ") { ch = dv.getUint16(off + 10, true); rate = dv.getUint32(off + 12, true); bits = dv.getUint16(off + 22, true); }
    if (id === "data") { dataBytes = Math.min(size, u8.length - off - 8); break; }
    off += 8 + size + (size % 2);
  }
  if (rate < 8000 || rate > 48000 || (ch !== 1 && ch !== 2) || bits !== 16 || !dataBytes) return null;
  return dataBytes / (rate * ch * 2);
}
function toBase64(u8) {
  let bin = "";
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function handleTranscribe(request, env, user, day, reply) {
  if (!env.AI) return reply({ error: "Voice and video recipes aren't set up on the server yet.", code: "no_ai" }, 501);
  const buf = await request.arrayBuffer();
  if (buf.byteLength > 6000000) return reply({ error: "That audio clip is too large.", code: "bad_audio" }, 413);
  const u8 = new Uint8Array(buf);
  const secs = wavSeconds(u8);
  if (secs === null || secs > 90) return reply({ error: "That audio clip couldn't be read.", code: "bad_audio" }, 422);
  const seconds = Math.max(1, Math.ceil(secs));
  const q = await rpc(env, "consume_voice", {
    p_user: user.id, p_day: day, p_seconds: seconds,
    p_free_limit: Number(env.FREE_VOICE_SECONDS ?? 600),
    p_premium_limit: Number(env.PREMIUM_VOICE_SECONDS ?? 7200),
  });
  if (!q.ok) { console.error("voice quota check failed", q.status); return reply({ error: "Couldn't check your daily limit. Try again." }, 502); }
  const row = (await q.json())[0];
  if (!row) return reply({ error: "Couldn't check your daily limit. Try again." }, 502);
  const quota = { used: row.r_used, limit: row.r_limit, plan: row.r_plan };
  if (!row.r_allowed) {
    return reply({ error: "You've used all " + Math.round(row.r_limit / 60) + " minutes of voice for today.", quota, code: "limit_reached" }, 429);
  }
  let out;
  try { out = await env.AI.run("@cf/openai/whisper-large-v3-turbo", { audio: toBase64(u8) }); }
  catch (e) {
    console.error("transcription failed", e && e.message);
    await rpc(env, "refund_voice", { p_user: user.id, p_day: day, p_seconds: seconds }).catch(() => {});
    return reply({ error: "The transcriber is unavailable right now. Please try again." }, 502);
  }
  const text = out && typeof out.text === "string" ? out.text.trim().slice(0, 6000) : "";
  return reply({ text, seconds, quota });
}

/* ───────────── entry point ───────────── */

export default {
  async fetch(request, env) {
    const allowed = (env.ALLOWED_ORIGINS || "https://troymd123.github.io").split(",").map(s => s.trim()).filter(Boolean);
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0],
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };
    const reply = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const path = new URL(request.url).pathname;
    const isQuota = request.method === "GET" && path === "/quota";
    const isPage = request.method === "POST" && path === "/page";
    const isAnalyze = request.method === "POST" && path === "/analyze";
    const isShopList = request.method === "POST" && path === "/shopping-list";
    const isTranscribe = request.method === "POST" && path === "/transcribe";
    if (request.method !== "POST" && !isQuota) return reply({ error: "Method not allowed" }, 405);
    if (!allowed.includes(origin)) return reply({ error: "Origin not allowed" }, 403);
    for (const k of ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY", "ANTHROPIC_API_KEY"]) {
      if (!env[k]) return reply({ error: "The server isn't configured yet." }, 500);
    }

    // Who is asking? Ask Supabase to validate their sign-in token.
    const auth = request.headers.get("Authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!token) return reply({ error: "Please sign in first." }, 401);
    const who = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!who.ok) return reply({ error: "Your session expired. Please sign in again." }, 401);
    const user = await who.json();
    if (!user || !user.id) return reply({ error: "Please sign in first." }, 401);

    const tz = env.QUOTA_TZ || "America/New_York";
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    if (isQuota) return reply(await readQuota(env, user.id, day));
    if (isPage) return handlePage(request, env, user, day, reply);
    if (isAnalyze) return handleAnalyze(request, env, user, day, reply);
    if (isShopList) return handleShoppingList(request, env, user, day, reply);
    if (isTranscribe) return handleTranscribe(request, env, user, day, reply);

    // Claude proxy: is the request what we expect? Drop everything else.
    const raw = await request.text();
    if (raw.length > MAX_BODY_CHARS) return reply({ error: "That request is too large." }, 413);
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return reply({ error: "Bad request." }, 400); }
    const { clean, error } = sanitize(parsed, env);
    if (error) return reply({ error }, 400);

    // Do they have extractions left today? (counted atomically in the database)
    const row = await consume(env, user.id, day);
    if (!row) return reply({ error: "Couldn't check your daily limit. Try again." }, 502);
    const quota = { used: row.r_used, limit: row.r_limit, plan: row.r_plan };
    if (!row.r_allowed) {
      return reply({ error: `You've used all ${row.r_limit} extractions for today.`, quota, code: "limit_reached" }, 429);
    }

    // Ask Claude. If it fails, give the extraction back.
    const data = await callClaude(env, clean);
    if (!data) {
      await refund(env, user.id, day);
      return reply({ error: "The recipe reader is unavailable right now. Please try again." }, 502);
    }
    return reply({ content: data.content, quota });
  },
};
