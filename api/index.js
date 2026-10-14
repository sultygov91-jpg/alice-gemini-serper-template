const DEFAULT_MODEL = "gemini-3.1-flash-lite";
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_ALICE_TEXT = 1024;
const TOTAL_RESPONSE_BUDGET_MS = 3600;
const SERPER_TIMEOUT_MS = 600;
const GEMINI_TIMEOUT_MS = 3000;

const SYSTEM_PROMPT = [
  "Ты — разговорный помощник на базе Gemini внутри навыка Алисы. Общайся по-русски, естественно, на ты, без роли дворецкого и обращения сэр.",
  "Обычно отвечай двумя–тремя короткими предложениями. Учитывай историю и продолжай обсуждение без повторного приветствия. По просьбе раскрывай тему подробнее, но ответ должен помещаться в 900 символов.",
  "Не используй Markdown, таблицы и длинные вступления. Не добавляй нравоучений или предупреждений без необходимости. Обычная ненормативная лексика собеседника сама по себе не повод отказывать в ответе.",
  "Если не знаешь, скажи об этом. Не выдумывай новости и результаты поиска. Не обещай выполнить действия, которых ты не выполняешь."
].join(" ");

function aliceResponse(text, endSession = false, history = []) {
  return {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: endSession
    },
    session_state: { history: safeHistory(history) }
  };
}

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (text.length <= MAX_ALICE_TEXT) return text || "Не удалось подготовить ответ.";

  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? ")
  );
  if (sentenceEnd >= 300) return candidate.slice(0, sentenceEnd + 1).trim();

  const lastSpace = candidate.lastIndexOf(" ");
  return (lastSpace > 200 ? candidate.slice(0, lastSpace) : candidate).trim() + "…";
}

function isSearchIntent(text) {
  return /\b(latest|today|current|news|weather|price|exchange rate|recent|search|look up)\b|сегодня|сейчас|последн|новост|погод|курс валют|найди|поищи|актуальн|сколько стоит|свежие данные/i.test(text);
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  const result = history
    .filter(item => item && (item.role === "user" || item.role === "model") && typeof item.text === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({ role: item.role, text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS) }));
  // Leave room below Yandex's session-state size limit, including UTF-8 Cyrillic.
  while (Buffer.byteLength(JSON.stringify({ history: result }), "utf8") > 6000) result.splice(0, 2);
  return result;
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

async function searchWeb(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY;
  if (!key || timeoutMs < 150) return "";

  try {
    const { response, data } = await fetchJson(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ q: query, gl: "ru", hl: "ru", num: 3 })
      },
      Math.min(SERPER_TIMEOUT_MS, timeoutMs)
    );

    if (!response.ok) {
      console.warn("Serper request failed with HTTP", response.status);
      return "";
    }

    const items = (Array.isArray(data.organic) ? data.organic : [])
      .slice(0, 3)
      .map((item, i) => {
        const title = String(item.title || "").slice(0, 180);
        const snippet = String(item.snippet || "").slice(0, 350);
        const link = String(item.link || "").slice(0, 240);
        return `${i + 1}. ${title}: ${snippet} ${link}`.trim();
      });

    const answerBox = data.answerBox?.answer || data.answerBox?.snippet;
    if (answerBox) items.unshift(`Краткий ответ поисковика: ${String(answerBox).slice(0, 350)}`);
    return items.length ? items.join("\n") : "";
  } catch (error) {
    console.warn("Serper request did not finish in time; continuing without search.");
    return "";
  }
}

async function askGemini(text, history, searchContext, timeoutMs) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("MISSING_GEMINI_KEY");
  if (timeoutMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

  const model = String(process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error("INVALID_MODEL_NAME");

  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));

  const prompt = searchContext
    ? `${text}\n\nРезультаты поиска в интернете:\n${searchContext}\nИспользуй их только там, где они относятся к вопросу.`
    : text;
  contents.push({ role: "user", parts: [{ text: prompt }] });

  const { response, data } = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        safetySettings: ["HARASSMENT", "HATE_SPEECH", "SEXUALLY_EXPLICIT", "DANGEROUS_CONTENT"].map(category => ({
          category: `HARM_CATEGORY_${category}`, threshold: "OFF"
        })),
        generationConfig: {
          temperature: 0.5,
          maxOutputTokens: 200,
          thinkingConfig: { thinkingLevel: "minimal" }
        }
      })
    },
    timeoutMs
  );

  if (!response.ok) {
    const status = Number(response.status);
    console.error("Gemini request failed", { status, model, code: data?.error?.status });
    if (status === 401 || status === 403) throw new Error("GEMINI_KEY_REJECTED");
    if (status === 429) throw new Error("GEMINI_QUOTA");
    throw new Error("GEMINI_REQUEST_FAILED");
  }

  const candidate = data?.candidates?.[0];
  const answer = (candidate?.content?.parts || [])
    .map(part => !part.thought && typeof part.text === "string" ? part.text : "")
    .join("")
    .trim();

  if (!answer) {
    if (data?.promptFeedback?.blockReason || candidate?.finishReason === "SAFETY") throw new Error("GEMINI_BLOCKED");
    throw new Error("GEMINI_EMPTY_RESPONSE");
  }
  if (candidate?.finishReason === "MAX_TOKENS") {
    console.warn("Gemini reached the output token limit.");
  }
  return answer;
}

