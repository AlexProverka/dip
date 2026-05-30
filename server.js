const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const {
    analyzeErrorCase,
    analyzeErrorCaseWithLlm,
    getSourceStats,
    prepareEmbeddingIndex,
    searchSources
} = require("./error_analysis_agent");

// ========== НАСТРОЙКИ СЕРВЕРА ==========
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, "data");
const DB_PATH = path.join(DATA_DIR, "dialogs.sqlite");
const ALLOWED_HOST = "priem.unecon.ru";

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new DatabaseSync(DB_PATH);
initDatabase();

// Типы файлов, которые сервер отдает браузеру
const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml; charset=utf-8",
    ".png": "image/png"
};

const ADMISSION_CACHE_TTL = 5 * 60 * 1000;
const ADMISSION_FETCH_TIMEOUT_MS = 30 * 1000;
const admissionListCache = new Map();

// ========== ОСНОВНОЙ HTTP-СЕРВЕР ==========
const server = http.createServer(async (req, res) => {
    try {
        setBaseHeaders(res);

        // Ответ на предварительный CORS-запрос браузера
        if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
        }

        const requestUrl = new URL(req.url, `http://${req.headers.host}`);

        // Проверка, что сервер жив и готов отдавать приложение
        if (requestUrl.pathname === "/api/health") {
            sendJson(res, 200, {
                ok: true,
                app: "ГЭУ Диалог",
                port: PORT,
                time: new Date().toISOString()
            });
            return;
        }

        // API для хранения диалогов, сообщений и оценок в SQLite
        if (requestUrl.pathname.startsWith("/api/")) {
            const handled = await handleAppApi(req, requestUrl, res);
            if (handled) return;
        }

        // Отдельный маршрут для загрузки конкурсных списков
        if (requestUrl.pathname === "/api/admission-list") {
            await handleAdmissionListProxy(requestUrl, res);
            return;
        }

        // Все остальные запросы считаются обычными файлами интерфейса
        serveStaticFile(requestUrl.pathname, res);
    } catch (error) {
        console.error(`Ошибка ${req.method} ${req.url}:`, error);
        sendJson(res, 500, { error: "Внутренняя ошибка сервера", details: error.message });
    }
});

// ========== БАЗА ДАННЫХ ДИАЛОГОВ ==========
function initDatabase() {
    db.exec(`
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS chats (
            id TEXT PRIMARY KEY,
            user_id TEXT,
            title TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            chat_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            meta_json TEXT NOT NULL DEFAULT '{}',
            timestamp INTEGER NOT NULL,
            FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS reviews (
            id TEXT PRIMARY KEY,
            message_id TEXT,
            chat_id TEXT,
            question TEXT NOT NULL,
            bot_answer TEXT NOT NULL,
            rating TEXT NOT NULL,
            correct_answer TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL DEFAULT '',
            source_details_json TEXT NOT NULL DEFAULT '[]',
            answer_meta_json TEXT NOT NULL DEFAULT '{}',
            analysis_json TEXT,
            error_reason TEXT NOT NULL DEFAULT '',
            suggested_source TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL
        );
    `);
}

