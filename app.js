/* =========================================================
   Volcablearn 主程式
   需要先載入 data.js（內建詞庫）。
   ========================================================= */
/* ---------- 資料（清理後，補充欄位為 AI 生成，待審核） ---------- */
/* ---------- 狀態與儲存 ---------- */
const KEY="wordbank.v1";
const DEF={target:0.9,growth:2.0,maxIv:365,newLimit:5,revLimit:50,types:{spell:true,choose:true,cloze:true,extend:false},slow:{card:8,spell:10,choose:6,cloze:12,extend:12,confuse:15},pracSrs:false,offset:0,topic:"all",dir:"en",goal:50,quizLen:10,timer:"normal",byLevel:true,src:"all"};
const clone=o=>JSON.parse(JSON.stringify(o));
let S, storageOk=true;
function load(){
  let d={};
  try{const raw=localStorage.getItem(KEY); if(raw) d=JSON.parse(raw)||{};}catch(e){storageOk=false;}
  S=fromData(d);
}
function fromData(d){
  const st=Object.assign(clone(DEF),d.settings||{});
  st.types=Object.assign(clone(DEF.types),(d.settings||{}).types||{});
  st.slow=Object.assign(clone(DEF.slow),(d.settings||{}).slow||{});
  return {settings:st,prog:d.prog||{},log:d.log||{},modeStats:d.modeStats||{},overrides:d.overrides||{},reviewed:d.reviewed||{},custom:Array.isArray(d.custom)?d.custom:[],savedAt:d.savedAt||0,xp:d.xp&&typeof d.xp==="object"?{total:+d.xp.total||0,days:d.xp.days||{}}:{total:0,days:{}},badges:d.badges||{},best:d.best||{combo:0},lv:Object.assign({theta:null,src:"",hist:{},test:null,skip:false},d.lv||{}),collect:d.collect||{},hidden:d.hidden||{},tomb:d.tomb||{}};
}
function save(){bump();S.savedAt=Date.now();try{localStorage.setItem(KEY,JSON.stringify(S));storageOk=true;}catch(e){storageOk=false;}pushCloud();acctPush();}
/* 雲端同步（只在 claude.ai 上開啟時可用；其他地方只存瀏覽器） */
let cloud=null,cloudState="off",cloudTimer=null;
const CL=()=>(typeof window!=="undefined"&&window.claude&&typeof window.claude.use==="function")?window.claude:null;
async function initCloud(){
  const c=CL();if(!c)return;
  try{
    const [db,user]=await Promise.all([c.use("db"),c.use("user")]);
    if(!db||!user)return;
    const id=await user.id();if(!id)return;
    const ref=db.doc("data/users/"+id+"/state");
    const snap=await ref.get();
    if(snap.exists){const d=snap.data()||{};let remote=null;try{remote=JSON.parse(d.state||"null");}catch(e){}
      if(remote&&(remote.savedAt||0)>(S.savedAt||0)){S=fromData(remote);bump();try{localStorage.setItem(KEY,JSON.stringify(S));}catch(e){}cur=null;}}
    cloud=ref;cloudState="on";
    if(!snap.exists||((snap.data()||{}).savedAt||0)<(S.savedAt||0))pushCloud(true);
    render();
  }catch(e){cloud=null;cloudState="off";}
}
function pushCloud(now){
  if(!cloud)return;clearTimeout(cloudTimer);
  const go=()=>cloud.set({state:JSON.stringify(S),savedAt:S.savedAt||Date.now()}).then(()=>{if(cloudState!=="on"){cloudState="on";render();}}).catch(()=>{cloud=null;cloudState="readonly";render();});
  if(now)go();else cloudTimer=setTimeout(go,1200);
}

/* ---------- 日期 ---------- */
const pad=n=>String(n).padStart(2,"0");
const ymd=d=>d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
const pd=s=>{const [y,m,d]=s.split("-").map(Number);return new Date(y,m-1,d,12);};
const addDays=(s,n)=>{const d=pd(s);d.setDate(d.getDate()+n);return ymd(d);};
const diffDays=(a,b)=>Math.round((pd(b)-pd(a))/864e5);
function today(){const d=new Date();d.setHours(12,0,0,0);d.setDate(d.getDate()+(+S.settings.offset||0));return ymd(d);}

/* ---------- 工具 ---------- */
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const pick=a=>a[Math.floor(Math.random()*a.length)];
const shuffle=a=>{a=a.slice();for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;};
const norm=s=>String(s).trim().toLowerCase().replace(/[’‘]/g,"'").replace(/\s+/g," ").replace(/-$/,"");
const alts=s=>String(s).split("|");
function eff(w){const o=S.overrides[w.w];return o?Object.assign({},w,o):w;}
let wver=0,_wv=-1,_wc=[];
function bump(){wver++;}
function baseWords(){
  const mine=(S.custom||[]).map(x=>x.src?x:Object.assign({src:"mine"},x));
  const core=WORDS.filter(w=>!S.hidden[w.w]);
  return core.concat(sharedWords(),mine);
}
function words(){if(_wv!==wver){_wc=baseWords().map(eff);_wv=wver;}return _wc;}
function byW(w){return words().find(x=>x.w===w);}
const NEWP={stage:0,due:null,ease:2.5,lapses:0,stubborn:false,c:0,wr:0,slow:0,lastRes:null,lastDay:null};
function getP(w){return S.prog[w]||NEWP;}
function P(w){return S.prog[w]||(S.prog[w]=clone(NEWP));}
function L(d){return S.log[d]||(S.log[d]={done:0,c:0,wr:0,slow:0,new:0,rev:0,prac:0});}
function blankOf(s){
  const m=s.match(/\{([^}]+)\}/);
  return {answers:m?alts(m[1]):[],blank:s.replace(/\{[^}]+\}/,"______"),full:s.replace(/\{([^}|]+)(\|[^}]*)?\}/,"$1")};
}
function pattern(w){return w.split(" ").map(t=>t[0]+"_".repeat(Math.max(1,t.length-1))).join(" ");}
/* 字母數提示：只露出第一個字母，其他字母變底線，空格、連字號照留，例如 remain constant → r_____ ________ */
function letterHint(ans){
  const a=String(ans);let first=true,n=0;
  const s=[...a].map(ch=>{if(/[a-z]/i.test(ch)){n++;if(first){first=false;return ch;}return "_";}return ch;}).join("");
  return `<p class="q lhint"><span class="lpat">${esc(s)}</span><span class="mute">共 ${n} 個字母</span></p>`;
}
const TOPICS=[...new Set(WORDS.map(w=>w.topic))];
function topicList(){return ["all",...new Set(words().map(w=>w.topic)),"頑固字"];}
function inMine(w){return w.src==="mine"||!!S.collect[w.w];}
function srcOk(w){const s=S.settings.src||"all";return s==="all"?true:s==="mine"?inMine(w):w.src!=="mine";}
function pool(){
  const t=S.settings.topic;
  return words().filter(w=>srcOk(w)&&(t==="all"?true:t==="頑固字"?getP(w.w).stubborn:w.topic===t));
}
const SRCL={all:"全部詞庫",mine:"我的詞庫",shared:"共有詞庫"};
function srcChips(){return `<span class="seg">${["all","mine","shared"].map(k=>`<button tabindex="-1" class="tog${(S.settings.src||"all")===k?" on":""}" data-act="src:${k}">${SRCL[k]}</button>`).join("")}</span>`;}
function avoided(a,b){return AVOID.some(([x,y])=>(x===a&&y===b)||(x===b&&y===a));}

/* ---------- CEFR 等級與使用者程度 ---------- */
const LVS=["A1","A2","B1","B2","C1","C2"];
const CEFR_MAP=Object.create(null),PLACE={A1:[],A2:[],B1:[],B2:[],C1:[],C2:[]};
(function(){if(typeof CEFR_LIST==="undefined")return;for(const l of LVS){for(let w of (CEFR_LIST[l]||"").split("|")){if(!w)continue;let p=false;if(w[0]==="*"){p=true;w=w.slice(1);}if(!CEFR_MAP[w])CEFR_MAP[w]=l;if(p)PLACE[l].push(w);}}})();
const LV_STOP=new Set(["the","a","an","of","to","in","on","at","by","for","with","be","one's","sb","sth","sb's","sth's","oneself","and","or"]);
function lookupLv(w){
  w=String(w||"").toLowerCase().trim().replace(/-$/,"");if(!w)return null;
  if(CEFR_MAP[w])return CEFR_MAP[w];
  const t=[];
  if(w.endsWith("ies"))t.push(w.slice(0,-3)+"y");if(w.endsWith("es"))t.push(w.slice(0,-2));if(w.endsWith("s"))t.push(w.slice(0,-1));
  if(w.endsWith("ed"))t.push(w.slice(0,-2),w.slice(0,-1));if(w.endsWith("ing"))t.push(w.slice(0,-3),w.slice(0,-3)+"e");
  if(w.endsWith("ly")){t.push(w.slice(0,-2));if(w.endsWith("ily"))t.push(w.slice(0,-3)+"y");if(/[ai]bly$/.test(w))t.push(w.slice(0,-1)+"e");}
  for(const x of t)if(CEFR_MAP[x])return CEFR_MAP[x];
  if(w.includes(" ")){let mx=-1;for(const p of w.split(" ")){if(LV_STOP.has(p))continue;const l=lookupLv(p);if(l)mx=Math.max(mx,LVS.indexOf(l));}if(mx>=0)return LVS[mx];}
  return null;
}
function lvOf(w){return w&&LVS.includes(w.cefr)?w.cefr:lookupLv(w&&w.w);}
const lvNum=l=>LVS.indexOf(l)+1;
function lvBadge(w){const l=lvOf(w);return l?`<span class="lv lv${l}">${l}</span>`:`<span class="lv">未分級</span>`;}
/* 使用者能力值 θ：1=A1 … 6=C2；答對機率 P = 1/(1+e^-(1.6(θ-b)+1.1))，θ=b 時約 75% */
function pKnow(theta,b){return 1/(1+Math.exp(-(1.6*(theta-b)+1.1)));}
function updateTheta(w,score){
  if(S.lv.theta==null||!w)return;const l=lvOf(w);if(!l)return;
  const p=pKnow(S.lv.theta,lvNum(l));
  S.lv.theta=Math.min(6.5,Math.max(0.5,S.lv.theta+0.06*(score-p)));S.lv.hist[today()]=+S.lv.theta.toFixed(3);
}
function myLevel(){const t=S.lv.theta;if(t==null)return null;return LVS[Math.min(5,Math.max(0,Math.round(t)-1))];}
function setLevel(theta,src){S.lv.theta=Math.min(6.5,Math.max(0.5,theta));S.lv.src=src;S.lv.hist[today()]=+S.lv.theta.toFixed(3);S.lv.skip=false;save();}
function lvWeight(w){
  if(!S.settings.byLevel||S.lv.theta==null)return 1;const l=lvOf(w);if(!l)return 1;
  const d=lvNum(l)-Math.round(S.lv.theta);return d===0?7:d===-1?2:d===1?1.2:d<=-2?0.3:0.2;
}

/* ---------- 分級測驗：認識／不認識＋假字 ---------- */
let pt=null;
function startPlacement(){
  const items=[];LVS.forEach(l=>shuffle(PLACE[l]).slice(0,10).forEach(w=>items.push({w,l})));
  shuffle(PSEUDO).slice(0,12).forEach(w=>items.push({w,l:null}));
  pt={items:shuffle(items),i:0,ans:[]};mode="placement";cur=null;render();
}
function ptAnswer(known){if(!pt||pt.done)return;pt.ans.push(!!known);pt.i++;if(pt.i>=pt.items.length)ptFinish();render();}
function ptFinish(){
  const by={};LVS.forEach(l=>by[l]={y:0,n:0});let fy=0,fn=0;
  pt.items.forEach((it,k)=>{const y=pt.ans[k];if(it.l){by[it.l].n++;if(y)by[it.l].y++;}else{fn++;if(y)fy++;}});
  const fa=fn?fy/fn:0,corr=LVS.map(l=>Math.max(0,(by[l].n?by[l].y/by[l].n:0)-fa));
  let idx=-1;for(let i=0;i<6;i++){if(corr[i]>=0.65)idx=i;else break;}
  const theta=idx<0?0.8:Math.min(6.4,idx+1+(idx<5?corr[idx+1]*0.45:0.3));
  pt.done=true;pt.result={corr,fa,theta,level:idx<0?"A1":LVS[idx],below:idx<0};
}
function pPlacement(){
  if(!pt)return `<div class="startcard"><h1>分級測驗</h1><p class="mute">還沒開始。</p><div class="actions"><button class="btn primary" data-act="pt-start">開始</button></div></div>`;
  if(pt.done){
    const r=pt.result;
    let h=`<div class="endcard"><div class="endtitle">你的程度約是 ${r.below?"A1 以下":r.level}</div><p class="sub">${esc(LV_DESC[r.level]||"")}</p>`;
    h+=`<div class="ptbars">${LVS.map((l,i)=>`<div class="ptb"><span>${l}</span><div class="hbar w"><i style="width:${Math.round(r.corr[i]*100)}%"></i></div><b>${Math.round(r.corr[i]*100)}%</b></div>`).join("")}</div>`;
    h+=`<p class="mute">每一級的分數 = 認識的真字比例 − 誤認假字的比例。分數在 65% 以上、而且下面每一級也都過關的最高等級，就是你的程度。</p>`;
    if(r.fa>0.3)h+=`<p class="acc">你把 ${Math.round(r.fa*100)}% 的假字選成「認識」，結果可能偏高或不準，建議重測時只在確定知道意思時才按「認識」。</p>`;
    h+=`<div class="actions"><button class="btn primary" data-act="pt-save">用這個結果 <kbd>Enter</kbd></button><button class="btn ghost" data-act="pt-start">重測</button></div><p class="note">之後答題時程度會自動微調，也可以在「設定」自己改。</p></div>`;
    return h;
  }
  const it=pt.items[pt.i],n=pt.items.length;
  return `<div class="qbar"><button class="qx" data-act="pt-quit" title="離開">✕</button><div class="prog big"><i style="width:${Math.round(pt.i/n*100)}%"></i></div><span class="qn">${pt.i+1} / ${n}</span></div>
  <div class="scene"><div class="fc"><div class="face"><span class="tag">分級測驗</span><div class="word">${esc(it.w)}</div><p class="hint">你知道這個字的意思嗎？清單裡有一些不存在的假字，亂按「認識」會扣分。</p></div></div></div>
  <div class="actions"><button class="btn red" data-act="pt-no"><span>不認識</span><kbd>1</kbd></button><button class="btn green" data-act="pt-yes"><span>認識</span><kbd>2</kbd></button></div>`;
}
const LV_DESC={A1:"入門：能看懂最基本的日常用字",A2:"基礎：熟悉生活常見用字",B1:"中級：能應付大部分日常與學校情境",B2:"中高級：能讀懂一般新聞與文章",C1:"高級：學術與專業文章大多沒問題",C2:"精通：接近母語人士的詞彙量"};
function levelPanel(compact){
  const L=myLevel();
  if(L==null)return `<div class="notice lvask"><p><b>先知道你的程度，題目才會剛剛好。</b></p><div class="row"><button class="btn primary" data-act="pt-start">做分級測驗（約 3 分鐘）</button><span class="mute">或自己選：</span>${LVS.map(l=>`<button class="tog" data-act="lvset:${l}">${l}</button>`).join("")}${compact?`<button class="link" data-act="lv-skip">先略過</button>`:""}</div></div>`;
  return "";
}

/* ---------- 遺忘曲線 ----------
  記憶率   R(t) = 0.9^(t / S)       t = 距上次複習天數，S = 穩定度（記憶率掉到 90% 需要幾天）
  下次間隔 I = S × ln(目標記憶率) / ln(0.9)   （目標 90% 時，I = S）
  複習後更新 S：
    會   S' = S × 成長倍率 × (易度/2.5) × (1 + max(0, 0.9 − R))   ← 快忘了還答對，加分
    模糊 S' = S × 1.2
    不會 S' = max(1, S × 0.3)，並且隔天再出
  新字第一次：S = 1（隔天先複習一次）
------------------------------------------------------------------ */
function retention(p,t){
  if(!p||p.stage===0||!p.S)return null;
  const el=Math.max(0,diffDays(p.lastDay||t,t||today()));
  return Math.pow(0.9,el/p.S);
}
function stabOf(p){ // 舊版進度沒有 S，用原本的間隔推回去
  if(p.S)return p.S;
  if(p.stage>0&&p.due&&p.lastDay)return Math.max(1,diffDays(p.lastDay,p.due));
  return p.stage>0?1:0;
}
function ivFromS(S0){
  const st=S.settings;
  return Math.min(st.maxIv,Math.max(1,Math.round(S0*Math.log(st.target)/Math.log(0.9))));
}
function nextS(p,res,t){
  const ease=p.ease,isNew=p.stage===0,s0=stabOf(p);
  if(isNew)return 1;
  const R=retention(Object.assign({},p,{S:s0}),t);
  if(res==="wrong")return Math.max(1,s0*0.3);
  if(res==="slow")return s0*1.2;
  return Math.max(s0+1,s0*S.settings.growth*(ease/2.5)*(1+Math.max(0,0.9-R)));
}
function applySRS(w,res){
  const t=today(),p=P(w),wasNew=p.stage===0;
  p.R=retention(Object.assign({},p,{S:stabOf(p)}),t);
  if(res==="wrong"){
    p.ease=Math.max(1.3,+(p.ease-0.2).toFixed(2));
    p.S=+nextS(p,res,t).toFixed(2);
    p.stage=1;p.lapses++;p.wr++;
    p.due=addDays(t,1);if(p.lapses>=3)p.stubborn=true;
  }else{
    p.ease=res==="fast"?Math.min(2.5,+(p.ease+0.05).toFixed(2)):Math.max(1.3,+(p.ease-0.05).toFixed(2));
    p.S=+nextS(p,res,t).toFixed(2);
    p.stage++;p.lapses=0;p.c++;if(res==="slow")p.slow++;
    p.due=addDays(t,ivFromS(p.S));
    if(p.stubborn&&p.stage>=4)p.stubborn=false;
  }
  p.lastAt=Date.now();p.lastDay=t;p.lastRes=res;
  const l=L(t);l.done++;wasNew?l.new++:l.rev++;res==="wrong"?l.wr++:l.c++;if(res==="slow")l.slow++;
  return Object.assign({},p);
}
function curR(w){const p=getP(w);return retention(Object.assign({},p,{S:stabOf(p)}),today());}
function todayQueue(){
  const t=today(),l=S.log[t]||{new:0,rev:0},ps=pool();
  const dueAll=ps.filter(w=>{const p=getP(w.w);return p.stage>0&&p.due&&p.due<=t;});
  dueAll.sort((a,b)=>curR(a.w)-curR(b.w)||getP(a.w).ease-getP(b.w).ease);   // 記憶率越低越先出
  const due=dueAll.slice(0,Math.max(0,S.settings.revLimit-l.rev));
  let nw=ps.filter(w=>getP(w.w).stage===0);
  if(S.settings.byLevel&&S.lv.theta!=null)nw=nw.map((w,i)=>[w,i]).sort((a,b)=>lvWeight(b[0])-lvWeight(a[0])||a[1]-b[1]).map(x=>x[0]);
  const news=nw.slice(0,Math.max(0,S.settings.newLimit-l.new));
  return {due,news,list:due.concat(news),dueTotal:dueAll.length};
}

