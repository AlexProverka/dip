// ========== МОДЕЛЬ ДАННЫХ ==========
// Структура чата:
// {
//   id: string,
//   userId: string | null,
//   title: string,
//   messages: Array<{id, role: 'user' | 'assistant', content, timestamp, meta}>,
//   createdAt: number,
//   updatedAt: number
// }

let chats = [];
let activeChatId = null;
let isLoading = false;
let currentMode = "applicant";
let staffReviews = [];
let reviewFilter = "all";

const STORAGE_KEYS = {
    legacyChats: "geu_chats",
    mode: "geu_mode",
    legacyReviews: "geu_staff_reviews"
};

const API_PROXY_URL = "http://localhost:3000/api/admission-list";
const LOCAL_SERVER_ORIGIN = "http://localhost:3000";
const ADMISSION_REQUEST_TIMEOUT_MS = 15 * 1000;
const APPLICANT_CODE_PATTERN = /(?:код(?:\s+абитуриента)?\s*[:№#-]?\s*)?(\d{4,})/i;

// ========== НАСТРОЙКИ КОНКУРСНЫХ СПИСКОВ ==========
const ADMISSION_SOURCE_URL = "https://priem.unecon.ru/stat/stat_konkurs.php?filial_kod=1&zayav_type_kod=1&obr_konkurs_kod=0&recomend_type=null&rec_status_kod=all&ob_forma_kod=1&ob_osnova_kod=1&konkurs_grp_kod=8113&prior=all&status_kod=all&is_orig_doc=all&dogovor=all&show=%D0%9F%D0%BE%D0%BA%D0%B0%D0%B7%D0%B0%D1%82%D1%8C";
let admissionListsCache = null;

const FALLBACK_ADMISSION_FORMS = [
    { code: "1", title: "очная" }
];

const FALLBACK_ADMISSION_BASES = [
    { code: "1", title: "Бюджет" },
    { code: "2", title: "Договор" }
];

const FALLBACK_ADMISSION_GROUPS = [
    { code: "8092", title: "Бизнес-информатика - Деловая аналитика" },
    { code: "8102", title: "Гостиничное дело - Организация и управление в гостиничном и ресторанном бизнесе" },
    { code: "8095", title: "Государственное и муниципальное управление - Государственное и муниципальное управление в регионе" },
    { code: "8052", title: "Менеджмент (1 группа профилей (профили: Логистика и управление цепями поставок, Маркетинг и управление брендами))" },
    { code: "8051", title: "Менеджмент (2 группа профилей (профили: Управление проектами, Управление бизнесом, Промышленный хайтек и урбанистика, Финансовый менеджмент и управление инвестициями, Международный бизнес))" },
    { code: "8113", title: "Прикладная математика и информатика (профили: Прикладная математика и информатика в экономике и управлении, Математическое обеспечение информационных систем)" },
    { code: "8099", title: "Сервис (профили: Управление креативным бизнесом, Управление и дизайн в индустрии событий)" },
    { code: "8062", title: "Торговое дело - Коммерция и электронная торговля" },
    { code: "8068", title: "Туризм (профили: Организация и управление в индустрии туризма, Национальный и международный туризм)" },
    { code: "8083", title: "Управление персоналом - Кадровый менеджмент" },
    { code: "8045", title: "Экономика" },
    { code: "8214", title: "Экономика - Экономика и управление на предприятиях нефтегазового комплекса" }
];

const FALLBACK_ADMISSION_LISTS = FALLBACK_ADMISSION_FORMS.flatMap(form =>
    FALLBACK_ADMISSION_BASES.flatMap(basis =>
        FALLBACK_ADMISSION_GROUPS.map(group => ({
            id: `${form.code}-${basis.code}-${group.code}`,
            formCode: form.code,
            formTitle: form.title,
            basisCode: basis.code,
            basisTitle: basis.title,
            groupCode: group.code,
            title: group.title,
            shortTitle: `${form.title} / ${basis.title}`,
            basis: `${form.title} / ${basis.title}`,
            url: buildAdmissionListUrl({
                groupCode: group.code,
                basisCode: basis.code,
                formCode: form.code
            })
        }))
    )
);

// ========== ЛОКАЛЬНАЯ БАЗА ЗНАНИЙ ДЛЯ ДЕМО ВЕКТОРНОГО ПОИСКА ==========
const KNOWLEDGE_BASE = [
    {
        id: "admission-lists",
        title: "Конкурсные списки",
        text: "Бот может проверить код абитуриента в конкурсных списках, показать список, тип конкурса, позицию, баллы и количество мест.",
        keywords: ["конкурс", "список", "код", "позиция", "место", "абитуриент"]
    },
    {
        id: "budget",
        title: "Бюджетные места",
        text: "Бюджетные места отображаются отдельно от договора. Внутри бюджета могут быть основные места, целевая квота, особая квота и отдельная квота.",
        keywords: ["бюджет", "бюджетные", "места", "квота", "основа"]
    },
    {
        id: "target",
        title: "Целевое обучение",
        text: "Целевая квота находится внутри бюджетного конкурса. Для нее важно показывать организацию, позицию абитуриента и количество выделенных мест.",
        keywords: ["целевое", "целевая", "целевики", "квота", "организация"]
    },
    {
        id: "staff-mode",
        title: "Режим сотрудника приемной комиссии",
        text: "Сотрудник может оценить ответ как правильный или неправильный. Если ответ неправильный, он вводит правильный ответ, а система сохраняет исправление.",
        keywords: ["сотрудник", "оценка", "правильно", "неправильно", "исправление"]
    },
    {
        id: "error-analysis-agent",
        title: "Агент анализа ошибок",
        text: "Агент анализа ошибок запускается после неправильной оценки ответа. Он сравнивает вопрос, ответ бота, правильный ответ сотрудника и источник, чтобы предположить причину ошибки.",
        keywords: ["агент", "ошибка", "ошибся", "причина", "неправильно", "исправление", "источник"]
    },
    {
        id: "seats",
        title: "Количество мест в бакалавриате",
        text: "Количество мест берется из заголовков конкурсных списков. Бот показывает места по бюджету, целевым квотам и договору для подключенной конкурсной группы.",
        keywords: ["бакалавриат", "количество", "мест", "места", "направление"]
    }
];

// Генерация URL конкурсного списка
function buildAdmissionListUrl({ groupCode, basisCode, formCode = "1" }) {
    const params = new URLSearchParams({
        filial_kod: "1",
        zayav_type_kod: "1",
        obr_konkurs_kod: "0",
        recomend_type: "null",
        rec_status_kod: "all",
        ob_forma_kod: formCode,
        ob_osnova_kod: basisCode,
        konkurs_grp_kod: groupCode,
        prior: "all",
        status_kod: "all",
        is_orig_doc: "all",
        dogovor: "all",
        show: "Показать"
    });

    return `https://priem.unecon.ru/stat/stat_konkurs.php?${params.toString()}`;
}

// Генерация уникального ID
function generateId() {
    return Date.now() + "-" + Math.random().toString(36).substr(2, 9);
}

// Форматирование даты
function formatDate(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;

    if (diff < 86400000) {
        return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    } else if (diff < 604800000) {
        return date.toLocaleDateString("ru-RU", { weekday: "short" });
    } else {
        return date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
    }
}

// Создание нового чата
function createNewChat(userId = null) {
    const id = generateId();
    const now = Date.now();

    const chat = {
        id,
        userId,
        title: "Новый диалог",
        messages: [],
        createdAt: now,
        updatedAt: now
    };

    chats.unshift(chat);
    activeChatId = id;

    saveChatToDatabase(chat);
    renderChats();
    renderMessages();
    updateActiveChatTitle();

    return chat;
}

// Обновление заголовка чата по первому сообщению
function updateChatTitle(chatId) {
    const chat = chats.find(c => c.id === chatId);
    if (!chat || chat.messages.length === 0) return;

    const firstUserMessage = chat.messages.find(m => m.role === "user");
    if (firstUserMessage) {
        let title = firstUserMessage.content;
        if (title.length > 30) title = title.substring(0, 30) + "...";
        chat.title = title;
        saveChatToDatabase(chat);
        renderChats();
        updateActiveChatTitle();
    }
}

function updateActiveChatTitle() {
    const chat = chats.find(c => c.id === activeChatId);
    const titleElement = document.getElementById("activeChatTitle");
    if (titleElement && chat) {
        titleElement.textContent = chat.title;
    }
}

// Добавление сообщения
function addMessage(role, content, meta = {}) {
    const chat = chats.find(c => c.id === activeChatId);
    if (!chat) return null;

    const message = {
        id: generateId(),
        role,
        content,
        meta,
        timestamp: Date.now()
    };

    chat.messages.push(message);
    chat.updatedAt = Date.now();

    saveMessageToDatabase(chat.id, message);
    renderMessages();

    return message;
}

// ========== ОСНОВНАЯ ОБРАБОТКА ЗАПРОСА ==========
async function callAIApi(messages, currentQuery) {
    const conversationHistory = messages.map(msg => ({
        role: msg.role,
        content: msg.content
    }));

    conversationHistory.push({
        role: "user",
        content: currentQuery
    });

    console.log("Отправка в API:", {
        messages: conversationHistory,
        chatId: activeChatId,
        mode: currentMode,
        timestamp: Date.now()
    });

    const applicantCode = extractApplicantCode(currentQuery);
    if (applicantCode) {
        return getApplicantPositions(applicantCode);
    }

    if (isSeatsQuery(currentQuery)) {
        return getSeatsInfo();
    }

    await new Promise(resolve => setTimeout(resolve, 500));
    return generateSmartResponse(currentQuery, messages);
}

// Распознавание кода абитуриента
function extractApplicantCode(query) {
    const normalizedQuery = query.replace(/\s+/g, " ").trim();
    const match = normalizedQuery.match(APPLICANT_CODE_PATTERN);
    return match ? match[1] : null;
}

function isSeatsQuery(query) {
    const lowerQuery = query.toLowerCase();
    return (
        lowerQuery.includes("мест") &&
        (lowerQuery.includes("бакалавр") || lowerQuery.includes("бюджет") || lowerQuery.includes("целев") || lowerQuery.includes("сколько"))
    );
}

// ========== ПРОВЕРКА АБИТУРИЕНТА В КОНКУРСНЫХ СПИСКАХ ==========
async function getApplicantPositions(applicantCode) {
    const admissionLists = await getAdmissionLists();
    const results = await mapWithConcurrency(admissionLists, 4, list => findApplicantInList(list, applicantCode));

    const found = [];
    const failed = [];

    results.forEach((result, index) => {
        const list = admissionLists[index];
        if (result.status === "fulfilled") {
            found.push(...result.value);
        } else {
            failed.push({
                title: `${list.shortTitle}: ${list.title}`,
                reason: result.reason?.message || "не удалось загрузить список"
            });
        }
    });

    if (found.length > 0) {
        return formatApplicantFoundResponse(applicantCode, found, failed);
    }

    return formatApplicantNotFoundResponse(applicantCode, failed, admissionLists);
}

async function getAdmissionLists() {
    if (admissionListsCache) return admissionListsCache;

    try {
        const html = await loadAdmissionListHtml(ADMISSION_SOURCE_URL);
        const documentHtml = new DOMParser().parseFromString(html, "text/html");
        const discoveredLists = discoverAdmissionLists(documentHtml);
        admissionListsCache = discoveredLists.length > 0 ? discoveredLists : FALLBACK_ADMISSION_LISTS;
    } catch (error) {
        console.warn("Не удалось получить список конкурсных групп, используется резервная настройка:", error);
        admissionListsCache = FALLBACK_ADMISSION_LISTS;
    }

    return admissionListsCache;
}

function discoverAdmissionLists(documentHtml) {
    const formOptions = extractSelectOptions(documentHtml, "ob_forma_kod").filter(option => option.value && option.value !== "null");
    const basisOptions = extractSelectOptions(documentHtml, "ob_osnova_kod").filter(option => option.value && option.value !== "null");
    const groupOptions = extractSelectOptions(documentHtml, "konkurs_grp_kod").filter(option => option.value && option.value !== "null");
    const selectedForms = formOptions.filter(option => option.selected);
    const formsToUse = selectedForms.length > 0 ? selectedForms : formOptions;
    const lists = [];

    formsToUse.forEach(form => {
        basisOptions.forEach(basis => {
            groupOptions.forEach(group => {
                lists.push({
                    id: `${form.value}-${basis.value}-${group.value}`,
                    formCode: form.value,
                    formTitle: form.text,
                    basisCode: basis.value,
                    basisTitle: basis.text,
                    groupCode: group.value,
                    title: group.text,
                    shortTitle: `${form.text} / ${basis.text}`,
                    basis: `${form.text} / ${basis.text}`,
                    url: buildAdmissionListUrl({
                        groupCode: group.value,
                        basisCode: basis.value,
                        formCode: form.value
                    })
                });
            });
        });
    });

    return lists;
}

function extractSelectOptions(documentHtml, name) {
    const select = documentHtml.querySelector(`select[name="${name}"]`);
    if (!select) return [];

    return [...select.querySelectorAll("option")].map(option => ({
        value: option.getAttribute("value") || "",
        text: normalizeCellText(option.textContent),
        selected: option.selected || option.hasAttribute("selected")
    }));
}

async function findApplicantInList(list, applicantCode) {
    const html = await loadAdmissionListHtml(list.url);
    const documentHtml = new DOMParser().parseFromString(html, "text/html");
    const sections = parseAdmissionSections(documentHtml);
    const matches = [];

    sections.forEach(section => {
        section.rows.forEach(row => {
            const hasApplicantCode = row.cells.some(cell => cell === applicantCode || cell.includes(applicantCode));
            if (!hasApplicantCode) return;

            matches.push({
                list,
                sectionTitle: section.title,
                competitionType: section.type,
                seats: section.seats,
                position: getApplicantPositionInSection(row),
                totalApplicants: section.rows.length,
                rowData: mapApplicantRow(row.cells, section.headers)
            });
        });
    });

    return matches;
}

// Парсинг таблиц и разделов конкурсного списка
function parseAdmissionSections(documentHtml) {
    return [...documentHtml.querySelectorAll("table")]
        .map(table => {
            const title = findNearestSectionTitle(table);
            const headers = extractTableHeaders(table);
            const rows = extractTableRows(table, headers.length);
            if (!isApplicantTable(headers, rows)) return null;

            return {
                title,
                type: detectCompetitionType(title),
                seats: extractSeatsCount(title),
                headers,
                rows
            };
        })
        .filter(Boolean);
}

function findNearestSectionTitle(table) {
    const textParts = [];
    let node = table.previousSibling;
    let steps = 0;

    while (node && steps < 40) {
        if (node.nodeType === Node.ELEMENT_NODE && node.tagName === "TABLE") {
            break;
        }

        const text = normalizeCellText(node.textContent || "");
        if (text) textParts.unshift(text);

        node = node.previousSibling;
        steps += 1;
    }

    const nearbyText = textParts.join(" ");
    const sectionTitle = extractSectionTitleFromText(nearbyText);
    if (sectionTitle) return sectionTitle;

    let element = table.previousElementSibling;
    while (element) {
        if (/^H[1-6]$/.test(element.tagName)) {
            return normalizeCellText(element.textContent);
        }
        element = element.previousElementSibling;
    }

    return "Конкурсный список";
}

function extractSectionTitleFromText(text) {
    const normalizedText = normalizeCellText(text);
    const patterns = [
        /ЦЕЛЕВАЯ\s+КВОТА\s*\([^)]+\)\s*\d+\s*мест[ао]?/i,
        /ЦЕЛЕВАЯ\s+КВОТА\s*\d+\s*мест[ао]?/i,
        /ОСОБАЯ\s+КВОТА\s*\d+\s*мест[ао]?/i,
        /ОТДЕЛЬНАЯ\s+КВОТА\s*\d+\s*мест[ао]?/i,
        /ОБЩИЙ\s+КОНКУРС\s*Всего:\s*\d+\s*мест[ао]?\.\s*Вакантно:\s*\d+\s*мест[ао]?/i,
        /ОБЩИЙ\s+КОНКУРС\s*\d+\s*мест[ао]?/i
    ];

    const match = patterns.map(pattern => normalizedText.match(pattern)).find(Boolean);
    return match ? normalizeCellText(match[0]) : "";
}

function extractTableHeaders(table) {
    const headerRow = table.querySelector("thead tr") || table.querySelector("tr");
    if (!headerRow) return [];

    return [...headerRow.querySelectorAll("td, th")].map(cell => normalizeCellText(cell.textContent));
}

function extractTableRows(table, headersCount) {
    const bodyRows = [...table.querySelectorAll("tbody tr")];
    const rows = bodyRows.length > 0 ? bodyRows : [...table.querySelectorAll("tr")].slice(1);

    return rows
        .map(row => ({
            cells: [...row.querySelectorAll("td, th")].map(cell => normalizeCellText(cell.textContent))
        }))
        .filter(row => row.cells.length > 0 && row.cells.length >= Math.min(headersCount, 2))
        .filter(row => !isHeaderLikeRow(row.cells, headersCount))
        .filter(row => row.cells.some(cell => /^\d{4,}$/.test(cell)));
}

function isApplicantTable(headers, rows) {
    const joinedHeaders = headers.join(" ").toLowerCase();
    return joinedHeaders.includes("код") && joinedHeaders.includes("рег") && rows.length > 0;
}

function isHeaderLikeRow(cells, headersCount) {
    const joinedCells = cells.join(" ").toLowerCase();
    return cells.length >= Math.min(headersCount, 2) && joinedCells.includes("код") && joinedCells.includes("рег");
}

function detectCompetitionType(title) {
    const lowerTitle = title.toLowerCase();
    if (lowerTitle.includes("целев")) return "Целевая квота";
    if (lowerTitle.includes("особ")) return "Особая квота";
    if (lowerTitle.includes("отдель")) return "Отдельная квота";
    if (lowerTitle.includes("договор") || lowerTitle.includes("контракт")) return "Договор";
    if (lowerTitle.includes("общий")) return "Общий конкурс";
    if (lowerTitle.includes("основ")) return "Основные места";
    return "Конкурс";
}

function extractSeatsCount(title) {
    const match = title.match(/(\d+)\s+мест/i);
    return match ? Number(match[1]) : null;
}

async function loadAdmissionListHtml(url) {
    const currentOriginProxyUrl = getCurrentOriginProxyUrl();
    const proxyUrls = currentOriginProxyUrl ? [currentOriginProxyUrl] : [API_PROXY_URL];
    const requestUrls = [...new Set(proxyUrls)]
        .map(proxyUrl => `${proxyUrl}?url=${encodeURIComponent(url)}`);

    let lastError = null;

    for (const requestUrl of requestUrls) {
        try {
            const response = await fetchWithTimeout(requestUrl, {
                cache: "no-store",
                headers: { "Accept": "text/html,application/xhtml+xml" }
            }, ADMISSION_REQUEST_TIMEOUT_MS);

            if (!response.ok) {
                throw new Error(`сервер вернул ${response.status}`);
            }

            return response.text();
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError || new Error("серверный прокси не настроен");
}

function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    return fetch(url, {
        ...options,
        signal: controller.signal
    }).finally(() => clearTimeout(timeoutId));
}

function getCurrentOriginProxyUrl() {
    if (window.location.protocol === "http:" || window.location.protocol === "https:") {
        return `${window.location.origin}/api/admission-list`;
    }

    return null;
}

function normalizeCellText(value) {
    return value.replace(/\s+/g, " ").trim();
}

function getApplicantPositionInSection(row) {
    const numberedCell = row.cells.find(cell => /^\d+$/.test(cell));
    return numberedCell ? Number(numberedCell) : null;
}

function mapApplicantRow(cells, headers) {
    const data = {};

    cells.forEach((cell, index) => {
        const header = headers[index] || `Колонка ${index + 1}`;
        data[header] = cell;
    });

    return data;
}

function pickRowValue(rowData, patterns) {
    const entry = Object.entries(rowData).find(([key]) =>
        patterns.some(pattern => pattern.test(key))
    );

    return entry?.[1] || null;
}

function formatApplicantFoundResponse(applicantCode, positions, failedLists) {
    const lines = [
        `Код абитуриента ${applicantCode} найден в конкурсных списках.`,
        ""
    ];

    const grouped = groupBy(positions, item => item.list.basis);

    Object.entries(grouped).forEach(([basis, items]) => {
        lines.push(`${basis}:`);
        items.forEach((positionInfo, index) => {
            const { list, sectionTitle, competitionType, seats, position, totalApplicants, rowData } = positionInfo;
            const score = pickRowValue(rowData, [/балл/i, /сумма/i]);
            const priority = pickRowValue(rowData, [/пр-т/i, /приоритет/i]);
            const status = pickRowValue(rowData, [/статус/i, /состояние/i]);
            const original = pickRowValue(rowData, [/согласие/i, /оригинал/i, /документ/i]);
            const organization = pickRowValue(rowData, [/организация/i]);

            lines.push(`${index + 1}. ${list.title}`);
            lines.push(`Вариант: ${competitionType}`);
            lines.push(`Раздел: ${sectionTitle}`);
            lines.push(`Позиция: ${position || "не определена"} из ${totalApplicants}`);
            if (seats !== null) lines.push(`Количество мест в разделе: ${seats}`);
            if (score) lines.push(`Баллы: ${score}`);
            if (priority) lines.push(`Приоритет: ${priority}`);
            if (organization) lines.push(`Целевая организация: ${organization}`);
            if (status) lines.push(`Статус: ${status}`);
            if (original) lines.push(`Согласие/документ: ${original}`);
            lines.push("");
        });
    });

    if (failedLists.length > 0) {
        lines.push("Часть списков сейчас не удалось проверить:");
        failedLists.forEach(item => lines.push(`- ${item.title}: ${item.reason}`));
        lines.push("");
    }

    lines.push("Источник: открытые конкурсные списки приемной комиссии.");

    return {
        content: lines.join("\n").trim(),
        meta: {
            answerType: "applicant-search",
            source: "Конкурсные списки priem.unecon.ru",
            sourceDetails: positions.map(item => `${item.list.shortTitle}: ${item.sectionTitle}`),
            diagnostic: "Ответ получен парсером HTML-таблиц конкурсных списков."
        }
    };
}

function formatApplicantNotFoundResponse(applicantCode, failedLists, admissionLists) {
    const allListsFailed = failedLists.length === admissionLists.length;

    const content = allListsFailed
        ? [
            `Я распознал код абитуриента ${applicantCode}, но не смог загрузить конкурсные списки.`,
            "",
            "Проверьте, что приложение открыто через локальный сервер или публичную ссылку туннеля, а server.js запущен.",
            "После запуска серверного прокси бот сможет вернуть позиции по подключенным спискам."
        ].join("\n")
        : [
            `Код абитуриента ${applicantCode} не найден в ${admissionLists.length} подключенных конкурсных списках.`,
            "",
            "Проверялись все конкурсные группы, формы и основы обучения, найденные на странице приемной комиссии."
        ].join("\n");

    return {
        content,
        meta: {
            answerType: "applicant-search",
            source: "Конкурсные списки priem.unecon.ru",
            diagnostic: allListsFailed ? "Списки не загрузились через прокси." : "Списки загрузились, но код не найден."
        }
    };
}

// ========== ИНФОРМАЦИЯ О КОЛИЧЕСТВЕ МЕСТ ==========
async function getSeatsInfo() {
    const admissionLists = await getAdmissionLists();
    const results = await mapWithConcurrency(
        admissionLists,
        4,
        async list => {
            const html = await loadAdmissionListHtml(list.url);
            const documentHtml = new DOMParser().parseFromString(html, "text/html");
            const sections = parseAdmissionSections(documentHtml);
            return { list, sections };
        }
    );

    const lines = [`По странице приемной комиссии найдено ${admissionLists.length} конкурсных списков. Места по ним:`, ""];
    const sources = [];

    results.forEach((result, index) => {
        const list = admissionLists[index];
        if (result.status === "rejected") {
            lines.push(`${list.shortTitle}: список не загрузился (${result.reason?.message || "ошибка"}).`);
            return;
        }

        const sectionsWithSeats = result.value.sections.filter(section => section.seats !== null);
        if (sectionsWithSeats.length === 0) return;

        lines.push(`${result.value.list.shortTitle} — ${result.value.list.title}:`);
        sectionsWithSeats.forEach(section => lines.push(`- ${section.type}: ${section.seats} мест`));
        lines.push("");
        sources.push(`${list.shortTitle}: ${list.title}`);
    });

    lines.push("Источник: заголовки разделов конкурсных списков приемной комиссии.");

    return {
        content: lines.join("\n").trim(),
        meta: {
            answerType: "seats-info",
            source: "Конкурсные списки priem.unecon.ru",
            sourceDetails: sources,
            diagnostic: "Количество мест извлечено из заголовков разделов списков."
        }
    };
}

// ========== ОТВЕТЫ ПО БАЗЕ ЗНАНИЙ ==========
function generateSmartResponse(query, history) {
    const lowerQuery = query.toLowerCase();
    const source = findKnowledgeSource(query);

    if (lowerQuery.includes("привет") || lowerQuery.includes("здравствуй")) {
        return buildKnowledgeReply(
            "Здравствуйте! Я ассистент приемной комиссии ГЭУ. Могу подсказать по поступлению, конкурсным спискам и проверке кода абитуриента.",
            source
        );
    }

    if (lowerQuery.includes("что ты умеешь") || lowerQuery.includes("функции")) {
        return buildKnowledgeReply(
            "Я могу отвечать на вопросы о поступлении, проверять код абитуриента в конкурсных списках, показывать бюджетные и целевые варианты, а в режиме сотрудника сохранять оценку ответа.",
            source
        );
    }

    if ((lowerQuery.includes("сотрудник") || lowerQuery.includes("режим")) && !lowerQuery.includes("агент") && !lowerQuery.includes("ошиб")) {
        return buildKnowledgeReply(
            "В режиме сотрудника после каждого ответа появляются кнопки «Правильно» и «Неправильно». Если ответ неправильный, можно ввести правильный вариант, и он сохранится в журнале проверок.",
            source
        );
    }

    if (lowerQuery.includes("агент") || lowerQuery.includes("ошиб")) {
        return buildKnowledgeReply(
            "Агент анализа ошибок работает после оценки «Неправильно»: он берет вопрос, ответ бота, правильный ответ сотрудника и источник ответа, а затем предполагает причину ошибки и предлагает, что улучшить.",
            source
        );
    }

    if (lowerQuery.includes("целев")) {
        return buildKnowledgeReply(
            "Целевое обучение отображается как отдельные разделы внутри бюджетного конкурса. Для найденного абитуриента бот показывает целевую организацию, позицию, баллы и количество мест в разделе.",
            source
        );
    }

    if (lowerQuery.includes("бюджет")) {
        return buildKnowledgeReply(
            "Бюджетный конкурс проверяется отдельно от договора. Внутри бюджета могут быть основные места, целевая квота, особая квота и отдельная квота.",
            source
        );
    }

    if (lowerQuery.includes("поступление") || lowerQuery.includes("экзамен") || lowerQuery.includes("прием")) {
        return buildKnowledgeReply(
            "По поступлению бот может подсказать общую информацию, а точные конкурсные данные лучше проверять по коду абитуриента или по подключенным спискам приемной комиссии.",
            source
        );
    }

    if (lowerQuery.includes("спасибо")) {
        return buildKnowledgeReply("Пожалуйста! Если нужно, могу проверить код абитуриента или показать данные по местам.", source);
    }

    return buildKnowledgeReply(
        `Я принял вопрос: «${query.substring(0, 80)}». Сейчас в прототипе я лучше всего работаю с конкурсными списками, бюджетом, целевым обучением и режимом проверки ответов сотрудником.`,
        source
    );
}

function buildKnowledgeReply(content, source) {
    const isStaff = currentMode === "staff";
    const finalContent = isStaff
        ? `${content}\n\nИсточник для проверки: ${source.title}.\nДиагностика: ответ выбран по совпадению ключевых слов с локальной базой знаний.`
        : content;

    return {
        content: finalContent,
        meta: {
            answerType: "knowledge",
            source: source.title,
            sourceDetails: [source.id],
            diagnostic: "Локальный поиск по базе знаний. В будущем этот блок можно заменить на готовую ИИ-модель и векторный поиск."
        }
    };
}

function findKnowledgeSource(query) {
    const words = query.toLowerCase().split(/[^а-яa-z0-9]+/i).filter(Boolean);
    let bestSource = KNOWLEDGE_BASE[0];
    let bestScore = -1;

    KNOWLEDGE_BASE.forEach(source => {
        const score = source.keywords.reduce((sum, keyword) => {
            return sum + (words.some(word => keyword.includes(word) || word.includes(keyword)) ? 1 : 0);
        }, 0);

        if (score > bestScore) {
            bestScore = score;
            bestSource = source;
        }
    });

    return bestSource;
}

// Источник для исправления ищется по правильному ответу сотрудника
function findCorrectionSource(question, correctAnswer, answerMeta = {}) {
    const combinedText = `${question || ""} ${correctAnswer || ""}`.toLowerCase();
    const isAdmissionCorrection = (
        answerMeta.answerType === "applicant-search" ||
        answerMeta.answerType === "seats-info" ||
        extractApplicantCode(combinedText) ||
        containsAnyText(combinedText, ["конкурс", "спис", "позици", "мест", "бюджет", "целев", "квот", "договор"])
    );

    if (isAdmissionCorrection) {
        return {
            id: "admission-lists",
            title: "Конкурсные списки priem.unecon.ru",
            diagnostic: "Источник выбран по словам из исправления сотрудника: конкурс, список, позиция, место, бюджет, целевое или договор."
        };
    }

    const localSource = findKnowledgeSource(`${question || ""} ${correctAnswer || ""}`);
    return {
        ...localSource,
        diagnostic: "Источник выбран по совпадению исправления с локальной базой знаний."
    };
}

// Агент анализа ошибок объясняет, почему ответ мог оказаться неправильным
function analyzeWrongAnswer({ question, answerMessage, correctAnswer, correctionSource }) {
    const answerMeta = answerMessage.meta || {};
    const answerSource = answerMeta.source || "";
    const answerType = answerMeta.answerType || "unknown";
    const botAnswer = answerMessage.content || "";
    const answerLower = botAnswer.toLowerCase();
    const questionLower = (question || "").toLowerCase();
    const correctionLower = (correctAnswer || "").toLowerCase();
    const evidence = [];

    if (!answerSource || answerSource === "Источник не указан") {
        evidence.push("В сохраненном ответе нет источника.");
        return buildErrorAnalysis(
            "missing-source",
            "Не указан источник",
            "Система не может надежно объяснить ответ, потому что рядом с ним не сохранен источник данных.",
            "Добавить к ответу источник и диагностическое пояснение, откуда он был получен.",
            evidence,
            correctionSource?.title || ""
        );
    }

    if (answerType === "error") {
        evidence.push("Ответ был системной ошибкой, а не нормальным ответом ассистента.");
        return buildErrorAnalysis(
            "system-error",
            "Системная ошибка",
            "Бот не дошел до нормальной обработки вопроса и вернул сообщение об ошибке.",
            "Проверить ошибку в консоли и повторить вопрос после исправления причины сбоя.",
            evidence,
            correctionSource?.title || answerSource
        );
    }

    if (answerType === "applicant-search" || answerType === "seats-info") {
        if (containsAnyText(answerLower, ["не смог загрузить", "списки не загруз", "прокси"])) {
            evidence.push("В ответе написано, что конкурсные списки не загрузились.");
            return buildErrorAnalysis(
                "parser-load-error",
                "Парсер не получил данные",
                "Ошибка возникла не в логике ответа, а на этапе загрузки конкурсных списков через серверный прокси.",
                "Проверить запуск server.js, доступность priem.unecon.ru и работу маршрута /api/admission-list.",
                evidence,
                "Конкурсные списки priem.unecon.ru"
            );
        }

        if (containsAnyText(answerLower, ["не найден"]) && containsAnyText(correctionLower, ["найден", "позици", "мест", "квот", "бюджет", "договор"])) {
            evidence.push("Бот написал, что абитуриент не найден, а сотрудник указал данные о найденной позиции.");
            return buildErrorAnalysis(
                "parser-coverage",
                "Проверены не все варианты списка",
                "Скорее всего, нужный абитуриент есть в другом разделе, квоте, основании обучения или конкурсной группе, которая не попала в настройки парсера.",
                "Проверить список URL, найденных на странице приемной комиссии, и уточнить правила разбора разделов: бюджет, целевая квота, особая квота, отдельная квота и договор.",
                evidence,
                "Конкурсные списки priem.unecon.ru"
            );
        }

        const requestedVariant = detectRequestedAdmissionVariant(`${questionLower} ${correctionLower}`);
        if (requestedVariant && !answerLower.includes(requestedVariant.marker)) {
            evidence.push(`В вопросе или исправлении есть вариант «${requestedVariant.title}», но в ответе он явно не показан.`);
            return buildErrorAnalysis(
                "missing-admission-variant",
                "Не показан нужный вариант конкурса",
                "Ответ не раскрыл тот вариант конкурсного списка, который был важен сотруднику.",
                "В ответе по коду всегда показывать найденные позиции отдельно по бюджету, целевой квоте, другим квотам и договору.",
                evidence,
                "Конкурсные списки priem.unecon.ru"
            );
        }
    }

    if (containsAnyText(questionLower, ["сегодня", "сейчас", "актуальн", "последн"]) && answerType === "knowledge") {
        evidence.push("Пользователь просил актуальные данные, но ответ взят из локальной базы знаний.");
        return buildErrorAnalysis(
            "outdated-source-risk",
            "Нужен актуальный источник",
            "Для такого вопроса локальной базы знаний может быть мало, потому что данные могли измениться.",
            "Переключить ответ на сайт приемной комиссии, документ с правилами приема или другой обновляемый источник.",
            evidence,
            correctionSource?.title || "Актуальный официальный источник"
        );
    }

    if (correctionSource && correctionSource.title !== answerSource) {
        evidence.push(`Источник ответа: ${answerSource}. По исправлению ближе: ${correctionSource.title}.`);
        return buildErrorAnalysis(
            "wrong-source",
            "Выбран не тот источник",
            "Исправление сотрудника больше похоже на другой источник, чем тот, по которому был построен ответ.",
            "При похожих вопросах повышать приоритет источника, найденного по исправлению сотрудника.",
            evidence,
            correctionSource.title
        );
    }

    const missingTerms = getMeaningfulWords(question)
        .filter(word => !answerLower.includes(word))
        .filter(word => correctionLower.includes(word))
        .slice(0, 5);

    if (missingTerms.length > 0) {
        evidence.push(`В исправлении есть важные слова из вопроса, которых не было в ответе: ${missingTerms.join(", ")}.`);
        return buildErrorAnalysis(
            "question-misread",
            "Вопрос понят неполно",
            "Бот ответил рядом с темой, но пропустил часть смысла вопроса.",
            "Уточнить ключевые слова для поиска источника и добавлять в ответ проверку всех важных терминов из вопроса.",
            evidence,
            correctionSource?.title || answerSource
        );
    }

    if (correctAnswer.length > botAnswer.length * 1.4) {
        evidence.push("Правильный ответ сотрудника заметно подробнее ответа бота.");
        return buildErrorAnalysis(
            "incomplete-answer",
            "Ответ был неполным",
            "Бот дал слишком короткий ответ и не раскрыл детали, которые сотрудник считает важными.",
            "Добавить в шаблон ответа обязательные поля: источник, вариант конкурса, позиция, места и статус, если они есть.",
            evidence,
            correctionSource?.title || answerSource
        );
    }

    evidence.push("Явного правила для ошибки не найдено, поэтому нужна ручная проверка исправления.");
    return buildErrorAnalysis(
        "unknown",
        "Причина требует проверки",
        "По текущим признакам нельзя уверенно определить одну причину ошибки.",
        "Посмотреть вопрос, ответ и исправление в журнале, затем добавить новое правило анализа.",
        evidence,
        correctionSource?.title || answerSource
    );
}

function buildErrorAnalysis(reasonType, reasonTitle, reasonText, recommendation, evidence, suggestedSource) {
    return {
        reasonType,
        reasonTitle,
        reasonText,
        recommendation,
        evidence,
        suggestedSource,
        summary: `${reasonTitle}. ${reasonText}`
    };
}

function detectRequestedAdmissionVariant(text) {
    const variants = [
        { title: "целевая квота", marker: "целев" },
        { title: "бюджет", marker: "бюджет" },
        { title: "договор", marker: "договор" },
        { title: "особая квота", marker: "особ" },
        { title: "отдельная квота", marker: "отдель" }
    ];

    return variants.find(variant => text.includes(variant.marker)) || null;
}

function containsAnyText(text, markers) {
    const normalizedText = (text || "").toLowerCase();
    return markers.some(marker => normalizedText.includes(marker));
}

function getMeaningfulWords(text) {
    const stopWords = new Set(["какой", "какая", "какие", "сколько", "почему", "через", "нужно", "можно", "есть", "будет", "чтобы", "ответ", "бота"]);

    return [...new Set((text || "")
        .toLowerCase()
        .split(/[^а-яa-z0-9]+/i)
        .filter(word => word.length > 3 && !stopWords.has(word)))];
}

function groupBy(items, keyGetter) {
    return items.reduce((acc, item) => {
        const key = keyGetter(item);
        if (!acc[key]) acc[key] = [];
        acc[key].push(item);
        return acc;
    }, {});
}

async function mapWithConcurrency(items, limit, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < items.length) {
            const currentIndex = nextIndex;
            nextIndex += 1;

            try {
                results[currentIndex] = {
                    status: "fulfilled",
                    value: await mapper(items[currentIndex], currentIndex)
                };
            } catch (error) {
                results[currentIndex] = {
                    status: "rejected",
                    reason: error
                };
            }
        }
    }

    const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
}