async function handleAppApi(req, requestUrl, res) {
    const pathname = requestUrl.pathname;

    if (pathname === "/api/state" && req.method === "GET") {
        sendJson(res, 200, getDatabaseState());
        return true;
    }

    if (pathname === "/api/state/import" && req.method === "POST") {
        const payload = await readRequestJson(req);
        importStateToDatabase(payload);
        sendJson(res, 200, getDatabaseState());
        return true;
    }

    if (pathname === "/api/chats" && req.method === "POST") {
        const chat = await readRequestJson(req);
        upsertChat(chat);
        sendJson(res, 200, { ok: true });
        return true;
    }

    const chatMatch = pathname.match(/^\/api\/chats\/([^/]+)$/);
    if (chatMatch && req.method === "PUT") {
        const chat = await readRequestJson(req);
        upsertChat({ ...chat, id: decodeURIComponent(chatMatch[1]) });
        sendJson(res, 200, { ok: true });
        return true;
    }

    if (chatMatch && req.method === "DELETE") {
        deleteChatFromDatabase(decodeURIComponent(chatMatch[1]));
        sendJson(res, 200, { ok: true });
        return true;
    }

    const messagesMatch = pathname.match(/^\/api\/chats\/([^/]+)\/messages$/);
    if (messagesMatch && req.method === "POST") {
        const payload = await readRequestJson(req);
        const chatId = decodeURIComponent(messagesMatch[1]);
        if (payload.chat) upsertChat(payload.chat);
        else upsertChat({ id: chatId, title: "Новый диалог" });
        upsertMessage(chatId, payload.message);
        sendJson(res, 200, { ok: true });
        return true;
    }

    if (messagesMatch && req.method === "DELETE") {
        clearChatMessagesInDatabase(decodeURIComponent(messagesMatch[1]));
        const payload = await readRequestJson(req);
        if (payload.chat) upsertChat(payload.chat);
        sendJson(res, 200, { ok: true });
        return true;
    }

    if (pathname === "/api/reviews" && req.method === "GET") {
        sendJson(res, 200, { reviews: getReviewsFromDatabase() });
        return true;
    }

    if (pathname === "/api/reviews" && req.method === "POST") {
        const review = await readRequestJson(req);
        upsertReview(review);
        sendJson(res, 200, { ok: true });
        return true;
    }

    if (pathname === "/api/source-search" && req.method === "POST") {
        const payload = await readRequestJson(req);
        sendJson(res, 200, {
            query: payload.query || "",
            topK: Number(payload.topK || 5),
            sources: await searchSources(payload.query || "", payload.topK || 5),
            stats: getSourceStats()
        });
        return true;
    }

    if (pathname === "/api/error-analysis" && req.method === "POST") {
        const payload = await readRequestJson(req);
        const analysis = await analyzeErrorCaseWithLlm({
            question: payload.question || "",
            agentAnswer: payload.agentAnswer || "",
            agentSources: payload.agentSources || [],
            adminAnswer: payload.adminAnswer || payload.correctAnswer || "",
            topK: payload.topK || 5
        });

        sendJson(res, 200, { analysis, stats: getSourceStats() });
        return true;
    }

    return false;
}

function getDatabaseState() {
    const chats = db.prepare(`
        SELECT id, user_id AS userId, title, created_at AS createdAt, updated_at AS updatedAt
        FROM chats
        ORDER BY updated_at DESC
    `).all();

    const messages = db.prepare(`
        SELECT id, chat_id AS chatId, role, content, meta_json AS metaJson, timestamp
        FROM messages
        ORDER BY timestamp ASC
    `).all();

    const messagesByChat = groupBy(messages, item => item.chatId);

    return {
        chats: chats.map(chat => ({
            id: chat.id,
            userId: chat.userId || null,
            title: chat.title,
            messages: (messagesByChat[chat.id] || []).map(message => ({
                id: message.id,
                role: message.role,
                content: message.content,
                meta: parseJson(message.metaJson, {}),
                timestamp: message.timestamp
            })),
            createdAt: chat.createdAt,
            updatedAt: chat.updatedAt
        })),
        reviews: getReviewsFromDatabase()
    };
}

function getReviewsFromDatabase() {
    return db.prepare(`
        SELECT
            id,
            message_id AS messageId,
            chat_id AS chatId,
            question,
            bot_answer AS botAnswer,
            rating,
            correct_answer AS correctAnswer,
            source,
            source_details_json AS sourceDetailsJson,
            answer_meta_json AS answerMetaJson,
            analysis_json AS analysisJson,
            error_reason AS errorReason,
            suggested_source AS suggestedSource,
            created_at AS createdAt
        FROM reviews
        ORDER BY created_at DESC
    `).all().map(review => ({
        id: review.id,
        messageId: review.messageId,
        chatId: review.chatId,
        question: review.question,
        botAnswer: review.botAnswer,
        rating: review.rating,
        correctAnswer: review.correctAnswer,
        source: review.source,
        sourceDetails: parseJson(review.sourceDetailsJson, []),
        answerMeta: parseJson(review.answerMetaJson, {}),
        analysis: parseJson(review.analysisJson, null),
        errorReason: review.errorReason,
        suggestedSource: review.suggestedSource,
        createdAt: review.createdAt
    }));
}

