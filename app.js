"use strict";

// ============================================================
// 定数
// ============================================================
const STORAGE_KEY = "daily5.v1";
const DAILY_COUNT = 5;
const MAX_REVIEWS = 2;
// box（何回連続で「わかった」か）→ 次に出すまでの日数。box 4 で習得済み
const INTERVALS = { 0: 1, 1: 3, 2: 7, 3: 21 };
const MASTERED_BOX = 4;
const TEST_PER_LEVEL = 4;
const TEST_FAKES = 3;
const PASS_RATE = 0.75;
const FAKE_PENALTY = 0.5; // 偽物を「わかる」と答えた割合 × これ を各レベルの点数から引く
const BY_ID = Object.fromEntries(PHRASES.map((p) => [p.id, p]));

// ============================================================
// 保存（localStorage）
// ============================================================
function defaultState() {
  return {
    version: 1,
    level: null,
    cats: Object.keys(CATEGORIES),
    items: {},        // id -> { box, due, last }
    days: {},         // "YYYY-MM-DD" -> { level, ids, newIds, results, prev }
    suggestCooldownUntil: null,
    debugOffset: 0,
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...defaultState(), ...JSON.parse(raw) };
  } catch (e) {
    console.warn("保存データを読めませんでした", e);
  }
  return defaultState();
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn("保存できませんでした", e);
  }
}

let state = loadState();

// ============================================================
// 日付
// ============================================================
function dateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(str, n) {
  const [y, m, d] = str.split("-").map(Number);
  return dateStr(new Date(y, m - 1, d + n));
}

function today() {
  return addDays(dateStr(new Date()), state.debugOffset || 0);
}