// ========== ОТПРАВКА СООБЩЕНИЯ ==========
async function sendMessage() {
    const input = document.getElementById("messageInput");
    const text = input.value.trim();

    if (!text || isLoading) return;

    input.value = "";
    input.disabled = true;
    isLoading = true;

    const welcomeDiv = document.querySelector(".welcome-message");
    if (welcomeDiv && chats.find(c => c.id === activeChatId)?.messages.length === 0) {
        welcomeDiv.style.display = "none";
    }

    addMessage("user", text);

    const chat = chats.find(c => c.id === activeChatId);
    if (chat && chat.messages.filter(m => m.role === "user").length === 1) {
        updateChatTitle(activeChatId);
    }

    showTypingIndicator();

    try {
        const history = chat.messages.slice(0, -1);
        const reply = await callAIApi(history, text);

        removeTypingIndicator();
        addMessage("assistant", reply.content || reply, reply.meta || {});
    } catch (error) {
        console.error("Ошибка при вызове API:", error);
        removeTypingIndicator();
        addMessage("assistant", "Извините, произошла ошибка. Пожалуйста, попробуйте позже.", {
            answerType: "error",
            source: "Системное сообщение",
            diagnostic: error.message
        });
    } finally {
        isLoading = false;
        input.disabled = false;
        input.focus();
    }
}