function importStateToDatabase(payload = {}) {
    db.exec("BEGIN");
    try {
        (payload.chats || []).forEach(chat => {
            upsertChat(chat);
            (chat.messages || []).forEach(message => upsertMessage(chat.id, message));
        });

        (payload.reviews || []).forEach(review => upsertReview(review));
        db.exec("COMMIT");
    } catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
}

function upsertChat(chat = {}) {
    const now = Date.now();
    db.prepare(`
        INSERT INTO chats (id, user_id, title, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            user_id = excluded.user_id,
            title = excluded.title,
            updated_at = excluded.updated_at
    `).run(
        chat.id,
        chat.userId || null,
        chat.title || "Новый диалог",
        Number(chat.createdAt || now),
        Number(chat.updatedAt || now)
    );
}

function upsertMessage(chatId, message = {}) {
    db.prepare(`
        INSERT INTO messages (id, chat_id, role, content, meta_json, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            chat_id = excluded.chat_id,
            role = excluded.role,
            content = excluded.content,
            meta_json = excluded.meta_json,
            timestamp = excluded.timestamp
    `).run(
        message.id,
        chatId,
        message.role || "assistant",
        message.content || "",
        stringifyJson(message.meta || {}),
        Number(message.timestamp || Date.now())
    );
}

function upsertReview(review = {}) {
    db.prepare(`
        INSERT INTO reviews (
            id, message_id, chat_id, question, bot_answer, rating, correct_answer,
            source, source_details_json, answer_meta_json, analysis_json,
            error_reason, suggested_source, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            message_id = excluded.message_id,
            chat_id = excluded.chat_id,
            question = excluded.question,
            bot_answer = excluded.bot_answer,
            rating = excluded.rating,
            correct_answer = excluded.correct_answer,
            source = excluded.source,
            source_details_json = excluded.source_details_json,
            answer_meta_json = excluded.answer_meta_json,
            analysis_json = excluded.analysis_json,
            error_reason = excluded.error_reason,
            suggested_source = excluded.suggested_source,
            created_at = excluded.created_at
    `).run(
        review.id,
        review.messageId || null,
        review.chatId || null,
        review.question || "",
        review.botAnswer || "",
        review.rating || "incorrect",
        review.correctAnswer || "",
        review.source || "",
        stringifyJson(review.sourceDetails || []),
        stringifyJson(review.answerMeta || {}),
        review.analysis ? stringifyJson(review.analysis) : null,
        review.errorReason || "",
        review.suggestedSource || "",
        Number(review.createdAt || Date.now())
    );
}

function deleteChatFromDatabase(chatId) {
    db.prepare("DELETE FROM chats WHERE id = ?").run(chatId);
}

function clearChatMessagesInDatabase(chatId) {
    db.prepare("DELETE FROM messages WHERE chat_id = ?").run(chatId);
    db.prepare("DELETE FROM reviews WHERE chat_id = ?").run(chatId);
}

function stringifyJson(value) {
    return JSON.stringify(value ?? null);
}