// ============================================================
// 日付から決まる乱数（同じ日なら同じ並びになる）
// ============================================================
function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededRandom(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rand = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ============================================================
// 今日の5
// ============================================================
function isMastered(item) {
  return item && item.box >= MASTERED_BOX;
}

function dueReviews(date) {
  return Object.entries(state.items)
    .filter(([id, it]) => BY_ID[id] && !isMastered(it) && it.due && it.due <= date)
    .sort((a, b) => a[1].due.localeCompare(b[1].due))
    .map(([id]) => id);
}

function unseenAtLevel(level, rand) {
  const pool = PHRASES.filter(
    (p) => p.level === level && state.cats.includes(p.cat) && !state.items[p.id]
  );
  return shuffle(pool, rand).map((p) => p.id);
}

// 今のレベル → 上のレベル → 下のレベルの順で、まだ見ていないものを探す
function pickNew(count, date) {
  const rand = seededRandom(hashString(date));
  const order = [state.level];
  for (let l = state.level + 1; l <= 5; l++) order.push(l);
  for (let l = state.level - 1; l >= 1; l--) order.push(l);
  const picked = [];
  for (const level of order) {
    for (const id of unseenAtLevel(level, rand)) {
      if (picked.length >= count) return picked;
      picked.push(id);
    }
  }
  return picked;
}

function getToday() {
  const date = today();
  if (state.days[date]) return state.days[date];

  const due = dueReviews(date);
  let reviews = due.slice(0, MAX_REVIEWS);
  const newIds = pickNew(DAILY_COUNT - reviews.length, date);
  // 新しいものが足りなければ復習で埋める
  if (reviews.length + newIds.length < DAILY_COUNT) {
    reviews = due.slice(0, DAILY_COUNT - newIds.length);
  }
  const day = {
    level: state.level,
    ids: [...reviews, ...newIds],
    newIds,
    results: {},
    prev: {},
  };
  state.days[date] = day;
  saveState();
  return day;
}

function answer(id, result) {
  const date = today();
  const day = getToday();
  // 同じ日に答え直したときのため、その日の最初の状態から計算する
  if (!(id in day.prev)) day.prev[id] = state.items[id] ? { ...state.items[id] } : null;
  const base = day.prev[id];
  const box = result === "ok" ? (base ? base.box : 0) + 1 : 0;
  state.items[id] = {
    box,
    due: box >= MASTERED_BOX ? null : addDays(date, INTERVALS[box]),
    last: date,
  };
  day.results[id] = result;
  saveState();
}

function isDayComplete(day) {
  return day && day.ids.length > 0 && day.ids.every((id) => day.results[id]);
}

function streak() {
  let date = today();
  if (!isDayComplete(state.days[date])) date = addDays(date, -1);
  let n = 0;
  while (isDayComplete(state.days[date])) {
    n++;
    date = addDays(date, -1);
  }
  return n;
}

// ============================================================
// レベル自動調整の提案
// ============================================================
function levelSuggestion() {
  const date = today();
  if (state.suggestCooldownUntil && date < state.suggestCooldownUntil) return null;
  // 今のレベルで最後までやった直近3日分
  const recent = Object.keys(state.days)
    .filter((d) => d <= date && state.days[d].level === state.level && isDayComplete(state.days[d]))
    .sort()
    .slice(-3)
    .map((d) => state.days[d]);
  if (recent.length < 3) return null;

  const rates = recent.map((day) => {
    if (!day.newIds.length) return null;
    const ok = day.newIds.filter((id) => day.results[id] === "ok").length;
    return ok / day.newIds.length;
  });
  if (rates.includes(null)) return null;
  const total = recent.reduce((s, d) => s + d.newIds.length, 0);
  const ok = recent.reduce((s, d) => s + d.newIds.filter((id) => d.results[id] === "ok").length, 0);

  if (ok / total >= 0.8 && state.level < 5) return "up";
  if (rates.every((r) => r <= 0.5) && state.level > 1) return "down";
  return null;
}

function setLevel(level) {
  state.level = level;
  state.suggestCooldownUntil = addDays(today(), 3);
  saveState();
}

// ============================================================
// レベルテスト
// ============================================================
let test = null;

function startTest() {
  const real = [];
  for (let level = 1; level <= 5; level++) {
    const pool = shuffle(PHRASES.filter((p) => p.level === level)).slice(0, TEST_PER_LEVEL);
    pool.forEach((p) => real.push({ en: p.en, level }));
  }
  const fakes = shuffle(FAKE_PHRASES).slice(0, TEST_FAKES).map((en) => ({ en, level: 0 }));
  test = { questions: shuffle([...real, ...fakes]), answers: [], index: 0 };
  render("test");
}

function answerTest(score) {
  test.answers[test.index] = score;
  test.index++;
  render(test.index >= test.questions.length ? "testResult" : "test");
}

// 存在しないフレーズを「わかる」と言った割合で点数を割り引く
function scoreTest() {
  const fakeScores = test.questions
    .map((q, i) => (q.level === 0 ? test.answers[i] : null))
    .filter((s) => s !== null);
  const falseAlarm = fakeScores.reduce((a, b) => a + b, 0) / fakeScores.length;

  const byLevel = {};
  for (let level = 1; level <= 5; level++) {
    const scores = test.questions
      .map((q, i) => (q.level === level ? test.answers[i] : null))
      .filter((s) => s !== null);
    const raw = scores.reduce((a, b) => a + b, 0) / scores.length;
    byLevel[level] = Math.max(0, raw - falseAlarm * FAKE_PENALTY);
  }

  let recommended = 5;
  for (let level = 1; level <= 5; level++) {
    if (byLevel[level] < PASS_RATE) { recommended = level; break; }
  }
  return { byLevel, falseAlarm, recommended };
}

// ============================================================
// 表示
// ============================================================
const app = document.getElementById("app");
let screen = "today";
let cardIndex = 0;
let revealed = false;
let chosenLevel = null;
let browsing = false; // 完了後に見返しているとき

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function speak(text) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  speechSynthesis.speak(u);
}

function render(next) {
  if (next) screen = next;
  if (!state.level && !["testIntro", "test", "testResult"].includes(screen)) screen = "testIntro";

  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.go === screen));
  renderMeta();
  const views = { testIntro: viewTestIntro, test: viewTest, testResult: viewTestResult, today: viewToday, settings: viewSettings };
  app.innerHTML = views[screen]();
  renderKeys();
}

function renderMeta() {
  const meta = document.getElementById("meta");
  if (!state.level) { meta.innerHTML = ""; return; }
  meta.innerHTML = `<span>レベル <b>${state.level}</b></span><span>連続 <b>${streak()}</b> 日</span>`;
}

function renderKeys() {
  const keys = document.getElementById("keys");
  if (screen === "today" && state.level && (browsing || !isDayComplete(getToday()))) {
    keys.innerHTML = revealed
      ? `<span><kbd>←</kbd> まだ</span><span><kbd>→</kbd> わかった</span><span><kbd>S</kbd> 発音</span>`
      : `<span><kbd>Space</kbd> 意味を見る</span><span><kbd>S</kbd> 発音</span>`;
  } else if (screen === "test") {
    keys.innerHTML = `<span><kbd>1</kbd> わかる</span><span><kbd>2</kbd> なんとなく</span><span><kbd>3</kbd> わからない</span>`;
  } else {
    keys.innerHTML = "";
  }
}

