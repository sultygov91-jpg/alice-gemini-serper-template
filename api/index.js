import { waitUntil } from "@vercel/functions";
import { createHash, createHmac } from "node:crypto";

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
  "Ты — Джарвис, спокойный и вежливый голосовой помощник. Обращайся к собеседнику на вы; изредка говори «сэр».",
  "Отвечай естественно, по-русски, кратко и так, чтобы ответ было удобно слушать.",
  "По умолчанию отвечай одним коротким предложением, до 25 слов. Если просят подробности, используй до трёх коротких предложений. Не используй Markdown, таблицы, списки с символами или длинные вступления.",
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
    const delay = timeout <= 1300 ? 250 : Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(5000, retryAfter * 1000) : 2000;
    await new Promise(resolve => setTimeout(resolve, delay));
    return uploadSound(bytes, name, timeout, retries - 1);
  }
  if (!response.ok || !data.sound?.id) throw new Error(`YANDEX_AUDIO_HTTP_${response.status}`);
  return data.sound;
}

async function withinDeadline(work, deadline) {
  let timer;
  try {
    return await Promise.race([work, new Promise(resolve => {
      timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
    })]);
  } finally { clearTimeout(timer); }
}

function voiceResponse(sound, text = "Ответ Джарвиса готов.") {
  if (!sound?.isProcessed || sound.error || !/^[a-f0-9-]{36}$/i.test(sound.id)) return null;
  const result = aliceResponse(text);
  result.response.tts = `<speaker audio="dialogs-upload/${SKILL_ID}/${sound.id}.opus">`;
  return result;
}

