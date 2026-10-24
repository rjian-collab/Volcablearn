/* =========================================================
   Volcablearn 共有詞庫 API（Cloudflare Worker）

   需要的設定（Cloudflare 後台 → 這個 Worker → Settings）：
   - D1 資料庫綁定，變數名稱：DB
   - 機密變數（Secret）：
       GEMINI_API_KEY   你的 Gemini API 金鑰（AI 審核用）
       ADMIN_TOKEN      （可省略）站長金鑰，16 字以上；用 Google 登入當站長就不需要
   - 一般變數（Variable）：
       ALLOWED_ORIGINS  允許呼叫的網站，例如 https://rjian-collab.github.io
       GOOGLE_CLIENT_ID Google 登入用的用戶端 ID（xxxx.apps.googleusercontent.com）
       ADMIN_EMAILS     站長的 Gmail，多個用逗號分開
       GEMINI_MODEL     （可省略）預設 gemini-3.5-flash
   - Workers AI 綁定（建議）：Bindings → Add binding → Workers AI，變數名稱 AI。
     Gemini 因地區限制（例如被分到香港機房）不能用時，會自動改用 Cloudflare 的 AI 審核。
   需要的資料表會在第一次使用時自動建立。

   API：
   GET  /api/health                 檢查是否正常
   GET  /api/words?since=時間        取得共有單字（增量同步）
   POST /api/words                  投稿單字 → AI 審核 → 通過就公開
   POST /api/report                 回報單字（3 人回報自動隱藏）
   GET  /api/admin/queue            站長：被隱藏／待審核／被拒絕的清單
   POST /api/admin/word             站長：刪除、恢復、強制通過、忽略
   GET  /api/config                 前端設定（Google 用戶端 ID）
   POST /api/auth/google            用 Google 登入，換取登入憑證
   GET  /api/me                     目前登入的使用者
   POST /api/auth/logout            登出
   GET  /api/sync / PUT /api/sync   下載／上傳學習進度
   POST /api/account/delete         刪除雲端上的個人資料
   GET  /api/submission?w=單字       查詢投稿的審核結果
   GET  /api/diag                   測試每個 Gemini 模型能不能用、要多久（每天限 10 次）
   ========================================================= */