function parseJson(value, fallback) {
    try {
        if (value === null || value === undefined || value === "") return fallback;
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function groupBy(items, keyGetter) {
    return items.reduce((acc, item) => {
        const key = keyGetter(item);
        if (!acc[key]) acc[key] = [];
        acc[key].push(item);
        return acc;
    }, {});
}

function readRequestJson(req) {
    return new Promise((resolve, reject) => {
        let body = "";

        req.on("data", chunk => {
            body += chunk;
            if (body.length > 2_000_000) {
                req.destroy();
                reject(new Error("Слишком большой запрос"));
            }
        });

        req.on("end", () => {
            if (!body) {
                resolve({});
                return;
            }

            try {
                resolve(JSON.parse(body));
            } catch {
                reject(new Error("Некорректный JSON"));
            }
        });

        req.on("error", reject);
    });
}

// ========== ПРОКСИ ДЛЯ КОНКУРСНЫХ СПИСКОВ ==========
async function handleAdmissionListProxy(requestUrl, res) {
    const targetUrl = requestUrl.searchParams.get("url");

    if (!targetUrl) {
        sendJson(res, 400, { error: "Не передан параметр url" });
        return;
    }

    const parsedTarget = new URL(targetUrl);

    // Защита: разрешаем проксировать только сайт приемной комиссии
    if (parsedTarget.hostname !== ALLOWED_HOST) {
        sendJson(res, 403, { error: "Этот источник не разрешен" });
        return;
    }

    const cached = admissionListCache.get(targetUrl);
    if (cached && Date.now() - cached.createdAt < ADMISSION_CACHE_TTL) {
        res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store, no-cache, must-revalidate"
        });
        res.end(cached.html);
        return;
    }

    // Запрашиваем HTML конкурсного списка с сайта приемной комиссии
    let response;
    try {
        response = await fetch(parsedTarget, {
            signal: AbortSignal.timeout(ADMISSION_FETCH_TIMEOUT_MS),
            headers: {
                "Accept": "text/html,application/xhtml+xml",
                "User-Agent": "GEU-Dialog/1.0"
            }
        });
    } catch (error) {
        const isTimeout = error.name === "TimeoutError" || error.name === "AbortError";
        sendJson(res, isTimeout ? 504 : 502, {
            error: isTimeout
                ? "Сайт приемной комиссии слишком долго не отвечал"
                : "Не удалось загрузить сайт приемной комиссии",
            details: error.message
        });
        return;
    }

    if (!response.ok) {
        sendJson(res, response.status, { error: `Сайт приемной комиссии вернул ${response.status}` });
        return;
    }

    const html = await response.text();
    admissionListCache.set(targetUrl, {
        html,
        createdAt: Date.now()
    });

    res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate"
    });
    res.end(html);
}

// ========== РАЗДАЧА ФАЙЛОВ ИНТЕРФЕЙСА ==========
function serveStaticFile(urlPath, res) {
    const safePath = normalizeStaticPath(urlPath);
    const filePath = path.resolve(ROOT_DIR, safePath);

    // Защита от выхода за пределы папки проекта
    if (!filePath.startsWith(path.resolve(ROOT_DIR))) {
        sendJson(res, 403, { error: "Доступ запрещен" });
        return;
    }

    // Если файла нет, возвращаем понятную ошибку
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        sendJson(res, 404, { error: "Файл не найден" });
        return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
        "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
        "Cache-Control": "no-store, no-cache, must-revalidate"
    });
    fs.createReadStream(filePath).pipe(res);
}

// Преобразование URL в безопасный путь к файлу
function normalizeStaticPath(urlPath) {
    const decodedPath = decodeURIComponent(urlPath.split("?")[0]);
    const cleanPath = decodedPath === "/" ? "/index.html" : decodedPath;
    return cleanPath.replace(/^\/+/, "");
}

// Отправка JSON-ответа с ошибкой или служебным сообщением
function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
}

// Базовые заголовки для работы браузера и отключения CORS-проблем
function setBaseHeaders(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Accept, Content-Type");
}

function getLocalNetworkUrls() {
    const interfaces = os.networkInterfaces();
    const urls = [];

    Object.values(interfaces).forEach(items => {
        (items || []).forEach(item => {
            if (item.family === "IPv4" && !item.internal) {
                urls.push(`http://${item.address}:${PORT}`);
            }
        });
    });

    return urls;
}

// ========== ЗАПУСК СЕРВЕРА ==========
server.listen(PORT, HOST, () => {
    console.log(`ГЭУ Диалог запущен: http://localhost:${PORT}`);

    const networkUrls = getLocalNetworkUrls();
    if (networkUrls.length > 0) {
        console.log("Адрес для просмотра с другого устройства в этой же сети:");
        networkUrls.forEach(url => console.log(`- ${url}`));
    }

    if (process.env.EMBEDDING_PRELOAD !== "0") {
        setTimeout(() => {
            prepareEmbeddingIndex()
                .then(index => console.log(`Embedding index ready: ${index.docs.length} fragments`))
                .catch(error => console.error(`Embedding index warmup failed: ${error.message}`));
        }, 1000);
    }
});