// Индикатор печати
function showTypingIndicator() {
    const container = document.getElementById("messagesContainer");
    const typingDiv = document.createElement("div");
    typingDiv.className = "message bot-message";
    typingDiv.id = "typingIndicator";
    typingDiv.innerHTML = `
        <div class="message-bubble">
            <div class="typing-indicator">
                <span></span><span></span><span></span>
            </div>
        </div>
    `;
    container.appendChild(typingDiv);
    container.scrollTop = container.scrollHeight;
}

function removeTypingIndicator() {
    const indicator = document.getElementById("typingIndicator");
    if (indicator) indicator.remove();
}

// ========== РЕНДЕР СООБЩЕНИЙ ==========
function renderMessages() {
    const container = document.getElementById("messagesContainer");
    const chat = chats.find(c => c.id === activeChatId);

    if (!chat) return;

    const welcomeDiv = container.querySelector(".welcome-message");
    if (chat.messages.length === 0) {
        if (!welcomeDiv) {
            container.innerHTML = `
                <div class="welcome-message">
                    <div class="welcome-icon">🎓</div>
                    <h3>Добро пожаловать в ГЭУ Диалог AI</h3>
                    <p>Задайте вопрос или отправьте код абитуриента, чтобы проверить позиции в конкурсных списках</p>
                </div>
            `;
        }
        return;
    }

    container.innerHTML = "";

    chat.messages.forEach(msg => {
        const messageDiv = document.createElement("div");
        messageDiv.className = `message ${msg.role === "user" ? "user-message" : "bot-message"}`;
        messageDiv.dataset.messageId = msg.id;

        messageDiv.innerHTML = `
            <div class="message-bubble">
                ${escapeHtml(msg.content)}
                ${renderMessageSource(msg)}
                ${renderFeedbackPanel(msg)}
            </div>
            <div class="message-time">${formatDate(msg.timestamp)}</div>
        `;

        container.appendChild(messageDiv);
    });

    container.scrollTop = container.scrollHeight;
}

