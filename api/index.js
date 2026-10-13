import { waitUntil } from "@vercel/functions";
import { createHmac } from "node:crypto";

const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const SKILL_ID = "74dc5f73-86f3-4269-b170-2b3aaa07f0f9";
const VOICE_ID = "a03438d6fdf34d61b72f0ec0d443a0af";
const SOUNDS_URL = `https://dialogs.yandex.net/api/v1/skills/${SKILL_ID}/sounds`;
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_ALICE_TEXT = 1024;
const TOTAL_RESPONSE_BUDGET_MS = 4000;
const SERPER_TIMEOUT_MS = 600;
const GEMINI_TIMEOUT_MS = 3400;

const SYSTEM_PROMPT = [
  "Ты — полезный голосовой помощник в навыке Яндекс Алисы.",
  "Отвечай естественно, по-русски, кратко и так, чтобы ответ было удобно слушать.",
  "Обычно используй 1–3 коротких предложения. Не используй Markdown, таблицы, списки с символами или длинные вступления.",
  "Если вопрос требует актуальных данных и переданы результаты поиска, опирайся на них; не выдумывай отсутствующие факты.",
  "Если не знаешь ответа, честно скажи об этом."
].join(" ");

function aliceResponse(text, endSession = false, history = []) {
  return {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: endSession
    },
    session_state: { history }
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
  return history
    .filter(item => item && (item.role === "user" || item.role === "model") && typeof item.text === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({ role: item.role, text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS) }));
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
        generationConfig: {
          temperature: 0.5,
          maxOutputTokens: 240
        }
      })
    },
    timeoutMs
  );

  if (!response.ok) {
    const status = Number(response.status);
    console.error("Gemini request failed with HTTP", status);
    if (status === 401 || status === 403) throw new Error("GEMINI_KEY_REJECTED");
    if (status === 429) throw new Error("GEMINI_QUOTA");
    throw new Error("GEMINI_REQUEST_FAILED");
  }

  const candidate = data?.candidates?.[0];
  const answer = (candidate?.content?.parts || [])
    .map(part => typeof part.text === "string" ? part.text : "")
    .join("")
    .trim();

  if (!answer) {
    if (data?.promptFeedback?.blockReason) throw new Error("GEMINI_BLOCKED");
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

function sessionPrefix(sessionId) {
  return "jarvis-" + createHmac("sha256", process.env.YANDEX_DIALOGS_TOKEN)
    .update(sessionId).digest("hex").slice(0, 24) + "-";
}

function silentWav() {
  const b = Buffer.alloc(2044);
  b.write("RIFF"); b.writeUInt32LE(b.length - 8, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36);
  b.writeUInt32LE(b.length - 44, 40);
  return b;
}

async function uploadSound(bytes, name, timeout = 5000, retries = 0) {
  const form = new FormData();
  form.append("file", new Blob([bytes]), name);
  const { response, data } = await fetchJson(SOUNDS_URL, {
    method: "POST", headers: { Authorization: `OAuth ${process.env.YANDEX_DIALOGS_TOKEN}` }, body: form
  }, timeout);
  if (response.status === 429 && retries > 0) {
    const retryAfter = Number(response.headers.get("retry-after"));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(5000, retryAfter * 1000) : 2000;
    await new Promise(resolve => setTimeout(resolve, delay));
    return uploadSound(bytes, name, timeout, retries - 1);
  }
  if (!response.ok || !data.sound?.id) throw new Error(`YANDEX_AUDIO_HTTP_${response.status}`);
  return data.sound;
}

async function createVoiceJob(text, history, name) {
  let stage = "GEMINI";
  const started = Date.now();
  try {
    let context = "";
    if (isSearchIntent(text) && process.env.SERPER_API_KEY) context = await searchWeb(text, 600);
    const answer = /^(проверка голоса|проверь голос)$/i.test(text)
      ? "К вашим услугам, сэр. Джарвис на связи. Готов помочь с вашим вопросом."
      : fitAliceText(await askGemini(text, history, context, 25000));
    console.info("Jarvis stage complete", { stage, elapsedMs: Date.now() - started });
    stage = "FISH";
    const audio = await fetch("https://api.fish.audio/v1/tts", {
      method: "POST", signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${process.env.FISH_API_KEY}`, "Content-Type": "application/json", model: "s2.1-pro-free" },
      body: JSON.stringify({ text: answer, reference_id: VOICE_ID, format: "mp3", latency: "balanced" })
    });
    if (!audio.ok) throw new Error(`FISH_HTTP_${audio.status}`);
    const bytes = await audio.arrayBuffer();
    console.info("Jarvis stage complete", { stage, elapsedMs: Date.now() - started, bytes: bytes.byteLength });
    stage = "YANDEX_UPLOAD";
    if (!bytes.byteLength || bytes.byteLength > 5 * 1024 * 1024) throw new Error("VOICE_SIZE_INVALID");
    await uploadSound(bytes, `${name}ready.mp3`, 3000, 2);
    console.info("Jarvis audio uploaded");
  } catch (error) {
    const code = /^(FISH_HTTP_\d+|YANDEX_AUDIO_HTTP_\d+|GEMINI_[A-Z_]+|VOICE_SIZE_INVALID)$/.test(error.message)
      ? error.message : `${stage}_${error.name === "AbortError" || error.name === "TimeoutError" ? "TIMEOUT" : "NETWORK_ERROR"}`;
    console.warn("Jarvis background response failed:", code);
    // Persist a small status marker in the same resource store as the audio.
    // It is never played. No conversation text or account identifiers in filenames.
    await uploadSound(silentWav(), `${name}error-${code}.wav`).catch(() => {});
  }
}

function selectLatestVoiceJob(sounds, prefix) {
  const own = sounds.filter(s => typeof s.originalName === "string" && s.originalName.startsWith(prefix));
  const latest = own.map(s => s.originalName.slice(prefix.length, prefix.length + 13))
    .filter(s => /^\d{13}$/.test(s)).sort().at(-1);
  return latest ? own.filter(s => s.originalName.startsWith(prefix + latest + "-")) : [];
}

async function readVoiceJob(sessionId) {
  const { response, data } = await fetchJson(SOUNDS_URL, {
    headers: { Authorization: `OAuth ${process.env.YANDEX_DIALOGS_TOKEN}` }
  }, 2500);
  if (!response.ok) throw new Error("VOICE_STATUS_UNAVAILABLE");
  const files = selectLatestVoiceJob(Array.isArray(data.sounds) ? data.sounds : [], sessionPrefix(sessionId));
  const failed = files.find(s => s.originalName.includes("-error-"));
  if (failed) {
    const text = failed.originalName.includes("FISH_HTTP_402")
      ? "Сервис озвучки запросил оплату. Бесплатный голос сейчас недоступен."
      : "Не удалось подготовить озвученный ответ, сэр. Попробуйте задать вопрос ещё раз.";
    return aliceResponse(text);
  }
  const ready = files.find(s => s.originalName.endsWith("-ready.mp3") && s.isProcessed && !s.error);
  if (ready && /^[a-f0-9-]{36}$/i.test(ready.id)) {
    const result = aliceResponse("Ответ Джарвиса готов.");
    result.response.tts = `<speaker audio="dialogs-upload/${SKILL_ID}/${ready.id}.opus">`;
    return result;
  }
  return aliceResponse("Ответ ещё готовится, сэр. Через несколько секунд скажите: готово.");
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-gemini-serper",
      message: "Webhook is ready. Yandex Dialogs should send POST requests to /api."
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const startedAt = Date.now();
  const remainingMs = () => TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt);
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const text = String(body?.request?.command || body?.request?.original_utterance || "").trim();
  const oldHistory = safeHistory(body?.state?.session?.history);

  if (!text) {
    return res.status(200).json(aliceResponse(
      "Привет! Я могу ответить на вопрос или найти актуальную информацию. Что хочешь узнать?",
      false,
      oldHistory
    ));
  }

  if (process.env.FISH_API_KEY && process.env.YANDEX_DIALOGS_TOKEN) {
    const sessionId = body.session?.session_id;
    if (!sessionId || body.session?.skill_id !== SKILL_ID) {
      return res.status(200).json(aliceResponse("Запустите навык через Алису, сэр."));
    }
    try {
      if (/^(готово|готов|ответ|продолжай|дальше|да|повтори)[.!?\s]*$/i.test(text)) {
        return res.status(200).json(await readVoiceJob(sessionId));
      }
      const name = sessionPrefix(sessionId) + Date.now() + "-";
      // A durable pending marker prevents a later request from replaying an older answer.
      await uploadSound(silentWav(), `${name}pending.wav`, 1800);
      waitUntil(createVoiceJob(text, oldHistory, name));
      return res.status(200).json(aliceResponse("Готовлю ответ, сэр. Через несколько секунд скажите: готово."));
    } catch (error) {
      console.warn("Jarvis request failed:", error.name === "AbortError" ? "TIMEOUT" : error.message);
      return res.status(200).json(aliceResponse("Не удалось связаться с сервисом озвучки. Попробуйте ещё раз, сэр."));
    }
  }

  try {
    let searchContext = "";
    if (isSearchIntent(text) && process.env.SERPER_API_KEY) {
      // Search has a very short budget because Alice expects a response within 4.5 seconds.
      searchContext = await searchWeb(text, Math.min(SERPER_TIMEOUT_MS, Math.max(0, remainingMs() - 2600)));
    }

    const answer = await askGemini(
      text,
      oldHistory,
      searchContext,
      Math.max(0, Math.min(GEMINI_TIMEOUT_MS, remainingMs() - 600))
    );

    const history = [
      ...oldHistory,
      { role: "user", text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
      { role: "model", text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS) }
    ].slice(-MAX_HISTORY_MESSAGES);

    return res.status(200).json(aliceResponse(answer, false, history));
  } catch (error) {
    const safeError = error?.name === "AbortError" ? new Error("TIME_BUDGET_EXHAUSTED") : error;
    console.warn("Alice webhook returned a fallback response:", safeError?.message || "unknown error");
    return res.status(200).json(aliceResponse(errorForUser(safeError), false, oldHistory));
  }
}

export { aliceResponse, fitAliceText, isSearchIntent, safeHistory, selectLatestVoiceJob };