// ---------- レベルテスト ----------
function viewTestIntro() {
  return `
    <section class="panel">
      <h1>まずはレベルチェック</h1>
      <p class="lead">23個のフレーズ・単語が1つずつ出ます。直感で「わかる / なんとなく / わからない」を選んでください（約2分）。</p>
      <p class="muted small">中には<strong>存在しないフレーズ</strong>も混ざっています。知ったかぶりで「わかる」を押すと判定が厳しくなるので、正直に答えるのがいちばんです。</p>
      <div class="row" style="margin-top:28px">
        <button class="btn primary big" data-action="start-test">テストを始める</button>
        ${state.level ? `<button class="btn" data-go="today">やめる</button>` : ""}
      </div>
    </section>`;
}

function viewTest() {
  const q = test.questions[test.index];
  return `
    <section class="panel">
      <div class="test-q">
        <div class="count">${test.index + 1} / ${test.questions.length}</div>
        <div class="en">${esc(q.en)}</div>
        <p class="muted">この意味、わかりますか？</p>
        <div class="choice-row">
          <button class="btn ok big" data-test="1">わかる <kbd>1</kbd></button>
          <button class="btn big" data-test="0.5">なんとなく <kbd>2</kbd></button>
          <button class="btn ng big" data-test="0">わからない <kbd>3</kbd></button>
        </div>
      </div>
    </section>`;
}

function viewTestResult() {
  const { byLevel, falseAlarm, recommended } = scoreTest();
  if (chosenLevel === null) chosenLevel = recommended;
  const bars = [1, 2, 3, 4, 5].map((l) => `
    <div class="bar-row">
      <span>レベル ${l}</span>
      <div class="bar"><i style="width:${Math.round(byLevel[l] * 100)}%"></i></div>
      <span>${Math.round(byLevel[l] * 100)}%</span>
    </div>`).join("");
  const warn = falseAlarm > 0
    ? `<p class="small muted">※ 存在しないフレーズを「わかる」寄りに答えた分、点数を割り引いています。</p>`
    : "";
  return `
    <section class="panel">
      <h1>レベル ${recommended} から始めるのがおすすめです</h1>
      <p class="lead">各レベルでどれくらい「わかる」だったか：</p>
      <div class="bars">${bars}</div>
      ${warn}
      <h2>開始レベルを選ぶ</h2>
      <div class="level-pick">
        ${[1, 2, 3, 4, 5].map((l) => `<button class="btn ${l === chosenLevel ? "selected" : ""}" data-pick="${l}">${l}</button>`).join("")}
      </div>
      <button class="btn primary big" data-action="finish-test">レベル ${chosenLevel} で始める</button>
    </section>`;
}

// ---------- 今日の5 ----------
function viewToday() {
  const day = getToday();
  if (!day.ids.length) {
    return `<section class="panel"><h1>全部やり終えました 🎉</h1><p class="lead">選んでいるカテゴリのフレーズはすべて学習済みです。設定でカテゴリを増やすか、phrases.js にフレーズを追加してください。</p></section>`;
  }
  if (isDayComplete(day) && !browsing) return viewDone(day);
  if (cardIndex >= day.ids.length) cardIndex = 0;
  const p = BY_ID[day.ids[cardIndex]];
  const isReview = !day.newIds.includes(p.id);

  const dots = day.ids.map((id, i) => {
    const r = day.results[id];
    return `<button class="dot ${r || ""} ${i === cardIndex ? "current" : ""}" data-card="${i}" aria-label="${i + 1}枚目"></button>`;
  }).join("");

  const body = revealed
    ? `<div class="reveal-area">
         <p class="ja">${esc(p.ja)}</p>
         <p class="ex">${esc(p.ex)}</p>
         <p class="exJa">${esc(p.exJa)}</p>
       </div>
       <div class="actions">
         <button class="btn ng big" data-answer="ng">✗ まだ <kbd>←</kbd></button>
         <button class="btn ok big" data-answer="ok">✓ わかった <kbd>→</kbd></button>
       </div>`
    : `<div class="reveal-area">
         <p class="hidden-hint">意味を思い浮かべてから…</p>
       </div>
       <div class="actions">
         <button class="btn primary big" data-action="reveal">意味を見る <kbd>Space</kbd></button>
       </div>`;

  return `
    ${browsing ? "" : suggestionBanner()}
    <div class="progress">${dots}</div>
    <section class="panel card">
      <div class="tags">
        ${isReview ? `<span class="tag review">復習</span>` : `<span class="tag">NEW</span>`}
        <span class="tag">${CATEGORIES[p.cat]}</span>
        <span class="tag">Lv ${p.level}</span>
      </div>
      <div class="en">${esc(p.en)}</div>
      <div><button class="speak" data-action="speak">🔊 発音</button></div>
      ${body}
    </section>
    ${browsing ? `<p style="text-align:center"><button class="btn" data-action="end-browse">まとめに戻る</button></p>` : ""}`;
}