function renderMessageSource(message) {
    if (message.role !== "assistant" || currentMode !== "staff") return "";

    const source = message.meta?.source || "Источник не указан";
    const diagnostic = message.meta?.diagnostic || "Диагностика не указана";

    return `
        <div class="message-source">
            <b>Источник:</b> ${escapeHtmlInline(source)}<br>
            <b>Почему выбран:</b> ${escapeHtmlInline(diagnostic)}
        </div>
    `;
}

function renderFeedbackPanel(message) {
    if (message.role !== "assistant" || currentMode !== "staff") return "";

    const review = staffReviews.find(item => item.messageId === message.id);
    if (review) {
        return `
            <div class="feedback-panel">
                <div class="feedback-saved">
                    Оценка сохранена: ${review.rating === "correct" ? "правильно" : "неправильно"}.
                </div>
                ${review.correctAnswer ? `<div class="message-source"><b>Правильный ответ:</b> ${escapeHtml(review.correctAnswer)}</div>` : ""}
                ${renderErrorAnalysisSummary(review)}
            </div>
        `;
    }

    return `
        <div class="feedback-panel">
            <div class="feedback-title">Оценка ответа сотрудником</div>
            <div class="feedback-actions">
                <button class="feedback-btn correct" data-feedback="correct" data-message-id="${message.id}">Правильно</button>
                <button class="feedback-btn incorrect" data-feedback="incorrect" data-message-id="${message.id}">Неправильно</button>
            </div>
            <div class="feedback-form" id="feedbackForm-${message.id}">
                <textarea placeholder="Введите правильный ответ сотрудника"></textarea>
                <button data-save-correction="${message.id}">Сохранить исправление</button>
            </div>
        </div>
    `;
}

