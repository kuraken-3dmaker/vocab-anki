"use strict";

// ============================================================
// 定数
// ============================================================
const STORAGE_KEY = "daily5.v1";
const DAILY_COUNT = 5;
const MAX_REVIEWS = 8;
const MIN_REVIEWS = 4;   // 期限が来たものが少ない日は、早めの復習でここまで埋める
const WRITE_COUNT = 2;
// box（何回連続で正解したか）→ 次に出すまでの日数。box 5 で習得済み
const INTERVALS = { 0: 1, 1: 3, 2: 7, 3: 16, 4: 35 };
const MASTERED_BOX = 5;
const CLOZE_FROM_BOX = 2; // ここから確認問題が4択 → 穴埋めになる
const TEST_PER_LEVEL = 4;
const TEST_FAKES = 3;
const PASS_RATE = 0.75;
const FAKE_PENALTY = 0.5; // 偽物を「わかる」と答えた割合 × これ を各レベルの点数から引く
const BY_ID = Object.fromEntries(PHRASES.map((p) => [p.id, p]));
const PHASES = [
  ["review", "確認問題"],
  ["learn", "新しい5つ"],
  ["practice", "穴埋め"],
  ["write", "作文"],
  ["done", "まとめ"],
];

// ============================================================
// 保存（localStorage）
// ============================================================
function defaultState() {
  return {
    version: 2,
    level: null,
    cats: Object.keys(CATEGORIES),
    items: {},        // id -> { box, due, last }
    days: {},         // "YYYY-MM-DD" -> その日のセッション（getToday 参照）
    writings: [],     // { date, id, scene, text, rating, note }
    suggestCooldownUntil: null,
    debugOffset: 0,
  };
}