const LVS = ["A1", "A2", "B1", "B2", "C1", "C2"];
const POS = ["n", "v", "adj", "adv", "ph", "prefix"];
const LIMITS = { submitPerUser: 30, submitPerIp: 100, reportPerUser: 50 };
const HIDE_AFTER_REPORTS = 3;
const PAGE = 1000;
const SESSION_DAYS = 60;
const MAX_STATE = 900000; // 學習進度最大約 900 KB
const CF_MODELS = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/qwen/qwen3-30b-a3b-fp8", "@cf/meta/llama-3.3-70b-instruct-fp8", "@cf/zai-org/glm-4.7-flash"];
const GEMINI_FALLBACK = ["gemini-3.5-flash", "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      const url = new URL(request.url);
      const p = url.pathname.replace(/\/+$/, "");
      await ensureTables(env);
      let res;
      if (p === "/api/health") res = json({ ok: true, time: Date.now() });
      else if (p === "/api/status") res = json({
        // 只回報「有沒有設定」，不會透露任何金鑰內容
        db: !!env.DB,
        gemini_key: !!env.GEMINI_API_KEY,
        gemini_model: env.GEMINI_MODEL || "gemini-3.5-flash（預設）",
        admin_token: adminToken(env) ? (adminToken(env).length >= 16 ? "已設定" : "太短，至少 16 字") : "沒有讀到",
        allowed_origins: String(env.ALLOWED_ORIGINS || "（沒有設定）"),
        google_client_id: env.GOOGLE_CLIENT_ID ? "已設定" : "沒有讀到",
        admin_emails: adminEmails(env).length ? `已設定 ${adminEmails(env).length} 個` : "沒有讀到",
        workers_ai: env.AI ? "已綁定" : "沒有綁定（建議綁定，避免 Gemini 地區限制）",
        ai_model_in_use: (await metaGet(env, "ai_model")) || "（還沒成功審核過）",
        last_ai_error: (await metaGet(env, "ai_error")) || "（沒有）",
        placement: "（看 /api/diag 的 colo 欄位）",
        version: "2026-10-24f",
      });
      else if (p === "/api/config") res = json({ google_client_id: String(env.GOOGLE_CLIENT_ID || "").trim() });
      else if (p === "/api/auth/google" && request.method === "POST") res = await authGoogle(request, env);
      else if (p === "/api/me" && request.method === "GET") res = await me(request, env);
      else if (p === "/api/auth/logout" && request.method === "POST") res = await logout(request, env);
      else if (p === "/api/sync" && request.method === "GET") res = await syncGet(request, env);
      else if (p === "/api/sync" && request.method === "PUT") res = await syncPut(request, env);
      else if (p === "/api/account/delete" && request.method === "POST") res = await accountDelete(request, env);
      else if (p === "/api/words" && request.method === "GET") res = await listWords(url, env);
      else if (p === "/api/words" && request.method === "POST") res = await submitWord(request, env, ctx);
      else if (p === "/api/submission" && request.method === "GET") res = await submission(url, env);
      else if (p === "/api/diag" && request.method === "GET") res = await diag(request, env);
      else if (p === "/api/report" && request.method === "POST") res = await report(request, env);
      else if (p === "/api/admin/queue" && request.method === "GET") res = await adminQueue(request, env);
      else if (p === "/api/admin/word" && request.method === "POST") res = await adminWord(request, env);
      else res = json({ error: "找不到這個 API" }, 404);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (e) {
      const res = json({ error: e.publicMessage || "伺服器發生錯誤" }, e.status || 500);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      if (!e.publicMessage) console.error(e);
      return res;
    }
  },

  // 選用：在 Cloudflare 設定 Cron Trigger（例如每 30 分鐘），自動重審「等待審核」的字
  async scheduled(event, env, ctx) {
    await ensureTables(env);
    const { results } = await env.DB.prepare("SELECT w, data, created_by FROM words WHERE status = 'pending' ORDER BY created_at LIMIT 10").all();
    for (const r of results) {
      const word = JSON.parse(r.data);
      let review;
      try { review = await aiReview(word, env); } catch (e) { break; }
      await applyReview(env, word, review, r.created_by, true);
    }
  },
};

/* ---------- 工具 ---------- */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}
function fail(msg, status = 400) { const e = new Error(msg); e.publicMessage = msg; e.status = status; return e; }
function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  const ok = allowed.includes("*") ? "*" : allowed.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ? origin : "";
  const h = { "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Max-Age": "86400", Vary: "Origin" };
  if (ok) h["Access-Control-Allow-Origin"] = ok;
  return h;
}
const today = () => new Date().toISOString().slice(0, 10);
let lastTs = 0;
function nowTs() { const t = Date.now(); lastTs = t > lastTs ? t : lastTs + 1; return lastTs; }
async function sha(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}
async function readJson(request) {
  const text = await request.text();
  if (text.length > 20000) throw fail("資料太大");
  try { return JSON.parse(text || "{}"); } catch { throw fail("資料格式錯誤"); }
}
async function useQuota(env, key, max) {
  const d = today();
  const row = await env.DB.prepare("SELECT day, n FROM quota WHERE k = ?").bind(key).first();
  const n = row && row.day === d ? row.n : 0;
  if (n >= max) throw fail("今天的使用次數已達上限，明天再試", 429);
  await env.DB.prepare("INSERT INTO quota (k, day, n) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET day = excluded.day, n = excluded.n").bind(key, d, n + 1).run();
}
function adminToken(env) { return String(env.ADMIN_TOKEN || "").trim(); }
function isAdmin(request, env) {
  const t = adminToken(env);
  const h = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  return t.length >= 16 && h === t;
}
function adminEmails(env) { return String(env.ADMIN_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean); }
async function requireAdmin(request, env) {
  // 方法一：用 Google 登入，而且 Email 在 ADMIN_EMAILS 裡
  const s = await sessionOf(request, env);
  if (s) {
    if (s.email && adminEmails(env).includes(s.email.toLowerCase())) return;
    if (!adminToken(env)) throw fail(adminEmails(env).length ? "這個 Google 帳號不是站長（不在 ADMIN_EMAILS 裡）" : "Worker 沒有設定 ADMIN_EMAILS（站長的 Gmail）", 403);
  }
  // 方法二：站長金鑰
  const t = adminToken(env);
  if (!t) throw fail("請用站長的 Google 帳號登入（Cloudflare 要設定 ADMIN_EMAILS）", 401);
  if (t.length < 16) throw fail(`Cloudflare 裡的 ADMIN_TOKEN 只有 ${t.length} 個字，至少要 16 個字`, 401);
  if (!isAdmin(request, env)) throw fail("站長金鑰不正確", 401);
}