function errorForUser(error) {
  switch (error?.message) {
    case "MISSING_GEMINI_KEY":
      return "Сервер пока не настроен. Проверьте переменную GEMINI_API_KEY в настройках Vercel.";
    case "GEMINI_KEY_REJECTED":
      return "Не удалось подключиться к Gemini. Проверьте API-ключ в настройках Vercel.";
    case "GEMINI_QUOTA":
      return "Сейчас превышен лимит запросов к Gemini. Попробуйте немного позже.";
    case "GEMINI_BLOCKED":
      return "Я не смогла обработать этот запрос. Попробуйте спросить иначе.";
    case "TIME_BUDGET_EXHAUSTED":
    case "AbortError":
      return "Не успела подготовить ответ. Попробуйте задать вопрос ещё раз, чуть короче.";
    default:
      return "Не получилось получить ответ от нейросети. Попробуйте ещё раз чуть позже.";
  }
}

// Best-effort cloud memory when Yandex state storage is unavailable.
// Kept only in this running instance, expires after 30 minutes; never persisted to logs.
const recentSessions = new Map();
function sessionKey(body) {
  const session = body.session;
  return session?.session_id && session?.skill_id ? `${session.skill_id}:${session.session_id}` : null;
}
function remember(key, history) {
  const now = Date.now();
  for (const [id, entry] of recentSessions) if (entry.expires <= now) recentSessions.delete(id);
  if (!key) return;
  if (recentSessions.size >= 500 && !recentSessions.has(key)) recentSessions.delete(recentSessions.keys().next().value);
  recentSessions.set(key, { history: safeHistory(history), expires: now + 30 * 60 * 1000 });
}
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET") {
    // Old local bridges can poll harmlessly; no audio jobs are created anymore.
    return res.status(200).json(req.query?.bridge === "1" ? { job: null, mode: "native" } :
      { ok: true, service: "alice-gemini-serper", mode: "native", revision: "gemini-conversation-v3" });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const startedAt = Date.now();
  const remainingMs = () => TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt);
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const text = String(body.request?.command || body.request?.original_utterance || "").trim();
  const key = sessionKey(body);
  if (body.session?.new && key) recentSessions.delete(key);
  const cached = key && recentSessions.get(key);
  const history = safeHistory(Array.isArray(body.state?.session?.history) ? body.state.session.history :
    cached && cached.expires > Date.now() ? cached.history : []);
  if (!text) return res.status(200).json(aliceResponse("Привет! Gemini на связи. О чём поговорим?", false, history));
  if (/^(выход|выйти|заверши разговор|закрой навык|хватит|стоп)[.!?]*$/i.test(text)) {
    if (key) recentSessions.delete(key);
    return res.status(200).json(aliceResponse("До встречи!", true));
  }
  if (/^(забудь разговор|очисти историю|начнём заново|начнем заново)[.!?]*$/i.test(text)) {
    if (key) recentSessions.delete(key);
    return res.status(200).json(aliceResponse("Начинаем заново. О чём поговорим?"));
  }
  try {
    let searchContext = "";
    if (isSearchIntent(text) && process.env.SERPER_API_KEY) {
      searchContext = await searchWeb(text, Math.min(SERPER_TIMEOUT_MS, Math.max(0, remainingMs() - 2800)));
    }
    const answer = await askGemini(text, history, searchContext, Math.min(GEMINI_TIMEOUT_MS, remainingMs() - 200));
    const spoken = fitAliceText(answer);
    console.info("Gemini conversation completed", { durationMs: Date.now() - startedAt });
    const nextHistory = [...history, { role: "user", text }, { role: "model", text: spoken }];
    remember(key, nextHistory);
    return res.status(200).json(aliceResponse(spoken, false, nextHistory));
  } catch (error) {
    const safeError = error?.name === "AbortError" ? new Error("TIME_BUDGET_EXHAUSTED") : error;
    console.warn("Gemini conversation fallback", { reason: safeError?.message, durationMs: Date.now() - startedAt });
    return res.status(200).json(aliceResponse(errorForUser(safeError), false, history));
  }
}
export { aliceResponse, safeHistory };