/* ---------- 出題 ---------- */
function distractors(w,n){
  const ok=x=>x.w!==w.w&&!(w.grp&&x.grp===w.grp)&&x.m!==w.m&&!avoided(x.w,w.w);
  let c=shuffle(words().filter(x=>x.pos===w.pos&&ok(x)));
  if(c.length<n)c=c.concat(shuffle(words().filter(x=>x.pos!==w.pos&&ok(x))));
  const out=[],seen=new Set([w.m]);
  for(const x of c){if(out.length>=n)break;if(seen.has(x.m)||out.some(y=>y.grp&&y.grp===x.grp))continue;seen.add(x.m);out.push(x);}
  return out;
}
function pending(w){return S.reviewed[w.w]?"":' <span class="mute">（待審核）</span>';}
function inputLine(label,wide){return `<p class="q">${label}<input id="ans" type="text" class="${wide?"wide":""}" autocomplete="off" autocapitalize="off" spellcheck="false"></p>`;}
function makeQ(type,w){
  const q={type,w,phase:"ask",t0:0};
  if(type==="spell"){
    q.kind="input";q.answers=[w.w];
    const dup=words().some(x=>x.w!==w.w&&x.pos===w.pos&&x.m===w.m);
    q.html=`<p class="q"><span class="b">${esc(w.m)}</span>  <span class="mute">(${esc(w.pos)})</span></p>`+
      letterHint(w.w)+(dup?`<p class="q mute">另有同義的字，請依字母數作答</p>`:"")+inputLine("英文：");
  }else if(type==="choose"){
    q.kind="choice";const opts=shuffle([w,...distractors(w,3)]);
    q.opts=opts.map(x=>x.m);q.a=opts.indexOf(w);
    q.html=`<p class="q"><span class="b">${esc(w.w)}</span>  <span class="mute">(${esc(w.pos)})</span></p><p class="q">中文：______</p>`;
  }else if(type==="cloze"){
    q.kind="input";const b=blankOf(w.ex);q.answers=b.answers;
    const base=norm(b.answers[0])!==norm(w.w);
    q.html=`<p class="q pre">${esc(b.blank)}</p><p class="q mute">(${esc(w.pos)}) ${esc(w.m)}${base?"　· 注意詞形變化":""}${pending(w)}</p>`+letterHint(b.answers[0])+inputLine("填入：");
    q.after=`<p class="q">${esc(b.full)}</p>`;
  }else if(type==="extend"){
    q.kind="input";
    const subs=[];if(w.syn.length)subs.push("syn");if(w.der.length)subs.push("der");if(w.col.length)subs.push("col");
    q.sub=pick(subs);
    if(q.sub==="syn"){
      q.answers=w.syn.flatMap(alts);
      q.also=words().filter(x=>x.grp&&x.grp===w.grp&&x.w!==w.w).map(x=>x.w);
      q.html=`<p><span class="pill">同義字</span></p><p class="q"><span class="b">${esc(w.w)}</span> <span class="mute">(${esc(w.pos)})</span> ${esc(w.m)}</p><p class="q">寫出一個同義字${pending(w)}</p>`+inputLine("→ ");
      q.after=`<p class="q">可接受：${w.syn.map(s=>esc(alts(s).join(" / "))).join("、")}</p>`;
    }else if(q.sub==="der"){
      const d=pick(w.der);q.answers=[d[0]];
      q.html=`<p><span class="pill">詞性轉換</span></p><p class="q"><span class="b">${esc(w.w)}</span> <span class="mute">(${esc(w.pos)})</span> ${esc(w.m)}</p><p class="q">→ [${esc(d[1])}] ${esc(d[2])}${pending(w)}</p>`+letterHint(d[0])+inputLine("→ ");
      q.after=`<p class="q">全部：${w.der.map(d=>esc(d[0])+" ("+esc(d[1])+") "+esc(d[2])).join("；")}</p>`;
    }else{
      const c=pick(w.col),b=blankOf(c[0]);q.answers=b.answers;
      q.html=`<p><span class="pill">搭配詞</span></p><p class="q"><span class="b">${esc(b.blank)}</span>　${esc(c[1])}</p><p class="q mute">(${esc(w.pos)}) ${esc(w.m)}　· 注意詞形${pending(w)}</p>`+letterHint(b.answers[0])+inputLine("填入：");
      q.after=`<p class="q">${esc(b.full)}　｜ 其他搭配：${w.col.map(c=>esc(blankOf(c[0]).full)).join("、")}</p>`;
    }
  }
  return q;
}
function makeConf(item){
  const order=shuffle(item.o.map((_,i)=>i));
  return {type:"confuse",kind:"choice",phase:"ask",t0:0,item,opts:order.map(i=>item.o[i]),a:order.indexOf(item.a),
    html:`<p><span class="pill">${esc(item.s)}</span></p><p class="q b pre">${esc(item.q)}</p>`};
}

/* ---------- 拼字差異 ---------- */
function diffHTML(given,target){
  const a=given.trim().toLowerCase(),b=target.toLowerCase(),n=a.length,m=b.length;
  const D=Array.from({length:n+1},(_,i)=>Array(m+1).fill(0));
  for(let i=0;i<=n;i++)D[i][0]=i;for(let j=0;j<=m;j++)D[0][j]=j;
  for(let i=1;i<=n;i++)for(let j=1;j<=m;j++)D[i][j]=Math.min(D[i-1][j]+1,D[i][j-1]+1,D[i-1][j-1]+(a[i-1]===b[j-1]?0:1));
  let i=n,j=m,ops=[];
  while(i>0||j>0){
    if(i>0&&j>0&&D[i][j]===D[i-1][j-1]+(a[i-1]===b[j-1]?0:1)){ops.push([a[i-1]===b[j-1]?"=":"~",a[i-1],b[j-1]]);i--;j--;}
    else if(i>0&&D[i][j]===D[i-1][j]+1){ops.push(["+",a[i-1],""]);i--;}
    else{ops.push(["-","",b[j-1]]);j--;}
  }
  ops.reverse();
  const g=ops.map(([o,x,y])=>o==="="?esc(x):o==="~"?`<mark>${esc(x)}</mark>`:o==="+"?`<mark><s>${esc(x)}</s></mark>`:`<mark>_</mark>`).join("");
  const t=ops.map(([o,x,y])=>o==="="?esc(y):o==="+"?"":`<mark>${esc(y)}</mark>`).join("");
  return `<p class="q">你的：${g||'<span class="mute">（空白）</span>'}</p><p class="q">正確：${t}</p>`;
}

/* ---------- 介面狀態 ---------- */
const MODES=["cards","quiz","add","library","stats","settings"];
const PRACTICE=["cards","quiz"];
const NAVL={cards:"閃卡",quiz:"測驗",add:"新增",library:"詞庫",stats:"統計",settings:"設定"};
const QUIZ=["mix","spell","choose","extend","cloze","confuse"];
const TITLE={mix:"綜合",spell:"填字",choose:"選意思",extend:"延伸詞彙",cloze:"例句挖空",confuse:"易混字",stats:"統計",review:"審核補充資料",settings:"設定"};
let mode="cards",quizType="mix",cur=null,lastPick=null,msg="",resetArm=false,editing=null,reviewOnlyPending=false,focusAfter=null;
let sess=null,toasts=[],extBusy=false,again=[],extra=null,lastNote="",delArm=null,addInput="",drafts=[],addBusy=false,addMsg="",addErr=false;
function setMode(m){if(mode==="quiz"&&m!=="quiz"&&sess&&sess.finished)sess=null;const changed=mode!==m;mode=m;cur=null;msg="";editing=null;resetArm=false;render();if(changed)try{window.scrollTo(0,0);}catch(e){}}
function switchMode(d){setMode(MODES[(MODES.indexOf(mode)+d+MODES.length)%MODES.length]);}
function switchQuiz(d){if(sess&&!sess.finished)return;quizType=QUIZ[(QUIZ.indexOf(quizType)+d+QUIZ.length)%QUIZ.length];sess=null;cur=null;render();}

/* ---------- 成就感：XP、每日目標、等級、徽章 ---------- */
const BADGES=[
  {id:"first",ic:"🌱",name:"第一步",desc:"完成第一張閃卡或第一題測驗"},
  {id:"round1",ic:"🏁",name:"完成一輪",desc:"完成第一輪測驗"},
  {id:"perfect",ic:"💯",name:"完美一輪",desc:"一輪測驗每題都一次答對"},
  {id:"combo10",ic:"⚡",name:"連對 10 題",desc:"測驗中連續答對 10 題"},
  {id:"cleared",ic:"✅",name:"今日清空",desc:"把當天要複習的閃卡全部看完"},
  {id:"goal",ic:"🎯",name:"達成目標",desc:"第一次達成每日 XP 目標"},
  {id:"streak3",ic:"🔥",name:"三天不間斷",desc:"連續學習 3 天"},
  {id:"streak7",ic:"🔥",name:"一週不間斷",desc:"連續學習 7 天"},
  {id:"streak30",ic:"🏆",name:"一個月不間斷",desc:"連續學習 30 天"},
  {id:"learn10",ic:"📘",name:"10 個字",desc:"開始學習 10 個單字"},
  {id:"learn50",ic:"📚",name:"50 個字",desc:"開始學習 50 個單字"},
  {id:"learn100",ic:"🎓",name:"100 個字",desc:"開始學習 100 個單字"},
  {id:"master10",ic:"🧠",name:"記牢 10 個",desc:"10 個字的記憶穩定度超過 7 天"},
  {id:"adder",ic:"✍️",name:"擴充題庫",desc:"自己新增 5 個單字"},
];
function goal(){return S.settings.goal||50;}
function xpToday(){return (S.xp.days&&S.xp.days[today()])||0;}
function levelOf(x){let lv=1,need=100,acc=0;while(x>=acc+need){acc+=need;lv++;need+=50;}return {lv,into:x-acc,need};}
function addXP(n){
  const t=today(),before=xpToday();
  S.xp.total=(S.xp.total||0)+n;S.xp.days[t]=before+n;
  const lvA=levelOf(S.xp.total-n).lv,lvB=levelOf(S.xp.total).lv;
  if(before<goal()&&before+n>=goal()){toast(`🎯 達成今日目標 ${goal()} XP！`);celebrate();}
  if(lvB>lvA)toast(`⬆️ 升級到 Lv ${lvB}！`);
}
function unlock(id,got){if(!S.badges[id]){S.badges[id]=today();const b=BADGES.find(x=>x.id===id);if(b){toast(`${b.ic} 解鎖成就：${b.name}`);if(got)got.push(id);}}}
function checkBadges(got){
  const st=streak(),ws=words(),learned=ws.filter(w=>getP(w.w).stage>0).length,strong=ws.filter(w=>getP(w.w).stage>0&&stabOf(getP(w.w))>=7).length;
  if(S.xp.total>0)unlock("first",got);
  if(xpToday()>=goal())unlock("goal",got);
  if(st>=3)unlock("streak3",got);if(st>=7)unlock("streak7",got);if(st>=30)unlock("streak30",got);
  if(learned>=10)unlock("learn10",got);if(learned>=50)unlock("learn50",got);if(learned>=100)unlock("learn100",got);
  if(strong>=10)unlock("master10",got);
  if((S.custom||[]).length>=5)unlock("adder",got);
}
function hud(){
  const st=streak(),x=xpToday(),g=goal(),lv=levelOf(S.xp.total||0);
  return `<div class="hud"><span class="hs${st?" on":""}" title="連續學習天數">🔥 ${st}</span><span class="hx" title="今日 XP / 每日目標"><span class="hbar"><i style="width:${Math.min(100,Math.round(x/g*100))}%"></i></span><b>${x}</b>/${g} XP</span><span class="hl" title="等級，下一級還差 ${lv.need-lv.into} XP">Lv ${lv.lv}</span>${acctChip()}</div>`;
}
function toast(msg){
  toasts.push(msg);const box=document.getElementById("toasts");if(!box)return;
  while(box.children.length>=3)box.firstChild.remove();
  const el=document.createElement("div");el.className="toast";el.textContent=msg;box.appendChild(el);
  setTimeout(()=>{el.classList.add("out");setTimeout(()=>el.remove(),400);},2600);
}
function celebrate(){
  if(window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches)return;
  const cv=document.createElement("canvas");cv.className="confetti";document.body.appendChild(cv);
  const W=cv.width=innerWidth,H=cv.height=innerHeight,ctx=cv.getContext("2d");
  const cols=["#4f46e5","#10b981","#f59e0b","#ef4444","#06b6d4","#a855f7"];
  const ps=Array.from({length:140},()=>({x:W/2+(Math.random()-.5)*W*.3,y:H*.35,vx:(Math.random()-.5)*14,vy:-Math.random()*14-4,r:Math.random()*6+4,c:pick(cols),a:Math.random()*6,s:(Math.random()-.5)*.3}));
  let f=0;(function step(){ctx.clearRect(0,0,W,H);ps.forEach(p=>{p.vy+=.35;p.x+=p.vx;p.y+=p.vy;p.vx*=.99;p.a+=p.s;ctx.save();ctx.translate(p.x,p.y);ctx.rotate(p.a);ctx.fillStyle=p.c;ctx.fillRect(-p.r/2,-p.r/4,p.r,p.r/2);ctx.restore();});
    if(++f<110)requestAnimationFrame(step);else cv.remove();})();
}

/* ---------- 延伸詞彙加入題庫 ---------- */
const STDPOS=["n","v","adj","adv","ph","prefix"];
function normPos(p){p=String(p||"").toLowerCase().replace(/\.$/,"");return p==="a"?"adj":STDPOS.includes(p)?p:"";}
function inBank(w){w=String(w).toLowerCase().trim();return words().some(x=>x.w===w);}
function extItems(w){
  const out=[];
  w.syn.forEach((s,i)=>{const x=alts(s)[0];out.push({k:"syn",i,label:x,sub:"",w:x});});
  w.der.forEach((d,i)=>{if(normPos(d[1]))out.push({k:"der",i,label:d[0],sub:`${d[1]} ${d[2]}`,w:d[0]});});
  w.col.forEach((c,i)=>{const p=blankOf(c[0]).full;out.push({k:"col",i,label:p,sub:c[1],w:p});});
  return out;
}
function extChips(w,title){
  const it=extItems(w);if(!it.length)return "";
  const grp={syn:"同義",der:"派生",col:"搭配"};
  let h=`<div class="xwrap">${title?`<div class="xtitle">${title}</div>`:""}`;
  ["syn","der","col"].forEach(k=>{const xs=it.filter(x=>x.k===k);if(!xs.length)return;
    h+=`<div class="xrow"><span class="xk">${grp[k]}</span>${xs.map(x=>inBank(x.w)?`<span class="xchip have" title="已在題庫">${esc(x.label)} ✓</span>`:`<button class="xchip" data-ext="${k}:${x.i}" data-src="${esc(w.w)}" title="加入題庫">${esc(x.label)}${x.sub?` <small>${esc(x.sub)}</small>`:""} ＋</button>`).join("")}</div>`;});
  return h+`</div>`;
}
function linkGroup(src,neww){
  // 讓原字和同義字變成同一群組：選擇題不會把彼此當干擾選項
  const g=src.grp||("g-"+src.w);
  if(!src.grp){S.overrides[src.w]=Object.assign({},S.overrides[src.w]||{},{grp:g});}
  return g;
}
function newRec(o){const r=Object.assign({addedTs:Date.now(),alt:"",syn:[],der:[],col:[],ex:"",topic:"自訂",grp:"",custom:true,src:"mine",addedAt:today()},o);if(!r.cefr)r.cefr=lookupLv(r.w)||"";return r;}
async function addExt(code,srcW){
  const [k,iS]=code.split(":"),i=+iS,src=byW(srcW);if(!src)return;
  if(k==="der"){const d=src.der[i];const w=d[0].toLowerCase();if(inBank(w))return toast("已經在題庫裡了");
    S.custom.push(newRec({w,pos:normPos(d[1])||"n",m:d[2]||"（待補）",der:[[src.w,src.pos,src.m]],topic:src.topic,from:src.w}));S.reviewed[w]=false;
    save();toast(`已加入「${w}」`);checkBadges();render();shareRecs([w]);return;}
  if(k==="col"){const c=src.col[i];const w=blankOf(c[0]).full.toLowerCase();if(inBank(w))return toast("已經在題庫裡了");
    S.custom.push(newRec({w,pos:"ph",m:c[1]||"（待補）",syn:[],der:[[src.w,src.pos,src.m]],topic:src.topic,from:src.w}));S.reviewed[w]=false;
    save();toast(`已加入「${w}」`);checkBadges();render();shareRecs([w]);return;}
  // 同義字：沒有中文，交給 AI；沒有 AI 就送到新增頁
  const s=alts(src.syn[i])[0].toLowerCase();if(inBank(s))return toast("已經在題庫裡了");
  const canAI=hasClaude()||!!aiCfg().key;
  if(!canAI){addInput=(addInput?addInput.trim()+"\n":"")+s;toast(`「${s}」已放到「新增」頁，請補上中文`);manualDrafts();return;}
  if(extBusy)return toast("上一個字還在產生中，請稍等");
  extBusy=true;toast(`AI 正在幫「${s}」補資料…`);
  try{
    const items=parseAI(await callAI(buildPrompt([s])));const it=items[0];if(!it||!it.m)throw new Error("AI 沒有給出中文意思");
    if(inBank(it.w)){toast("已經在題庫裡了");}
    else{const g=linkGroup(src,it.w);S.custom.push(newRec(Object.assign({},it,{grp:g,from:src.w,note:undefined,input:undefined})));S.reviewed[it.w]=false;save();toast(`已加入「${it.w}」（${it.m}）`);checkBadges();shareRecs([it.w]);}
  }catch(e){toast("加入失敗："+e.message);}
  extBusy=false;render();
}

