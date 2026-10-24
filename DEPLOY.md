# Volcablearn 站長說明

給維護這個網站的人看的：怎麼架站、更新、改內建單字。

## 放到 GitHub Pages（公開網址）

> GitHub 免費帳號只能用**公開（Public）**的 repository 架 GitHub Pages。檔案內容任何人都看得到，所以**絕對不要把 API 金鑰寫進任何檔案**。

1. 登入 [github.com](https://github.com)（沒有帳號就先註冊）。
2. 右上角「**+**」→「**New repository**」。
   - Repository name 填 `Volcablearn`（可以自己取）。
   - 選 **Public**。
   - 按「**Create repository**」。
3. 在新 repository 頁面，點「**uploading an existing file**」連結。
4. 把這個資料夾裡的**所有檔案和 `icons` 資料夾**一起拖進網頁（拖「裡面的檔案」，不要拖外層資料夾）：
   `index.html`、`style.css`、`config.js`、`cefr.js`、`data.js`、`app.js`、`manifest.webmanifest`、`sw.js`、`README.md`、`icons/`、`worker/`
5. 拉到下面按「**Commit changes**」。
6. 上方點「**Settings**」→ 左側「**Pages**」。
7. 「Build and deployment」的 Source 選「**Deploy from a branch**」，Branch 選 **main**、資料夾選 **/ (root)** → 按「**Save**」。
8. 等 1～2 分鐘，重新整理 Pages 設定頁，會出現網址，格式是：
   `https://你的帳號.github.io/Volcablearn/`
   點「**Visit site**」就能打開。

### 之後要更新

改好檔案後，回到 repository →「**Add file**」→「**Upload files**」上傳覆蓋 → Commit。
等 1～2 分鐘後重新整理網頁（安裝成 App 的話，可能要關掉再打開一次才會看到新版）。


---

## 啟用共有詞庫（Cloudflare，免費、不用信用卡）

沒做這一段，網站也能正常使用（內建單字＋各自的詞庫）。做完之後：使用者新增的字會先送到伺服器，由 AI 審核，通過就加入「共有詞庫」，所有人都看得到；被 3 個人回報的字會自動隱藏。

會用到兩樣東西：**Worker**（放審核程式，保管你的 Gemini 金鑰）和 **D1**（存共有單字的資料庫）。程式在這個專案的 `worker/` 資料夾。

### 1. 註冊 Cloudflare

到 [dash.cloudflare.com](https://dash.cloudflare.com/sign-up) 用 Email 註冊並登入。免費方案就夠用，不需要綁卡。

### 2. 建立資料庫

1. 左側選單點「**D1 SQL database**」（在 Storage & Databases 底下）→「**Create Database**」。
2. 名稱填 `volcablearn-db`，按「**Create**」。
3. 進入這個資料庫 → 點「**Console**」。
4. 打開本專案的 `worker/schema.sql`，**整段複製**貼到 Console → 按「**Execute**」。
   如果出現「No SQL statements detected」，就改成**一行一行**貼上執行（共 6 行）。
   各表用途：`words` 共有單字、`reports` 回報紀錄、`rejected` AI 拒絕的投稿、`quota` 每日使用次數。
5. 點「**Tables**」，應該看到 `words`、`reports`、`rejected`、`quota` 四個表。

### 3. 建立 Worker

1. 左側「**Workers & Pages**」→「**Create application**」→「**Start with Hello World!**」→「**Get started**」。
2. 名稱填 `volcablearn-api` → 按「**Deploy**」。
3. 進入這個 Worker → 點右上「**Edit code**」（`</>` 圖示）。
4. 把編輯器裡 `worker.js` 的內容**全部刪掉**，貼上本專案 `worker/worker.js` 的全部內容 → 按「**Deploy**」（或 Save 後再 Deploy）。

### 4. 把資料庫接到 Worker

1. 回到 Worker 頁面 →「**Bindings**」分頁 →「**Add binding**」→ 選「**D1 database**」→「**Add binding**」。
2. **Variable name** 一定要填大寫的 `DB`。
3. 下拉選單選 `volcablearn-db` →「**Add binding**」。

### 5. 設定金鑰和變數

Worker 頁面 →「**Settings**」→「**Variables and Secrets**」→「**Add**」，依序新增：

| 類型 | 名稱 | 值 |
|---|---|---|
| Secret | `GEMINI_API_KEY` | 你的 Gemini API 金鑰（AI 審核用） |
| Secret | `ADMIN_TOKEN` | 自己想一串 **16 字以上**的亂碼，當作站長密碼，記下來 |
| Text（一般變數） | `ALLOWED_ORIGINS` | `https://rjian-collab.github.io` |

最後按「**Deploy**」。

> Secret 存進去之後就看不到原文了，金鑰不會出現在網頁或 GitHub 上。

### 6. 測試 Worker

Worker 頁面上方會顯示網址，例如 `https://volcablearn-api.你的帳號.workers.dev`。
在瀏覽器打開「網址 + `/api/health`」，看到 `{"ok":true,...}` 就成功了。

### 7. 讓網站連上 Worker

到 GitHub 專案，編輯 `config.js`（點檔案 → 右上鉛筆圖示），把網址填進引號：

```js
window.VOLCAB_CONFIG = {
  apiBase: "https://volcablearn-api.你的帳號.workers.dev"
};
```

按「**Commit changes**」，等 1～2 分鐘後重新整理網站。「詞庫 → 共有詞庫」顯示「已同步」就完成了。

### 8. 站長管理

網站「設定 → 共有詞庫 → 站長金鑰」填入你的 `ADMIN_TOKEN`。之後在「詞庫 → 共有詞庫」最下方會出現：
- **被回報而隱藏**的字：可以恢復公開或刪除。
- **等待 AI 審核**的字（AI 額度用完時會先排隊）：可以直接通過或刪除。
- **AI 拒絕的投稿**：AI 判斷錯了的話可以強制通過。

（選用）Worker →「**Settings**」→「**Trigger Events**」→ 新增 **Cron Trigger**（例如每 30 分鐘），排隊中的字會自動重新送 AI 審核。

### 免費額度與限制

- Workers 免費方案每天 10 萬次請求；D1 免費方案有 5 GB 空間，小型網站很夠用。
- 每個使用者每天最多投稿 30 個字、回報 50 次，避免被灌爆；要調整就改 `worker.js` 最上面的 `LIMITS`。
- AI 審核用的是**你的** Gemini 金鑰，每投稿一個字呼叫一次。免費額度用完時，投稿會排隊等待，不會出錯。

---

## 檔案說明

| 檔案 | 用途 | 什麼時候會改它 |
|---|---|---|
| `index.html` | 網頁骨架，負責載入下面的檔案 | 幾乎不用改 |
| `style.css` | 外觀：顏色、字體、卡片、按鈕樣式 | 想換顏色或版面時 |
| `data.js` | 內建詞庫（51 個字）與易混字題目 | 想增減內建單字時 |
| `app.js` | 主程式（JavaScript）：閃卡、遺忘曲線、測驗、統計、AI 新增單字 | 想改功能時 |
| `manifest.webmanifest` | 讓瀏覽器知道可以「安裝」成 App | 想改 App 名稱時 |
| `sw.js` | 離線快取，讓沒網路時也能打開 | 新增或改名檔案時要更新清單 |
| `icons/` | App 圖示 | 想換圖示時 |
| `config.js` | 共有詞庫伺服器網址（站長填） | 啟用共有詞庫時 |
| `cefr.js` | CEFR 單字等級表（估計單字難度、分級測驗） | 幾乎不用改 |
| `worker/` | Cloudflare 後端程式與資料表 | 啟用或修改共有詞庫時 |
| `og-image.png` | 分享到 Threads 等社群時顯示的預覽圖 | 想換預覽圖時 |

### 自己複製貼上建立檔案

如果不用上傳，也可以在 GitHub 上一個一個建立：repository 頁面 →「**Add file**」→「**Create new file**」，檔名填 `style.css` 這類名稱，把內容整段貼上 →「**Commit changes**」。每個檔案重複一次。`icons` 裡的圖片不能用貼的，要用「Upload files」上傳。

### 改內建單字要注意

- `data.js` 是 JavaScript 檔，每一列結尾要有逗號，最後一列可以沒有。
- 文字要用英文雙引號 `"` 包起來；中文裡不要出現英文雙引號。
- 改完存檔後重新整理網頁，打開瀏覽器的「開發人員工具」（按 F12）→「Console」，如果有紅字就是格式寫錯了。

### 本機測試

直接雙擊 `index.html` 就能用（不能安裝成 App，也不能離線）。