/* ---------- 驗證投稿內容 ---------- */
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
function cleanWord(o) {
  if (!o || typeof o !== "object") throw fail("缺少單字資料");
  const w = str(o.w, 60).toLowerCase().replace(/\s+/g, " ");
  if (!/^[a-z](?:[a-z' -]*[a-z-])?$/.test(w)) throw fail("單字只能包含英文字母、空格、連字號或撇號");
  const m = str(o.m, 40);
  if (!m) throw fail("缺少中文意思");
  const arr = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
  const word = {
    w,
    pos: POS.includes(o.pos) ? o.pos : w.includes(" ") ? "ph" : "n",
    m,
    alt: str(o.alt, 60),
    syn: arr(o.syn, 3).map(s => str(s, 40)).filter(Boolean),
    der: arr(o.der, 3).filter(Array.isArray).map(d => [str(d[0], 40), str(d[1], 10), str(d[2], 30)]).filter(d => d[0]),
    col: arr(o.col, 3).filter(Array.isArray).map(c => [str(c[0], 80), str(c[1], 40)]).filter(c => c[0]),
    ex: str(o.ex, 300),
    topic: str(o.topic, 10) || "社群",
    cefr: LVS.includes(String(o.cefr || "").toUpperCase()) ? String(o.cefr).toUpperCase() : "",
  };
  if (word.ex && !/\{[^}]+\}/.test(word.ex)) word.ex = "";
  return word;
}

/* ---------- AI 審核（Gemini） ---------- */
/* 呼叫一次 Gemini；逾時 25 秒就放棄 */
async function geminiCall(model, prompt, env, timeoutMs = 25000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST", signal: ac.signal,
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0 } }),
    });
    const j = await r.json().catch(() => ({}));
    const text = ((j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || []).map(p => p.text || "").join("");
    return { ok: r.ok, status: r.status, ms: Date.now() - t0, text, error: r.ok ? (text ? "" : "沒有回傳內容" + (j.promptFeedback && j.promptFeedback.blockReason ? `（${j.promptFeedback.blockReason}）` : "")) : ((j.error && j.error.message) || "HTTP " + r.status) };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, text: "", error: e.name === "AbortError" ? "逾時（超過 25 秒）" : String(e.message || e) };
  } finally { clearTimeout(timer); }
}
/* Cloudflare Workers AI（不受 Gemini 地區限制） */
async function cfCall(model, prompt, env, timeoutMs = 25000) {
  const t0 = Date.now();
  try {
    const r = await Promise.race([
      env.AI.run(model, { messages: [{ role: "user", content: prompt }], max_tokens: 600, temperature: 0 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("逾時（超過 25 秒）")), timeoutMs)),
    ]);
    let text = r && (typeof r.response === "string" ? r.response : r.response ? JSON.stringify(r.response) : "");
    if (!text && r && r.choices && r.choices[0]) text = (r.choices[0].message && r.choices[0].message.content) || r.choices[0].text || "";
    text = String(text || "").replace(/<think>[\s\S]*?<\/think>/g, "");
    return { ok: !!text, status: text ? 200 : 0, ms: Date.now() - t0, text, error: text ? "" : "沒有回傳內容" };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, text: "", error: String(e.message || e).slice(0, 160) };
  }
}
function parseReview(text) {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { const out = JSON.parse(text.slice(a, b + 1)); return typeof out.approve === "boolean" ? out : null; } catch { return null; }
}
function aiModels(env, preferred) {
  const list = [env.GEMINI_MODEL, preferred, ...GEMINI_FALLBACK].map(m => String(m || "").trim()).filter(Boolean);
  return [...new Set(list)];
}
async function aiReview(word, env) {
  if (!env.GEMINI_API_KEY && !env.AI) throw new Error("Worker 沒有讀到 GEMINI_API_KEY，也沒有綁定 Workers AI");
  const models = aiModels(env, "");
  const prompt = `你是英文單字卡的審核員。判斷下面這筆使用者投稿的單字資料能不能放進公開的共有單字庫。
檢查：
1. w 是否為真實存在、拼字正確的英文單字或常用片語。
2. 中文意思 m 是否正確，並和詞性 pos 相符。
3. 例句 ex（如果有）是否自然、正確使用這個字，且用大括號標出這個字。
4. 同義字 syn、派生詞 der、搭配詞 col 是否大致正確。
5. 是否含有不當、冒犯、廣告或與學英文無關的內容。
小錯誤請直接修正後通過；只有不是英文、意思完全錯誤或不當內容才拒絕。
只輸出一個 JSON，不要其他文字：
{"approve": true 或 false, "reason": "繁體中文，20 字以內", "cefr": "A1、A2、B1、B2、C1、C2 其中之一", "fix": {"m": "需要修正時才填", "pos": "需要修正時才填", "ex": "需要修正時才填，目標字用大括號標出"}}
投稿資料：
${JSON.stringify(word)}`;
  const errs = [];
  const pref = (await metaGet(env, "ai_model")) || "";
  const geoBlocked = Number(await metaGet(env, "gemini_geo")) > Date.now() - 3600000;
  const done = async (out, label) => {
    await metaSet(env, "ai_model", label);
    return {
      approve: out.approve === true,
      reason: str(out.reason, 60) || (out.approve ? "通過" : "未通過"),
      cefr: LVS.includes(String(out.cefr || "").toUpperCase()) ? String(out.cefr).toUpperCase() : "",
      fix: out.fix && typeof out.fix === "object" ? out.fix : {},
    };
  };
  const tryCf = async () => {
    if (!env.AI) return null;
    const list = [...new Set([pref.startsWith("@cf/") ? pref : "", env.WORKERS_AI_MODEL || "", ...CF_MODELS].filter(Boolean))];
    for (const model of list) {
      const r = await cfCall(model, prompt, env);
      const out = r.ok ? parseReview(r.text) : null;
      if (out) return done(out, model);
      errs.push(`${model}: ${r.ok ? "回傳格式看不懂" : r.error}`);
    }
    return null;
  };
  // 最近被 Gemini 地區擋過、或上次是 Cloudflare AI 成功的，就先用 Cloudflare AI
  if (env.AI && (geoBlocked || pref.startsWith("@cf/") || !env.GEMINI_API_KEY)) { const r = await tryCf(); if (r) return r; }
  if (env.GEMINI_API_KEY) {
    gem: for (const model of models.filter(m => !m.startsWith("@cf/"))) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await geminiCall(model, prompt, env);
        if (r.ok && r.text) {
          const out = parseReview(r.text);
          if (out) return done(out, model);
          errs.push(`${model}: 回傳格式看不懂`); break;
        }
        errs.push(`${model}: ${r.status || ""} ${r.error}`.trim());
        if (/location is not supported/i.test(r.error)) { await metaSet(env, "gemini_geo", Date.now()); break gem; }
        if ((r.status >= 500 || r.status === 0) && attempt === 0 && r.error.indexOf("逾時") < 0) { await new Promise(res => setTimeout(res, 1200)); continue; }
        if (r.status === 400 || r.status === 401 || r.status === 403) break gem;
        break;
      }
    }
    if (env.AI && !(geoBlocked || pref.startsWith("@cf/"))) { const r = await tryCf(); if (r) return r; }
  }
  await metaSet(env, "ai_error", new Date().toISOString().slice(0, 16) + " " + errs.join("；").slice(0, 380));
  throw new Error(errs.join("；") || "沒有可用的 AI（請設定 GEMINI_API_KEY 或綁定 Workers AI）");
}