/* ---------- 測驗一輪 ---------- */
function fitFor(type,ps){return type==="cloze"?ps.filter(w=>blankOf(w.ex||"").answers.length):type==="extend"?ps.filter(w=>w.syn.length||w.der.length||w.col.length):ps;}
function buildSession(type,n){
  const items=[];
  if(type==="confuse"){shuffle(CONF).slice(0,Math.min(n,CONF.length)).forEach(c=>items.push({t:"confuse",c}));}
  else{
    let ps=pool();const chosen=[];
    const cand=type==="mix"?ps:fitFor(type,ps);
    let left=cand.slice();
    while(chosen.length<n&&left.length){const w=weightedPick(left);chosen.push(w);left=left.filter(x=>x.w!==w.w);}
    chosen.forEach(w=>{let t=type;
      if(type==="mix"){const ok=["choose","spell"];if(blankOf(w.ex||"").answers.length)ok.push("cloze");if(w.syn.length||w.der.length||w.col.length)ok.push("extend");t=pick(ok);}
      items.push({t,w:w.w});});
    if(type==="mix"&&items.length>=8)items[Math.floor(items.length/2)]={t:"confuse",c:pick(CONF)};
  }
  return {type,items,idx:0,base:items.length,firstOk:0,combo:0,maxCombo:0,xp:0,start:Date.now(),wrong:[],requeued:{},finished:false,got:[]};
}
function startSession(){sess=buildSession(quizType,S.settings.quizLen||10);cur=null;if(!sess.items.length){sess=null;toast("這個主題沒有可以出的題目");}render();}
function sessQ(){const it=sess.items[sess.idx];if(!it)return null;if(it.t==="confuse")return makeConf(it.c);const w=byW(it.w);return w?makeQ(it.t,w):null;}
function onSessAnswer(q){
  const it=sess.items[sess.idx],key=it.t+"|"+(it.w||it.c.q);
  if(q.res!=="wrong"){
    if(!sess.requeued[key])sess.firstOk++;
    sess.combo++;sess.maxCombo=Math.max(sess.maxCombo,sess.combo);
    const quick=q.limit?(q.ms<=q.limit*500):(q.res==="fast");
    let gain=10+(quick?5:0);
    if(sess.combo>0&&sess.combo%5===0){gain+=10;toast(`⚡ 連對 ${sess.combo} 題！ +10`);}
    sess.xp+=gain;addXP(gain);q.gain=gain;
  }else{
    sess.combo=0;if(q.timeout)sess.timeouts=(sess.timeouts||0)+1;
    if(!sess.requeued[key]){sess.requeued[key]=1;sess.items.push(Object.assign({},it));sess.wrong.push(it);}
  }
  S.best.combo=Math.max(S.best.combo||0,sess.maxCombo);
}
function finishSession(){
  sess.finished=true;sess.secs=Math.round((Date.now()-sess.start)/1000);
  const perfect=sess.firstOk===sess.base;
  const bonus=perfect?20:5;sess.bonus=bonus;sess.xp+=bonus;addXP(bonus);
  const got=sess.got;unlock("round1",got);if(perfect)unlock("perfect",got);if(sess.maxCombo>=10)unlock("combo10",got);checkBadges(got);
  save();celebrate();
}
/* ---------- 倒數計時 ---------- */
const TBASE={choose:12,confuse:20,spell:20,cloze:25,extend:25};
const TMODES=[["off","關閉",0],["easy","寬鬆",1.5],["normal","一般",1],["hard","挑戰",0.6]];
function timerOn(){return (S.settings.timer||"normal")!=="off"&&mode==="quiz"&&sess&&!sess.finished;}
function timeLimit(type){const m=(TMODES.find(x=>x[0]===(S.settings.timer||"normal"))||TMODES[2])[2];return Math.max(5,Math.round((TBASE[type]||20)*m));}
let tTimer=null,tHidden=0;
function stopTimer(){if(tTimer){cancelAnimationFrame(tTimer);tTimer=null;}}
function startTimer(){
  stopTimer();const q=cur;if(!q||q.phase!=="ask"||!q.limit)return;
  const bar=document.getElementById("tbar"),sec=document.getElementById("tsec"),box=document.getElementById("tbox");
  const tick=()=>{
    if(cur!==q||q.phase!=="ask"){tTimer=null;return;}
    if(document.hidden){tTimer=requestAnimationFrame(tick);return;}
    const left=Math.max(0,q.limit*1000-(performance.now()-q.t0));
    if(bar)bar.style.width=(left/(q.limit*1000)*100)+"%";
    if(sec)sec.textContent=Math.ceil(left/1000);
    if(box)box.classList.toggle("warn",left<=3000);
    if(left<=0){tTimer=null;q.timeout=true;submit(q.kind==="choice"?-1:"");return;}
    tTimer=requestAnimationFrame(tick);
  };
  tTimer=requestAnimationFrame(tick);
}
document.addEventListener("visibilitychange",()=>{
  if(document.hidden){tHidden=performance.now();}
  else if(tHidden){const d=performance.now()-tHidden;tHidden=0;if(cur&&cur.phase==="ask"&&cur.limit)cur.t0+=d;}
});
function pQuizEnd(){
  const s=sess,acc=Math.round(s.firstOk/s.base*100),perfect=s.firstOk===s.base;
  const mm=Math.floor(s.secs/60),ss=String(s.secs%60).padStart(2,"0");
  let h=`<div class="endcard"><div class="endtitle">${perfect?"完美！":acc>=80?"做得好！":"完成這一輪！"}</div><p class="sub">${TITLE[s.type]} · ${s.base} 題</p>
    <div class="endstats"><div><b>+${s.xp}</b><span>XP</span></div><div><b>${acc}%</b><span>一次答對</span></div><div><b>${s.maxCombo}</b><span>最高連對</span></div><div><b>${mm}:${ss}</b><span>用時${s.timeouts?` · 超時 ${s.timeouts}`:""}</span></div></div>`;
  h+=`<div class="goalline">${hudGoalText()}</div>`;
  if(s.got.length)h+=`<div class="newbadges">${s.got.map(id=>{const b=BADGES.find(x=>x.id===id);return `<div class="badge on"><span class="bi">${b.ic}</span><b>${esc(b.name)}</b><small>${esc(b.desc)}</small></div>`;}).join("")}</div>`;
  if(s.wrong.length){h+=`<div class="wronglist"><h2>這輪答錯的</h2>${s.wrong.map(it=>{if(it.t==="confuse")return `<p>${esc(it.c.q)} → <b>${esc(it.c.o[it.c.a])}</b></p>`;const w=byW(it.w);return w?`<p><b>${esc(w.w)}</b> <span class="mute">${esc(w.pos)}</span> ${esc(w.m)}</p>`:"";}).join("")}</div>`;}
  h+=`<div class="actions"><button class="btn primary" data-act="again-round">再來一輪 <kbd>Enter</kbd></button><button class="btn ghost" data-act="quiz-menu">換題型</button></div></div>`;
  return h;
}
function hudGoalText(){const x=xpToday(),g=goal();return x>=g?`🎯 今日目標已達成（${x}/${g} XP）`:`今日 ${x}/${g} XP，再 ${g-x} XP 達成目標`;}
function pQuizStart(){
  const ps=pool();
  let h=`<div class="startcard"><h1>測驗</h1><p class="mute">一輪 ${S.settings.quizLen||10} 題，答錯的題目會在最後再出一次，全部答對才算完成。答對 +10 XP，剩一半以上時間答對再 +5，連對 5 題再 +10。時間到算答錯。</p>`;
  h+=`<p class="seg">${QUIZ.map(k=>`<button tabindex="-1" data-quiz="${k}" class="tog${k===quizType?" on":""}">${TITLE[k]}</button>`).join(" ")}</p>`;
  h+=`<p class="seg"><span class="mute">題數</span>${[5,10,20].map(n=>`<button tabindex="-1" class="tog${(S.settings.quizLen||10)===n?" on":""}" data-act="qlen:${n}">${n} 題</button>`).join(" ")}${quizType!=="confuse"?`<span class="mute">主題</span><button class="chip" data-act="topic">${esc(S.settings.topic==="all"?"全部主題":S.settings.topic)}</button>`:""}</p>`;
  h+=`<p class="seg"><span class="mute">詞庫</span>${srcChips()}</p>`;
  h+=`<p class="seg"><span class="mute">難度</span><button tabindex="-1" class="tog${S.settings.byLevel?" on":""}" data-act="bylevel">${myLevel()?`依我的程度（${myLevel()}）`:"依我的程度（未設定）"}</button><button tabindex="-1" class="tog${S.settings.byLevel?"":" on"}" data-act="bylevel-off">不限程度</button></p>`;
  if(S.settings.byLevel&&!myLevel())h+=levelPanel(false);
  h+=`<p class="seg"><span class="mute">倒數計時</span>${TMODES.map(([k,l,m])=>`<button tabindex="-1" class="tog${(S.settings.timer||"normal")===k?" on":""}" data-act="timer:${k}">${l}${m?`（選擇題 ${Math.max(5,Math.round(12*m))} 秒）`:""}</button>`).join(" ")}</p>`;
  const n=quizType==="confuse"?CONF.length:fitFor(quizType==="mix"?"choose":quizType,ps).length;
  h+=`<div class="actions"><button class="btn primary wide" data-act="start-round" ${n?"":"disabled"}>開始 <kbd>Enter</kbd></button></div>`;
  if(!n)h+=`<p class="acc" style="text-align:center">這個主題目前沒有可以出的題目，換個主題或題型試試。</p>`;
  h+=`<p class="note">${hudGoalText()}</p></div>`;
  return h;
}
function pQuiz(){
  if(!sess)return pQuizStart();
  if(sess.finished)return pQuizEnd();
  if(!cur){cur=sessQ();if(!cur){sess.idx++;if(sess.idx>=sess.items.length){finishSession();return pQuizEnd();}return pQuiz();}}
  const pctv=Math.round(sess.idx/sess.items.length*100);
  let h=`<div class="qbar"><button class="qx" data-act="quit-round" title="結束這一輪">✕</button><div class="prog big"><i style="width:${pctv}%"></i></div><span class="qn">${Math.min(sess.idx+1,sess.items.length)} / ${sess.items.length}</span></div>`;
  h+=`<div class="qmeta"><span class="pill">${TITLE[cur.type]||""}</span>${sess.combo>=2?`<span class="combo">⚡ 連對 ${sess.combo}</span>`:""}<span class="mute">本輪 +${sess.xp} XP</span></div>`;
  if(timerOn()&&cur.phase==="ask"&&!cur.limit)cur.limit=timeLimit(cur.type);
  const tb=cur.limit&&cur.phase==="ask"?`<div class="tbox" id="tbox"><div class="tline"><i id="tbar"></i></div><span class="tsec"><span id="tsec">${cur.limit}</span> 秒</span></div>`:"";
  return h+`<div class="qcard">${tb}${qBlock(cur)}</div>`;
}

/* ---------- 閃卡 ---------- */
function newCard(w,kind){
  const d=S.settings.dir==="mix"?(Math.random()<.5?"en":"zh"):S.settings.dir;
  return {type:"card",kind,w,dir:d,phase:"front",t0:performance.now(),think:0};
}
function flip(){if(cur&&cur.type==="card"&&cur.phase==="front"){cur.phase="back";cur.think=performance.now()-cur.t0;
  const fc=document.querySelector(".fc");if(fc)fc.classList.add("flipped");
  const g=(n,cls,lab)=>`<button class="btn ${cls}" data-grade="${n}"><span>${lab}</span><small>${(cur.kind==="due"||cur.kind==="new")?preview(cur.w.w,n):"&nbsp;"}</small><kbd>${n}</kbd></button>`;
  const a=document.querySelector(".actions");if(a)a.innerHTML=g(1,"red","不會")+g(2,"amber","模糊")+g(3,"green","會");else render();}}
function grade(g){
  const c=cur;if(!c||c.type!=="card"||c.phase!=="back")return;
  const thr=S.settings.slow.card*1000;
  const res=g===1?"wrong":g===2?"slow":(c.think>thr?"slow":"fast");
  const w=c.w.w;
  if(c.kind==="again"){again.shift();if(g===1)again.push(w);lastNote=`${w}：${g===1?"等一下再來":"OK，今天先這樣"}`;addXP(2);}
  else if(c.kind==="free"){extra.shift();L(today()).prac++;lastNote=`${w}：自由複習（不計排程）`;addXP(2);}
  else{
    const p=applySRS(w,res);
    const m=S.modeStats.card||(S.modeStats.card={c:0,w:0,slow:0});res==="wrong"?m.w++:m.c++;if(res==="slow")m.slow++;
    if(res==="wrong"&&!again.includes(w))again.push(w);
    addXP(res==="fast"?10:res==="slow"?6:2);updateTheta(c.w,g===3?1:g===2?0.5:0);
    lastNote=`${w}：${res==="wrong"?"不會 → 明天再出，等一下也會再看一次":(res==="slow"?(g===3?"會，但想了 "+(c.think/1000).toFixed(0)+" 秒，記為模糊":"模糊"):"會")+" → "+diffDays(today(),p.due)+" 天後"}${p.stubborn?"（頑固字）":""}`;
  }
  const l=L(today());
  if(c.kind!=="free"&&!l.cleared&&!todayQueue().list.length&&!again.length&&l.done>0){l.cleared=1;addXP(20);unlock("cleared");toast("✅ 今天的閃卡全部完成！ +20 XP");celebrate();}
  checkBadges();save();cur=null;render();
}
function preview(w,g){
  if(g===1)return "明天";
  const p=Object.assign({},getP(w));p.ease=g===2?Math.max(1.3,p.ease-0.05):Math.min(2.5,p.ease+0.05);
  return ivFromS(nextS(p,g===2?"slow":"fast",today()))+" 天";
}
function pCards(){
  const Q=todayQueue(),l=S.log[today()]||{done:0};
  const total=l.done+Q.list.length,done=l.done;
  const pctv=total?Math.round(done/total*100):100;
  let h=(S.lv.skip?"":levelPanel(true))+`<div class="deckbar"><span>今日 <b>${done}</b> / ${total}</span><div class="prog"><i style="width:${pctv}%"></i></div><button class="chip" data-act="topic" title="切換主題 (/)">${esc(S.settings.topic==="all"?"全部主題":S.settings.topic)}</button><button class="chip" data-act="src-cycle" title="切換詞庫">${SRCL[S.settings.src||"all"]}</button></div>`;
  if((S.settings.src||"all")==="mine"&&!pool().length)return h+`<div class="startcard"><h1>你的詞庫還是空的</h1><p class="mute">到「新增」加入自己的單字，或到「詞庫 → 共有詞庫」收藏想背的字。</p><div class="actions"><button class="btn primary" data-mode="add">去新增單字</button><button class="btn ghost" data-act="src:all">改用全部詞庫</button></div></div>`;
  again=again.filter(x=>byW(x));
  if(!cur){
    if(Q.list.length)cur=newCard(Q.list[0],getP(Q.list[0].w).stage===0?"new":"due");
    else if(again.length)cur=newCard(byW(again[0]),"again");
    else if(extra&&extra.length)cur=newCard(byW(extra[0]),"free");
  }
  if(!cur){
    const next=words().map(w=>getP(w.w)).filter(p=>p.stage>0&&p.due>today()).map(p=>p.due).sort()[0];
    h+=`<div class="scene"><div class="fc done"><div class="face"><div class="word">今天完成了 🎉</div><p class="sub">${l.done} 張${next?" · 下一批："+next:""}</p><p class="sub">${hudGoalText()}</p>`;
    if(Q.dueTotal>Q.due.length)h+=`<p class="sub">另有 ${Q.dueTotal-Q.due.length} 張超過每日上限，可在設定調整</p>`;
    h+=`<div class="row" style="justify-content:center"><button class="btn primary" data-act="extra">隨機再看 10 張</button><button class="btn ghost" data-mode="quiz">去做一輪測驗</button></div><p class="hint">隨機複習不影響排程</p></div></div></div>`;
    return h;
  }
  const c=cur,w=c.w,tag={new:"新字",due:"複習",again:"再看一次",free:"自由複習"}[c.kind];
  const frontMain=c.dir==="en"?`<div class="word">${esc(w.w)}</div>`:`<div class="word zh">${esc(w.m)}</div>`;
  const exb=blankOf(w.ex||"");
  const exHTML=esc(exb.blank).replace("______",`<b>${esc(exb.answers[0])}</b>`);
  h+=`<div class="scene" data-act="flip"><div class="fc${c.phase==="back"?" flipped":""}">
    <div class="face front"><span class="tag">${tag}</span>${frontMain}<div class="pos">${esc(w.pos)}</div><p class="hint">點一下或按 Space 翻面</p></div>
    <div class="face back"><span class="tag">${tag}</span>
      ${c.kind==="due"?`<span class="rtag">預估記憶率 ${Math.round(curR(w.w)*100)}%</span>`:""}
      <div class="word sm">${esc(w.w)} <span class="pos">${esc(w.pos)}</span> ${lvBadge(w)}</div>
      <div class="meaning">${esc(w.m)}</div>
      ${w.alt?`<div class="alt">另有：${esc(w.alt)}</div>`:""}
      ${exb.answers.length?`<div class="ex">${exHTML}</div>`:""}
      ${extChips(w,"點「＋」把延伸詞彙加入題庫")}
    </div></div></div>`;
  const pv=c.kind==="due"||c.kind==="new";
  if(c.phase==="front"){
    h+=`<div class="actions"><button class="btn primary wide" data-act="flipbtn">顯示答案 <kbd>Space</kbd></button></div>`;
  }else{
    const g=(n,cls,lab)=>`<button class="btn ${cls}" data-grade="${n}"><span>${lab}</span><small>${pv?preview(w.w,n):"&nbsp;"}</small><kbd>${n}</kbd></button>`;
    h+=`<div class="actions">${g(1,"red","不會")}${g(2,"amber","模糊")}${g(3,"green","會")}</div>`;
  }
  h+=`<p class="note">${lastNote?"上一張：　"+esc(lastNote):"&nbsp;"}</p>`;
  return h;
}
function cycleTopic(){const t=topicList();S.settings.topic=t[(t.indexOf(S.settings.topic)+1)%t.length];save();cur=null;render();}

