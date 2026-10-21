"use strict";

// ============================================================
// 問題づくりと答えの判定（4択・穴埋め）
// ============================================================

const PLACEHOLDERS = ["someone", "something"];
const IRREGULAR = {
  take: ["took", "taken"], give: ["gave", "given"], get: ["got", "gotten"],
  go: ["went", "gone"], make: ["made"], run: ["ran"], hit: ["hit"],
  drink: ["drank", "drunk"], lose: ["lost"], break: ["broke", "broken"],
  write: ["wrote", "written"], move: ["moved"], have: ["had"], do: ["did", "done"],
  be: ["is", "are", "was", "were", "been"], kick: ["kicked"],
};

// "reach out (to)" → ["reach out"], "bull / bear market" → ["bull market", "bear market"]
function phraseVariants(en) {
  const cleaned = en.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned.includes(" / ")) return [cleaned];
  const parts = cleaned.split(" / ").map((s) => s.trim()).filter(Boolean);
  const tail = parts[parts.length - 1].split(" ").slice(1).join(" ");
  return parts.map((p, i) => (i < parts.length - 1 && !p.includes(" ") && tail ? `${p} ${tail}` : p));
}

function tokens(s) {
  return s.toLowerCase().replace(/[’‘]/g, "'").match(/[a-z0-9]+(?:['-][a-z0-9]+)*/g) || [];
}

// base の活用形（ゆるめ）を全部作る
function inflections(base) {
  const forms = new Set([base, base + "s", base + "es", base + "d", base + "ed", base + "ing"]);
  if (base.endsWith("e")) { forms.add(base.slice(0, -1) + "ing"); forms.add(base.slice(0, -1) + "ed"); }
  if (base.endsWith("y")) { forms.add(base.slice(0, -1) + "ies"); forms.add(base.slice(0, -1) + "ied"); }
  if (/[^aeiou][aeiou][bdgklmnprt]$/.test(base)) {
    const last = base[base.length - 1];
    forms.add(base + last + "ed"); forms.add(base + last + "ing");
  }
  (IRREGULAR[base] || []).forEach((f) => forms.add(f));
  return forms;
}

function wordMatches(base, word) {
  return base === word || inflections(base).has(word);
}

// 例文の中からフレーズの位置を探す → { start, end }（見つからなければ null）
function findPhrase(p) {
  const words = [];
  const re = /[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g;
  let m;
  while ((m = re.exec(p.ex))) words.push({ w: m[0].toLowerCase().replace(/’/g, "'"), start: m.index, end: m.index + m[0].length });

  for (const variant of phraseVariants(p.en)) {
    const pattern = tokens(variant);
    for (let i = 0; i < words.length; i++) {
      const end = matchAt(pattern, words, i);
      if (end !== -1) return { start: words[i].start, end: words[end - 1].end };
    }
  }
  return null;
}

// pattern を words[i] から当てはめる。成功したら終わりの位置（含まない）を返す
function matchAt(pattern, words, i, pi = 0) {
  if (pi === pattern.length) return i;
  if (i >= words.length) return -1;
  const token = pattern[pi];
  if (PLACEHOLDERS.includes(token)) {
    for (let n = 1; n <= 3 && i + n <= words.length; n++) {
      const end = matchAt(pattern, words, i + n, pi + 1);
      if (end !== -1) return end;
    }
    return -1;
  }
  if (!wordMatches(token, words[i].w)) return -1;
  return matchAt(pattern, words, i + 1, pi + 1);
}

const CLOZE = {};
function cloze(p) {
  if (!(p.id in CLOZE)) {
    const pos = findPhrase(p);
    CLOZE[p.id] = pos && {
      before: p.ex.slice(0, pos.start),
      answer: p.ex.slice(pos.start, pos.end),
      after: p.ex.slice(pos.end),
    };
  }
  return CLOZE[p.id];
}

// 頭文字だけのヒント： "circle back" → "c_____ b___"
function hint(answer) {
  return answer.replace(/[A-Za-z]+/g, (w) => w[0] + "_".repeat(w.length - 1));
}

// ============================================================
// 判定
// ============================================================
function normalize(s) {
  return tokens(s.replace(/-/g, " ")).join(" ");
}

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      // 隣どうしの入れ替え（cirlce ↔ circle）も1文字のミスとして数える
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
    }
  }
  return dp[a.length][b.length];
}

// 入力が元の形（活用も可）として正しいか
function matchesBaseForm(input, variant) {
  const pattern = tokens(variant.replace(/-/g, " "));
  const words = tokens(input.replace(/-/g, " ")).map((w) => ({ w }));
  return matchAt(pattern, words, 0) === words.length;
}

// → "correct" | "almost"（タイプミス程度） | "wrong"
function checkAnswer(p, input) {
  const typed = normalize(input);
  if (!typed) return "wrong";
  const c = cloze(p);
  const targets = [...(c ? [c.answer] : []), ...phraseVariants(p.en)];
  for (const t of targets) {
    if (normalize(t) === typed || matchesBaseForm(input, t)) return "correct";
  }
  for (const t of targets) {
    const n = normalize(t);
    const allowed = n.length >= 12 ? 2 : n.length >= 5 ? 1 : 0;
    if (allowed && editDistance(n, typed) <= allowed) return "almost";
  }
  return "wrong";
}

// ============================================================
// 4択
// ============================================================
function choiceOptions(p, rand) {
  const near = PHRASES.filter((q) => q.id !== p.id && q.ja !== p.ja && Math.abs(q.level - p.level) <= 1);
  const sameCat = shuffle(near.filter((q) => q.cat === p.cat), rand);
  const others = shuffle(near.filter((q) => q.cat !== p.cat), rand);
  const distractors = [...sameCat.slice(0, 2), ...others].slice(0, 3);
  return shuffle([p, ...distractors], rand).map((q) => q.id);
}