async function applyReview(env, word, review, uid, fromPending) {
  const ts = nowTs();
  if (review.approve) {
    const f = review.fix || {};
    if (str(f.m, 40)) word.m = str(f.m, 40);
    if (POS.includes(f.pos)) word.pos = f.pos;
    if (str(f.ex, 300) && /\{[^}]+\}/.test(f.ex)) word.ex = str(f.ex, 300);
    if (!word.cefr && review.cefr) word.cefr = review.cefr;
    await env.DB.prepare(
      "INSERT INTO words (w, data, cefr, status, reports, created_by, created_at, updated_at, note) VALUES (?, ?, ?, 'approved', 0, ?, ?, ?, ?) " +
      "ON CONFLICT(w) DO UPDATE SET data = excluded.data, cefr = excluded.cefr, status = 'approved', updated_at = excluded.updated_at, note = excluded.note"
    ).bind(word.w, JSON.stringify(word), word.cefr || null, uid || null, ts, ts, "AI：" + review.reason).run();
    return { result: "approved", reason: review.reason, word };
  }
  if (fromPending) await env.DB.prepare("DELETE FROM words WHERE w = ? AND status = 'pending'").bind(word.w).run();
  await env.DB.prepare("INSERT INTO rejected (w, data, reason, uid, created_at) VALUES (?, ?, ?, ?, ?)").bind(word.w, JSON.stringify(word), review.reason, uid || null, ts).run();
  return { result: "rejected", reason: review.reason };
}