function submit(val){
  const q=cur;if(!q||q.phase!=="ask")return;
  const ms=performance.now()-q.t0;let ok;
  if(q.kind==="input"){q.given=String(val);const v=norm(val);ok=v!==""&&(q.answers.some(a=>norm(a)===v)||(q.also||[]).some(a=>norm(a)===v));q.viaGroup=ok&&!q.answers.some(a=>norm(a)===v);}
  else{q.given=val;ok=val===q.a;}
  q.ms=ms;q.res=!ok?"wrong":ms>S.settings.slow[q.type]*1000?"slow":"fast";q.phase="fb";
  const ms0=S.modeStats[q.type]||(S.modeStats[q.type]={c:0,w:0,slow:0});ok?ms0.c++:ms0.w++;if(q.res==="slow")ms0.slow++;
  if(q.w&&S.settings.pracSrs)q.srs=applySRS(q.w.w,q.res);
  else L(today()).prac++;
  if(sess&&!sess.finished&&mode==="quiz")onSessAnswer(q);
  if(q.w)updateTheta(q.w,ok?1:0);
  checkBadges();save();render();
}
function advance(){
  if(!cur)return;
  if(cur.phase==="front"){cur.phase="back";render();return;}
  if(cur.phase==="back"){cur=makeQ("choose",cur.w);render();return;}
  if(cur.phase==="ask"){if(cur.kind==="choice")submit(-1);else{const i=document.getElementById("ans");if(i)i.focus();}return;}
  if(cur.phase==="fb"){cur=null;
    if(sess&&!sess.finished&&mode==="quiz"){sess.idx++;if(sess.idx>=sess.items.length)finishSession();}
    render();}
}

