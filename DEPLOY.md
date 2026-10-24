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
   `index.html`、`style.css`、`data.js`、`app.js`、`manifest.webmanifest`、`sw.js`、`README.md`、`icons/`
5. 拉到下面按「**Commit changes**」。
6. 上方點「**Settings**」→ 左側「**Pages**」。
7. 「Build and deployment」的 Source 選「**Deploy from a branch**」，Branch 選 **main**、資料夾選 **/ (root)** → 按「**Save**」。
8. 等 1～2 分鐘，重新整理 Pages 設定頁，會出現網址，格式是：
   `https://你的帳號.github.io/Volcablearn/`
   點「**Visit site**」就能打開。

### 之後要更新

改好檔案後，回到 repository →「**Add file**」→「**Upload files**」上傳覆蓋 → Commit。
等 1～2 分鐘後重新整理網頁（安裝成 App 的話，可能要關掉再打開一次才會看到新版）。


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
| `og-image.png` | 分享到 Threads 等社群時顯示的預覽圖 | 想換預覽圖時 |

### 自己複製貼上建立檔案

如果不用上傳，也可以在 GitHub 上一個一個建立：repository 頁面 →「**Add file**」→「**Create new file**」，檔名填 `style.css` 這類名稱，把內容整段貼上 →「**Commit changes**」。每個檔案重複一次。`icons` 裡的圖片不能用貼的，要用「Upload files」上傳。

### 改內建單字要注意

- `data.js` 是 JavaScript 檔，每一列結尾要有逗號，最後一列可以沒有。
- 文字要用英文雙引號 `"` 包起來；中文裡不要出現英文雙引號。
- 改完存檔後重新整理網頁，打開瀏覽器的「開發人員工具」（按 F12）→「Console」，如果有紅字就是格式寫錯了。

### 本機測試

直接雙擊 `index.html` 就能用（不能安裝成 App，也不能離線）。