async function createVoiceJob(text, history, name, deadline = 0, pending = Promise.resolve(null)) {
  let stage = "GEMINI";
  const started = Date.now();
  try {
    let context = "";
    if (isSearchIntent(text) && process.env.SERPER_API_KEY) context = await searchWeb(text, 600);
    const answer = /^(проверка голоса|проверь голос)$/i.test(text)
      ? "К вашим услугам, сэр. Джарвис на связи. Готов помочь с вашим вопросом."
      : fitAliceText(await askGemini(text, history, context, 25000));
    console.info("Jarvis stage complete", { stage, elapsedMs: Date.now() - started });
    const pendingError = await pending;
    if (pendingError) throw pendingError;
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
    let sound = await uploadSound(bytes, `${name}ready.mp3`, 3000, 2);
    console.info("Jarvis audio uploaded", { elapsedMs: Date.now() - started });
    while (!sound.isProcessed && !sound.error && deadline - Date.now() > 350) {
      await new Promise(resolve => setTimeout(resolve, 200));
      const status = await fetchJson(`${SOUNDS_URL}/${sound.id}`, {
        headers: { Authorization: `OAuth ${process.env.YANDEX_DIALOGS_TOKEN}` }
      }, Math.max(100, deadline - Date.now())).catch(() => null);
      if (!status?.response.ok) break;
      sound = status.data.sound || sound;
    }
    return voiceResponse(sound, answer);
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
  let response, data;
  for (let attempt = 0; attempt < 2; attempt++) {
    ({ response, data } = await fetchJson(SOUNDS_URL, {
      headers: { Authorization: `OAuth ${process.env.YANDEX_DIALOGS_TOKEN}` }
    }, 1300));
    if (response.status !== 429 && response.status < 500) break;
    if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!response.ok) {
    console.warn("Jarvis status failed", { status: response.status });
    return aliceResponse("Яндекс пока не отдаёт готовую запись, сэр. Попробуйте сказать «готово» немного позже.");
  }
  const files = selectLatestVoiceJob(Array.isArray(data.sounds) ? data.sounds : [], sessionPrefix(sessionId));
  const failed = files.find(s => s.originalName.includes("-error-"));
  if (failed) {
    const text = failed.originalName.includes("GEMINI_")
      ? "Не удалось получить ответ Gemini, сэр. Попробуйте задать вопрос ещё раз."
      : failed.originalName.includes("FISH_HTTP_402")
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
  if (!files.length) return aliceResponse("У меня пока нет вопроса в этом разговоре, сэр. Задайте его.");
  if (files.some(s => s.originalName.endsWith("-ready.mp3") && s.error)) {
    return aliceResponse("Яндекс не смог обработать запись, сэр. Задайте вопрос ещё раз.");
  }
  const createdAt = Number(files[0].originalName.slice(sessionPrefix(sessionId).length, sessionPrefix(sessionId).length + 13));
  if (Date.now() - createdAt > 120000) return aliceResponse("Подготовка ответа прервалась, сэр. Задайте вопрос ещё раз.");
  return aliceResponse("Ответ ещё готовится, сэр. Через несколько секунд скажите: готово.");
}


function deliveryCode(id) {
  return String(1000000000 + parseInt(createHmac("sha256", process.env.YANDEX_DIALOGS_TOKEN).update(id).digest("hex").slice(0, 8), 16));
}

async function deliveredVoice(text) {
  const code = text.replace(/\s/g, "");
  if (!/^\d{10}$/.test(code)) return null;
  const { response, data } = await fetchJson(SOUNDS_URL, {
    headers: { Authorization: `OAuth ${process.env.YANDEX_DIALOGS_TOKEN}` }
  }, 2600);
  if (!response.ok) return aliceResponse("Не удалось получить запись, сэр. Повторите вопрос.");
  const sound = (data.sounds || []).find(s =>
    /^auto-jarvis-[a-f0-9]{24}-\d{13}-ready\.mp3$/.test(s.originalName || "") &&
    Number(s.originalName.split("-")[3]) > Date.now() - 120000 && deliveryCode(s.id) === code);
  return voiceResponse(sound) || aliceResponse("Запись уже недоступна, сэр. Задайте вопрос ещё раз.");
}

let soundsCache = null;
let soundsCacheUntil = 0;
let soundsInFlight = null;
async function cachedSounds() {
  if (soundsCache && Date.now() < soundsCacheUntil) return soundsCache;
  if (soundsInFlight) return soundsInFlight;
  soundsInFlight = fetchJson(SOUNDS_URL, {
    headers: { Authorization: `OAuth ${process.env.YANDEX_DIALOGS_TOKEN}` }
  }, 5000).then(result => {
    soundsCache = result;
    const retry = Number(result.response.headers.get("retry-after"));
    soundsCacheUntil = Date.now() + (result.response.ok ? 10000 : Math.min(60000, Math.max(15000, (retry || 30) * 1000)));
    if (!result.response.ok) console.warn("Audio store read failed", { status: result.response.status });
    return result;
  }).finally(() => { soundsInFlight = null; });
  return soundsInFlight;
}

async function bridgeStatus(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const key = String(req.headers["x-jarvis-bridge-key"] || "");
  if (createHash("sha256").update(key).digest("hex") !== "2d9fe6c51c4f33ff82b054f2de1ae8b5e600bc913f3c3de921e283c365cab9e6") {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { response, data } = await cachedSounds();
  if (!response.ok) {
    res.setHeader("Retry-After", "30");
    return res.status(503).json({ error: "Audio store unavailable", upstreamStatus: response.status });
  }
  const recent = (data.sounds || []).filter(s =>
    /^auto-jarvis-[a-f0-9]{24}-\d{13}-(pending\.wav|ready\.mp3|error-[A-Z_0-9]+\.wav)$/.test(s.originalName || "")
  ).map(s => ({ ...s, created: Number(s.originalName.split("-")[3]) }))
    .filter(s => s.created > Date.now() - 120000).sort((a,b) => b.created-a.created);
  const latest = recent[0]?.created;
  const ready = recent.find(s => s.created === latest && s.originalName.endsWith("-ready.mp3") && s.isProcessed && !s.error);
  return res.status(200).json({ job: ready ? { id: ready.id, created: ready.created,
    command: `СКАЖИ НАВЫКУ МОЙ ДЖАРВИС ${deliveryCode(ready.id)}` } : null });
}

export default async function handler(req, res) {
  if (req.method === "GET" && req.query?.bridge === "1") return bridgeStatus(req, res);
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

  if (body.session?.skill_id === SKILL_ID && process.env.YANDEX_DIALOGS_TOKEN && /^\d{10}$/.test(text.replace(/\s/g, ""))) {
    try { return res.status(200).json(await deliveredVoice(text)); }
    catch { return res.status(200).json(aliceResponse("Не удалось получить запись, сэр. Повторите вопрос.")); }
  }

  if (!text) {
    if (process.env.FISH_API_KEY && process.env.YANDEX_DIALOGS_TOKEN) {
      const greeting = aliceResponse("К вашим услугам, сэр. Джарвис на связи. Готов помочь с вашим вопросом.");
      greeting.response.tts = `<speaker audio="dialogs-upload/${SKILL_ID}/46696cac-4241-433b-a682-185293a9f52d.opus">`;
      return res.status(200).json(greeting);
    }
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

      const name = "auto-" + sessionPrefix(sessionId) + Date.now() + "-";
      waitUntil(createVoiceJob(text, oldHistory, name));
      return res.status(200).json(aliceResponse("Готовлю ответ, сэр. Он прозвучит автоматически.", false));
    } catch (error) {
      console.warn("Jarvis request failed:", error.name === "AbortError" ? "TIMEOUT" : error.message);
      return res.status(200).json(aliceResponse("Яндекс временно не принял запрос на запись, сэр. Повторите вопрос немного позже."));
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

export { aliceResponse, fitAliceText, isSearchIntent, safeHistory, selectLatestVoiceJob, withinDeadline, voiceResponse };