/* ---------- 畫面 ---------- */
function render(){
  const app=document.getElementById("app");
  let h=`<header><div class="logo">Volcablearn</div><nav>${MODES.map(m=>`<button tabindex="-1" class="${m===mode?"on":""}" data-mode="${m}">${NAVL[m]}</button>`).join("")}</nav></header>${hud()}`;
  if(!storageOk)h+=`<p class="acc">> 注意：瀏覽器不允許儲存，進度只在本次分頁有效，請記得匯出 JSON。</p>`;
  h+=({cards:pCards,add:pAdd,quiz:pQuiz,stats:pStats,review:pReview,library:pLibrary,settings:pSettings,placement:pPlacement})[mode]();
  app.innerHTML=h;
  if(cur&&cur.phase==="ask"&&!cur.t0)cur.t0=performance.now();
  if(cur&&cur.phase==="ask"&&cur.limit&&mode==="quiz")startTimer();else stopTimer();
  const ans=document.getElementById("ans");
  if(ans&&cur&&cur.phase==="ask")ans.focus();
  else if(PRACTICE.includes(mode)&&document.activeElement&&document.activeElement!==document.body)document.activeElement.blur();
  if(focusAfter){const el=document.querySelector(focusAfter);if(el)el.focus();focusAfter=null;}
  paintGoogleButtons();
  document.getElementById("foot").textContent=mode==="add"?"一行一個單字 · Ctrl+Enter 讓 AI 產生 · Tab 切換頁面":mode==="cards"
    ?"Space 翻面 · 1 不會 · 2 模糊 · 3 會 · / 換主題 · Tab 切換頁面"
    :mode==="quiz"?(sess&&!sess.finished?"Enter 送出/下一題 · 1–4 選擇 · Esc 不會 · Tab 切換頁面":"Enter 開始 · [ ] 換題型 · / 換主題 · Tab 切換頁面")
    :mode==="placement"?"1 不認識 · 2 認識 · Tab 切換頁面"
    :mode==="library"?"搜尋可輸入英文或中文 · Tab 切換頁面"
    :mode==="review"?"↑↓ 移動 · a 確認/取消 · e 編輯 · Ctrl+Enter 儲存 · Tab 切換模式"
    :"↑↓ 移動 · Enter 執行 · Tab 切換模式";
}
function topicLine(){return `<p class="mute">topic: <button data-act="topic">${esc(S.settings.topic)}</button>  （按 / 切換）</p>`;}
function qBlock(q){
  let h=q.html;
  if(q.kind==="choice"){
    h+=q.opts.map((o,i)=>{
      if(q.phase==="ask")return `<button class="opt" data-opt="${i}"><span class="k">${i+1}</span>${esc(o)}</button>`;
      if(i===q.a)return `<div class="opt right"><span class="k">${i+1}</span>${esc(o)}</div>`;
      if(i===q.given)return `<div class="opt wrong"><span class="k">${i+1}</span>${esc(o)}</div>`;
      return `<div class="opt dim"><span class="k">${i+1}</span>${esc(o)}</div>`;
    }).join("");
  }
  if(q.phase==="fb"){
    if(q.kind==="input")h=h.replace(/<input id="ans"/,`<input id="ans" disabled value="${esc(q.given)}"`);
    const sec=(q.ms/1000).toFixed(1);
    const tag=q.timeout?`<span class="pill bad">⏰ 時間到</span>`:q.res==="wrong"?`<span class="pill bad">錯誤</span>`:q.res==="slow"?'<span class="pill ok">正確，但慢</span>':'<span class="pill ok">正確</span>';
    h+=`<hr><p class="q">${tag} · ${sec}s</p>`;
    if(q.viaGroup)h+=`<p class="q mute">同群組的字也算對；本題預期：${esc(q.answers.join(" / "))}</p>`;
    if(q.kind==="input"&&q.res==="wrong"){
      h+=(q.type==="spell"||q.type==="cloze"||(q.type==="extend"&&q.sub!=="syn"))?diffHTML(q.given,q.answers[0]):`<p class="q">你的：${esc(q.given)||'<span class="mute">（空白）</span>'}</p>`;
    }
    if(q.after)h+=q.after;
    if(q.type==="confuse")h+=`<p class="q">${esc(q.item.why)}</p>`;
    if(q.w&&q.type!=="extend"&&!(sess&&!sess.finished)){const w=q.w;
      h+=`<p class="q mute">${lvBadge(w)} ${esc(w.w)} (${esc(w.pos)}) ${esc(w.m)}${w.alt?"；另有："+esc(w.alt):""}　同義：${w.syn.map(s=>esc(alts(s)[0])).join(", ")}${pending(w)}</p>`;}
    if(q.srs)h+=`<p class="q">階段 ${q.srs.stage} · 易度 ${q.srs.ease} → 下次 ${q.srs.due}（${diffDays(today(),q.srs.due)} 天後）${q.srs.stubborn?' · <span class="acc">頑固字</span>':""}</p>`;
    if(q.gain)h+=`<p class="gain">+${q.gain} XP</p>`;
    if(q.w&&q.type==="extend")h+=extChips(q.w,"把延伸詞彙加入題庫");
    h+=`<p class="mute">Enter / Space → ${sess&&!sess.finished&&sess.idx+1>=sess.items.length?"看結果":"下一題"}</p>`;
  }
  return h;
}
function weightedPick(ps){
  const cand=ps.filter(w=>!lastPick||w.w!==lastPick||ps.length===1);
  const wt=cand.map(w=>{const p=getP(w.w);const r=curR(w.w);return (1+(r===null?3:(1-r)*10)+p.lapses*2+(p.stubborn?4:0))*lvWeight(w);});
  let r=Math.random()*wt.reduce((a,b)=>a+b,0);for(let i=0;i<cand.length;i++){r-=wt[i];if(r<=0)return cand[i];}return cand[cand.length-1];
}
function bar(n,max){return "#".repeat(max?Math.round(n/max*20):0);}
function pct(c,w){return c+w?Math.round(c/(c+w)*100)+"%":"—";}
function active(d){const l=S.log[d];return !!((l&&(l.done||l.prac))||(S.xp&&S.xp.days&&S.xp.days[d]));}
function streak(){
  let d=today(),n=0;if(!active(d))d=addDays(d,-1);
  while(active(d)){n++;d=addDays(d,-1);}return n;
}
function levelStats(){
  const L=myLevel();
  let h=`<h2>我的程度</h2>`;
  if(!L)return h+levelPanel(false);
  const th=S.lv.theta,days=Object.keys(S.lv.hist).sort().slice(-30);
  const pos=Math.min(100,Math.max(0,(th-0.5)/6*100));
  h+=`<div class="lvscale">${LVS.map(l=>`<span class="${l===L?"on":""}">${l}</span>`).join("")}<i style="left:${pos}%"></i></div>`;
  h+=`<p class="q"><b>${L}</b> · ${esc(LV_DESC[L])}<span class="mute">（能力值 ${th.toFixed(2)}，來源：${S.lv.src==="test"?"分級測驗":S.lv.src==="self"?"自己選擇":"答題調整"}，之後依答題自動微調）</span></p>`;
  if(days.length>1){const vals=days.map(d=>S.lv.hist[d]),mn=Math.min(...vals,1),mx=Math.max(...vals,6);
    const pts=vals.map((v,i)=>`${(i/(vals.length-1)*100).toFixed(1)},${(100-(v-mn)/(mx-mn||1)*100).toFixed(1)}`).join(" ");
    h+=`<svg class="lvtrend" viewBox="0 0 100 100" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke"/></svg><p class="q mute">近 ${days.length} 天的程度變化</p>`;}
  const ws=words(),cnt=LVS.map(l=>ws.filter(w=>lvOf(w)===l).length),un=ws.filter(w=>!lvOf(w)).length;
  h+=`<p class="q mute">題庫各等級字數：${LVS.map((l,i)=>`${l} ${cnt[i]}`).join(" · ")} · 未分級 ${un}</p>`;
  h+=`<p><button data-act="pt-start">重新做分級測驗</button></p>`;
  return h;
}
function pStats(){
  const t=today(),l=S.log[t]||{done:0,c:0,wr:0,slow:0,new:0,rev:0,prac:0},ws=words();
  const lv=levelOf(S.xp.total||0),nb=BADGES.filter(b=>S.badges[b.id]).length;
  let h=`<h1>統計</h1><div class="lvcard"><div><b>Lv ${lv.lv}</b><span>累積 ${S.xp.total||0} XP</span></div><div class="prog"><i style="width:${Math.round(lv.into/lv.need*100)}%"></i></div><small>再 ${lv.need-lv.into} XP 升到 Lv ${lv.lv+1}</small></div>`;
  h+=`<h2>成就 <span class="mute">${nb} / ${BADGES.length}</span></h2><div class="badges">${BADGES.map(b=>`<div class="badge${S.badges[b.id]?" on":""}" title="${esc(b.desc)}"><span class="bi">${b.ic}</span><b>${esc(b.name)}</b><small>${S.badges[b.id]?esc(S.badges[b.id])+" 解鎖":esc(b.desc)}</small></div>`).join("")}</div>`;
  h+=`<p class="q">最高連對：${S.best.combo||0} 題</p>`+levelStats()+`<hr><h2>今日 ${t}</h2>`;
  h+=`<p class="q">完成：${l.done}（新字 ${l.new} / 複習 ${l.rev}）· 自由練習 ${l.prac}</p>`;
  h+=`<p class="q">正確率：${pct(l.c,l.wr)}（${l.c}/${l.c+l.wr}）· 答對但慢 ${l.slow}</p>`;
  h+=`<p class="q">連續天數：${streak()} · 今日 XP：${xpToday()} / ${goal()}</p>`;
  const learned=ws.filter(w=>getP(w.w).stage>0),rs=learned.map(w=>curR(w.w));
  h+=`<p class="q">目前平均記憶率：${rs.length?Math.round(rs.reduce((a,b)=>a+b,0)/rs.length*100)+"%":"—"}（已學 ${learned.length} 字）</p>`;
  const B=[["新字",x=>x===0],["1–3 天",x=>x>0&&x<3],["3–7 天",x=>x>=3&&x<7],["7–21 天",x=>x>=7&&x<21],["21–60 天",x=>x>=21&&x<60],["60 天以上",x=>x>=60]];
  const cnt=B.map(([l,f])=>ws.filter(w=>{const p=getP(w.w);return f(p.stage===0?0:stabOf(p));}).length),mx=Math.max(...cnt);
  h+=`<h2>記憶穩定度分布 <span class="mute">（S＝記憶率掉到 90% 要幾天）</span></h2>`;
  B.forEach(([l],i)=>{h+=`<p class="bar">${l.padEnd(7," ")} ${String(cnt[i]).padStart(3)}  ${bar(cnt[i],mx)}</p>`;});
  const low=learned.map(w=>[w,curR(w.w)]).sort((a,b)=>a[1]-b[1]).slice(0,8);
  if(low.length){h+=`<h2>最快忘記的字</h2>`+low.map(([w,r])=>`<p class="q">${esc(w.w)} <span class="mute">${esc(w.m)} · 記憶率 ${Math.round(r*100)}% · S ${stabOf(getP(w.w)).toFixed(1)} 天</span></p>`).join("");}
  h+=`<h2>各題型正確率（累計，card＝閃卡自評）</h2>`;
  ["card","spell","choose","cloze","extend","confuse"].forEach(k=>{const m=S.modeStats[k]||{c:0,w:0,slow:0};h+=`<p class="q">${k.padEnd(8)} ${pct(m.c,m.w).padStart(4)}  （${m.c}/${m.c+m.w}，慢 ${m.slow}）</p>`;});
  h+=`<h2>主題</h2>`;
  [...new Set(ws.map(w=>w.topic))].forEach(tp=>{const g=ws.filter(w=>w.topic===tp);const c=g.reduce((a,w)=>a+getP(w.w).c,0),wr=g.reduce((a,w)=>a+getP(w.w).wr,0);const rr=g.filter(w=>getP(w.w).stage>0).map(w=>curR(w.w));const avg=rr.length?Math.round(rr.reduce((a,b)=>a+b,0)/rr.length*100)+"%":"—";h+=`<p class="q">${esc(tp)}：${g.length} 字 · 已學 ${rr.length} · 平均記憶率 ${avg} · 正確率 ${pct(c,wr)}</p>`;});
  const stub=ws.filter(w=>getP(w.w).stubborn);
  h+=`<h2>頑固字 <span class="mute">${stub.length}</span></h2>`;
  h+=stub.length?stub.map(w=>{const p=getP(w.w);return `<p class="q acc">${esc(w.w)} (${esc(w.pos)}) ${esc(w.m)} <span class="mute">連錯 ${p.lapses} · 累計錯 ${p.wr} · 階段 ${p.stage}</span></p>`;}).join(""):`<p class="q mute">沒有。連錯 3 次會自動列入；之後連對 3 次會移出。</p>`;
  const slow=ws.filter(w=>getP(w.w).lastRes==="slow");
  h+=`<h2>答對但慢 <span class="mute">${slow.length}</span></h2>`;
  h+=slow.length?slow.map(w=>`<p class="q">${esc(w.w)} <span class="mute">${esc(w.m)} · 慢 ${getP(w.w).slow} 次</span></p>`).join(""):`<p class="q mute">沒有。</p>`;
  h+=`<h2>最近 7 天</h2>`;
  const mxp=Math.max(goal(),...Array.from({length:7},(_,i)=>(S.xp.days||{})[addDays(t,-i)]||0));
  h+=`<div class="week">${Array.from({length:7},(_,k)=>{const i=6-k,d=addDays(t,-i),x=(S.xp.days||{})[d]||0;return `<div class="wd${x>=goal()?" met":""}"><div class="wcol"><i style="height:${Math.round(x/mxp*100)}%"></i></div><b>${x}</b><span>${d.slice(5)}</span></div>`;}).join("")}</div><p class="q mute">每天的 XP（綠色＝達成目標）</p>`;
  return h;
}
function fmtEdit(w){
  return `pos: ${w.pos}\ncefr: ${w.cefr||lvOf(w)||""}\nmeaning: ${w.m}\nalt: ${w.alt}\ntopic: ${w.topic}\nsyn: ${w.syn.join(", ")}\nder: ${w.der.map(d=>d.join("|")).join(" ; ")}\ncol: ${w.col.map(c=>c.join("|")).join(" ; ")}\nex: ${w.ex}`;
}
function parseEdit(txt,w){
  const o={};txt.split("\n").forEach(line=>{const m=line.match(/^\s*(\w+)\s*:\s*(.*)$/);if(!m)return;const k=m[1],v=m[2].trim();
    if(k==="pos"&&v)o.pos=v;else if(k==="cefr")o.cefr=LVS.includes(v.toUpperCase())?v.toUpperCase():"";else if(k==="meaning")o.m=v;else if(k==="alt")o.alt=v;else if(k==="topic")o.topic=v||w.topic;
    else if(k==="syn")o.syn=v?v.split(",").map(s=>s.trim()).filter(Boolean):[];
    else if(k==="der")o.der=v?v.split(";").map(s=>s.split("|").map(x=>x.trim())).filter(a=>a[0]).map(a=>[a[0],a[1]||"",a[2]||""]):[];
    else if(k==="col")o.col=v?v.split(";").map(s=>s.split("|").map(x=>x.trim())).filter(a=>a[0]).map(a=>[/\{/.test(a[0])?a[0]:a[0].replace(new RegExp("\\b"+w.w.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"\\b","i"),m=>"{"+m+"}"),a[1]||""]):[];
    else if(k==="ex")o.ex=v;});
  if(o.ex&&!/\{/.test(o.ex))throw new Error("例句要用 {} 標出挖空的字，例如 Prices {soared} in 2021.");
  return o;
}
function pReview(){
  const ws=words().filter(w=>w.src!=="shared"),done=ws.filter(w=>S.reviewed[w.w]).length;
  let h=`<h1>審核補充資料 <span class="mute">${done} / ${ws.length} 已確認</span></h1>`;
  h+=`<p class="mute">同義字、派生詞、搭配詞、例句、主題由 AI 生成，可能有錯。確認無誤按 a；要修改按 e。</p>`;
  h+=`<p><button data-nav class="tog${reviewOnlyPending?" on":""}" data-act="pendonly">只顯示待審核</button>　<button data-nav data-act="approveall">全部標為已確認</button></p>`;
  if(msg)h+=`<p class="acc">> ${esc(msg)}</p>`;
  h+=`<hr>`;
  ws.forEach((w,i)=>{
    if(reviewOnlyPending&&S.reviewed[w.w]&&editing!==w.w)return;
    const ok=S.reviewed[w.w],ed=!!S.overrides[w.w];
    h+=`<div class="blk" tabindex="0" data-nav data-w="${esc(w.w)}"><p><span class="b">${i+1}. ${esc(w.w)}</span> <span class="mute">(${esc(w.pos)})</span> ${esc(w.m)}　${ok?'<span class="pill ok">已確認</span>':'<span class="pill">待審核</span>'}${ed?' <span class="mute">· 已修改</span>':""}${w.custom?' <span class="pill">自訂</span>':""}</p>`;
    if(editing===w.w){
      h+=`<textarea id="edit" spellcheck="false">${esc(fmtEdit(w))}</textarea><p><button data-act="save" data-w="${esc(w.w)}">儲存 Ctrl+Enter</button>　<button data-act="cancel">取消 Esc</button>${S.overrides[w.w]?'　<button data-act="revert" data-w="'+esc(w.w)+'">還原為原始生成</button>':""}</p>`;
    }else{
      if(w.alt)h+=`<p class="q mute">其他意思：${esc(w.alt)}</p>`;
      h+=`<p class="q">同義：${w.syn.map(s=>esc(alts(s).join("/"))).join(", ")||"—"}</p>`;
      h+=`<p class="q">派生：${w.der.map(d=>esc(d[0])+" ("+esc(d[1])+") "+esc(d[2])).join("；")||"—"}</p>`;
      h+=`<p class="q">搭配：${w.col.map(c=>esc(blankOf(c[0]).full)+" "+esc(c[1])).join("；")}</p>`;
      h+=w.ex?`<p class="q">例句：${esc(blankOf(w.ex).full)} <span class="mute">← 挖空 ${esc(blankOf(w.ex).answers.join("/"))}</span></p>`:`<p class="q mute">例句：—</p>`;
      h+=`<p class="q mute">主題：${esc(w.topic)}${w.grp?" · 同義群組："+esc(w.grp):""}${w.from?" · 延伸自 "+esc(w.from):""}</p>`;
      h+=extChips(w,"加入題庫");
      h+=`<p><button data-act="approve" data-w="${esc(w.w)}">${ok?"取消確認":"確認"} a</button>　<button data-act="edit" data-w="${esc(w.w)}">編輯 e</button>${w.custom?`　<button data-act="delword" data-w="${esc(w.w)}">${delArm===w.w?"再按一次確認刪除":"刪除這個字"}</button>`:""}</p>`;
    }
    h+=`</div>`;
  });
  return h;
}
function chk(on,label,act){return `<button data-nav class="tog${on?" on":""}" data-act="${act}">${label}</button>`;}
function pSettings(){
  const st=S.settings;
  let h=`<h1>設定</h1>`;if(msg)h+=`<p class="acc">> ${esc(msg)}</p>`;
  h+=acctSection();
  h+=`<hr><h2>遺忘曲線</h2>`;
  h+=`<p class="q">目標記憶率（%）：<input data-nav type="number" min="70" max="97" data-k="target" value="${Math.round(st.target*100)}">　成長倍率：<input data-nav type="number" step="0.1" min="1.2" max="4" data-k="growth" value="${st.growth}">　最長間隔（天）：<input data-nav type="number" min="7" data-k="maxIv" value="${st.maxIv}"></p>`;
  h+=`<div class="formula">記憶率 R = 0.9<sup>t / S</sup>　（t＝距上次複習天數，S＝穩定度）<br>下次複習：記憶率掉到目標值的那一天 → 間隔 = S × ln(目標) / ln(0.9)<br>按「會」：S × 成長倍率 × 易度/2.5 × (1 + 快忘程度)；「模糊」：S × 1.2；「不會」：S × 0.3，隔天再出<br><span class="mute">目標記憶率調高 → 複習更頻繁、更不容易忘；調低 → 複習量變少。</span></div>`;
  h+=`<p class="q">每日新字上限：<input data-nav type="number" min="0" data-k="newLimit" value="${st.newLimit}">　每日複習上限：<input data-nav type="number" min="0" data-k="revLimit" value="${st.revLimit}"></p>`;
  h+=`<h2>我的程度（CEFR）</h2><p>${LVS.map(l=>`<button data-nav class="tog${myLevel()===l?" on":""}" data-act="lvset:${l}">${l}</button>`).join(" ")}　<button data-nav data-act="pt-start">做分級測驗</button></p><p class="q mute">${myLevel()?`目前 ${myLevel()}：${esc(LV_DESC[myLevel()])}。答題時會自動微調。`:"還沒設定。"}</p>`;
  h+=`<p>${chk(S.settings.byLevel,"依我的程度挑新字和測驗題","bylevel-toggle")}</p>`;
  h+=`<h2>卡片正面</h2><p>${[["en","英文 → 中文"],["zh","中文 → 英文"],["mix","混合"]].map(([k,l])=>`<button data-nav class="tog${st.dir===k?" on":""}" data-act="dir:${k}">${l}</button>`).join("　")}</p>`;
  h+=`<h2>「答對但慢」門檻（秒）<span class="mute"> card＝翻面前想多久</span></h2><p>${Object.keys(st.slow).map(k=>`${k} <input data-nav type="number" min="1" data-k="slow:${k}" value="${st.slow[k]}">`).join("　")}</p>`;
  h+=`<h2>每日目標</h2><p>${[20,50,100,150].map(n=>`<button data-nav class="tog${st.goal===n?" on":""}" data-act="goal:${n}">${n} XP${n===20?"（輕鬆）":n===50?"（一般）":n===100?"（認真）":"（衝刺）"}</button>`).join(" ")}</p>`;
  h+=`<h2>其他</h2><p>${chk(st.pracSrs,"quiz 測驗也計入遺忘曲線","prac")}</p>`;
  h+=`<p class="q">日期偏移（測試用，天）：<input data-nav type="number" data-k="offset" value="${st.offset}"> <span class="mute">目前視為 ${today()}</span></p>`;
  const ai=aiCfg();
  if(hasClaude()){
    h+=`<h2>AI 自動補資料</h2><p class="q">已連接你的 Claude 帳號，不需要 API 金鑰。第一次產生時會詢問是否允許，按允許即可；用的是你自己的 Claude 使用額度。</p><p><button data-nav data-act="aitest">測試連線</button></p>`;
  }else{
  h+=`<h2>AI 自動補資料</h2><p>${[["gemini","Gemini（Google，有免費額度）"],["anthropic","Claude（Anthropic，付費）"]].map(([k,l])=>`<button data-nav class="tog${ai.provider===k?" on":""}" data-act="ai:${k}">${l}</button>`).join(" ")}</p>`;
  h+=`<p class="q">API 金鑰：<input data-nav type="password" class="wide" data-ai="key" value="${esc(ai.key)}" placeholder="${ai.provider==="gemini"?"到 aistudio.google.com 取得":"到 console.anthropic.com 取得"}" autocomplete="off"></p>`;
  h+=`<p class="q">模型名稱：<input data-nav type="text" data-ai="model" value="${esc(ai.model)}" placeholder="${AIDEF[ai.provider]}"> <span class="mute">留空＝用預設</span></p>`;
  h+=`<p><button data-nav data-act="aitest">測試連線</button>${ai.key?`　<button data-nav data-act="aiclear">清除金鑰</button>`:""}</p>`;
  h+=keyGuide(ai.provider,!ai.key);
  }
  h+=`<h2>共有詞庫</h2><p class="q mute">${apiOn()?`已連上共有詞庫伺服器（${Object.keys(shared.words).length} 個社群單字）。`:CL()?"在 claude.ai 上開啟時無法使用共有詞庫。":"這個網站還沒設定共有詞庫伺服器（站長要在 config.js 填入網址）。"}</p>`;
  if(apiOn())h+=`<details class="guide"><summary>用站長金鑰管理（不用 Google 登入時）</summary><p class="q">站長金鑰：<input data-nav id="admkey" type="password" class="wide" value="${esc(adminKey())}" placeholder="只有站長需要填" autocomplete="off"> <button data-nav data-act="adm-verify">驗證並開啟站長管理</button> <span class="mute">填了之後「詞庫 → 共有詞庫」會出現管理功能</span></p></details>`;
  h+=`<h2>資料</h2><p class="q mute">${cloudState==="on"?"進度會自動同步到你的 Claude 帳號，換電腦打開這個網頁也看得到。":cloudState==="readonly"?"這個網頁目前不能幫你存到雲端，進度只存在這台裝置的瀏覽器，記得定期匯出備份。":"進度存在這台裝置的瀏覽器，換電腦或清除瀏覽資料會不見，記得定期匯出備份。"}</p>`;
  h+=`<p><button data-nav data-act="export">匯出 JSON</button>　<button data-nav data-act="import">匯入 JSON</button>　<button data-nav data-act="exportwords">匯出詞庫（含審核狀態）</button></p>`;
  h+=`<h2>資料來源</h2><p class="q mute">CEFR 單字等級：A1～B2 取自 CEFR-J Wordlist v1.5（Tono Laboratory, TUFS）；C1～C2 取自 Octanove Vocabulary Profile C1/C2 v1.0（Octanove Labs，CC BY-SA 4.0）。</p>`;
  h+=`<p><button data-nav data-act="reset" class="${resetArm?"acc":""}">${resetArm?"再按一次確認重設":"重設學習進度"}</button> <span class="mute">（審核與修改會保留）</span></p>`;
  return h;
}

/* ---------- 共有詞庫（Cloudflare Worker API） ---------- */
const API=(((typeof window!=="undefined"&&window.VOLCAB_CONFIG)||{}).apiBase||"").replace(/\/+$/,"");
function apiOn(){return !!API&&!CL();}
const SHK="volcab.shared";
let shared={since:0,words:{}},shSync="idle",shLast=0;
function loadShared(){try{const d=JSON.parse(localStorage.getItem(SHK)||"null");if(d&&d.words)shared=d;}catch(e){}}
function saveShared(){try{localStorage.setItem(SHK,JSON.stringify(shared));}catch(e){}}
function myUid(){let u="anon";try{u=localStorage.getItem("volcab.uid");if(!u){u=Array.from(crypto.getRandomValues(new Uint8Array(12)),b=>b.toString(16).padStart(2,"0")).join("");localStorage.setItem("volcab.uid",u);}}catch(e){}return u;}
function adminKey(){try{return localStorage.getItem("volcab.admin")||"";}catch(e){return "";}}
async function api(path,opt){
  opt=opt||{};const h={"Content-Type":"application/json"};const tk=sessTok();if(opt.admin)h.Authorization="Bearer "+(tk&&isAdminUser()?tk:adminKey());else if(tk)h.Authorization="Bearer "+tk;
  let r;try{r=await fetch(API+path,{method:opt.method||"GET",headers:h,body:opt.body?JSON.stringify(opt.body):undefined});}catch(e){throw new Error("連不上共有詞庫伺服器");}
  const j=await r.json().catch(()=>({}));if(!r.ok){const e=new Error(j.error||("伺服器錯誤 "+r.status));e.status=r.status;throw e;}return j;
}
async function syncShared(){
  if(!apiOn()||shSync==="busy")return;shSync="busy";
  try{let more=true,g=0;while(more&&g++<30){const j=await api("/api/words?since="+(shared.since||0));
      (j.words||[]).forEach(x=>{if(x.status!=="approved")delete shared.words[x.w];else shared.words[x.w]=x;});
      shared.since=j.next||shared.since;more=!!j.more;}
    saveShared();shSync="ok";shLast=Date.now();bump();
  }catch(e){shSync="error";}
  if(mode==="library"||mode==="cards"&&!cur)render();
}
function sharedWords(){
  const have=new Set(WORDS.map(w=>w.w).concat((S.custom||[]).map(w=>w.w)));
  return Object.values(shared.words).filter(x=>x&&x.w&&!have.has(x.w)&&!S.hidden[x.w]).map(x=>({w:x.w,pos:x.pos||"n",m:x.m||"",alt:x.alt||"",syn:x.syn||[],der:x.der||[],col:x.col||[],ex:x.ex||"",topic:x.topic||"社群",grp:"",cefr:x.cefr||"",src:"shared"}));
}
/* ---------- 統計（匿名，算人頭不算瀏覽次數） ---------- */
const twToday=()=>new Date(Date.now()+8*3600000).toISOString().slice(0,10);
function statHit(){
  if(!apiOn())return;let last="";try{last=localStorage.getItem("volcab.hit")||"";}catch(e){}
  const d=twToday();if(last===d)return;
  api("/api/hit",{method:"POST",body:{vid:myUid()}}).then(()=>{try{localStorage.setItem("volcab.hit",d);}catch(e){}}).catch(()=>{});
}
function trackAdds(list){if(apiOn()&&list.length)api("/api/track/add",{method:"POST",body:{vid:myUid(),words:list.slice(0,20)}}).catch(()=>{});}
async function shareRecs(list){
  trackAdds(list);
  if(!apiOn()||!list.length)return;
  for(const w of list){
    const rec=(S.custom||[]).find(x=>x.w===w);if(!rec)continue;
    rec.share={st:"sending"};
    try{const j=await api("/api/words",{method:"POST",body:{uid:myUid(),word:{w:rec.w,pos:rec.pos,m:rec.m,alt:rec.alt,syn:rec.syn,der:rec.der,col:rec.col,ex:rec.ex,topic:rec.topic,cefr:rec.cefr}}});
      rec.share={st:j.result,reason:j.reason||""};
      if(j.word&&j.word.cefr&&!rec.cefr)rec.cefr=j.word.cefr;
      if(j.result==="reviewing"){toast(`「${w}」已加入我的詞庫，AI 正在背景審核`);pollSubmission(w,0);}
      else toast(j.result==="approved"?`「${w}」已加入共有詞庫`:j.result==="exists"?`「${w}」共有詞庫裡已經有了`:j.result==="pending"?`「${w}」排隊等 AI 審核中`:`「${w}」沒有通過審核：${j.reason||""}`);
    }catch(e){rec.share={st:"error",reason:e.message};}
    save();
  }
  syncShared();render();
}
/* 背景審核：隔幾秒回頭查一次結果 */
const POLL=[4000,8000,15000,30000,60000];
function pollSubmission(w,i){
  if(i>=POLL.length)return;
  setTimeout(async()=>{
    const rec=(S.custom||[]).find(x=>x.w===w);if(!rec||!apiOn())return;
    try{
      const j=await api("/api/submission?w="+encodeURIComponent(w));
      if(j.status==="reviewing"){pollSubmission(w,i+1);return;}
      const st=j.status==="approved"?"approved":j.status==="rejected"?"rejected":j.status==="pending"?"pending":rec.share&&rec.share.st;
      rec.share={st,reason:j.reason||""};if(j.cefr&&!rec.cefr)rec.cefr=j.cefr;save();
      if(st==="approved"){toast(`「${w}」通過 AI 審核，已加入共有詞庫`);syncShared();}
      else if(st==="rejected")toast(`「${w}」沒有通過 AI 審核：${j.reason||""}`);
      else if(st==="pending")toast(`「${w}」AI 暫時無法審核，稍後會自動再試`);
      if(mode==="library"||mode==="add")render();
    }catch(e){pollSubmission(w,i+1);}
  },POLL[i]);
}
function resumePolls(){(S.custom||[]).forEach(r=>{if(r.share&&(r.share.st==="reviewing"||r.share.st==="pending"||r.share.st==="sending"))pollSubmission(r.w,0);});}
const SHL={reviewing:"AI 審核中…",sending:"分享中…",approved:"已在共有詞庫",exists:"共有詞庫已有",pending:"等待審核",rejected:"未通過審核",error:"分享失敗",off:"只存在我的詞庫"};

/* ---------- Google 帳號登入與跨裝置同步 ---------- */
const SESSK="volcab.session";
let session=null,gClient="",gReady=false,gLoading=false,acctState="off",acctLast=0,acctTimer=null,acctBusy=false,delAcctArm=false;
function loadSession(){try{const s=JSON.parse(localStorage.getItem(SESSK)||"null");if(s&&s.token&&(!s.exp||s.exp>Date.now()))session=s;}catch(e){}}
function saveSession(){try{if(session)localStorage.setItem(SESSK,JSON.stringify(session));else localStorage.removeItem(SESSK);}catch(e){}}
function sessTok(){return session&&session.token||"";}
function isAdminUser(){return !!(session&&session.user&&session.user.admin);}
function adminUI(){return apiOn()&&(!!adminKey()||isAdminUser());}
async function initGoogle(){
  if(!apiOn()||gLoading||gReady)return;gLoading=true;
  try{const c=await api("/api/config");gClient=c.google_client_id||"";}catch(e){gClient="";}
  if(!gClient){gLoading=false;if(mode==="settings")render();return;}
  const s=document.createElement("script");s.src="https://accounts.google.com/gsi/client";s.async=true;
  s.onload=()=>{try{google.accounts.id.initialize({client_id:gClient,callback:onGoogleCred,ux_mode:"popup",auto_select:false,cancel_on_tap_outside:true});gReady=true;}catch(e){}gLoading=false;render();};
  s.onerror=()=>{gLoading=false;};document.head.appendChild(s);
}
function paintGoogleButtons(){
  if(!gReady||typeof google==="undefined")return;
  document.querySelectorAll(".gbtn").forEach(el=>{if(el.dataset.done)return;el.dataset.done="1";try{google.accounts.id.renderButton(el,{theme:"outline",size:"large",text:"signin_with",shape:"pill",locale:"zh-TW"});}catch(e){}});
}
async function onGoogleCred(resp){
  try{
    const j=await api("/api/auth/google",{method:"POST",body:{credential:resp&&resp.credential}});
    session={token:j.token,user:j.user,exp:j.expires_at};saveSession();
    toast(`已用 ${j.user.name||j.user.email} 登入`);
    await acctPull(true);
    if(isAdminUser())toast("你是站長：「詞庫 → 共有詞庫」可以管理投稿");
  }catch(e){toast("登入失敗："+e.message);}
  render();
}
async function acctLogout(){
  try{await api("/api/auth/logout",{method:"POST"});}catch(e){}
  session=null;saveSession();acctState="off";lib.admin=null;toast("已登出，這台裝置上的進度會保留");render();
}
function acctExpired(){session=null;saveSession();acctState="off";toast("登入已過期，請重新用 Google 登入");render();}
/* 合併兩份進度：每個字取最近一次作答的紀錄，XP／成就／收藏取聯集，設定用較新的那份 */
function mergeState(a,b){
  const A=fromData(clone(a)),B=fromData(clone(b));
  const newer=(B.savedAt||0)>(A.savedAt||0)?B:A,older=newer===A?B:A;
  const o=fromData(clone(newer));
  const tomb=Object.assign({},A.tomb,B.tomb);
  for(const k in A.tomb)tomb[k]=Math.max(A.tomb[k]||0,B.tomb[k]||0);
  o.tomb=tomb;
  o.prog={};for(const s of [A,B])for(const w in s.prog){const x=o.prog[w],y=s.prog[w];if(!x||(y.lastAt||0)>(x.lastAt||0)||((y.lastAt||0)===(x.lastAt||0)&&(y.c+y.wr)>(x.c+x.wr)))o.prog[w]=y;}
  o.log={};for(const s of [A,B])for(const d in s.log){const x=o.log[d]||{},y=s.log[d],m={};for(const k of new Set([...Object.keys(x),...Object.keys(y)]))m[k]=Math.max(+x[k]||0,+y[k]||0);o.log[d]=m;}
  o.modeStats={};for(const s of [A,B])for(const k in s.modeStats){const x=o.modeStats[k]||{c:0,w:0,slow:0},y=s.modeStats[k];o.modeStats[k]={c:Math.max(x.c,y.c||0),w:Math.max(x.w,y.w||0),slow:Math.max(x.slow,y.slow||0)};}
  o.xp={total:0,days:{}};for(const s of [A,B])for(const d in s.xp.days)o.xp.days[d]=Math.max(o.xp.days[d]||0,s.xp.days[d]||0);
  o.xp.total=Math.max(A.xp.total||0,B.xp.total||0,Object.values(o.xp.days).reduce((x,y)=>x+y,0));
  o.badges={};for(const s of [A,B])for(const k in s.badges)o.badges[k]=!o.badges[k]||s.badges[k]<o.badges[k]?s.badges[k]:o.badges[k];
  o.best={combo:Math.max(A.best.combo||0,B.best.combo||0)};
  const lvNewer=[A,B].map(s=>Object.keys(s.lv.hist||{}).sort().pop()||"").reduce((m,d,i)=>d>m.d?{d,i}:m,{d:"",i:newer===A?0:1});
  o.lv=clone([A,B][lvNewer.i].lv);o.lv.hist=Object.assign({},older.lv.hist,newer.lv.hist);
  o.reviewed=Object.assign({},older.reviewed,newer.reviewed);
  o.overrides=Object.assign({},older.overrides,newer.overrides);
  o.hidden=Object.assign({},A.hidden,B.hidden);
  o.collect={};for(const s of [A,B])for(const w in s.collect)o.collect[w]=Math.max(o.collect[w]||0,+s.collect[w]||1);
  for(const w in o.collect)if((tomb["c:"+w]||0)>o.collect[w])delete o.collect[w];
  const cm={};for(const s of [older,newer])for(const r of s.custom||[])cm[r.w]=Object.assign({},cm[r.w]||{},r);
  o.custom=Object.values(cm).filter(r=>!(tomb["w:"+r.w]&&tomb["w:"+r.w]>(r.addedTs||0)));
  o.savedAt=Math.max(A.savedAt||0,B.savedAt||0);
  return o;
}
async function acctPull(first){
  if(!session||!apiOn()||acctBusy)return;acctBusy=true;acctState="syncing";
  try{
    const j=await api("/api/sync");
    if(j.user){session.user=j.user;saveSession();}
    if(j.data){
      let remote=null;try{remote=JSON.parse(j.data);}catch(e){}
      if(remote){const merged=mergeState(S,remote);S=merged;bump();cur=null;try{localStorage.setItem(KEY,JSON.stringify(S));}catch(e){}
        if(JSON.stringify(merged)!==j.data)acctPush(true);}
    }else acctPush(true);
    acctState="ok";acctLast=Date.now();
    if(first&&j.data)toast("已把雲端進度和這台裝置的進度合併");
  }catch(e){if(e.status===401)acctExpired();else acctState="error";}
  acctBusy=false;render();
}
function acctPush(now){
  if(!session||!apiOn())return;clearTimeout(acctTimer);
  const go=async()=>{
    if(!session)return;acctState="syncing";
    try{await api("/api/sync",{method:"PUT",body:{data:JSON.stringify(S)}});acctState="ok";acctLast=Date.now();}
    catch(e){if(e.status===401)acctExpired();else acctState="error";}
    if(mode==="settings")render();else{const c=document.getElementById("acctchip");if(c)c.outerHTML=acctChip();}
  };
  if(now)go();else acctTimer=setTimeout(go,2000);
}
function acctChip(){
  if(!apiOn())return "";
  if(!session)return gClient?`<button class="achip" id="acctchip" data-mode="settings" title="用 Google 登入後，進度會跨裝置同步">登入同步</button>`:"";
  const t=acctState==="syncing"?"同步中…":acctState==="error"?"同步失敗":"已同步";
  return `<button class="achip ${acctState==="error"?"bad":"ok"}" id="acctchip" data-mode="settings" title="${esc(session.user.email||"")}">☁ ${t}</button>`;
}
function acctSection(){
  let h=`<h2>帳號與跨裝置同步</h2>`;
  if(CL())return h+`<p class="q mute">在 claude.ai 上開啟時，進度會自動同步到你的 Claude 帳號。</p>`;
  if(!apiOn())return h+`<p class="q mute">這個網站還沒設定共有伺服器，暫時無法登入同步。</p>`;
  if(session){
    const u=session.user||{};
    h+=`<div class="acct"><div><b>${esc(u.name||"已登入")}</b> <span class="mute">${esc(u.email||"")}</span>${u.admin?' <span class="pill ok">站長</span>':""}</div>`;
    h+=`<p class="q mute">${acctState==="syncing"?"同步中…":acctState==="error"?'<span class="acc">上次同步失敗，會自動再試。</span>':acctLast?"已同步，"+new Date(acctLast).toLocaleTimeString("zh-TW",{hour:"2-digit",minute:"2-digit"})+"。":""} 學習進度、我的詞庫、XP 與成就會自動同步到這個帳號，換裝置登入同一個 Google 帳號就能接著背。</p>`;
    h+=`<p><button data-nav data-act="acct-sync">立即同步</button>　<button data-nav data-act="acct-logout">登出</button>　<button data-nav data-act="acct-delete" class="${delAcctArm?"acc":""}">${delAcctArm?"再按一次：永久刪除雲端進度":"刪除雲端進度"}</button>${u.admin?'　<button data-nav data-act="lib:shared" data-mode="library">開啟站長管理</button>':""}</p></div>`;
  }else if(gClient){
    h+=`<p class="q mute">用 Google 帳號登入後，學習進度、我的詞庫、XP 與成就會自動同步，換手機或電腦登入同一個帳號就能接著背。第一次登入時，這台裝置上已有的進度會一起合併上去。</p><div class="gbtn"></div>`;
    if(!gReady)h+=`<p class="q mute">登入按鈕載入中…</p>`;
  }else{
    h+=`<p class="q mute">${gLoading?"載入中…":"站長還沒開啟 Google 登入。"}</p>`;
  }
  h+=`<p class="q mute"><a href="privacy.html" target="_blank" rel="noopener">隱私權政策</a></p>`;
  return h;
}

/* ---------- 詞庫頁：我的／共有／待審核 ---------- */
let lib={tab:"mine",q:"",lv:"all",n:80,reporting:null,admin:null};
function libRows(){
  const ws=words();
  let xs=lib.tab==="mine"?ws.filter(inMine):ws.filter(w=>w.src!=="mine");
  const q=lib.q.trim().toLowerCase();
  if(q)xs=xs.filter(w=>w.w.includes(q)||String(w.m).includes(q));
  if(lib.lv!=="all")xs=xs.filter(w=>(lvOf(w)||"none")===lib.lv);
  if(lib.tab==="mine")xs=xs.slice().sort((a,b)=>(b.addedAt||"").localeCompare(a.addedAt||"")||a.w.localeCompare(b.w));
  else xs=xs.slice().sort((a,b)=>(lvNum(lvOf(a)||"C2")-lvNum(lvOf(b)||"C2"))||a.w.localeCompare(b.w));
  return xs;
}
function libList(){
  const xs=libRows();if(!xs.length)return `<p class="mute libempty">${lib.tab==="mine"?"你的詞庫還沒有字。到「新增」加入自己的單字，或在「共有詞庫」按「收藏」。":"沒有符合的單字。"}</p>`;
  const adm=adminUI();
  let h=xs.slice(0,lib.n).map(w=>{
    const tag=w.src==="mine"?`<span class="stag mine">我新增的</span>`:w.src==="shared"?`<span class="stag">社群</span>`:`<span class="stag">內建</span>`;
    const sh=w.src==="mine"&&apiOn()?`<span class="stag ${w.share&&w.share.st==="approved"?"ok":w.share&&(w.share.st==="rejected"||w.share.st==="error")?"bad":""}" title="${esc(w.share&&w.share.reason||"")}">${SHL[(w.share&&w.share.st)||"off"]}${w.share&&w.share.reason&&w.share.st!=="approved"?"："+esc(w.share.reason):""}</span>`:"";
    let act="";
    if(w.src==="mine"){
      if(apiOn()&&(!w.share||["error","rejected","off"].includes(w.share.st)))act+=`<button data-act="reshare" data-w="${esc(w.w)}">分享到共有</button>`;
      act+=`<button data-act="delword" data-w="${esc(w.w)}">${delArm===w.w?"再按一次確認刪除":"刪除"}</button>`;
    }else{
      act+=S.collect[w.w]?`<button data-act="uncollect" data-w="${esc(w.w)}">已收藏 ✓</button>`:`<button data-act="collect" data-w="${esc(w.w)}">收藏</button>`;
      act+=`<button data-act="report" data-w="${esc(w.w)}">回報</button>`;
      if(adm&&w.src==="shared")act+=`<button data-act="adm-del" data-w="${esc(w.w)}">站長刪除</button>`;
    }
    let row=`<div class="lrow"><div class="lmain"><b>${esc(w.w)}</b> <span class="mute">${esc(w.pos)}</span> ${lvBadge(w)} <span>${esc(w.m)}</span></div><div class="lmeta">${tag}${sh}</div><div class="lact">${act}</div>`;
    if(lib.reporting===w.w)row+=`<div class="lrep"><span class="mute">哪裡有問題？</span>${["中文意思錯誤","例句或搭配錯誤","不是英文或拼錯","不當內容"].map(r=>`<button data-act="report-go" data-w="${esc(w.w)}" data-r="${r}">${r}</button>`).join("")}<button data-act="report-cancel">取消</button></div>`;
    return row+`</div>`;
  }).join("");
  if(xs.length>lib.n)h+=`<p style="text-align:center"><button data-act="lib-more">再顯示 ${Math.min(200,xs.length-lib.n)} 個（共 ${xs.length}）</button></p>`;
  return h;
}
function pLibrary(){
  const ws=words(),nMine=ws.filter(inMine).length,nShared=ws.filter(w=>w.src!=="mine").length,nRev=ws.filter(w=>!S.reviewed[w.w]&&w.src!=="shared").length;
  let h=`<div class="libtabs">${[["mine",`我的詞庫 ${nMine}`],["shared",`共有詞庫 ${nShared}`],["review",`待審核 ${nRev}`]].map(([k,l])=>`<button class="tog${lib.tab===k?" on":""}" data-act="lib:${k}">${l}</button>`).join("")}</div>`;
  if(lib.tab==="review")return h+pReview();
  if(lib.tab==="shared"){
    h+=apiOn()?`<p class="mute">共有詞庫是大家一起建立的：別人新增、通過 AI 審核的字會出現在這裡。${shSync==="busy"?"同步中…":shSync==="error"?'<span class="acc">同步失敗，稍後再試。</span>':shLast?"已同步。":""} <button class="link" data-act="sync">立即同步</button></p>`
      :`<p class="mute">${CL()?"在 claude.ai 上開啟時無法連到共有詞庫伺服器，這裡只顯示內建單字。":"這個網站還沒連上共有詞庫伺服器，目前只有內建單字。"}</p>`;
  }else{
    h+=`<p class="mute">你自己新增的字，以及從共有詞庫收藏的字。${apiOn()?"新增的字會自動送去 AI 審核，通過後大家都能用。":""}</p>`;
  }
  if(lib.tab==="shared"&&adminUI())h+=adminPanel();
  h+=`<div class="libbar"><input id="libq" type="text" placeholder="搜尋英文或中文" value="${esc(lib.q)}" autocomplete="off"><span class="seg">${["all",...LVS,"none"].map(l=>`<button tabindex="-1" class="tog${lib.lv===l?" on":""}" data-act="liblv:${l}">${l==="all"?"全部":l==="none"?"未分級":l}</button>`).join("")}</span></div>`;
  h+=`<div id="liblist">${libList()}</div>`;
  return h;
}
function statsPanel(){
  const st=lib.stats;
  if(!st&&!lib.statsBusy&&!lib.statsErr){lib.statsBusy=true;api("/api/admin/stats",{admin:true}).then(j=>{lib.stats=j;lib.statsErr="";}).catch(e=>{lib.statsErr=e.message;}).then(()=>{lib.statsBusy=false;render();});}
  let h=`<details class="admin stats"${lib.statsOpen?" open":""} data-stats><summary>網站統計 ${st?`<span class="pill ok">今天 ${st.visitors.today} 人</span>`:lib.statsErr?`<span class="pill bad">${esc(lib.statsErr)}</span>`:`<span class="mute">載入中…</span>`}</summary>`;
  h+=`<p><button data-act="stats-load">重新載入</button></p>`;
  if(!st)return h+`</details>`;
  const v=st.visitors,w=st.words,tile=(n,l,s)=>`<div class="stile"><b>${n}</b><span>${l}</span>${s?`<small>${s}</small>`:""}</div>`;
  h+=`<h2>上站人數 <span class="mute">（每個瀏覽器每天算一次）</span></h2><div class="stiles">`+
    tile(v.today,"今天",`昨天 ${v.yesterday}`)+tile(v.last7,"近 7 天")+tile(v.last30,"近 30 天")+tile(v.total,"累計訪客",`回訪 ${v.returning}`)+tile(v.google_users,"Google 登入同步")+`</div>`;
  const max=Math.max(1,...st.days.map(d=>d.visitors));
  h+=`<div class="sbars" role="img" aria-label="近 30 天每日訪客">`+st.days.map(d=>`<div class="sbar" title="${d.day.slice(5)}：${d.visitors} 人（新訪客 ${d.new_visitors}）、新增 ${d.adds} 字"><i style="height:${Math.round(d.visitors/max*100)}%"><em style="height:${d.visitors?Math.round(d.new_visitors/d.visitors*100):0}%"></em></i></div>`).join("")+`</div>`;
  h+=`<p class="mute sleg"><span class="k1"></span>回訪 <span class="k2"></span>新訪客　${st.days[0].day.slice(5)} ～ ${st.days[29].day.slice(5)}（台灣時間；電腦版把滑鼠移到長條上可看數字）</p>`;
  h+=`<h2>新增的單字</h2><div class="stiles">`+tile(w.total_adds,"總新增次數",`今天 ${w.today}`)+tile(w.distinct_words,"不同的字")+tile(w.adders,"有加字的人")+
    tile(w.shared.approved,"共有詞庫",`待審 ${w.shared.pending}・隱藏 ${w.shared.hidden}・拒絕 ${w.shared.rejected}`)+`</div>`;
  h+=`<h3>最多人加的字</h3>`+(w.top.length?`<p class="schips">${w.top.map(x=>`<span class="stag">${esc(x.w)} <b>${x.n}</b></span>`).join(" ")}</p>`:`<p class="mute">還沒有資料</p>`);
  h+=`<h3>最近新增</h3>`+(w.recent.length?`<p class="schips">${w.recent.map(x=>`<span class="stag" title="${esc(x.day)}">${esc(x.w)}</span>`).join(" ")}</p>`:`<p class="mute">還沒有資料</p>`);
  return h+`<p class="mute">只統計開始記錄之後的資料；同一個人用不同裝置或瀏覽器會算成不同人，清除瀏覽資料也會被算成新訪客。</p></details>`;
}
function adminPanel(){
  if(!lib.admin&&!lib.adminBusy){lib.adminBusy=true;api("/api/admin/queue",{admin:true}).then(j=>{lib.admin=j;lib.adminErr="";}).catch(e=>{lib.adminErr=e.message;}).then(()=>{lib.adminBusy=false;render();});}
  const a=lib.admin,n=a?(a.hidden.length+a.pending.length+a.rejected.length):0;
  let h=`<details class="admin"${lib.adminOpen?" open":""}><summary>站長管理 ${a?`<span class="pill${n?" bad":" ok"}">${n?n+" 筆待處理":"沒有待處理"}</span>`:lib.adminErr?`<span class="pill bad">${esc(lib.adminErr)}</span>`:`<span class="mute">載入中…</span>`}</summary>`;
  h+=`<p><button data-act="adm-load">重新載入</button></p>`;
  if(a){
    const sec=(title,arr,acts)=>`<h2>${title} <span class="mute">${arr.length}</span></h2>`+(arr.length?arr.map(x=>`<div class="lrow"><div class="lmain"><b>${esc(x.w)}</b> <span class="mute">${esc(x.pos||"")}</span> <span>${esc(x.m||"")}</span></div><div class="lmeta"><span class="stag">${esc(x.note||x.reason||"")}</span></div><div class="lact">${acts.map(([k,l])=>`<button data-act="${k}" data-w="${esc(x.w)}"${x.id?` data-id="${x.id}"`:""}>${l}</button>`).join("")}</div></div>`).join(""):`<p class="mute">沒有。</p>`);
    h+=sec("被回報而隱藏",a.hidden||[],[["adm-approve","恢復公開"],["adm-del","刪除"]]);
    h+=sec("等待 AI 審核",a.pending||[],[["adm-approve","直接通過"],["adm-del","刪除"]]);
    h+=sec("AI 拒絕的投稿",a.rejected||[],[["adm-force","強制通過"],["adm-dismiss","忽略"]]);
    h+=`<p class="mute">共有詞庫裡的每個字旁邊也會出現「站長刪除」按鈕。</p>`;
  }
  return statsPanel()+h+`</details>`;
}
/* ---------- AI ---------- */
const AIK="wordbank.ai";
let sampleFn=null;
async function initSample(){const c=CL();if(!c)return;try{sampleFn=await c.use("sample");}catch(e){sampleFn=null;}if(sampleFn)render();}
const hasClaude=()=>!!sampleFn;
const AIDEF={gemini:"gemini-3.5-flash",anthropic:"claude-haiku-5-5"};
function aiCfg(){let o={};try{o=JSON.parse(localStorage.getItem(AIK)||"{}")||{};}catch(e){}return Object.assign({provider:"gemini",key:"",model:""},o);}
function setAi(o){try{localStorage.setItem(AIK,JSON.stringify(Object.assign(aiCfg(),o)));}catch(e){}}
function aiErr(st,m){
  const h=st===400?"請求被拒，金鑰或模型名稱可能有誤":st===401||st===403?"金鑰無效或沒有權限":st===404?"找不到這個模型，名稱可能已更新，請到設定修改":st===429?"超過免費額度或太頻繁，請稍後再試":st>=500?"AI 服務暫時有問題，請稍後再試":"連線失敗";
  return `${h}（${st}${m?"："+String(m).slice(0,180):""}）`;
}
async function callAI(prompt){
  if(sampleFn){
    try{const r=await sampleFn(prompt,{modelTier:"default"});if(!r||!r.text)throw {code:"empty"};return r.text;}
    catch(e){const code=e&&e.code;
      throw new Error(code==="not_granted"?"你沒有允許這個網頁使用 Claude。重新整理後再按一次，並在詢問視窗按允許。":code==="rate_limited"?"使用太頻繁了，請等一下再試。":code==="empty"?"Claude 沒有回傳內容，請再試一次。":"Claude 產生失敗："+((e&&e.message)||"未知錯誤"));}
  }
  const c=aiCfg();if(!c.key)throw new Error("還沒設定 API 金鑰，請到「設定」貼上。");
  /* 模型忙碌（503/500）時自動重試一次；還是不行、額度用完（429）或找不到模型（404）時，自動換下一個模型 */
  const first=(c.model||AIDEF[c.provider]).trim();
  const models=c.provider==="gemini"?[first,...GEMINI_FALLBACK.filter(m=>m!==first)]:[first];
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  let lastErr=null;
  for(const model of models){
    for(let attempt=0;attempt<2;attempt++){
      let r,j;
      try{
        if(c.provider==="gemini"){
          r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,{method:"POST",headers:{"Content-Type":"application/json","x-goog-api-key":c.key},body:JSON.stringify({contents:[{role:"user",parts:[{text:prompt}]}],generationConfig:{temperature:0.4}})});
        }else{
          r=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"content-type":"application/json","x-api-key":c.key,"anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true"},body:JSON.stringify({model,max_tokens:8000,messages:[{role:"user",content:prompt}]})});
        }
      }catch(e){throw new Error("連不上 AI 服務，請檢查網路。（"+e.message+"）");}
      j=await r.json().catch(()=>({}));
      if(r.ok){
        const txt=c.provider==="gemini"?((j.candidates&&j.candidates[0]&&j.candidates[0].content&&j.candidates[0].content.parts)||[]).map(p=>p.text||"").join(""):(j.content||[]).map(b=>b.text||"").join("");
        if(txt)return txt;
        lastErr=new Error("AI 沒有回傳內容，請再試一次。");break;
      }
      lastErr=new Error(aiErr(r.status,j.error&&j.error.message));
      if(r.status===503||r.status===500||r.status===529){if(attempt===0){addMsgBusy(`${model} 忙碌中，自動重試…`);await wait(2000);continue;}break;}
      if(r.status===429||r.status===404)break;
      throw lastErr;
    }
    if(models.length>1)addMsgBusy("改用其他模型再試…");
  }
  throw lastErr||new Error("AI 暫時無法使用，請稍後再試。");
}
const GEMINI_FALLBACK=["gemini-3.5-flash","gemini-3.8-flash","gemini-3.6-flash","gemini-3.5-flash-lite","gemini-3.1-flash-lite"];
function addMsgBusy(m){if(addBusy&&mode==="add"){addMsg=m;render();}}
function buildPrompt(list){
  const topics=[...new Set(words().map(w=>w.topic))];
  return `你是幫台灣學生製作英文單字閃卡的助手。請為下列每個英文單字或片語各產生一筆資料，只輸出一個 JSON 陣列，不要輸出其他文字或 Markdown。
每筆格式：
{"input":"使用者輸入的原字","w":"英文原形，小寫；片語保留空格；若明顯拼錯請改正","pos":"n、v、adj、adv、ph、prefix 其中之一","m":"繁體中文主要意思，選最常用的意思，12 字以內","alt":"其他常見意思（繁體中文），沒有就空字串","syn":["1 到 2 個英文同義字，優先選比原字更進階的"],"der":[["派生字","詞性","繁體中文"]],"col":[["常見搭配詞，目標字用大括號包起來並寫出實際詞形，例如 {exceed} expectations","繁體中文"]],"ex":"一句自然、常見情境的英文例句，目標字只出現一次並用大括號包起來，寫出實際詞形，例如 House prices {soared} in 2021.","cefr":"這個字的 CEFR 等級：A1、A2、B1、B2、C1、C2 其中之一","topic":"從這些主題選一個：${topics.join("、")}；都不適合就自訂 2 到 4 字的繁體中文主題","note":"如果輸入不是英文單字或可能拼錯，用繁體中文簡短說明；否則空字串"}
der 最多 3 個，col 2 個。所有中文都用繁體中文。
單字：
${list.map(x=>"- "+x).join("\n")}`;
}
const escRe=s=>s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
function wrapWord(s,w){
  if(!s)return "";if(/\{[^}]+\}/.test(s))return s;
  const head=w.split(" ")[0],re=new RegExp("\\b("+escRe(head)+"\\w*"+escRe(w.slice(head.length))+")","i");
  return re.test(s)?s.replace(re,"{$1}"):"";
}
function normAI(o){
  if(!o||typeof o!=="object")return null;
  const str=v=>typeof v==="string"?v.trim():"";
  const w=(str(o.w)||str(o.input)).toLowerCase().replace(/\s+/g," ");if(!w)return null;
  let pos=str(o.pos).toLowerCase().replace(/\.$/,"");if(pos==="a"||pos==="adjective")pos="adj";if(pos==="noun")pos="n";if(pos==="verb")pos="v";if(pos==="adverb")pos="adv";if(pos==="phrase")pos="ph";
  if(!["n","v","adj","adv","ph","prefix"].includes(pos))pos=w.includes(" ")?"ph":"n";
  const arr=v=>Array.isArray(v)?v:[];
  return {w,pos,m:str(o.m),alt:str(o.alt),syn:arr(o.syn).map(str).filter(Boolean).slice(0,3),
    der:arr(o.der).filter(Array.isArray).map(d=>[str(d[0]),str(d[1]),str(d[2])]).filter(d=>d[0]).slice(0,3),
    col:arr(o.col).filter(Array.isArray).map(c=>[wrapWord(str(c[0]),w),str(c[1])]).filter(c=>c[0]).slice(0,3),
    ex:wrapWord(str(o.ex),w),cefr:LVS.includes(str(o.cefr).toUpperCase())?str(o.cefr).toUpperCase():"",topic:str(o.topic)||"自訂",grp:"",note:str(o.note),input:str(o.input)};
}
function parseAI(text){
  const a=text.indexOf("["),b=text.lastIndexOf("]");
  if(a<0||b<a)throw new Error("AI 回傳的格式看不懂，請再試一次。");
  let arr;try{arr=JSON.parse(text.slice(a,b+1));}catch(e){throw new Error("AI 回傳的 JSON 有誤，請再試一次。");}
  if(!Array.isArray(arr))throw new Error("AI 回傳的格式不是清單。");
  return arr.map(normAI).filter(Boolean);
}
function inputList(){return [...new Set(addInput.split(/\n|,|，|、/).map(s=>s.trim()).filter(Boolean))];}
async function aiGenerate(){
  if(addBusy)return;
  addErr=true;const list=inputList();if(!list.length){addMsg="請先輸入單字。";render();return;}
  if(list.length>20){addMsg="一次最多 20 個，請分批。";render();return;}
  const have=new Set(words().map(w=>w.w));
  const todo=list.filter(x=>!have.has(x.toLowerCase()));
  const dup=list.filter(x=>have.has(x.toLowerCase()));
  if(!todo.length){addMsg="這些字都已經在詞庫裡了："+dup.join("、");render();return;}
  addErr=false;addBusy=true;addMsg=`AI 產生中…（${todo.length} 個字）`;render();
  try{
    const items=parseAI(await callAI(buildPrompt(todo)));
    drafts=drafts.concat(items.map(x=>Object.assign(x,{dupe:have.has(x.w)})));
    addMsg=`完成，產生 ${items.length} 筆。請檢查下面的內容，沒問題再按「加入詞庫」。`+(dup.length?`（已在詞庫而略過：${dup.join("、")}）`:"");
    addInput="";
  }catch(e){addMsg=e.message;addErr=true;}
  addBusy=false;render();
}
function manualDrafts(){
  const list=inputList();const have=new Set(words().map(w=>w.w));
  const src=list.length?list:[""];
  drafts=drafts.concat(src.map(x=>({w:x.toLowerCase(),pos:x.includes(" ")?"ph":"n",m:"",alt:"",syn:[],der:[],col:[],ex:"",topic:"自訂",grp:"",note:"",dupe:have.has(x.toLowerCase())})));
  addInput="";addErr=false;addMsg="請在下面填好中文意思（meaning），其他欄位可以留空。";render();
}
function fmtDraft(d){return d._raw!=null?d._raw:`word: ${d.w}\n`+fmtEdit(d);}
function readDraft(i){
  const ta=document.getElementById("draft-"+i);const d=drafts[i];
  const word=((ta.value.match(/^\s*word\s*:\s*(.*)$/m)||[])[1]||"").trim().toLowerCase();
  if(!word)throw new Error("第 "+(i+1)+" 筆缺少 word。");
  const o=Object.assign({},d,parseEdit(ta.value,{w:word,topic:d.topic}),{w:word});
  if(!o.m)throw new Error(word+"：請填 meaning（中文意思）。");
  if(words().some(x=>x.w===word))throw new Error(word+" 已經在詞庫裡了。");
  return o;
}
function commitDraft(i){
  const o=readDraft(i);
  const rec={addedTs:Date.now(),w:o.w,pos:o.pos||"n",m:o.m,alt:o.alt||"",syn:o.syn||[],der:o.der||[],col:o.col||[],ex:o.ex||"",topic:o.topic||"自訂",cefr:o.cefr||lookupLv(o.w)||"",grp:"",custom:true,src:"mine",addedAt:today()};
  if(apiOn())rec.share={st:"sending"};
  S.custom.push(rec);S.reviewed[rec.w]=false;return rec.w;
}
function pAdd(){
  const ai=aiCfg();
  let h=`<h1>新增單字</h1><p class="mute">一行一個英文單字或片語（也可以用逗號分開），一次最多 20 個。AI 會補上詞性、中文、同義字、派生詞、搭配詞、例句和主題。</p>`;
  if(hasClaude())h+=`<p class="notice">會用你的 Claude 帳號產生資料，不需要金鑰。第一次使用時會跳出詢問視窗，按允許即可。</p>`;
  else if(!ai.key)h+=`<div class="notice"><p><b>還沒設定 AI 金鑰。</b>沒有金鑰也能用「手動新增」；想讓 AI 自動補資料，請照下面步驟免費申請 Gemini 金鑰，再到 <button class="link" data-mode="settings">設定</button> 貼上。</p>${keyGuide(ai.provider,false)}</div>`;
  h+=`<textarea id="addin" class="addin" spellcheck="false" placeholder="mitigate&#10;be attributed to&#10;substantial">${esc(addInput)}</textarea>`;
  h+=`<div class="row"><button class="btn primary" data-act="aigen" ${addBusy?"disabled":""}>${addBusy?"AI 產生中…":"AI 產生資料"} <kbd>Ctrl+Enter</kbd></button><button class="btn ghost" data-act="manual">手動新增</button></div>`;
  if(addMsg)h+=`<p class="${addErr?"acc":"mute"}">${esc(addMsg)}</p>`;
  if(drafts.length){
    h+=`<hr><h2>待加入 <span class="mute">${drafts.length} 筆</span>　<button data-act="addall">全部加入詞庫</button>　<button data-act="dropall">全部捨棄</button></h2>`;
    h+=`<p class="mute">格式：每行「欄位: 內容」。der、col 用 ; 分隔多筆，| 分隔欄位；例句用 { } 標出要挖空的字。</p>`;
    drafts.forEach((d,i)=>{
      h+=`<div class="blk"><p><span class="b">${esc(d.w||"（新單字）")}</span> <span class="mute">(${esc(d.pos)})</span> ${esc(d.m)} <span class="pill">AI 生成・待審核</span></p>`;
      if(d.note)h+=`<p class="acc">AI 提醒：${esc(d.note)}</p>`;
      if(d.dupe)h+=`<p class="acc">這個字已經在詞庫裡。</p>`;
      if(d.input&&d.input.toLowerCase()!==d.w)h+=`<p class="mute">你輸入的是「${esc(d.input)}」，AI 改成「${esc(d.w)}」。</p>`;
      h+=`<textarea id="draft-${i}" spellcheck="false">${esc(fmtDraft(d))}</textarea>`;
      h+=`<p><button data-act="adddraft" data-i="${i}">加入詞庫</button>　<button data-act="dropdraft" data-i="${i}">捨棄</button></p></div>`;
    });
  }
  const mine=(S.custom||[]);
  if(mine.length){h+=`<hr><h2>我新增的字 <span class="mute">${mine.length}</span></h2><p class="mute">${mine.slice().reverse().slice(0,30).map(w=>esc(w.w)).join("、")}${mine.length>30?"…":""}　可到「審核」修改或刪除。</p>`;}
  return h;
}