function renderErrorAnalysisSummary(review) {
    if (review.analysis) {
        const analysis = review.analysis;
        return `
            <div class="analysis-box">
                <b>Агент анализа ошибок:</b> ${escapeHtmlInline(analysis.reasonTitle)}<br>
                ${escapeHtmlInline(analysis.reasonText)}<br>
                <b>Что сделать:</b> ${escapeHtmlInline(analysis.recommendation)}
                ${analysis.suggestedSource ? `<br><b>Источник по исправлению:</b> ${escapeHtmlInline(analysis.suggestedSource)}` : ""}
            </div>
        `;
    }

    if (review.errorReason) {
        return `<div class="message-source"><b>Причина ошибки:</b> ${escapeHtmlInline(review.errorReason)}</div>`;
    }

    return "";
}

// ========== РЕНДЕР СПИСКА ЧАТОВ ==========
function renderChats() {
    const list = document.getElementById("chatsList");
    if (!list) return;

    list.innerHTML = "";

    if (chats.length === 0) {
        list.innerHTML = '<div style="padding: 20px; text-align: center; color: #94a3b8;">Нет диалогов</div>';
        return;
    }

    chats.forEach(chat => {
        const chatDiv = document.createElement("div");
        chatDiv.className = `chat-item ${chat.id === activeChatId ? "active" : ""}`;

        const lastMessage = chat.messages[chat.messages.length - 1];
        const preview = lastMessage
            ? (lastMessage.content.length > 50 ? lastMessage.content.substring(0, 50) + "..." : lastMessage.content)
            : "Новый диалог";

        chatDiv.innerHTML = `
            <div class="chat-title">
                <span>${escapeHtml(chat.title)}</span>
                <button class="delete-chat" data-id="${chat.id}" title="Удалить диалог">🗑️</button>
            </div>
            <div class="chat-preview">${escapeHtml(preview)}</div>
            <div class="chat-date">${formatDate(chat.updatedAt)}</div>
        `;

        chatDiv.onclick = (e) => {
            if (e.target.classList.contains("delete-chat")) return;
            activeChatId = chat.id;
            renderChats();
            renderMessages();
            updateActiveChatTitle();
        };

        const deleteBtn = chatDiv.querySelector(".delete-chat");
        deleteBtn.onclick = (e) => {
            e.stopPropagation();
            deleteChat(chat.id);
        };

        list.appendChild(chatDiv);
    });
}

