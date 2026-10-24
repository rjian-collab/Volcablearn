/* =========================================================
   Volcablearn 共有詞庫 API（Cloudflare Worker）

   需要的設定（Cloudflare 後台 → 這個 Worker → Settings）：
   - D1 資料庫綁定，變數名稱：DB
   - 機密變數（Secret）：
       GEMINI_API_KEY  你的 Gemini API 金鑰（AI 審核用）
       ADMIN_TOKEN     站長金鑰，自己想一串 16 字以上的亂碼
   - 一般變數（Variable）：
       ALLOWED_ORIGINS 允許呼叫的網站，例如 https://rjian-collab.github.io
       GEMINI_MODEL    （可省略）預設 gemini-3.8-flash

   API：
   GET  /api/health                 檢查是否正常
   GET  /api/words?since=時間        取得共有單字（增量同步）
   POST /api/words                  投稿單字 → AI 審核 → 通過就公開
   POST /api/report                 回報單字（3 人回報自動隱藏）
   GET  /api/admin/queue            站長：被隱藏／待審核／被拒絕的清單
   POST /api/admin/word             站長：刪除、恢復、強制通過、忽略
   ========================================================= */

const LVS = ["A1", "A2", "B1", "B2", "C1", "C2"];
const POS = ["n", "v", "adj", "adv", "ph", "prefix"];
const LIMITS = { submitPerUser: 30, submitPerIp: 100, reportPerUser: 50 };
const HIDE_AFTER_REPORTS = 3;
const PAGE = 1000;

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      const url = new URL(request.url);
      const p = url.pathname.replace(/\/+$/, "");
      let res;
      if (p === "/api/health") res = json({ ok: true, time: Date.now() });
      else if (p === "/api/words" && request.method === "GET") res = await listWords(url, env);
      else if (p === "/api/words" && request.method === "POST") res = await submitWord(request, env);
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
  const h = { "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Max-Age": "86400", Vary: "Origin" };
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
function isAdmin(request, env) {
  const t = String(env.ADMIN_TOKEN || "");
  const h = request.headers.get("Authorization") || "";
  return t.length >= 16 && h === "Bearer " + t;
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
async function aiReview(word, env) {
  if (!env.GEMINI_API_KEY) throw new Error("no key");
  const model = env.GEMINI_MODEL || "gemini-3.8-flash";
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
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0 } }),
  });
  if (!r.ok) throw new Error("gemini " + r.status);
  const j = await r.json();
  const text = ((j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || []).map(p => p.text || "").join("");
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("bad ai output");
  const out = JSON.parse(text.slice(a, b + 1));
  return {
    approve: out.approve === true,
    reason: str(out.reason, 60) || (out.approve ? "通過" : "未通過"),
    cefr: LVS.includes(String(out.cefr || "").toUpperCase()) ? String(out.cefr).toUpperCase() : "",
    fix: out.fix && typeof out.fix === "object" ? out.fix : {},
  };
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

async function submitWord(request, env) {
  const body = await readJson(request);
  const uid = str(body.uid, 40) || "anon";
  const word = cleanWord(body.word);
  const existing = await env.DB.prepare("SELECT status, data FROM words WHERE w = ?").bind(word.w).first();
  if (existing && existing.status !== "deleted") {
    return json({ result: existing.status === "approved" ? "exists" : existing.status === "pending" ? "pending" : "exists", reason: "共有詞庫已經有這個字" });
  }
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  await useQuota(env, "u:" + uid, LIMITS.submitPerUser);
  await useQuota(env, "ip:" + (await sha(ip + (env.ADMIN_TOKEN || ""))), LIMITS.submitPerIp);
  let review;
  try {
    review = await aiReview(word, env);
  } catch (e) {
    const ts = nowTs();
    await env.DB.prepare(
      "INSERT INTO words (w, data, cefr, status, reports, created_by, created_at, updated_at, note) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, 'AI 暫時無法審核') " +
      "ON CONFLICT(w) DO UPDATE SET data = excluded.data, status = 'pending', updated_at = excluded.updated_at"
    ).bind(word.w, JSON.stringify(word), word.cefr || null, uid, ts, ts).run();
    return json({ result: "pending", reason: "AI 暫時無法審核，稍後會再處理" });
  }
  return json(await applyReview(env, word, review, uid, false));
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
  if (!isAdmin(request, env)) throw fail("站長金鑰不正確", 401);
  const pick = r => { const d = JSON.parse(r.data); return { w: r.w, pos: d.pos, m: d.m, note: r.note || "", id: r.id }; };
  const hidden = (await env.DB.prepare("SELECT w, data, note FROM words WHERE status = 'hidden' ORDER BY updated_at DESC LIMIT 200").all()).results.map(pick);
  const pending = (await env.DB.prepare("SELECT w, data, note FROM words WHERE status = 'pending' ORDER BY created_at LIMIT 200").all()).results.map(pick);
  const rejected = (await env.DB.prepare("SELECT id, w, data, reason AS note FROM rejected ORDER BY created_at DESC LIMIT 200").all()).results.map(pick);
  return json({ hidden, pending, rejected });
}

async function adminWord(request, env) {
  if (!isAdmin(request, env)) throw fail("站長金鑰不正確", 401);
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