function keyGuide(p,open){
  const L=(u,txt)=>`<a href="${u}" target="_blank" rel="noopener noreferrer">${txt}</a>`;
  const g=`<ol>
    <li>打開 ${L("https://aistudio.google.com/apikey","Google AI Studio 的 API 金鑰頁")}，用 Google 帳號登入。</li>
    <li>第一次使用會請你同意服務條款，勾選後按繼續。新帳號會自動建立一個預設專案。</li>
    <li>按「<b>Create API key</b>」（建立 API 金鑰）。如果要你選專案，選預設的那個就好。</li>
    <li>按複製圖示，複製那一長串金鑰。</li>
    <li>回到這個 App 的「設定 → AI 自動補資料」，選 <b>Gemini</b>，把金鑰貼進「API 金鑰」欄位。</li>
    <li>按「<b>測試連線</b>」，出現「連線成功」就完成了。</li>
  </ol>
  <p class="mute">免費方案不需要信用卡，但每天能用的次數有限（以 AI Studio 顯示為準）；一次輸入多個單字只算一次。免費方案送出的內容可能被 Google 用來改善服務，不要輸入個人隱私。</p>`;
  const c=`<ol>
    <li>打開 ${L("https://console.anthropic.com/","Anthropic Console")}，用 Google 帳號或 Email 註冊並登入。</li>
    <li>到 ${L("https://console.anthropic.com/settings/billing","Plans &amp; Billing")} 綁定信用卡並儲值（第一次最低 5 美元）。</li>
    <li>到 ${L("https://console.anthropic.com/settings/keys","API Keys")} 按「<b>Create Key</b>」，取個名字（例如 wordbank）後建立。</li>
    <li><b>金鑰只會顯示這一次</b>，馬上複製。</li>
    <li>回到這個 App 的「設定 → AI 自動補資料」，選 <b>Claude</b>，貼上金鑰，按「<b>測試連線</b>」。</li>
  </ol>
  <p class="mute">Claude 按使用量付費，查一個字大約不到 1 台幣，可以在 Console 設定每月花費上限。</p>`;
  return `<details class="guide"${open?" open":""}><summary>如何取得 ${p==="anthropic"?"Claude":"Gemini"} API 金鑰？（約 3 分鐘）</summary>${p==="anthropic"?c:g}
  <p><b>安全提醒</b></p><ul class="mute">
    <li>Gemini 和 Claude 的 API 都規定使用者要<b>年滿 18 歲</b>。</li>
    <li>金鑰就像密碼：只貼在<b>自己的</b>電腦或手機上，不要傳給別人、不要截圖分享、不要寫進 GitHub 的任何檔案。</li>
    <li>金鑰只存在這個瀏覽器裡，不會被「匯出 JSON」帶走。用公用電腦時，用完記得按「清除金鑰」。</li>
    <li>覺得金鑰外洩了，就回到申請頁刪除舊金鑰、重新建立一把。</li>
  </ul></details>`;
}
/* ---------- 匯出 / 匯入 ---------- */
async function download(name,obj){
  const c=CL();
  if(c){try{const dl=await c.use("downloads");if(dl){await dl.save({filename:name,data:JSON.stringify(obj,null,2)});return;}}catch(e){if(e&&e.code&&e.code!=="unavailable")return;}}
  const blob=new Blob([JSON.stringify(obj,null,2)],{type:"application/json"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=name;document.body.appendChild(a);a.click();
  setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},500);
}
function doImport(file){
  const r=new FileReader();
  r.onload=()=>{try{const d=JSON.parse(r.result);if(!d||typeof d!=="object"||!("prog" in d||"settings" in d))throw new Error("格式不符");
    S=fromData(d);bump();save();msg="已匯入 "+file.name;}catch(e){msg="匯入失敗："+e.message;}render();};
  r.readAsText(file);
}