// Удаление чата
function deleteChat(chatId) {
    const index = chats.findIndex(c => c.id === chatId);
    if (index !== -1) {
        chats.splice(index, 1);
        deleteChatInDatabase(chatId);

        if (activeChatId === chatId) {
            if (chats.length > 0) {
                activeChatId = chats[0].id;
            } else {
                createNewChat();
            }
        }

        renderChats();
        renderMessages();
        updateActiveChatTitle();
    }
}

// Очистка текущего чата
function clearCurrentChat() {
    const chat = chats.find(c => c.id === activeChatId);
    if (chat && confirm("Очистить все сообщения в этом диалоге?")) {
        chat.messages = [];
        chat.title = "Новый диалог";
        chat.updatedAt = Date.now();
        clearChatMessagesInDatabase(chat);
        renderChats();
        renderMessages();
        updateActiveChatTitle();
    }
}

// ========== РЕЖИМ СОТРУДНИКА И ОЦЕНКИ ==========
function setMode(mode) {
    currentMode = mode;
    localStorage.setItem(STORAGE_KEYS.mode, currentMode);
    updateModeUI();
    renderMessages();
}

function updateModeUI() {
    document.querySelectorAll(".mode-btn").forEach(button => {
        button.classList.toggle("active", button.dataset.mode === currentMode);
    });

    const badge = document.getElementById("currentModeBadge");
    if (badge) {
        badge.textContent = currentMode === "staff" ? "Режим сотрудника" : "Режим абитуриента";
    }
}