function viewDone(day) {
  const learning = Object.values(state.items).filter((it) => !isMastered(it)).length;
  const mastered = Object.values(state.items).filter(isMastered).length;
  const list = day.ids.map((id) => {
    const p = BY_ID[id];
    const r = day.results[id];
    return `<li>
      <span class="mark ${r}">${r === "ok" ? "✓" : "✗"}</span>
      <span class="en">${esc(p.en)}</span>
      <span class="ja muted">${esc(p.ja)}</span>
    </li>`;
  }).join("");
  return `
    ${suggestionBanner()}
    <section class="panel">
      <h1>今日の5、完了！</h1>
      <p class="lead">また明日。「まだ」にしたものは明日の復習に出てきます。</p>
      <div class="stats">
        <div class="stat"><b>${streak()}</b><span>連続日数</span></div>
        <div class="stat"><b>${learning}</b><span>覚えている途中</span></div>
        <div class="stat"><b>${mastered}</b><span>習得済み</span></div>
      </div>
      <ul class="summary">${list}</ul>
      <div class="row" style="margin-top:24px">
        <button class="btn" data-action="review-again">もう一度見る</button>
      </div>
    </section>`;
}

function suggestionBanner() {
  const s = levelSuggestion();
  if (!s) return "";
  const text = s === "up"
    ? `最近の新しいフレーズは8割以上「わかった」でした。レベル ${state.level + 1} に上げますか？`
    : `最近は「まだ」が多めです。レベル ${state.level - 1} に下げて土台を固めますか？`;
  const target = s === "up" ? state.level + 1 : state.level - 1;
  return `
    <div class="banner">
      <p>${text}<br><span class="small muted">変更は明日の5から反映されます。</span></p>
      <button class="btn primary" data-level="${target}">レベル ${target} にする</button>
      <button class="btn" data-action="dismiss-suggest">今のままで</button>
    </div>`;
}

// ---------- 設定 ----------
function viewSettings() {
  const rows = [1, 2, 3, 4, 5].map((l) => {
    const all = PHRASES.filter((p) => p.level === l);
    const seen = all.filter((p) => state.items[p.id]).length;
    const mastered = all.filter((p) => isMastered(state.items[p.id])).length;
    return `<tr><td>レベル ${l}</td><td>${all.length}</td><td>${seen}</td><td>${mastered}</td></tr>`;
  }).join("");

  const debug = location.search.includes("debug")
    ? `<div class="debug">
         <strong>テスト用：日付をずらす</strong>（今の設定：${state.debugOffset} 日 → ${today()}）
         <div class="row" style="margin-top:8px">
           <button class="btn" data-shift="-1">−1日</button>
           <button class="btn" data-shift="1">＋1日</button>
           <button class="btn" data-shift="0">元に戻す</button>
         </div>
       </div>`
    : "";

  return `
    <section class="panel">
      <h2>レベル</h2>
      <div class="level-pick">
        ${[1, 2, 3, 4, 5].map((l) => `<button class="btn ${l === state.level ? "selected" : ""}" data-level="${l}">${l}</button>`).join("")}
      </div>
      <p class="small muted">変更は明日の5から反映されます。<button class="btn" data-action="retest" style="margin-left:8px">レベルテストをやり直す</button></p>

      <h2>出すカテゴリ</h2>
      <div class="checks">
        ${Object.entries(CATEGORIES).map(([key, label]) => `
          <label><input type="checkbox" data-cat="${key}" ${state.cats.includes(key) ? "checked" : ""}> ${label}</label>`).join("")}
      </div>

      <h2>進み具合</h2>
      <table class="level-table">
        <tr><th></th><th>全部</th><th>出てきた</th><th>習得済み</th></tr>
        ${rows}
      </table>

      <h2>データの書き出し・読み込み</h2>
      <p class="small muted">学習記録はこのブラウザの中だけに保存されています。パソコンとスマホでデータを移したいときや、バックアップに使ってください。</p>
      <div class="row">
        <button class="btn" data-action="export">書き出す（.json）</button>
        <label class="btn">読み込む<input type="file" accept="application/json,.json" id="import" hidden></label>
        <button class="btn danger" data-action="reset">全部リセット</button>
      </div>
      ${debug}
    </section>`;
}