/* ---------- 事件 ---------- */
document.addEventListener("click",e=>{
  const fl=e.target.closest('.scene[data-act="flip"]');if(fl&&!e.target.closest("button")){flip();return;}
  const b=e.target.closest("button");if(!b)return;
  if(b.dataset.mode){if(b.dataset.act&&b.dataset.act.startsWith("lib:"))lib.tab=b.dataset.act.slice(4);setMode(b.dataset.mode);return;}
  if(b.dataset.act!=="delword")delArm=null;
  if(b.dataset.opt!==undefined){submit(+b.dataset.opt);return;}
  if(b.dataset.grade){grade(+b.dataset.grade);return;}
  if(b.dataset.quiz){if(sess&&!sess.finished)return;quizType=b.dataset.quiz;sess=null;cur=null;render();return;}
  if(b.dataset.ext){addExt(b.dataset.ext,b.dataset.src);return;}
  const a=b.dataset.act,w=b.dataset.w;if(!a)return;
  msg="";
  if(a==="topic")return cycleTopic();
  if(a==="flipbtn"){flip();return;}
  if(a==="aigen"){const ta=document.getElementById("addin");if(ta)addInput=ta.value;aiGenerate();return;}
  if(a==="manual"){const ta=document.getElementById("addin");if(ta)addInput=ta.value;manualDrafts();return;}
  if(a==="adddraft"||a==="addall"||a==="dropdraft"||a==="dropall"){
    const ta=document.getElementById("addin");if(ta)addInput=ta.value;
    addErr=false;
    try{
      if(a==="dropall"){drafts=[];addMsg="已全部捨棄。";}
      else if(a==="dropdraft"){drafts.splice(+b.dataset.i,1);addMsg="";}
      else if(a==="adddraft"){const w=commitDraft(+b.dataset.i);drafts.splice(+b.dataset.i,1);save();addMsg=`已加入「${w}」到我的詞庫。${apiOn()?"同時送去 AI 審核，通過後會加入共有詞庫。":""}`;shareRecs([w]);}
      else{const recs=drafts.map((d,i)=>readDraft(i));const seen=new Set();recs.forEach(r=>{if(seen.has(r.w))throw new Error(r.w+" 重複了兩次。");seen.add(r.w);});
        const added=drafts.map((d,i)=>commitDraft(i));drafts=[];save();addMsg=`已加入 ${added.length} 個字到我的詞庫：${added.join("、")}${apiOn()?"。同時送去 AI 審核，通過後會加入共有詞庫。":""}`;shareRecs(added);}
    }catch(err){addMsg=err.message;addErr=true;}
    render();return;
  }
  if(a.startsWith("ai:")){setAi({provider:a.slice(3)});focusAfter=`[data-act="${a}"]`;render();return;}
  if(a==="aiclear"){setAi({key:""});msg="金鑰已清除";render();return;}
  if(a==="aitest"){msg="測試中…";render();callAI('Reply with exactly: OK').then(r=>{msg="連線成功："+r.trim().slice(0,40);render();}).catch(err=>{msg=err.message;render();});return;}
  if(a==="delword"){if(delArm!==w){delArm=w;render();return;}S.tomb["w:"+w]=Date.now();S.custom=S.custom.filter(x=>x.w!==w);delete S.prog[w];delete S.overrides[w];delete S.reviewed[w];again=again.filter(x=>x!==w);delArm=null;save();msg=w+" 已刪除";render();return;}
  if(a==="start-round"||a==="again-round"){startSession();return;}
  if(a==="acct-sync"){acctPull(false);return;}
  if(a==="acct-logout"){acctLogout();return;}
  if(a==="acct-delete"){if(!delAcctArm){delAcctArm=true;render();return;}delAcctArm=false;api("/api/account/delete",{method:"POST"}).then(()=>{session=null;saveSession();acctState="off";toast("雲端進度已刪除，這台裝置上的進度仍保留");render();}).catch(e=>toast(e.message));return;}
  if(a==="pt-start"){startPlacement();return;}
  if(a==="pt-yes"){ptAnswer(true);return;}
  if(a==="pt-no"){ptAnswer(false);return;}
  if(a==="pt-quit"){pt=null;setMode("cards");return;}
  if(a==="pt-save"){if(pt&&pt.result){setLevel(pt.result.theta,"test");S.lv.test={date:today(),corr:pt.result.corr,fa:pt.result.fa};save();toast(`程度設定為 ${myLevel()}`);}pt=null;setMode("cards");return;}
  if(a.startsWith("lvset:")){const l=a.slice(6);setLevel(lvNum(l),"self");toast(`程度設定為 ${l}`);render();return;}
  if(a==="lv-skip"){S.lv.skip=true;save();render();return;}
  if(a.startsWith("src:")){S.settings.src=a.slice(4);save();cur=null;render();return;}
  if(a==="src-cycle"){const o=["all","mine","shared"];S.settings.src=o[(o.indexOf(S.settings.src||"all")+1)%3];save();cur=null;render();return;}
  if(a==="bylevel"){S.settings.byLevel=true;save();render();return;}
  if(a==="bylevel-off"){S.settings.byLevel=false;save();render();return;}
  if(a==="bylevel-toggle"){S.settings.byLevel=!S.settings.byLevel;save();focusAfter='[data-act="bylevel-toggle"]';render();return;}
  if(a.startsWith("lib:")){lib.tab=a.slice(4);lib.n=80;lib.reporting=null;if(lib.tab==="shared")syncShared();render();return;}
  if(a.startsWith("liblv:")){lib.lv=a.slice(6);lib.n=80;render();return;}
  if(a==="lib-more"){lib.n+=200;render();return;}
  if(a==="sync"){syncShared();render();return;}
  if(a==="collect"){S.collect[w]=Date.now();delete S.tomb["c:"+w];save();toast(`已收藏「${w}」到我的詞庫`);render();return;}
  if(a==="uncollect"){delete S.collect[w];S.tomb["c:"+w]=Date.now();save();render();return;}
  if(a==="report"){lib.reporting=w;render();return;}
  if(a==="report-cancel"){lib.reporting=null;render();return;}
  if(a==="report-go"){const r=b.dataset.r;S.hidden[w]=1;delete S.collect[w];lib.reporting=null;save();toast(`已回報「${w}」，這個字不會再出現在你的題目裡`);
    if(apiOn()&&shared.words[w])api("/api/report",{method:"POST",body:{uid:myUid(),w,reason:r}}).catch(()=>{});render();return;}
  if(a==="reshare"){shareRecs([w]);render();return;}
  if(a==="stats-load"){lib.statsOpen=true;lib.stats=null;lib.statsErr="";render();return;}
  if(a==="adm-load"){lib.adminOpen=true;api("/api/admin/queue",{admin:true}).then(j=>{lib.admin=j;lib.adminErr="";render();}).catch(e=>{lib.adminErr=e.message;toast(e.message);render();});return;}
  if(a==="adm-verify"){const el=document.getElementById("admkey");if(el)try{localStorage.setItem("volcab.admin",el.value.trim());}catch(err){}
    api("/api/admin/queue",{admin:true}).then(j=>{lib.admin=j;lib.adminErr="";lib.adminOpen=true;lib.tab="shared";toast("站長金鑰正確，已開啟站長管理");setMode("library");}).catch(e=>{msg=e.message==="站長金鑰不正確"?"站長金鑰不正確：要和 Cloudflare 裡的 ADMIN_TOKEN 一字不差（大小寫也要一樣）。":e.message==="找不到這個 API"?"Worker 的程式還是舊版，請把 GitHub 上最新的 worker/worker.js 貼到 Cloudflare 並 Deploy。":e.message;render();});return;}
  if(a==="adm-del"||a==="adm-approve"||a==="adm-force"||a==="adm-dismiss"){
    const act={"adm-del":"delete","adm-approve":"approve","adm-force":"force","adm-dismiss":"dismiss"}[a];
    api("/api/admin/word",{method:"POST",admin:true,body:{action:act,w,id:b.dataset.id?+b.dataset.id:undefined}}).then(()=>{toast("已處理");if(lib.admin)return api("/api/admin/queue",{admin:true}).then(j=>{lib.admin=j;});}).then(()=>syncShared()).catch(e=>toast(e.message)).then(()=>render());return;}
  if(a==="quiz-menu"){sess=null;cur=null;render();return;}
  if(a==="quit-round"){if(b.dataset.arm){sess=null;cur=null;render();}else{b.dataset.arm="1";b.textContent="確定結束？";b.classList.add("arm");}return;}
  if(a.startsWith("timer:")){S.settings.timer=a.slice(6);save();render();return;}
  if(a.startsWith("qlen:")){S.settings.quizLen=+a.slice(5);save();render();return;}
  if(a.startsWith("goal:")){S.settings.goal=+a.slice(5);save();focusAfter=`[data-act="${a}"]`;render();return;}
  if(a==="extra"){extra=shuffle(pool()).slice(0,10).map(w=>w.w);lastNote="";cur=null;render();return;}
  if(a.startsWith("dir:")){S.settings.dir=a.slice(4);save();focusAfter=`[data-act="${a}"]`;render();return;}
  if(a==="pendonly"){reviewOnlyPending=!reviewOnlyPending;focusAfter='[data-act="pendonly"]';}
  else if(a==="approveall"){words().forEach(x=>S.reviewed[x.w]=true);save();msg="已全部確認";}
  else if(a==="approve"){S.reviewed[w]=!S.reviewed[w];save();focusAfter=`.blk[data-w="${CSS.escape(w)}"]`;}
  else if(a==="edit"){editing=w;focusAfter="#edit";}
  else if(a==="cancel"){focusAfter=editing?`.blk[data-w="${CSS.escape(editing)}"]`:null;editing=null;}
  else if(a==="save"){try{const base=baseWords().find(x=>x.w===w);S.overrides[w]=parseEdit(document.getElementById("edit").value,base);S.reviewed[w]=true;save();editing=null;msg=w+" 已儲存並確認";focusAfter=`.blk[data-w="${CSS.escape(w)}"]`;}catch(err){msg=err.message;render();document.getElementById("edit")&&document.getElementById("edit").focus();return;}}
  else if(a==="revert"){delete S.overrides[w];save();editing=null;msg=w+" 已還原";}
  else if(a.startsWith("type:")){const k=a.slice(5);S.settings.types[k]=!S.settings.types[k];save();focusAfter=`[data-act="${a}"]`;}
  else if(a==="prac"){S.settings.pracSrs=!S.settings.pracSrs;save();focusAfter='[data-act="prac"]';}
  else if(a==="export"){download("volcablearn-progress-"+today()+".json",Object.assign({app:"wordbank",version:1,exportedAt:new Date().toISOString()},S));msg="已匯出";}
  else if(a==="import"){document.getElementById("imp").click();return;}
  else if(a==="exportwords"){download("volcablearn-words.json",words().map(x=>Object.assign({},x,{reviewed:!!S.reviewed[x.w],edited:!!S.overrides[x.w]})));msg="已匯出詞庫";}
  else if(a==="reset"){if(!resetArm){resetArm=true;focusAfter='[data-act="reset"]';render();return;}S.prog={};S.log={};S.modeStats={};save();resetArm=false;msg="進度已重設";}
  render();
});
document.addEventListener("input",e=>{
  const el=e.target;if(el.id==="addin")addInput=el.value;
  else if(el.dataset&&el.dataset.ai)setAi({[el.dataset.ai]:el.value.trim()});
  else if(el.id==="libq"){lib.q=el.value;lib.n=80;const box=document.getElementById("liblist");if(box)box.innerHTML=libList();}
  else if(el.id==="admkey"){try{localStorage.setItem("volcab.admin",el.value.trim());}catch(err){}lib.admin=null;lib.adminErr="";}
  else if(el.id&&el.id.startsWith("draft-")){const d=drafts[+el.id.slice(6)];if(d)d._raw=el.value;}
});
document.getElementById("imp").addEventListener("change",e=>{const f=e.target.files[0];if(f)doImport(f);e.target.value="";});
document.addEventListener("change",e=>{
  if(e.target.dataset&&e.target.dataset.ai){setAi({[e.target.dataset.ai]:e.target.value.trim()});msg="已儲存";return;}
  const k=e.target.dataset&&e.target.dataset.k;if(!k)return;const v=e.target.value;msg="";
  if(k==="target"){S.settings.target=Math.min(0.97,Math.max(0.7,(+v||90)/100));}
  else if(k==="growth"){S.settings.growth=Math.min(4,Math.max(1.2,+v||2));}
  else if(k==="maxIv"){S.settings.maxIv=Math.max(7,Math.round(+v||365));}
  else if(k.startsWith("slow:")){S.settings.slow[k.slice(5)]=Math.max(1,+v||1);}
  else if(k==="offset"){S.settings.offset=Math.round(+v||0);}
  else S.settings[k]=Math.max(0,Math.round(+v||0));
  save();focusAfter=`[data-k="${k}"]`;render();
});
function navFocus(d){
  const els=[...document.querySelectorAll("main [data-nav]")];if(!els.length)return;
  const i=els.indexOf(document.activeElement.closest("[data-nav]"));
  const n=els[i<0?0:Math.max(0,Math.min(els.length-1,i+d))];n.focus();n.scrollIntoView({block:"nearest"});
}
document.addEventListener("keydown",e=>{
  if(e.key==="Tab"){e.preventDefault();const f=e.target;if(f.tagName==="INPUT"&&f.dataset&&(f.dataset.k||f.dataset.ai))f.dispatchEvent(new Event("change",{bubbles:true}));switchMode(e.shiftKey?-1:1);return;}
  if(e.isComposing||e.keyCode===229)return;
  const tg=e.target,tag=tg.tagName;
  if(tag==="TEXTAREA"&&tg.id==="addin"){if(e.key==="Enter"&&(e.ctrlKey||e.metaKey)){e.preventDefault();addInput=tg.value;aiGenerate();}return;}
  if(tag==="TEXTAREA"&&tg.id.startsWith("draft-"))return;
  if(tag==="TEXTAREA"){
    if(e.key==="Enter"&&(e.ctrlKey||e.metaKey)){e.preventDefault();document.querySelector('[data-act="save"]').click();}
    else if(e.key==="Escape"){e.preventDefault();document.querySelector('[data-act="cancel"]').click();}
    return;
  }
  if(e.ctrlKey||e.metaKey||e.altKey)return;
  if(mode==="placement"&&pt){
    if(!pt.done){if(e.key==="1"||e.key==="ArrowLeft"){e.preventDefault();ptAnswer(false);}else if(e.key==="2"||e.key==="ArrowRight"){e.preventDefault();ptAnswer(true);}return;}
    if(e.key==="Enter"){e.preventDefault();document.querySelector('[data-act="pt-save"]').click();}return;
  }
  if(mode==="cards"){
    if(e.key==="/"){e.preventDefault();cycleTopic();return;}
    if(!cur){if(e.key==="Enter"){e.preventDefault();const x=document.querySelector('[data-act="extra"]');if(x)x.click();}return;}
    if(cur.phase==="front"&&(e.key===" "||e.key==="Enter")){e.preventDefault();flip();return;}
    if(cur.phase==="back"&&/^[123]$/.test(e.key)){e.preventDefault();grade(+e.key);return;}
    if(e.key===" "||e.key==="Enter")e.preventDefault();
    return;
  }
  if(mode==="quiz"&&(!sess||sess.finished)&&tg.id!=="ans"){
    if(e.key==="Enter"||e.key===" "){e.preventDefault();startSession();return;}
    if(e.key==="["||e.key==="]"){e.preventDefault();if(sess)sess=null;switchQuiz(e.key==="]"?1:-1);return;}
    if(e.key==="/"&&quizType!=="confuse"){e.preventDefault();cycleTopic();return;}
    return;
  }
  if(PRACTICE.includes(mode)){
    if(tg.id==="ans"){
      if(e.key==="Enter"){e.preventDefault();submit(tg.value);}
      else if(e.key==="Escape"){e.preventDefault();submit("");}
      return;
    }
    if(e.key==="Enter"||e.key===" "){e.preventDefault();advance();return;}
    if(/^[1-9]$/.test(e.key)&&cur&&cur.kind==="choice"&&cur.phase==="ask"){const i=+e.key-1;if(i<cur.opts.length){e.preventDefault();submit(i);}return;}
    if(e.key==="Escape"&&cur&&cur.phase==="ask"){submit(cur.kind==="choice"?-1:"");return;}
        return;
  }
  if(e.key==="ArrowDown"||e.key==="ArrowUp"){e.preventDefault();navFocus(e.key==="ArrowDown"?1:-1);return;}
  if((mode==="review"||mode==="library"&&lib.tab==="review")&&tag!=="INPUT"){
    const blk=tg.closest&&tg.closest(".blk");if(!blk)return;
    if(e.key==="a"){e.preventDefault();blk.querySelector('[data-act="approve"]').click();}
    if(e.key==="e"){e.preventDefault();blk.querySelector('[data-act="edit"]').click();}
  }
});