function handleFeedbackClick(event) {
    const feedbackButton = event.target.closest("[data-feedback]");
    const correctionButton = event.target.closest("[data-save-correction]");

    if (feedbackButton) {
        const messageId = feedbackButton.dataset.messageId;
        const rating = feedbackButton.dataset.feedback;

        if (rating === "correct") {
            saveStaffReview(messageId, "correct");
            return;
        }

        const form = document.getElementById(`feedbackForm-${messageId}`);
        if (form) form.classList.add("visible");
    }

    if (correctionButton) {
        const messageId = correctionButton.dataset.saveCorrection;
        const form = document.getElementById(`feedbackForm-${messageId}`);
        const textarea = form?.querySelector("textarea");
        const correctedAnswer = textarea?.value.trim();

        if (!correctedAnswer) {
            alert("Введите правильный ответ.");
            return;
        }

        saveStaffReview(messageId, "incorrect", correctedAnswer);
    }
}

function saveStaffReview(messageId, rating, correctAnswer = "") {
    const chat = chats.find(c => c.id === activeChatId);
    if (!chat) return;

    const messageIndex = chat.messages.findIndex(message => message.id === messageId);
    if (messageIndex === -1) return;

    const answerMessage = chat.messages[messageIndex];
    const questionMessage = [...chat.messages.slice(0, messageIndex)].reverse().find(message => message.role === "user");
    const question = questionMessage?.content || "Вопрос не найден";
    const correctionSource = correctAnswer ? findCorrectionSource(question, correctAnswer, answerMessage.meta || {}) : null;
    const analysis = rating === "incorrect"
        ? analyzeWrongAnswer({ question, answerMessage, correctAnswer, correctionSource })
        : null;

    const review = {
        id: generateId(),
        messageId,
        chatId: chat.id,
        question,
        botAnswer: answerMessage.content,
        rating,
        correctAnswer,
        source: answerMessage.meta?.source || "Источник не указан",
        sourceDetails: answerMessage.meta?.sourceDetails || [],
        answerMeta: answerMessage.meta || {},
        analysis,
        errorReason: analysis?.summary || "",
        suggestedSource: analysis?.suggestedSource || correctionSource?.title || "",
        createdAt: Date.now()
    };

    staffReviews.unshift(review);
    saveReviewToDatabase(review);
    renderMessages();
    renderReviewPanel();
    updateReviewCounter();
}

function renderReviewPanel() {
    const list = document.getElementById("reviewList");
    if (!list) return;

    updateReviewFiltersUI();

    if (staffReviews.length === 0) {
        list.innerHTML = '<div class="empty-reviews">Проверок пока нет. Переключитесь в режим сотрудника и оцените ответ бота.</div>';
        return;
    }

    const visibleReviews = reviewFilter === "all"
        ? staffReviews
        : staffReviews.filter(review => review.rating === reviewFilter);

    if (visibleReviews.length === 0) {
        list.innerHTML = '<div class="empty-reviews">По выбранному фильтру пока нет проверок.</div>';
        return;
    }

    list.innerHTML = visibleReviews.map(review => `
        <div class="review-item ${review.rating}">
            <strong>${review.rating === "correct" ? "Правильно" : "Неправильно"}</strong>
            <p><b>Вопрос:</b> ${escapeHtml(review.question)}</p>
            <p><b>Ответ бота:</b> ${escapeHtml(review.botAnswer)}</p>
            ${review.correctAnswer ? `<p><b>Правильный ответ:</b> ${escapeHtml(review.correctAnswer)}</p>` : ""}
            <p><b>Источник:</b> ${escapeHtmlInline(review.source)}</p>
            ${review.suggestedSource ? `<p><b>Источник по исправлению:</b> ${escapeHtmlInline(review.suggestedSource)}</p>` : ""}
            ${renderReviewAnalysis(review)}
            <div class="review-meta">${formatDate(review.createdAt)}</div>
        </div>
    `).join("");
}

function renderReviewAnalysis(review) {
    if (review.analysis) {
        const evidence = (review.analysis.evidence || [])
            .map(item => `<li>${escapeHtmlInline(item)}</li>`)
            .join("");

        return `
            <div class="review-analysis">
                <p><b>Причина:</b> ${escapeHtmlInline(review.analysis.reasonTitle)}</p>
                <p>${escapeHtmlInline(review.analysis.reasonText)}</p>
                <p><b>Рекомендация:</b> ${escapeHtmlInline(review.analysis.recommendation)}</p>
                ${evidence ? `<ul>${evidence}</ul>` : ""}
            </div>
        `;
    }

    return review.errorReason
        ? `<p><b>Почему могла быть ошибка:</b> ${escapeHtmlInline(review.errorReason)}</p>`
        : "";
}

function updateReviewFiltersUI() {
    document.querySelectorAll("[data-review-filter]").forEach(button => {
        button.classList.toggle("active", button.dataset.reviewFilter === reviewFilter);
    });
}