/* ---------- API ---------- */
async function listWords(url, env) {
  const since = Math.max(0, Number(url.searchParams.get("since")) || 0);
  const { results } = await env.DB.prepare(
    "SELECT w, data, cefr, status, updated_at FROM words WHERE updated_at > ? AND status IN ('approved', 'hidden', 'deleted') ORDER BY updated_at, w LIMIT ?"
  ).bind(since, PAGE).all();
  const words = results.map(r => {
    if (r.status !== "approved") return { w: r.w, status: r.status, updated_at: r.updated_at };
    const d = JSON.parse(r.data);
    return Object.assign(d, { w: r.w, cefr: r.cefr || d.cefr || "", status: "approved", updated_at: r.updated_at });
  });
  const more = results.length === PAGE;
  const next = results.length ? results[results.length - 1].updated_at : since;
  return json({ words, next, more });
}

async function submitWord(request, env, ctx) {
  const body = await readJson(request);
  const sess = await sessionOf(request, env);
  const uid = sess ? sess.uid : (str(body.uid, 40) || "anon");
  const word = cleanWord(body.word);
  const existing = await env.DB.prepare("SELECT status, data FROM words WHERE w = ?").bind(word.w).first();
  if (existing && existing.status !== "deleted") {
    return json({ result: existing.status === "approved" ? "exists" : existing.status === "pending" ? "pending" : "exists", reason: "共有詞庫已經有這個字" });
  }
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  await useQuota(env, "u:" + uid, LIMITS.submitPerUser);
  await useQuota(env, "ip:" + (await sha(ip + (env.ADMIN_TOKEN || ""))), LIMITS.submitPerIp);
  const ts = nowTs();
  await env.DB.prepare(
    "INSERT INTO words (w, data, cefr, status, reports, created_by, created_at, updated_at, note) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, 'AI 審核中') " +
    "ON CONFLICT(w) DO UPDATE SET data = excluded.data, status = 'pending', updated_at = excluded.updated_at, note = 'AI 審核中'"
  ).bind(word.w, JSON.stringify(word), word.cefr || null, uid, ts, ts).run();
  // 先回應使用者，AI 在背景審核（不用等）
  const job = reviewNow(env, word, uid);
  if (ctx && ctx.waitUntil) { ctx.waitUntil(job); return json({ result: "reviewing", reason: "AI 審核中" }); }
  return json(await job);
}
async function reviewNow(env, word, uid) {
  try {
    const review = await aiReview(word, env);
    return await applyReview(env, word, review, uid, true);
  } catch (e) {
    await env.DB.prepare("UPDATE words SET note = ? WHERE w = ? AND status = 'pending'").bind("AI 暫時無法審核：" + String(e.message || e).slice(0, 150), word.w).run();
    return { result: "pending", reason: "AI 暫時無法審核，稍後會再處理" };
  }
}
async function submission(url, env) {
  const w = str(url.searchParams.get("w"), 60).toLowerCase();
  const row = await env.DB.prepare("SELECT status, note, cefr FROM words WHERE w = ?").bind(w).first();
  if (row && row.status === "approved") return json({ status: "approved", reason: String(row.note || "").replace(/^AI：/, ""), cefr: row.cefr || "" });
  if (row && row.status === "pending") return json({ status: /無法/.test(row.note || "") ? "pending" : "reviewing", reason: row.note || "" });
  const rj = await env.DB.prepare("SELECT reason FROM rejected WHERE w = ? ORDER BY created_at DESC LIMIT 1").bind(w).first();
  if (rj) return json({ status: "rejected", reason: rj.reason || "" });
  if (row) return json({ status: row.status, reason: row.note || "" });
  return json({ status: "none" });
}
async function diag(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  await useQuota(env, "diag:" + (await sha(ip + (env.ADMIN_TOKEN || ""))), 10);
  const p = 'Reply with exactly this JSON and nothing else: {"approve": true}';
  const results = [];
  if (env.GEMINI_API_KEY) for (const model of aiModels(env, "").slice(0, 3)) {
    const r = await geminiCall(model, p, env, 12000);
    results.push({ model, ok: r.ok && /approve/.test(r.text), status: r.status, seconds: +(r.ms / 1000).toFixed(1), error: r.error.slice(0, 120) });
    if (/location is not supported/i.test(r.error)) break;
  }
  if (env.AI) for (const model of CF_MODELS) {
    const r = await cfCall(model, p, env, 15000);
    results.push({ model, ok: r.ok && /approve/.test(r.text), status: r.status, seconds: +(r.ms / 1000).toFixed(1), error: r.error.slice(0, 120) });
  }
  return json({ colo: (request.cf && request.cf.colo) || "", results });
}