/* 測試用介面 */
window.WB={mergeState,get session(){return session;},acctPull,get sess(){return sess;},get pt(){return pt;},get lib(){return lib;},myLevel,lvOf,pool,levelOf,streak,parseAI,normAI,buildPrompt,get drafts(){return drafts;},grade,flip,get again(){return again;},get S(){return S;},applySRS,todayQueue,today,addDays,diffDays,ivFromS,nextS,retention,curR,words,makeQ,distractors,setOffset:n=>{S.settings.offset=n;save();},render,setMode,submit,get cur(){return cur;}};
load();render();
loadShared();loadSession();bump();initCloud();initSample();syncShared();initGoogle();if(apiOn())resumePolls();statHit();
document.addEventListener("toggle",e=>{const t=e.target;if(!t||!t.matches)return;if(t.matches("details[data-stats]"))lib.statsOpen=t.open;else if(t.matches("details.admin"))lib.adminOpen=t.open;},true);if(session)acctPull(false);
document.addEventListener("visibilitychange",()=>{if(!document.hidden&&session&&Date.now()-acctLast>60000)acctPull(false);});setInterval(()=>{if(!document.hidden)syncShared();},10*60*1000);
if("serviceWorker" in navigator&&!CL()&&/github\.io$|^localhost$|^127\./.test(location.hostname)){const had=!!navigator.serviceWorker.controller;let reloaded=false;
  navigator.serviceWorker.register("sw.js",{updateViaCache:"none"}).then(r=>r.update()).catch(()=>{});
  navigator.serviceWorker.addEventListener("controllerchange",()=>{if(had&&!reloaded){reloaded=true;location.reload();}});}