function updateReviewCounter() {
    const counter = document.getElementById("reviewCounter");
    if (counter) counter.textContent = staffReviews.length;
}

// ========== СОХРАНЕНИЕ В БАЗЕ ДАННЫХ ==========
async function apiRequest(path, options = {}) {
    const requestUrl = getApiRequestUrl(path);
    const requestOptions = {
        method: options.method || "GET",
        headers: {
            "Accept": "application/json",
            ...(options.body ? { "Content-Type": "application/json" } : {})
        }
    };

    if (options.body) {
        requestOptions.body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    }

    const response = await fetch(requestUrl, requestOptions);
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};

    if (!response.ok) {
        throw new Error(payload.error || `Сервер вернул ${response.status}`);
    }

    return payload;
}

function getApiRequestUrl(path) {
    if (/^https?:\/\//i.test(path)) return path;

    if (window.location.protocol === "http:" || window.location.protocol === "https:") {
        return path;
    }

    return `${LOCAL_SERVER_ORIGIN}${path}`;
}

function queueDatabaseWrite(promise) {
    promise
        .then(() => {
            setDatabaseStatus("База данных подключена", true);
        })
        .catch(error => {
            console.error("Ошибка сохранения в базу данных:", error);
            setDatabaseStatus("База данных: ошибка сохранения", false);
        });
}

function saveChatToDatabase(chat) {
    queueDatabaseWrite(apiRequest(`/api/chats/${encodeURIComponent(chat.id)}`, {
        method: "PUT",
        body: chat
    }));
}

function saveMessageToDatabase(chatId, message) {
    const chat = chats.find(item => item.id === chatId);
    queueDatabaseWrite(apiRequest(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
        method: "POST",
        body: { chat, message }
    }));
}

function deleteChatInDatabase(chatId) {
    queueDatabaseWrite(apiRequest(`/api/chats/${encodeURIComponent(chatId)}`, {
        method: "DELETE"
    }));
}

function clearChatMessagesInDatabase(chat) {
    queueDatabaseWrite(apiRequest(`/api/chats/${encodeURIComponent(chat.id)}/messages`, {
        method: "DELETE",
        body: { chat }
    }));
}

function saveReviewToDatabase(review) {
    queueDatabaseWrite(apiRequest("/api/reviews", {
        method: "POST",
        body: review
    }));
}

async function loadFromDatabase() {
    try {
        currentMode = localStorage.getItem(STORAGE_KEYS.mode) || "applicant";

        let state = await apiRequest("/api/state");
        const legacyState = readLegacyLocalStorage();

        if ((state.chats || []).length === 0 && (legacyState.chats.length > 0 || legacyState.reviews.length > 0)) {
            state = await apiRequest("/api/state/import", {
                method: "POST",
                body: legacyState
            });
            localStorage.removeItem(STORAGE_KEYS.legacyChats);
            localStorage.removeItem(STORAGE_KEYS.legacyReviews);
        }

        chats = sanitizeStoredChats(state.chats || []);
        staffReviews = sanitizeStoredReviews(state.reviews || []);

        if (chats.length > 0) {
            activeChatId = chats[0].id;
        } else {
            createNewChat();
        }

        setDatabaseStatus("База данных подключена", true);
    } catch (e) {
        console.error("Ошибка загрузки базы данных:", e);
        const legacyState = readLegacyLocalStorage();
        chats = sanitizeStoredChats(legacyState.chats || []);
        staffReviews = sanitizeStoredReviews(legacyState.reviews || []);

        if (chats.length > 0) {
            activeChatId = chats[0].id;
        } else {
            createNewChat();
        }

        const statusText = window.location.protocol === "file:"
            ? "Откройте через http://localhost:3000"
            : "База данных недоступна";
        setDatabaseStatus(statusText, false);
    }

    updateModeUI();
    updateReviewCounter();
    renderReviewPanel();
    renderChats();
    renderMessages();
    updateActiveChatTitle();
}

function readLegacyLocalStorage() {
    try {
        return {
            chats: sanitizeStoredChats(JSON.parse(localStorage.getItem(STORAGE_KEYS.legacyChats) || "[]")),
            reviews: sanitizeStoredReviews(JSON.parse(localStorage.getItem(STORAGE_KEYS.legacyReviews) || "[]"))
        };
    } catch {
        return { chats: [], reviews: [] };
    }
}

function setDatabaseStatus(text, isOk) {
    const statusIndicator = document.getElementById("statusIndicator");
    const statusText = statusIndicator?.querySelector("span:last-child");
    const statusDot = statusIndicator?.querySelector(".status-dot");

    if (statusText) statusText.textContent = text;
    if (statusDot) statusDot.classList.toggle("error", !isOk);
}

function sanitizeStoredChats(savedChats) {
    return savedChats.map(chat => ({
        ...chat,
        id: chat.id || generateId(),
        title: chat.title || "Новый диалог",
        createdAt: chat.createdAt || Date.now(),
        updatedAt: chat.updatedAt || Date.now(),
        messages: (chat.messages || []).map(message => ({
            id: message.id || generateId(),
            role: message.role,
            content: (message.content || "").replace(
                /Источник: https:\/\/priem\.unecon\.ru\/stat\/stat_konkurs\.php\?\S+/g,
                "Источник: сайт приемной комиссии"
            ),
            timestamp: message.timestamp || Date.now(),
            meta: message.meta || {}
        }))
    }));
}

function sanitizeStoredReviews(savedReviews) {
    return savedReviews.map(review => ({
        ...review,
        id: review.id || generateId(),
        question: review.question || "Вопрос не найден",
        botAnswer: review.botAnswer || "",
        rating: review.rating || "incorrect",
        correctAnswer: review.correctAnswer || "",
        source: review.source || "Источник не указан",
        sourceDetails: review.sourceDetails || [],
        answerMeta: review.answerMeta || {},
        analysis: review.analysis || null,
        errorReason: review.errorReason || "",
        suggestedSource: review.suggestedSource || "",
        createdAt: review.createdAt || Date.now()
    }));
}

// Escape HTML для безопасности
function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML.replace(/\n/g, "<br>");
}

function escapeHtmlInline(text) {
    const div = document.createElement("div");
    div.textContent = text || "";
    return div.innerHTML;
}

// ========== ИНИЦИАЛИЗАЦИЯ ==========
document.addEventListener("DOMContentLoaded", async () => {
    await loadFromDatabase();

    document.getElementById("sendBtn").addEventListener("click", sendMessage);
    document.getElementById("messageInput").addEventListener("keypress", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    document.getElementById("newChatBtn").addEventListener("click", () => createNewChat());
    document.getElementById("clearChatBtn").addEventListener("click", clearCurrentChat);
    document.getElementById("messagesContainer").addEventListener("click", handleFeedbackClick);

    document.querySelectorAll(".mode-btn").forEach(button => {
        button.addEventListener("click", () => setMode(button.dataset.mode));
    });

    document.getElementById("reviewsToggle").addEventListener("click", () => {
        document.getElementById("reviewDrawer").hidden = false;
        renderReviewPanel();
    });

    document.getElementById("reviewDrawerClose").addEventListener("click", () => {
        document.getElementById("reviewDrawer").hidden = true;
    });

    document.getElementById("reviewFilters")?.addEventListener("click", (event) => {
        const button = event.target.closest("[data-review-filter]");
        if (!button) return;

        reviewFilter = button.dataset.reviewFilter;
        renderReviewPanel();
    });
});