// v1（カードだけの版）のデータを引き継ぐ
function migrate(s) {
  if ((s.version || 1) >= 2) return s;
  s.version = 2;
  s.writings = s.writings || [];
  const date = addDays(dateStr(new Date()), s.debugOffset || 0);
  for (const it of Object.values(s.items)) {
    // v1 は box 4 で習得済みだった。v2 ではもう1段階（35日後）確かめる
    if (it.box >= 4) { it.box = 4; it.due = addDays(date, INTERVALS[4]); }
  }
  // 今日の分が v1 のまま途中なら、v2 のセッションで作り直す
  const d = s.days[date];
  if (d && !d.v && !isDayComplete(d)) delete s.days[date];
  return s;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return migrate({ ...defaultState(), ...JSON.parse(raw), version: JSON.parse(raw).version || 1 });
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

let state = loadState();

// ============================================================
// その日のセッションを作る
// ============================================================
function isMastered(item) {
  return item && item.box >= MASTERED_BOX;
}

function learningIds() {
  return Object.entries(state.items).filter(([id, it]) => BY_ID[id] && !isMastered(it));
}

// 期限が来たもの（古い順）→ 足りなければ、最後に見たのが古いものを早めに
function pickReviews(date) {
  const learning = learningIds();
  const due = learning
    .filter(([, it]) => it.due && it.due <= date)
    .sort((a, b) => a[1].due.localeCompare(b[1].due))
    .map(([id]) => id)
    .slice(0, MAX_REVIEWS);
  const early = learning
    .filter(([id, it]) => !due.includes(id) && it.last < date)
    .sort((a, b) => a[1].last.localeCompare(b[1].last))
    .map(([id]) => id)
    .slice(0, Math.max(0, MIN_REVIEWS - due.length));
  return { reviewIds: [...due, ...early], earlyIds: early };
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

  const { reviewIds, earlyIds } = pickReviews(date);
  const day = {
    v: 2,
    level: state.level,
    reviewIds,
    earlyIds,
    newIds: pickNew(DAILY_COUNT, date),
    phase: null,
    queue: [],        // { id, kind: "choice" | "cloze", retry }
    qIndex: 0,
    pending: null,    // 答えた直後の表示 { result, input }
    first: {},        // "phase:id" -> 最初の回答が正解だったか
    known: {},        // id -> "known" | "new"
    learnIndex: 0,
    writeIds: [],
    writeIndex: 0,
    draft: { text: "", sent: false, checked: false, note: "" },
    complete: false,
  };
  state.days[date] = day;
  startPhase(day, "review");
  saveState();
  return day;
}

function kindFor(id) {
  const it = state.items[id];
  return it && it.box >= CLOZE_FROM_BOX && cloze(BY_ID[id]) ? "cloze" : "choice";
}

function startPhase(day, phase) {
  day.phase = phase;
  day.queue = [];
  day.qIndex = 0;
  day.pending = null;
  if (phase === "review") {
    if (!day.reviewIds.length) return startPhase(day, "learn");
    day.queue = day.reviewIds.map((id) => ({ id, kind: kindFor(id) }));
  } else if (phase === "learn") {
    if (!day.newIds.length) return startPhase(day, "done");
    day.learnIndex = 0;
  } else if (phase === "practice") {
    day.queue = day.newIds.map((id) => ({ id, kind: cloze(BY_ID[id]) ? "cloze" : "choice" }));
  } else if (phase === "write") {
    // 「初めて」の表現を優先
    const order = [...day.newIds].sort((a, b) => (day.known[a] === "new" ? 0 : 1) - (day.known[b] === "new" ? 0 : 1));
    day.writeIds = order.slice(0, WRITE_COUNT);
    day.writeIndex = 0;
    day.draft = { text: "", sent: false, checked: false, note: "" };
  } else if (phase === "done") {
    day.complete = true;
  }
}

function nextPhase(day) {
  const i = PHASES.findIndex(([key]) => key === day.phase);
  startPhase(day, PHASES[i + 1][0]);
}

// ============================================================
// 復習の段階
// ============================================================
function setItem(id, box) {
  const date = today();
  state.items[id] = {
    box,
    due: box >= MASTERED_BOX ? null : addDays(date, INTERVALS[box]),
    last: date,
  };
}

function applyFirstAnswer(day, id, ok) {
  const base = state.items[id];
  if (day.phase === "review") {
    // 早めの復習は、正解しても段階を上げない（予定より早く出しただけなので）
    const early = day.earlyIds.includes(id);
    if (!ok) setItem(id, 0);
    else if (early) state.items[id] = { ...base, last: today() };
    else setItem(id, Math.min(MASTERED_BOX, base.box + 1));
  } else {
    setItem(id, ok ? 1 : 0);
  }
}

// result: "correct" | "almost" | "wrong"
function submitAnswer(result, input) {
  const day = getToday();
  if (day.pending) return;
  const q = day.queue[day.qIndex];
  const ok = result !== "wrong";
  const key = `${day.phase}:${q.id}`;
  if (!(key in day.first)) {
    day.first[key] = ok;
    applyFirstAnswer(day, q.id, ok);
  }
  // 間違えたものは最後にもう一度（正解するまで）
  if (!ok) day.queue.push({ id: q.id, kind: q.kind, retry: true });
  day.pending = { result, input };
  saveState();
}

function nextQuestion() {
  const day = getToday();
  day.qIndex++;
  day.pending = null;
  hintShown = false;
  if (day.qIndex >= day.queue.length) nextPhase(day);
  saveState();
}

function markKnown(kind) {
  const day = getToday();
  const id = day.newIds[day.learnIndex];
  day.known[id] = kind;
  // 練習の前に閉じても、明日また同じものが新しく出ないように仮登録
  if (!state.items[id]) setItem(id, 0);
  day.learnIndex++;
  revealed = false;
  if (day.learnIndex >= day.newIds.length) nextPhase(day);
  saveState();
}

function finishWriting(rating) {
  const day = getToday();
  const id = day.writeIds[day.writeIndex];
  if (rating) {
    state.writings.push({
      date: today(),
      id,
      scene: sceneFor(id),
      text: day.draft.text.trim(),
      rating,
      note: day.draft.note.trim(),
    });
  }
  day.writeIndex++;
  day.draft = { text: "", sent: false, checked: false, note: "" };
  if (day.writeIndex >= day.writeIds.length) nextPhase(day);
  saveState();
}

function sceneFor(id) {
  return pickScene(BY_ID[id], seededRandom(hashString(today() + id)));
}

function isDayComplete(day) {
  if (!day) return false;
  if (day.v === 2) return day.complete;
  return day.ids.length > 0 && day.ids.every((id) => day.results[id]);
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
// 新しい表現のうち、もう知っていたもの
function knownCount(day) {
  return day.v === 2
    ? day.newIds.filter((id) => day.known[id] === "known").length
    : day.newIds.filter((id) => day.results[id] === "ok").length;
}

function levelSuggestion() {
  const date = today();
  if (state.suggestCooldownUntil && date < state.suggestCooldownUntil) return null;
  // 今のレベルで最後までやった直近3日分
  const recent = Object.keys(state.days)
    .filter((d) => d <= date && state.days[d].level === state.level && isDayComplete(state.days[d]))
    .sort()
    .slice(-3)
    .map((d) => state.days[d]);
  if (recent.length < 3 || recent.some((d) => !d.newIds.length)) return null;

  const rates = recent.map((d) => knownCount(d) / d.newIds.length);
  const total = recent.reduce((s, d) => s + d.newIds.length, 0);
  const ok = recent.reduce((s, d) => s + knownCount(d), 0);

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
let revealed = false;
let hintShown = false;
let chosenLevel = null;

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
  const views = {
    testIntro: viewTestIntro, test: viewTest, testResult: viewTestResult,
    today: viewToday, notebook: viewNotebook, settings: viewSettings,
  };
  app.innerHTML = views[screen]();
  renderKeys();
  afterRender();
}

// 入力欄や「次へ」にフォーカスを移して、キーボードだけで進められるようにする
function afterRender() {
  const target = app.querySelector("[data-autofocus]");
  if (target) target.focus({ preventScroll: true });
}

function renderMeta() {
  const meta = document.getElementById("meta");
  if (!state.level) { meta.innerHTML = ""; return; }
  meta.innerHTML = `<span>レベル <b>${state.level}</b></span><span>連続 <b>${streak()}</b> 日</span>`;
}

function keysFor() {
  if (screen === "test") return [["1", "わかる"], ["2", "なんとなく"], ["3", "わからない"]];
  if (screen !== "today" || !state.level) return [];
  const day = getToday();
  if (day.v !== 2) return [];
  if (day.phase === "learn") {
    return revealed ? [["←", "初めて"], ["→", "知ってた"], ["S", "発音"]] : [["Space", "意味を見る"], ["S", "発音"]];
  }
  if (day.phase === "review" || day.phase === "practice") {
    if (day.pending) return [["Enter", "次へ"]];
    const q = day.queue[day.qIndex];
    return q.kind === "choice" ? [["1〜4", "選ぶ"], ["S", "発音"]] : [["Enter", "答える"]];
  }
  if (day.phase === "write") return [["⌘ Enter", "Claude で添削"]];
  return [];
}

function renderKeys() {
  document.getElementById("keys").innerHTML = keysFor()
    .map(([k, label]) => `<span><kbd>${k}</kbd> ${label}</span>`).join("");
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

// ---------- 今日のセッション ----------
function viewToday() {
  const day = getToday();
  if (day.v !== 2) {
    return `
      <section class="panel">
        <h1>今日の5（旧バージョン）は完了しています</h1>
        <p class="lead">新しくなったセッション（確認問題・穴埋め・作文）は明日から始まります。今すぐ試したいときは下のボタンからどうぞ。</p>
        <button class="btn primary big" data-action="new-session">新しいセッションを始める</button>
      </section>`;
  }
  if (!day.reviewIds.length && !day.newIds.length) {
    return `<section class="panel"><h1>全部やり終えました 🎉</h1><p class="lead">選んでいるカテゴリのフレーズはすべて習得済みです。設定でカテゴリを増やすか、phrases.js にフレーズを追加してください。</p></section>`;
  }
  const body = {
    review: viewQuestion, practice: viewQuestion, learn: viewLearn, write: viewWrite, done: viewDone,
  }[day.phase](day);
  return stepper(day) + body;
}

function stepper(day) {
  const current = PHASES.findIndex(([key]) => key === day.phase);
  const counts = {
    review: day.reviewIds.length,
    learn: day.newIds.length,
    practice: day.newIds.length,
    write: Math.min(WRITE_COUNT, day.newIds.length),
  };
  return `<ol class="stepper">${PHASES.map(([key, label], i) => {
    if (key !== "done" && !counts[key]) return "";
    const cls = i < current ? "past" : i === current ? "current" : "";
    return `<li class="${cls}">${label}</li>`;
  }).join("")}</ol>`;
}

function questionTags(day, q, p) {
  return `
    <div class="tags">
      ${q.retry ? `<span class="tag review">もう一度</span>` : ""}
      ${day.earlyIds.includes(q.id) && day.phase === "review" ? `<span class="tag">早めの復習</span>` : ""}
      <span class="tag">${CATEGORIES[p.cat]}</span>
      <span class="tag">Lv ${p.level}</span>
    </div>`;
}

function viewQuestion(day) {
  const q = day.queue[day.qIndex];
  const p = BY_ID[q.id];
  const count = `<div class="count">${day.qIndex + 1} / ${day.queue.length}</div>`;
  const inner = q.kind === "choice" ? viewChoice(day, q, p) : viewCloze(day, q, p);
  return `<section class="panel card quiz">${count}${questionTags(day, q, p)}${inner}</section>`;
}

function viewChoice(day, q, p) {
  const rand = seededRandom(hashString(today() + q.id + (q.retry ? ":retry" : "")));
  const options = choiceOptions(p, rand);
  const pending = day.pending;
  const buttons = options.map((id, i) => {
    let cls = "";
    if (pending) {
      if (id === p.id) cls = "ok";
      else if (id === pending.input) cls = "ng";
    }
    return `<button class="option ${cls}" data-choice="${id}" ${pending ? "disabled" : ""}>
      <kbd>${i + 1}</kbd><span>${esc(BY_ID[id].ja)}</span></button>`;
  }).join("");
  return `
    <p class="prompt">この意味は？</p>
    <div class="en">${esc(p.en)}</div>
    <div><button class="speak" data-action="speak">🔊 発音</button></div>
    <div class="options">${buttons}</div>
    ${pending ? feedback(pending.result, p) : ""}`;
}

function viewCloze(day, q, p) {
  const c = cloze(p);
  const pending = day.pending;
  const blank = pending
    ? `<mark class="${pending.result === "wrong" ? "ng" : "ok"}">${esc(c.answer)}</mark>`
    : `<span class="blank">${hintShown ? esc(hint(c.answer)) : "______"}</span>`;
  const input = pending
    ? `<p class="your-answer">あなたの答え：<span class="${pending.result === "wrong" ? "ng-text" : ""}">${esc(pending.input || "（わからない）")}</span></p>`
    : `<div class="answer-row">
         <input id="answer" type="text" autocomplete="off" autocapitalize="off" spellcheck="false"
                placeholder="空欄に入る英語を入力" data-autofocus>
         <button class="btn primary" data-action="submit">答える</button>
       </div>
       <div class="row center">
         <button class="btn small-btn" data-action="hint" ${hintShown ? "disabled" : ""}>ヒント（頭文字）</button>
         <button class="btn small-btn" data-action="give-up">わからない</button>
       </div>`;
  return `
    <p class="prompt">空欄に入る表現は？</p>
    <p class="ja">${esc(p.ja)}</p>
    <p class="ex sentence">${esc(c.before)}${blank}${esc(c.after)}</p>
    <p class="exJa">${esc(p.exJa)}</p>
    ${input}
    ${pending ? feedback(pending.result, p) : ""}`;
}

function feedback(result, p) {
  const title = { correct: "正解！", almost: "ほぼ正解（スペルに注意）", wrong: "不正解 — 最後にもう一度出ます" }[result];
  return `
    <div class="feedback ${result === "wrong" ? "ng" : "ok"}">
      <strong>${title}</strong>
      <span><b>${esc(p.en)}</b>：${esc(p.ja)}</span>
      <span class="ex">${esc(p.ex)}</span>
    </div>
    <div class="actions">
      <button class="btn primary big" data-action="next" data-autofocus>次へ <kbd>Enter</kbd></button>
    </div>`;
}

function viewLearn(day) {
  const p = BY_ID[day.newIds[day.learnIndex]];
  const body = revealed
    ? `<div class="reveal-area">
         <p class="ja">${esc(p.ja)}</p>
         <p class="ex">${esc(p.ex)}</p>
         <p class="exJa">${esc(p.exJa)}</p>
       </div>
       <div class="actions">
         <button class="btn ng big" data-known="new">初めて <kbd>←</kbd></button>
         <button class="btn ok big" data-known="known">知ってた <kbd>→</kbd></button>
       </div>`
    : `<div class="reveal-area">
         <p class="hidden-hint">意味を思い浮かべてから…</p>
       </div>
       <div class="actions">
         <button class="btn primary big" data-action="reveal">意味を見る <kbd>Space</kbd></button>
       </div>`;
  return `
    ${suggestionBanner()}
    <section class="panel card">
      <div class="count">${day.learnIndex + 1} / ${day.newIds.length}</div>
      <div class="tags">
        <span class="tag">NEW</span>
        <span class="tag">${CATEGORIES[p.cat]}</span>
        <span class="tag">Lv ${p.level}</span>
      </div>
      <div class="en">${esc(p.en)}</div>
      <div><button class="speak" data-action="speak">🔊 発音</button></div>
      ${body}
    </section>`;
}

function viewWrite(day) {
  const p = BY_ID[day.writeIds[day.writeIndex]];
  const d = day.draft;
  const done = d.sent || d.checked;
  const check = d.checked
    ? `<div class="example-box">
         <p class="small muted">例文（使い方の参考）</p>
         <p class="ex">${esc(p.ex)}</p>
         <p class="exJa">${esc(p.exJa)}</p>
       </div>`
    : "";
  const sent = d.sent
    ? `<p class="notice">claude.ai を新しいタブで開きました。入力欄に依頼文が入っていなければ <kbd>⌘</kbd><kbd>V</kbd> で貼り付けてください（コピー済み）。</p>`
    : "";
  const rate = done
    ? `<label class="field">
         <span class="small muted">添削メモ（任意：直された文などを貼っておくと作文帳で見返せます）</span>
         <textarea id="note" rows="3">${esc(d.note)}</textarea>
       </label>
       <div class="actions">
         <button class="btn ng big" data-rate="meh">いまいち</button>
         <button class="btn ok big" data-rate="good">うまく使えた</button>
       </div>`
    : `<div class="actions">
         <button class="btn" data-action="skip-write">スキップ</button>
         <button class="btn" data-action="self-check">自分でチェック</button>
         <button class="btn primary big" data-action="coach">Claude で添削 <kbd>⌘ Enter</kbd></button>
       </div>`;
  return `
    <section class="panel card write">
      <div class="count">作文 ${day.writeIndex + 1} / ${day.writeIds.length}</div>
      <p class="prompt">「${esc(sceneFor(p.id))}」の場面で、この表現を使って英文を書いてみよう</p>
      <div class="en">${esc(p.en)}</div>
      <p class="ja">${esc(p.ja)}</p>
      <textarea id="draft" rows="4" placeholder="Write a sentence using “${esc(p.en)}”..."
        ${done ? "readonly" : "data-autofocus"}>${esc(d.text)}</textarea>
      ${sent}${check}${rate}
    </section>`;
}

function viewDone(day) {
  const firstOf = (phase) => Object.entries(day.first).filter(([k]) => k.startsWith(phase + ":"));
  const review = firstOf("review");
  const practice = firstOf("practice");
  const pct = (list) => (list.length ? Math.round((list.filter(([, ok]) => ok).length / list.length) * 100) + "%" : "—");
  const missed = [...review, ...practice].filter(([, ok]) => !ok).map(([k]) => k.split(":").slice(1).join(":"));
  const learning = learningIds().length;
  const mastered = Object.values(state.items).filter(isMastered).length;
  const writings = state.writings.filter((w) => w.date === today());

  const missedList = missed.length
    ? `<h2>間違えた表現（次の確認問題で出ます）</h2>
       <ul class="summary">${[...new Set(missed)].map((id) => `
         <li><span class="mark ng">✗</span><span class="en">${esc(BY_ID[id].en)}</span><span class="ja muted">${esc(BY_ID[id].ja)}</span></li>`).join("")}
       </ul>`
    : "";
  const writingList = writings.length
    ? `<h2>今日の作文</h2>${writings.map(writingCard).join("")}`
    : "";
  return `
    ${suggestionBanner()}
    <section class="panel">
      <h1>今日のセッション、完了！</h1>
      <p class="lead">おつかれさま。また明日。</p>
      <div class="stats">
        <div class="stat"><b>${pct(review)}</b><span>確認問題の正答率</span></div>
        <div class="stat"><b>${pct(practice)}</b><span>穴埋めの正答率</span></div>
        <div class="stat"><b>${streak()}</b><span>連続日数</span></div>
        <div class="stat"><b>${learning}</b><span>覚えている途中</span></div>
        <div class="stat"><b>${mastered}</b><span>習得済み</span></div>
      </div>
      ${missedList}
      ${writingList}
    </section>`;
}

function writingCard(w, index) {
  const p = BY_ID[w.id];
  return `
    <article class="writing">
      <div class="writing-head">
        <span class="en">${esc(p ? p.en : w.id)}</span>
        <span class="tag ${w.rating === "good" ? "" : "review"}">${w.rating === "good" ? "うまく使えた" : "いまいち"}</span>
        <span class="small muted">${esc(w.date)}・${esc(w.scene)}</span>
      </div>
      <p class="writing-text">${esc(w.text || "（空）")}</p>
      ${w.note ? `<p class="writing-note">${esc(w.note)}</p>` : ""}
    </article>`;
}

function suggestionBanner() {
  const s = levelSuggestion();
  if (!s) return "";
  const text = s === "up"
    ? `最近の新しい表現は8割以上「知ってた」でした。レベル ${state.level + 1} に上げますか？`
    : `最近は「初めて」が多めです。レベル ${state.level - 1} に下げて土台を固めますか？`;
  const target = s === "up" ? state.level + 1 : state.level - 1;
  return `
    <div class="banner">
      <p>${text}<br><span class="small muted">変更は明日のセッションから反映されます。</span></p>
      <button class="btn primary" data-level="${target}">レベル ${target} にする</button>
      <button class="btn" data-action="dismiss-suggest">今のままで</button>
    </div>`;
}

// ---------- 作文帳 ----------
function viewNotebook() {
  const list = state.writings.slice().reverse();
  return `
    <section class="panel">
      <h1>作文帳</h1>
      <p class="lead">これまでに書いた英文と添削メモ（${list.length} 件）</p>
      ${list.length ? list.map(writingCard).join("") : `<p class="muted">まだありません。今日のセッションの最後で作文すると、ここにたまっていきます。</p>`}
    </section>`;
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
      <p class="small muted">変更は明日のセッションから反映されます。<button class="btn" data-action="retest" style="margin-left:8px">レベルテストをやり直す</button></p>

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
      <p class="small muted">正解するたびに 1日 → 3日 → 7日 → 16日 → 35日後 と間隔をあけて出題し、35日後にも正解したら習得済みになります。</p>

      <h2>データの書き出し・読み込み</h2>
      <p class="small muted">学習記録と作文帳はこのブラウザの中だけに保存されています。パソコンとスマホでデータを移したいときや、バックアップに使ってください。</p>
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
function submitCloze() {
  const day = getToday();
  const input = document.getElementById("answer");
  if (!input || day.pending) return;
  const value = input.value.trim();
  if (!value) { input.focus(); return; }
  submitAnswer(checkAnswer(BY_ID[day.queue[day.qIndex].id], value), value);
  render();
}

function chooseOption(index) {
  const day = getToday();
  if (day.pending) return;
  const q = day.queue[day.qIndex];
  if (q.kind !== "choice") return;
  const options = choiceOptions(BY_ID[q.id], seededRandom(hashString(today() + q.id + (q.retry ? ":retry" : ""))));
  const id = options[index];
  if (!id) return;
  submitAnswer(id === q.id ? "correct" : "wrong", id);
  render();
}

function startCoach() {
  const day = getToday();
  const text = (document.getElementById("draft") || {}).value || "";
  if (!text.trim()) { alert("先に英文を書いてください。"); return; }
  day.draft.text = text;
  const p = BY_ID[day.writeIds[day.writeIndex]];
  const prompt = coachPrompt(p, sceneFor(p.id), text);
  // コピーはフォーカスがあるうちに始め、タブはクリックの直後に開く（ブロックされないように）
  copyText(prompt);
  window.open(claudeUrl(prompt), "_blank", "noopener");
  day.draft.sent = true;
  saveState();
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
      if (![1, 2].includes(data.version) || typeof data.items !== "object") throw new Error("形式が違います");
      if (!confirm("今のデータを、読み込んだデータで置き換えます。よろしいですか？")) return;
      state = migrate({ ...defaultState(), ...data });
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
  if (!t || t.disabled) return;
  const d = t.dataset;

  if (d.go) { revealed = false; render(d.go); return; }
  if (d.test !== undefined) { answerTest(Number(d.test)); return; }
  if (d.pick) { chosenLevel = Number(d.pick); render(); return; }
  if (d.known) { markKnown(d.known); render(); return; }
  if (d.choice) {
    const day = getToday();
    const q = day.queue[day.qIndex];
    submitAnswer(d.choice === q.id ? "correct" : "wrong", d.choice);
    render();
    return;
  }
  if (d.rate) { finishWriting(d.rate); render(); return; }
  if (d.level) { setLevel(Number(d.level)); render(); return; }
  if (d.shift !== undefined) {
    state.debugOffset = d.shift === "0" ? 0 : state.debugOffset + Number(d.shift);
    saveState(); revealed = false; hintShown = false; render(); return;
  }

  switch (d.action) {
    case "start-test": chosenLevel = null; startTest(); break;
    case "finish-test":
      state.level = chosenLevel;
      saveState(); test = null; revealed = false;
      render("today");
      break;
    case "new-session": delete state.days[today()]; getToday(); render(); break;
    case "reveal": revealed = true; render(); break;
    case "speak": {
      const day = getToday();
      const id = day.phase === "learn" ? day.newIds[day.learnIndex] : day.queue[day.qIndex].id;
      speak(BY_ID[id].en);
      break;
    }
    case "submit": submitCloze(); break;
    case "hint": hintShown = true; render(); break;
    case "give-up": submitAnswer("wrong", ""); render(); break;
    case "next": nextQuestion(); render(); break;
    case "coach": startCoach(); break;
    case "self-check": {
      const day = getToday();
      day.draft.text = document.getElementById("draft").value;
      day.draft.checked = true;
      saveState(); render();
      break;
    }
    case "skip-write": finishWriting(null); render(); break;
    case "dismiss-suggest":
      state.suggestCooldownUntil = addDays(today(), 3);
      saveState(); render();
      break;
    case "retest": render("testIntro"); break;
    case "export": exportData(); break;
    case "reset":
      if (confirm("学習記録と作文帳をすべて消します。元に戻せません。よろしいですか？")) {
        state = defaultState(); saveState(); render("testIntro");
      }
      break;
  }
});

// 書きかけの作文・メモは入力のたびに保存（再読み込みしても消えない）
document.addEventListener("input", (e) => {
  if (screen !== "today") return;
  const day = getToday();
  if (e.target.id === "draft") { day.draft.text = e.target.value; saveState(); }
  if (e.target.id === "note") { day.draft.note = e.target.value; saveState(); }
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
  if (e.target.id === "answer" && e.key === "Enter") { e.preventDefault(); submitCloze(); return; }
  if (e.target.id === "draft" && e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); startCoach(); return; }
  // ボタンにフォーカスがあるときの Enter / Space はブラウザがそのボタンを押すので、ここでは何もしない
  if (e.target.matches("input, textarea, button") && ["Enter", " "].includes(e.key)) return;
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.matches("input, textarea")) return;

  if (screen === "test") {
    const map = { "1": 1, "2": 0.5, "3": 0 };
    if (e.key in map) answerTest(map[e.key]);
    return;
  }
  if (screen !== "today" || !state.level) return;
  const day = getToday();
  if (day.v !== 2) return;

  if (day.phase === "learn") {
    const id = day.newIds[day.learnIndex];
    if (e.key === " " && !revealed) { e.preventDefault(); revealed = true; render(); }
    else if (e.key === "ArrowRight" && revealed) { markKnown("known"); render(); }
    else if (e.key === "ArrowLeft" && revealed) { markKnown("new"); render(); }
    else if (e.key.toLowerCase() === "s") speak(BY_ID[id].en);
    return;
  }
  if (day.phase === "review" || day.phase === "practice") {
    const q = day.queue[day.qIndex];
    if (day.pending) {
      if (e.key === "Enter" || e.key === "ArrowRight") { nextQuestion(); render(); }
      return;
    }
    if (q.kind === "choice") {
      if (/^[1-4]$/.test(e.key)) chooseOption(Number(e.key) - 1);
      else if (e.key.toLowerCase() === "s") speak(BY_ID[q.id].en);
    }
  }
});

render(state.level ? "today" : "testIntro");