// ============================================================
// 操作
// ============================================================
function goToNextCard() {
  const day = getToday();
  revealed = false;
  if (browsing) {
    cardIndex++;
    if (cardIndex >= day.ids.length) { browsing = false; cardIndex = 0; }
    return;
  }
  const next = day.ids.findIndex((id, i) => i > cardIndex && !day.results[id]);
  const first = day.ids.findIndex((id) => !day.results[id]);
  cardIndex = next !== -1 ? next : first !== -1 ? first : 0;
}

function handleAnswer(result) {
  const day = getToday();
  answer(day.ids[cardIndex], result);
  goToNextCard();
  render();
}

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `daily5-backup-${today()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (data.version !== 1 || typeof data.items !== "object") throw new Error("形式が違います");
      if (!confirm("今のデータを、読み込んだデータで置き換えます。よろしいですか？")) return;
      state = { ...defaultState(), ...data };
      saveState();
      alert("読み込みました。");
      render("today");
    } catch (e) {
      alert("読み込めませんでした：" + e.message);
    }
  };
  reader.readAsText(file);
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("button, [data-go]");
  if (!t) return;
  const d = t.dataset;

  if (d.go) { revealed = false; browsing = false; render(d.go); return; }
  if (d.test !== undefined) { answerTest(Number(d.test)); return; }
  if (d.pick) { chosenLevel = Number(d.pick); render(); return; }
  if (d.answer) { handleAnswer(d.answer); return; }
  if (d.card) { cardIndex = Number(d.card); revealed = !!getToday().results[getToday().ids[cardIndex]]; render(); return; }
  if (d.level) { setLevel(Number(d.level)); render(); return; }
  if (d.shift !== undefined) {
    state.debugOffset = d.shift === "0" ? 0 : state.debugOffset + Number(d.shift);
    saveState(); cardIndex = 0; revealed = false; render(); return;
  }

  switch (d.action) {
    case "start-test": chosenLevel = null; startTest(); break;
    case "finish-test":
      state.level = chosenLevel;
      saveState(); test = null; cardIndex = 0; revealed = false;
      render("today");
      break;
    case "reveal": revealed = true; render(); break;
    case "speak": speak(BY_ID[getToday().ids[cardIndex]].en); break;
    case "review-again":
      // 結果は消さずに1枚目から見返す（答え直しもできる）
      browsing = true; cardIndex = 0; revealed = false; render();
      break;
    case "end-browse": browsing = false; render(); break;
    case "dismiss-suggest":
      state.suggestCooldownUntil = addDays(today(), 3);
      saveState(); render();
      break;
    case "retest": render("testIntro"); break;
    case "export": exportData(); break;
    case "reset":
      if (confirm("学習記録をすべて消します。元に戻せません。よろしいですか？")) {
        state = defaultState(); saveState(); render("testIntro");
      }
      break;
  }
});

document.addEventListener("change", (e) => {
  if (e.target.dataset.cat) {
    const cat = e.target.dataset.cat;
    state.cats = e.target.checked ? [...state.cats, cat] : state.cats.filter((c) => c !== cat);
    if (!state.cats.length) { state.cats = [cat]; e.target.checked = true; alert("カテゴリは1つ以上選んでください。"); }
    saveState();
  }
  if (e.target.id === "import" && e.target.files[0]) importData(e.target.files[0]);
});

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.matches("input, textarea")) return;

  if (screen === "test") {
    const map = { "1": 1, "2": 0.5, "3": 0 };
    if (e.key in map) answerTest(map[e.key]);
    return;
  }
  if (screen !== "today" || !state.level) return;
  const day = getToday();
  if (!day.ids.length || (isDayComplete(day) && !browsing)) return;

  if (e.key === " " && !revealed) { e.preventDefault(); revealed = true; render(); }
  else if (e.key === "ArrowRight" && revealed) handleAnswer("ok");
  else if (e.key === "ArrowLeft" && revealed) handleAnswer("ng");
  else if (e.key.toLowerCase() === "s") speak(BY_ID[day.ids[cardIndex]].en);
});

// 途中まで答えた日に開き直したら、まだ答えていないカードから
if (state.level) {
  const day = getToday();
  cardIndex = Math.max(0, day.ids.findIndex((id) => !day.results[id]));
}
render(state.level ? "today" : "testIntro");
