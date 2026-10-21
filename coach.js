"use strict";

// ============================================================
// 作文：場面のお題と、claude.ai で添削してもらうための依頼文
// ============================================================

const SCENES = {
  jobhunt: ["面接での受け答え", "リクルーターへのメール", "ネットワーキングイベントでの会話"],
  business: ["チームの会議での発言", "上司へのSlackメッセージ", "クライアントへのメール"],
  academic: ["授業のレポート", "ゼミでのディスカッション", "教授へのメール"],
  finance: ["インターン先での数字の報告", "経済ニュースについての意見", "投資やお金についての会話"],
  tech: ["エンジニアとの打ち合わせ", "プロジェクトの進捗報告", "ITの話題での雑談"],
};

function pickScene(p, rand) {
  const list = SCENES[p.cat];
  return list[Math.floor(rand() * list.length)];
}

function coachPrompt(p, scene, text) {
  return [
    "英語を勉強中の大学生です。次の表現を使って英文を書いたので、添削してください。",
    "",
    `表現: ${p.en}（意味: ${p.ja}）`,
    `場面: ${scene}`,
    `私の英文: ${text.trim()}`,
    "",
    "次の形で、短く答えてください。",
    "1. 評価: ◎自然 / ○惜しい / △不自然 のどれか",
    "2. この表現の使い方は正しいか（正しくなければ理由）",
    "3. 直した文",
    "4. ネイティブならこう言う、という自然な言い方（1〜2個）",
    "5. 解説（日本語で2〜3行）",
  ].join("\n");
}

function claudeUrl(prompt) {
  return "https://claude.ai/new?q=" + encodeURIComponent(prompt);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    // file:// などで Clipboard API が使えないとき
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}