async function report(request, env) {
  const body = await readJson(request);
  const uid = str(body.uid, 40);
  const w = str(body.w, 60).toLowerCase();
  if (!uid || !w) throw fail("缺少資料");
  const row = await env.DB.prepare("SELECT status FROM words WHERE w = ?").bind(w).first();
  if (!row) return json({ ok: true, note: "不是共有詞庫的字" });
  await useQuota(env, "r:" + uid, LIMITS.reportPerUser);
  await env.DB.prepare("INSERT OR IGNORE INTO reports (w, uid, reason, created_at) VALUES (?, ?, ?, ?)").bind(w, uid, str(body.reason, 40), Date.now()).run();
  const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE w = ?").bind(w).first();
  const n = (c && c.n) || 0;
  if (n >= HIDE_AFTER_REPORTS && row.status === "approved") {
    await env.DB.prepare("UPDATE words SET status = 'hidden', reports = ?, updated_at = ?, note = ? WHERE w = ?").bind(n, nowTs(), `被 ${n} 人回報`, w).run();
  } else {
    await env.DB.prepare("UPDATE words SET reports = ? WHERE w = ?").bind(n, w).run();
  }
  return json({ ok: true, reports: n, hidden: n >= HIDE_AFTER_REPORTS });
}

async function adminQueue(request, env) {
  await requireAdmin(request, env);
  const pick = r => { const d = JSON.parse(r.data); return { w: r.w, pos: d.pos, m: d.m, note: r.note || "", id: r.id }; };
  const hidden = (await env.DB.prepare("SELECT w, data, note FROM words WHERE status = 'hidden' ORDER BY updated_at DESC LIMIT 200").all()).results.map(pick);
  const pending = (await env.DB.prepare("SELECT w, data, note FROM words WHERE status = 'pending' ORDER BY created_at LIMIT 200").all()).results.map(pick);
  const rejected = (await env.DB.prepare("SELECT id, w, data, reason AS note FROM rejected ORDER BY created_at DESC LIMIT 200").all()).results.map(pick);
  return json({ hidden, pending, rejected });
}

async function adminWord(request, env) {
  await requireAdmin(request, env);
  const body = await readJson(request);
  const w = str(body.w, 60).toLowerCase();
  const ts = nowTs();
  switch (body.action) {
    case "delete":
      await env.DB.prepare("UPDATE words SET status = 'deleted', updated_at = ?, note = '站長刪除' WHERE w = ?").bind(ts, w).run();
      break;
    case "approve":
      await env.DB.prepare("UPDATE words SET status = 'approved', reports = 0, updated_at = ?, note = '站長通過' WHERE w = ?").bind(ts, w).run();
      await env.DB.prepare("DELETE FROM reports WHERE w = ?").bind(w).run();
      break;
    case "force": {
      const r = await env.DB.prepare("SELECT data FROM rejected WHERE id = ?").bind(Number(body.id) || 0).first();
      if (!r) throw fail("找不到這筆投稿", 404);
      const word = JSON.parse(r.data);
      await env.DB.prepare(
        "INSERT INTO words (w, data, cefr, status, reports, created_at, updated_at, note) VALUES (?, ?, ?, 'approved', 0, ?, ?, '站長強制通過') " +
        "ON CONFLICT(w) DO UPDATE SET data = excluded.data, status = 'approved', updated_at = excluded.updated_at, note = excluded.note"
      ).bind(word.w, r.data, word.cefr || null, ts, ts).run();
      await env.DB.prepare("DELETE FROM rejected WHERE id = ?").bind(Number(body.id)).run();
      break;
    }
    case "dismiss":
      await env.DB.prepare("DELETE FROM rejected WHERE id = ?").bind(Number(body.id) || 0).run();
      break;
    case "edit": {
      const word = cleanWord(Object.assign({}, body.word, { w }));
      await env.DB.prepare("UPDATE words SET data = ?, cefr = ?, updated_at = ?, note = '站長修改' WHERE w = ?").bind(JSON.stringify(word), word.cefr || null, ts, w).run();
      break;
    }
    default:
      throw fail("不支援的動作");
  }
  return json({ ok: true });
}

/* ---------- 資料表（第一次使用時自動建立） ---------- */
let tablesReady = false;
async function ensureTables(env) {
  if (tablesReady || !env.DB) return;
  const sql = [
    "CREATE TABLE IF NOT EXISTS words (w TEXT PRIMARY KEY, data TEXT NOT NULL, cefr TEXT, status TEXT NOT NULL DEFAULT 'approved', reports INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at INTEGER, updated_at INTEGER NOT NULL, note TEXT)",
    "CREATE INDEX IF NOT EXISTS idx_words_updated ON words(updated_at)",
    "CREATE TABLE IF NOT EXISTS reports (w TEXT NOT NULL, uid TEXT NOT NULL, reason TEXT, created_at INTEGER, PRIMARY KEY (w, uid))",
    "CREATE TABLE IF NOT EXISTS rejected (id INTEGER PRIMARY KEY AUTOINCREMENT, w TEXT NOT NULL, data TEXT NOT NULL, reason TEXT, uid TEXT, created_at INTEGER)",
    "CREATE TABLE IF NOT EXISTS quota (k TEXT PRIMARY KEY, day TEXT NOT NULL, n INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, uid TEXT NOT NULL, email TEXT, name TEXT, created_at INTEGER, expires_at INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS user_state (uid TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)",
  ];
  for (const s of sql) await env.DB.prepare(s).run();
  tablesReady = true;
}

/* ---------- Google 登入 ---------- */
let jwks = { keys: null, until: 0 };
async function googleKeys(force) {
  if (!force && jwks.keys && Date.now() < jwks.until) return jwks.keys;
  const r = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  if (!r.ok) throw fail("暫時無法連到 Google，請稍後再試", 503);
  const j = await r.json();
  const m = (r.headers.get("cache-control") || "").match(/max-age=(\d+)/);
  jwks = { keys: j.keys || [], until: Date.now() + (m ? Number(m[1]) * 1000 : 3600000) };
  return jwks.keys;
}
function b64url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
async function verifyGoogleToken(cred, clientId) {
  const parts = String(cred || "").split(".");
  if (parts.length !== 3) throw fail("Google 登入憑證格式錯誤", 401);
  const [h, p, sig] = parts;
  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64url(h)));
    payload = JSON.parse(new TextDecoder().decode(b64url(p)));
  } catch { throw fail("Google 登入憑證格式錯誤", 401); }
  if (header.alg !== "RS256") throw fail("Google 登入憑證格式錯誤", 401);
  let jwk = (await googleKeys(false)).find(k => k.kid === header.kid);
  if (!jwk) jwk = (await googleKeys(true)).find(k => k.kid === header.kid);
  if (!jwk) throw fail("無法驗證 Google 登入憑證", 401);
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(sig), new TextEncoder().encode(h + "." + p));
  if (!ok) throw fail("Google 登入憑證無效", 401);
  if (!["accounts.google.com", "https://accounts.google.com"].includes(payload.iss)) throw fail("Google 登入憑證無效", 401);
  if (payload.aud !== clientId) throw fail("Google 登入憑證不是發給這個網站的（檢查 GOOGLE_CLIENT_ID）", 401);
  if (!payload.exp || payload.exp * 1000 < Date.now() - 60000) throw fail("Google 登入憑證已過期，請重新登入", 401);
  if (!payload.sub) throw fail("Google 登入憑證無效", 401);
  return payload;
}
function randomToken() { return Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join(""); }
function bearer(request) { return (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim(); }
async function sessionOf(request, env) {
  const tok = bearer(request);
  if (!tok || tok.length !== 64) return null;
  const s = await env.DB.prepare("SELECT uid, email, name, expires_at FROM sessions WHERE token = ?").bind(tok).first();
  if (!s || s.expires_at < Date.now()) return null;
  return s;
}
async function requireSession(request, env) {
  const s = await sessionOf(request, env);
  if (!s) throw fail("登入已過期，請重新登入", 401);
  return s;
}
function userOut(s, env) {
  return { name: s.name || "", email: s.email || "", admin: !!(s.email && adminEmails(env).includes(String(s.email).toLowerCase())) };
}
async function authGoogle(request, env) {
  const clientId = String(env.GOOGLE_CLIENT_ID || "").trim();
  if (!clientId) throw fail("站長還沒設定 Google 登入（Cloudflare 缺少 GOOGLE_CLIENT_ID）", 503);
  const body = await readJson(request);
  const g = await verifyGoogleToken(body.credential, clientId);
  const email = g.email && g.email_verified !== false ? String(g.email).toLowerCase() : "";
  const s = { uid: "g:" + g.sub, email, name: str(g.name || g.given_name || "", 60) };
  const token = randomToken(), now = Date.now();
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now).run();
  await env.DB.prepare("INSERT INTO sessions (token, uid, email, name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").bind(token, s.uid, s.email, s.name, now, now + SESSION_DAYS * 86400000).run();
  const st = await env.DB.prepare("SELECT updated_at FROM user_state WHERE uid = ?").bind(s.uid).first();
  return json({ token, user: userOut(s, env), has_data: !!st, expires_at: now + SESSION_DAYS * 86400000 });
}
async function me(request, env) { const s = await requireSession(request, env); return json({ user: userOut(s, env) }); }
async function logout(request, env) {
  const tok = bearer(request);
  if (tok) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(tok).run();
  return json({ ok: true });
}

/* ---------- 學習進度同步 ---------- */
async function syncGet(request, env) {
  const s = await requireSession(request, env);
  const r = await env.DB.prepare("SELECT data, updated_at FROM user_state WHERE uid = ?").bind(s.uid).first();
  return json({ data: r ? r.data : null, updated_at: r ? r.updated_at : 0, user: userOut(s, env) });
}
async function syncPut(request, env) {
  const s = await requireSession(request, env);
  const text = await request.text();
  if (text.length > MAX_STATE + 1000) throw fail("學習進度太大，無法同步（請到設定匯出備份）", 413);
  let body;
  try { body = JSON.parse(text); } catch { throw fail("資料格式錯誤"); }
  if (typeof body.data !== "string" || !body.data.startsWith("{")) throw fail("資料格式錯誤");
  try { JSON.parse(body.data); } catch { throw fail("資料格式錯誤"); }
  const ts = Date.now();
  await env.DB.prepare("INSERT INTO user_state (uid, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(uid) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at").bind(s.uid, body.data, ts).run();
  return json({ ok: true, updated_at: ts });
}
async function accountDelete(request, env) {
  const s = await requireSession(request, env);
  await env.DB.prepare("DELETE FROM user_state WHERE uid = ?").bind(s.uid).run();
  await env.DB.prepare("DELETE FROM sessions WHERE uid = ?").bind(s.uid).run();
  return json({ ok: true });
}

async function metaGet(env, k) { try { const r = await env.DB.prepare("SELECT v FROM meta WHERE k = ?").bind(k).first(); return r ? r.v : ""; } catch { return ""; } }
async function metaSet(env, k, v) { try { await env.DB.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(k, String(v)).run(); } catch {} }
