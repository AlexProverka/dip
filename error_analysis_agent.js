const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

const DEFAULT_TOP_K = 5;
const MAX_SOURCE_PREVIEW = 520;
const DEFAULT_LLM_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const DEFAULT_LLM_MODEL = "gpt-4o-mini";
const POLLINATIONS_PROVIDER = "pollinations";
const POLLINATIONS_LEGACY_ENDPOINT = "https://text.pollinations.ai/openai";
const POLLINATIONS_MODEL = "openai-fast";
const DEFAULT_EMBEDDING_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
const EMBEDDING_INDEX_PATH = process.env.EMBEDDING_INDEX_PATH || path.join(__dirname, "data", "source_embedding_index.json");
const EMBEDDING_MODEL_CACHE_DIR = process.env.TRANSFORMERS_CACHE || path.join(__dirname, "data", "transformers-cache");
const EMBEDDING_DISABLED = process.env.EMBEDDING_DISABLED === "1";
const EMBEDDING_AUTO_INSTALL = process.env.EMBEDDING_AUTO_INSTALL === "1";
const EMBEDDING_BUILD_ON_DEMAND = process.env.EMBEDDING_BUILD_ON_DEMAND === "1";
const EMBEDDING_DEPENDENCIES = [
    "@xenova/transformers@^2.17.2",
    "onnxruntime-node@^1.26.0",
    "sharp@^0.34.5"
];

const SOURCE_PATHS = [
    process.env.SOURCE_DATA_PATH,
    path.join(__dirname, "data", "combined_data.json"),
    "C:\\Users\\Acer\\Downloads\\combined_data.json"
].filter(Boolean);

const STOP_WORDS = new Set([
    "что", "как", "где", "когда", "есть", "или", "для", "при", "над", "под", "без",
    "все", "всем", "если", "это", "эта", "этот", "этом", "они", "она", "оно",
    "нужно", "можно", "будет", "будут", "был", "была", "были", "также",
    "свои", "свой", "по", "на", "из", "от", "до", "за", "во", "со", "ко",
    "the", "and", "for", "with"
]);

let cachedIndex = null;
let cachedEmbeddingIndexPromise = null;
let cachedEmbeddingPipelinePromise = null;
let embeddingRuntimeError = null;
let embeddingFallbackWarned = false;
let embeddingInstallPromise = null;

function findSourceDataPath() {
    const sourcePath = SOURCE_PATHS.find(item => item && fs.existsSync(item));
    if (!sourcePath) {
        throw new Error(`Файл combined_data.json не найден. Проверены пути: ${SOURCE_PATHS.join("; ")}`);
    }
    return sourcePath;
}

function loadSourceIndex() {
    if (cachedIndex) return cachedIndex;

    const sourcePath = findSourceDataPath();
    const rawItems = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
    const docs = rawItems
        .filter(item => item && item.label !== "TABLE")
        .map((item, index) => {
            const text = String(item.key || item.text || "").trim();
            const tokens = tokenize(text);
            const termCounts = countTerms(tokens);

            return {
                id: `source-${index}`,
                fileName: item.file_name || "",
                pageNumber: item.page_number || "",
                sourceGroup: item.source_group || "",
                label: item.label || "",
                text,
                tokens,
                termCounts,
                tokenCount: tokens.length
            };
        })
        .filter(doc => doc.text && doc.tokenCount > 0);

    const df = new Map();
    docs.forEach(doc => {
        Object.keys(doc.termCounts).forEach(term => {
            df.set(term, (df.get(term) || 0) + 1);
        });
    });

    const idf = new Map();
    df.forEach((count, term) => {
        idf.set(term, Math.log((docs.length + 1) / (count + 1)) + 1);
    });

    docs.forEach(doc => {
        doc.vector = buildVector(doc.termCounts, idf);
        doc.vectorNorm = vectorNorm(doc.vector);
    });

    cachedIndex = { sourcePath, docs, idf };
    return cachedIndex;
}

async function searchSources(query, topK = DEFAULT_TOP_K) {
    if (!String(query || "").trim()) {
        return [];
    }

    if (!EMBEDDING_DISABLED && !embeddingRuntimeError) {
        try {
            return await searchSourcesByEmbeddings(query, topK);
        } catch (error) {
            embeddingRuntimeError = error;
            if (!embeddingFallbackWarned) {
                console.warn(`Embedding search fallback: ${error.message}`);
                embeddingFallbackWarned = true;
            }
        }
    }

    return searchSourcesByTfIdf(query, topK);
}

function searchSourcesByTfIdf(query, topK = DEFAULT_TOP_K) {
    const index = loadSourceIndex();
    const queryTokens = tokenize(query);
    const queryVector = buildVector(countTerms(queryTokens), index.idf);
    const queryNorm = vectorNorm(queryVector);

    if (!queryTokens.length || queryNorm === 0) {
        return [];
    }

    const ranked = index.docs
        .map(doc => {
            const cosine = cosineSimilarity(queryVector, queryNorm, doc.vector, doc.vectorNorm);
            const overlap = tokenOverlap(queryTokens, doc.tokens);
            const score = cosine + overlap * 0.08;

            return {
                id: doc.id,
                score: roundScore(score),
                searchMode: "tf-idf",
                cosine: roundScore(cosine),
                overlap: roundScore(overlap),
                fileName: doc.fileName,
                pageNumber: doc.pageNumber,
                sourceGroup: doc.sourceGroup,
                text: doc.text,
                preview: makePreview(doc.text)
            };
        })
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score);

    return dedupeSearchResults(ranked)
        .slice(0, Math.max(1, Number(topK) || DEFAULT_TOP_K));
}

async function searchSourcesByEmbeddings(query, topK = DEFAULT_TOP_K) {
    const embeddingIndex = await loadEmbeddingIndex();
    const queryEmbedding = await embedText(query);
    const queryNorm = denseVectorNorm(queryEmbedding);

    if (!queryEmbedding.length || queryNorm === 0) {
        return [];
    }

    const ranked = embeddingIndex.docs
        .map(doc => {
            const cosine = denseCosineSimilarity(queryEmbedding, queryNorm, doc.embedding, doc.embeddingNorm);

            return {
                id: doc.id,
                score: roundScore(cosine),
                searchMode: "semantic-embeddings",
                embeddingModel: embeddingIndex.model,
                cosine: roundScore(cosine),
                fileName: doc.fileName,
                pageNumber: doc.pageNumber,
                sourceGroup: doc.sourceGroup,
                text: doc.text,
                preview: makePreview(doc.text)
            };
        })
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score);

    return dedupeSearchResults(ranked)
        .slice(0, Math.max(1, Number(topK) || DEFAULT_TOP_K));
}

async function loadEmbeddingIndex(options = {}) {
    if (cachedEmbeddingIndexPromise) return cachedEmbeddingIndexPromise;

    cachedEmbeddingIndexPromise = buildOrLoadEmbeddingIndex(options);

    try {
        return await cachedEmbeddingIndexPromise;
    } catch (error) {
        cachedEmbeddingIndexPromise = null;
        throw error;
    }
}

async function buildOrLoadEmbeddingIndex({ allowBuild = EMBEDDING_BUILD_ON_DEMAND } = {}) {
    const sourceIndex = loadSourceIndex();
    const sourceSignature = buildSourceSignature(sourceIndex);
    const savedIndex = readSavedEmbeddingIndex(sourceSignature);

    if (savedIndex) {
        const embeddingsById = new Map(savedIndex.items.map(item => [item.id, item.embedding]));
        return {
            sourcePath: sourceIndex.sourcePath,
            model: savedIndex.meta.model,
            sourceSignature,
            indexPath: EMBEDDING_INDEX_PATH,
            docs: sourceIndex.docs
                .map(doc => {
                    const embedding = embeddingsById.get(doc.id);
                    if (!embedding) return null;

                    return {
                        ...doc,
                        embedding,
                        embeddingNorm: denseVectorNorm(embedding)
                    };
                })
                .filter(Boolean)
        };
    }

    if (!allowBuild) {
        throw new Error("Embedding index is not ready. Run npm run build:embeddings before enabling semantic search.");
    }

    const items = [];
    for (const doc of sourceIndex.docs) {
        const embedding = await embedText(doc.text);
        items.push({
            id: doc.id,
            embedding
        });
    }

    const payload = {
        meta: {
            createdAt: new Date().toISOString(),
            model: EMBEDDING_MODEL,
            sourcePath: sourceIndex.sourcePath,
            sourceSignature,
            textSources: sourceIndex.docs.length
        },
        items
    };

    fs.mkdirSync(path.dirname(EMBEDDING_INDEX_PATH), { recursive: true });
    fs.writeFileSync(EMBEDDING_INDEX_PATH, JSON.stringify(payload), "utf8");

    return {
        sourcePath: sourceIndex.sourcePath,
        model: EMBEDDING_MODEL,
        sourceSignature,
        indexPath: EMBEDDING_INDEX_PATH,
        docs: sourceIndex.docs.map((doc, index) => ({
            ...doc,
            embedding: items[index].embedding,
            embeddingNorm: denseVectorNorm(items[index].embedding)
        }))
    };
}

function readSavedEmbeddingIndex(sourceSignature) {
    if (!fs.existsSync(EMBEDDING_INDEX_PATH)) {
        return null;
    }

    try {
        const savedIndex = JSON.parse(fs.readFileSync(EMBEDDING_INDEX_PATH, "utf8"));
        if (
            savedIndex?.meta?.model === EMBEDDING_MODEL &&
            savedIndex?.meta?.sourceSignature === sourceSignature &&
            Array.isArray(savedIndex.items) &&
            savedIndex.items.length > 0
        ) {
            return savedIndex;
        }
    } catch (error) {
        console.warn(`Не удалось прочитать embedding-индекс: ${error.message}`);
    }

    return null;
}

function buildSourceSignature(index) {
    const hash = crypto.createHash("sha256");
    hash.update(index.sourcePath);
    index.docs.forEach(doc => {
        hash.update(doc.id);
        hash.update(doc.fileName || "");
        hash.update(String(doc.pageNumber || ""));
        hash.update(doc.text);
    });
    return hash.digest("hex");
}

async function embedText(text) {
    const extractor = await getEmbeddingPipeline();
    const result = await extractor(String(text || ""), {
        pooling: "mean",
        normalize: true
    });

    return Array.from(result.data, value => Number(value));
}

function isMissingEmbeddingDependencyError(error) {
    const message = String(error?.message || "");
    return error?.code === "ERR_MODULE_NOT_FOUND" ||
        message.includes("Cannot find package '@xenova/transformers'") ||
        message.includes("Cannot find package 'onnxruntime-node'") ||
        message.includes("Cannot find package 'sharp'");
}

async function installEmbeddingDependencies() {
    if (embeddingInstallPromise) return embeddingInstallPromise;

    embeddingInstallPromise = new Promise((resolve, reject) => {
        const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
        const args = [
            "install",
            "--omit=dev",
            "--no-audit",
            "--no-fund",
            ...EMBEDDING_DEPENDENCIES
        ];

        console.warn(`Installing embedding dependencies: ${EMBEDDING_DEPENDENCIES.join(", ")}`);
        execFile(npmCommand, args, {
            cwd: __dirname,
            timeout: 10 * 60 * 1000,
            windowsHide: true
        }, (error, stdout, stderr) => {
            if (stdout) console.log(stdout.trim());
            if (stderr) console.warn(stderr.trim());
            if (error) {
                embeddingInstallPromise = null;
                reject(error);
                return;
            }
            resolve();
        });
    });

    return embeddingInstallPromise;
}

async function createEmbeddingPipeline() {
    const { pipeline, env } = await import("@xenova/transformers");
    env.cacheDir = EMBEDDING_MODEL_CACHE_DIR;
    env.allowRemoteModels = process.env.EMBEDDING_ALLOW_REMOTE !== "0";
    env.allowLocalModels = true;
    return pipeline("feature-extraction", EMBEDDING_MODEL);
}

async function getEmbeddingPipeline() {
    if (cachedEmbeddingPipelinePromise) return cachedEmbeddingPipelinePromise;

    cachedEmbeddingPipelinePromise = (async () => {
        try {
            return await createEmbeddingPipeline();
        } catch (error) {
            if (!EMBEDDING_AUTO_INSTALL || !isMissingEmbeddingDependencyError(error)) {
                throw error;
            }

            console.warn(`Embedding dependencies are missing, trying runtime install: ${error.message}`);
            await installEmbeddingDependencies();
            return createEmbeddingPipeline();
        }
    })();

    try {
        return await cachedEmbeddingPipelinePromise;
    } catch (error) {
        cachedEmbeddingPipelinePromise = null;
        throw error;
    }
}

async function analyzeErrorCase({ question, agentAnswer, agentSources, adminAnswer, topK = DEFAULT_TOP_K } = {}) {
    const normalizedAgentSources = normalizeAgentSources(agentSources);
    const topSources = await searchSources(adminAnswer || question || "", topK);
    const bestSource = topSources[0] || null;
    const agentSourceText = normalizedAgentSources.map(sourceContentText).join("\n");
    const topSourceText = topSources.map(source => source.text).join("\n");
    const sourceOverlap = topSources.filter(source => sourceMatchesAgent(source, normalizedAgentSources)).length;
    const answerSearch = await searchSources(agentAnswer || "", topK);
    const answerMatchesManySources = answerSearch.filter(source => source.score >= 0.12).length >= 2;
    const evidence = [];

    if (!String(adminAnswer || "").trim()) {
        return buildAnalysis({
            reasonType: "missing-admin-answer",
            reasonTitle: "Нет правильного ответа сотрудника",
            reasonText: "Векторный поиск нельзя запустить, потому что отсутствует эталонный ответ сотрудника приемной комиссии.",
            recommendation: "Добавить правильный ответ сотрудника для этого вопроса.",
            evidence: ["Поле adminAnswer пустое."],
            topSources
        });
    }

    if (!normalizedAgentSources.length) {
        evidence.push("Источник ответа агента не был сохранен.");
        evidence.push(...topEvidence(topSources));
        return buildAnalysis({
            reasonType: "missing-agent-source",
            reasonTitle: "Не указан источник агента",
            reasonText: "Найденные по правильному ответу источники не с чем сравнить: у ответа агента нет сохраненного источника.",
            recommendation: "Сохранять вместе с ответом агента название источника, страницу и текстовый фрагмент.",
            evidence,
            suggestedSource: formatSourceTitle(bestSource),
            topSources
        });
    }

    const adminTokens = meaningfulTokens(adminAnswer);
    const agentTokens = meaningfulTokens(agentAnswer);
    const agentSourceAdminOverlap = tokenOverlap(meaningfulTokens(agentSourceText), adminTokens);
    const agentAnswerAdminOverlap = tokenOverlap(agentTokens, adminTokens);
    const missingImportantTerms = adminTokens
        .filter(term => !agentTokens.includes(term))
        .slice(0, 8);
    const extraTerms = agentTokens
        .filter(term => !adminTokens.includes(term))
        .filter(term => !meaningfulTokens(topSourceText).includes(term))
        .slice(0, 8);

    if (hasNonexistentDirectionNoise(agentAnswer, adminAnswer, topSourceText, extraTerms)) {
        if (sourceOverlap === 0 && agentSourceAdminOverlap < 0.28) {
            evidence.push("Источник агента слабо связан с правильным ответом сотрудника и найденными эталонными фрагментами.");
            evidence.push(...topEvidence(topSources));
            if (agentSourceText) evidence.push(`Сохраненный источник агента: ${makePreview(agentSourceText, 260)}`);
            return buildAnalysis({
                reasonType: "wrong-source",
                reasonTitle: "Неправильно выбран источник",
                reasonText: "Ответ агента содержит лишние сведения, потому что был построен на неподходящем источнике.",
                recommendation: "Для похожих вопросов сначала проверять, совпадает ли источник агента с top-k фрагментами, найденными по правильному ответу сотрудника.",
                evidence,
                suggestedSource: formatSourceTitle(bestSource),
                topSources
            });
        }

        evidence.push(`В ответе агента есть лишние слова/приписки, которых нет в правильном ответе и найденных источниках: ${extraTerms.join(", ")}.`);
        evidence.push(...topEvidence(topSources));
        return buildAnalysis({
            reasonType: "nonexistent-direction",
            reasonTitle: "Появились лишние строки или приписки",
            reasonText: "Агент добавил сведения, которые не подтверждаются найденными по правильному ответу источниками.",
            recommendation: "Запрещать генерацию направлений, адресов и условий, которых нет в выбранном фрагменте источника.",
            evidence,
            suggestedSource: formatSourceTitle(bestSource),
            topSources
        });
    }

    const conflict = detectSpecificFactConflict(agentAnswer, adminAnswer);
    if (conflict) {
        evidence.push(conflict);
        evidence.push(...topEvidence(topSources));
        return buildAnalysis({
            reasonType: "wrong-source",
            reasonTitle: "Неправильно выбран источник",
            reasonText: "В ответе агента есть конкретный факт, который противоречит правильному ответу сотрудника.",
            recommendation: "Для вопросов с датами, адресами и условиями проверять совпадение конкретного факта с top-k источником по правильному ответу.",
            evidence,
            suggestedSource: formatSourceTitle(bestSource),
            topSources
        });
    }

    const isTooGenericShortAnswer = agentTokens.length <= 3 && adminTokens.length >= 8 && missingImportantTerms.length >= 6;
    if (isTooGenericShortAnswer && sourceOverlap === 0) {
        evidence.push("Ответ агента слишком общий и не передает конкретные сведения из правильного ответа сотрудника.");
        evidence.push(...topEvidence(topSources));
        if (agentSourceText) evidence.push(`Сохраненный источник агента: ${makePreview(agentSourceText, 260)}`);
        return buildAnalysis({
            reasonType: "wrong-source",
            reasonTitle: "Неправильно выбран источник",
            reasonText: "Ответ агента построен на слишком общем фрагменте и не соответствует источникам, найденным по правильному ответу сотрудника.",
            recommendation: "Использовать не общий фрагмент о наличии темы, а конкретный top-k источник с условиями, количеством, адресом или другим существенным фактом.",
            evidence,
            suggestedSource: formatSourceTitle(bestSource),
            topSources
        });
    }

    if (isIncompleteAnswer(agentAnswer, adminAnswer, missingImportantTerms) && (agentSourceAdminOverlap >= 0.28 || agentAnswerAdminOverlap >= 0.35)) {
        evidence.push("Ответ агента короче эталонного ответа сотрудника или не содержит важные условия из него.");
        if (missingImportantTerms.length) {
            evidence.push(`Пропущенные важные слова: ${missingImportantTerms.join(", ")}.`);
        }
        evidence.push(...topEvidence(topSources));
        return buildAnalysis({
            reasonType: "incomplete-answer",
            reasonTitle: "Ответ неполный",
            reasonText: "Агент опирался на близкий фрагмент, но перенес в ответ только часть условий из правильного ответа сотрудника.",
            recommendation: "Не обрезать исходный фрагмент и сохранять все обязательные условия, даты, адреса и ограничения.",
            evidence,
            suggestedSource: formatSourceTitle(bestSource),
            topSources
        });
    }

    const sourceContradiction = detectSourceAnswerContradiction(agentAnswer, agentSourceText, adminAnswer);
    if (sourceContradiction) {
        evidence.push(`Ответ агента: «${makePreview(agentAnswer, 220)}»`);
        evidence.push(`Переданный фрагмент источника: «${makePreview(agentSourceText, 260)}»`);
        evidence.push(`Эталонный ответ сотрудника: «${makePreview(adminAnswer, 260)}»`);
        if (sourceContradiction.extraTerms.length) {
            evidence.push(`В ответе появились слова или ограничения, которых нет в источнике: ${sourceContradiction.extraTerms.join(", ")}.`);
        }
        evidence.push(...topEvidence(topSources));
        return buildAnalysis({
            reasonType: "nonexistent-direction",
            reasonTitle: "Ответ противоречит переданному источнику",
            reasonText: `Агент получил фрагмент источника, где сказано: «${makePreview(sourceContradiction.referenceFragment, 220)}». Но в ответе он написал: «${makePreview(agentAnswer, 220)}». Это не проблема отсутствующего источника: источник был передан, но агент исказил его смысл и добавил неподтвержденное ограничение.`,
            recommendation: "При генерации ответа проверять, что итоговая формулировка не меняет условия из выбранного фрагмента. Если источник и ответ сотрудника совпадают, агент должен повторить их смысл без новых ограничений и уточнений.",
            evidence,
            suggestedSource: "Переданный фрагмент источника агента",
            topSources
        });
    }

    if (bestSource && sourceOverlap === 0) {
        evidence.push("Источник агента не совпал с текстовыми фрагментами, найденными по правильному ответу сотрудника.");
        evidence.push(...topEvidence(topSources));
        if (agentSourceText) evidence.push(`Сохраненный источник агента: ${makePreview(agentSourceText, 260)}`);
        return buildAnalysis({
            reasonType: "wrong-source",
            reasonTitle: "Неправильно выбран источник",
            reasonText: "Правильный ответ указывает на другие источники, чем те, по которым был построен ответ агента.",
            recommendation: "В похожих вопросах повышать приоритет найденных top-k источников и проверять совпадение страницы/фрагмента.",
            evidence,
            suggestedSource: formatSourceTitle(bestSource),
            topSources
        });
    }

    if (isIncompleteAnswer(agentAnswer, adminAnswer, missingImportantTerms)) {
        evidence.push("Ответ агента короче эталонного ответа сотрудника или не содержит важные слова из него.");
        if (missingImportantTerms.length) {
            evidence.push(`Пропущенные важные слова: ${missingImportantTerms.join(", ")}.`);
        }
        evidence.push(...topEvidence(topSources));
        return buildAnalysis({
            reasonType: "incomplete-answer",
            reasonTitle: "Ответ неполный",
            reasonText: "Агент выбрал близкий источник, но передал только часть эталонного ответа.",
            recommendation: "Не обрезать FAQ-блок и сохранять обязательные условия, даты, адреса и ограничения.",
            evidence,
            suggestedSource: formatSourceTitle(bestSource),
            topSources
        });
    }

    if (isLikelyMergedRows({ normalizedAgentSources, answerMatchesManySources, sourceOverlap, answerSearch, topSources, agentAnswer })) {
        evidence.push("Ответ агента похож сразу на несколько разных источников или содержит несколько сохраненных источников.");
        evidence.push(...topEvidence(answerSearch.slice(0, 3), "Фрагмент, на который похож ответ агента"));
        return buildAnalysis({
            reasonType: "merged-rows",
            reasonTitle: "Объединил несколько строк в одну",
            reasonText: "Ответ выглядит как склейка нескольких фрагментов: правильный ответ находится в одном наборе источников, а ответ агента похож еще на другие строки.",
            recommendation: "При генерации ответа брать одну найденную строку/один FAQ-блок и не смешивать его с соседними строками.",
            evidence,
            suggestedSource: formatSourceTitle(bestSource),
            topSources
        });
    }

    evidence.push("Найденные источники и источник агента похожи, но различия требуют ручной проверки.");
    evidence.push(...topEvidence(topSources));
    return buildAnalysis({
        reasonType: "needs-review",
        reasonTitle: "Причина требует проверки",
        reasonText: "Автоматический анализ не нашел уверенной причины из заданного списка.",
        recommendation: "Посмотреть top-k источники, ответ агента и эталонный ответ сотрудника вручную.",
        evidence: normalizeEvidenceForFragments(evidence, topSources),
        suggestedSource: formatSourceTitle(bestSource),
        topSources
    });
}

async function analyzeErrorCaseWithLlm(input = {}) {
    const baseAnalysis = await analyzeErrorCase(input);

    if (!isLlmConfigured()) {
        return {
            ...baseAnalysis,
            llm: {
                used: false,
                reason: "OPENAI_API_KEY или LLM_API_KEY не задан, используется локальная логика."
            }
        };
    }

    try {
        const llmAnalysis = await requestLlmAnalysis(input, baseAnalysis);
        return mergeLlmAnalysis(baseAnalysis, llmAnalysis);
    } catch (error) {
        return {
            ...baseAnalysis,
            llm: {
                used: false,
                error: error.message,
                fallback: "LLM не ответила, используется локальная логика."
            }
        };
    }
}

function normalizeAgentSources(agentSources) {
    const rawSources = Array.isArray(agentSources) ? agentSources : [agentSources].filter(Boolean);

    return rawSources
        .map(source => {
            if (!source) return null;
            if (typeof source === "string") {
                return { title: source, text: source };
            }

            return {
                title: source.title || source.fileName || source.file_name || source.source || "",
                fileName: source.fileName || source.file_name || "",
                pageNumber: source.pageNumber || source.page_number || "",
                text: source.text || source.preview || source.key || source.content || source.title || ""
            };
        })
        .filter(source => source && sourceToText(source).trim());
}

function sourceToText(source) {
    return [
        source.title,
        source.fileName,
        source.pageNumber,
        source.text
    ].filter(Boolean).join(" ");
}

function sourceContentText(source) {
    return [source.text, source.title]
        .filter(Boolean)
        .sort((a, b) => b.length - a.length)[0] || "";
}

function sourceMatchesAgent(source, agentSources) {
    const sourceTitle = formatSourceTitle(source).toLowerCase();
    const sourceText = `${source.fileName} ${source.pageNumber} ${source.preview}`.toLowerCase();

    return agentSources.some(agentSource => {
        const agentText = sourceToText(agentSource).toLowerCase();
        if (!agentText) return false;

        return (
            (source.fileName && agentText.includes(String(source.fileName).toLowerCase())) ||
            (source.pageNumber && agentText.includes(String(source.pageNumber).toLowerCase())) ||
            (sourceTitle && agentText.includes(sourceTitle)) ||
            tokenOverlap(tokenize(agentText), tokenize(sourceText)) >= 0.42
        );
    });
}

function isLikelyMergedRows({ normalizedAgentSources, answerMatchesManySources, sourceOverlap, answerSearch, topSources, agentAnswer }) {
    if (normalizedAgentSources.length > 1 && sourceOverlap < normalizedAgentSources.length) return true;

    if (meaningfulTokens(agentAnswer).length < 18) return false;

    const topIds = new Set(topSources.map(source => source.id));
    const foreignStrongMatches = answerSearch.filter(source => !topIds.has(source.id) && source.score >= 0.2);
    return answerMatchesManySources && foreignStrongMatches.length > 0;
}

function hasNonexistentDirectionNoise(agentAnswer, adminAnswer, topSourceText, extraTerms) {
    const answer = normalizeText(agentAnswer);
    const admin = normalizeText(adminAnswer);

    if (answer.includes("без исключ") && (admin.includes("как правило") || admin.includes("не предоставляется"))) {
        return true;
    }

    if (answer.includes("военная кафед") && admin.includes("программа военной подготовки") && !admin.includes("военная кафед")) {
        return true;
    }

    if ((answer.includes("старш") || answer.includes("сокращ")) && admin.includes("поступают на 1 курс")) {
        return true;
    }

    if (answer.includes("всем поступающ") && admin.includes("не нужно")) {
        return true;
    }

    if (extraTerms.length < 3) return false;

    const reference = normalizeText(`${adminAnswer} ${topSourceText}`);
    const domainMarkers = [
        "направлен", "профил", "факультет", "колледж", "общежит", "адрес",
        "бюджет", "контракт", "экзамен", "день открытых"
    ];

    return domainMarkers.some(marker => answer.includes(marker) && !reference.includes(marker));
}

function detectSpecificFactConflict(agentAnswer, adminAnswer) {
    const answer = normalizeText(agentAnswer);
    const admin = normalizeText(adminAnswer);

    if (
        answer.includes("нужно") &&
        /(сдавать|экзамен|экзамены|вступительн)/.test(answer) &&
        (admin.includes("не нужно") || admin.includes("сдавать не нужно") || admin.includes("экзамены сдавать не нужно"))
    ) {
        return "В ответе агента указано, что экзамены нужно сдавать, а в правильном ответе сотрудника сказано, что экзамены сдавать не нужно.";
    }

    if (
        (answer.includes("нужен всем") || answer.includes("нужно всем") || answer.includes("всем поступающ")) &&
        (admin.includes("не нужен") || admin.includes("не нужно") || admin.includes("только при"))
    ) {
        return "В ответе агента указано общее обязательное условие для всех поступающих, а правильный ответ сотрудника содержит ограничение или исключение.";
    }

    const agentDates = extractFactTokens(agentAnswer, DATE_PATTERNS);
    const adminDates = extractFactTokens(adminAnswer, DATE_PATTERNS);
    if (agentDates.size && adminDates.size && !setsIntersect(agentDates, adminDates)) {
        return `В ответе агента указаны даты ${[...agentDates].join(", ")}, а в правильном ответе - ${[...adminDates].join(", ")}.`;
    }

    const agentPlaces = extractFactTokens(agentAnswer, PLACE_PATTERNS);
    const adminPlaces = extractFactTokens(adminAnswer, PLACE_PATTERNS);
    if (agentPlaces.size && adminPlaces.size && !setsIntersect(agentPlaces, adminPlaces)) {
        return `В ответе агента указаны адресные маркеры ${[...agentPlaces].join(", ")}, а в правильном ответе - ${[...adminPlaces].join(", ")}.`;
    }

    return "";
}

function detectSourceAnswerContradiction(agentAnswer, agentSourceText, adminAnswer) {
    const answer = normalizeText(agentAnswer);
    const source = normalizeText(agentSourceText);
    const admin = normalizeText(adminAnswer);
    if (!answer || !source) return null;

    const reference = `${source} ${admin}`.trim();
    const referenceTokens = meaningfulTokens(reference);
    const answerTokens = meaningfulTokens(answer);
    const overlapWithSource = tokenOverlap(answerTokens, meaningfulTokens(source));
    const overlapWithAdmin = admin ? tokenOverlap(answerTokens, meaningfulTokens(admin)) : 0;
    const extraTerms = answerTokens
        .filter(term => !referenceTokens.includes(term))
        .filter(term => !STOP_WORDS.has(term))
        .slice(0, 8);

    const restrictionTerms = [
        "лишь", "только", "исключительно", "аспирант", "аспирантам", "магистр", "магистрам",
        "бакалавр", "бакалаврам", "всем", "очной", "заочной", "студентам"
    ];
    const directContradiction =
        (answer.includes("лишь") || answer.includes("только") || answer.includes("исключительно")) &&
        (source.includes("всем") || admin.includes("всем")) &&
        extraTerms.length > 0;

    const sourceAndAdminAgree = !admin || tokenOverlap(meaningfulTokens(source), meaningfulTokens(admin)) >= 0.55;

    if (sourceAndAdminAgree && directContradiction && overlapWithSource < 0.75 && overlapWithAdmin < 0.75) {
        return {
            extraTerms,
            referenceFragment: agentSourceText || adminAnswer
        };
    }

    return null;
}

const DATE_PATTERNS = [
    { key: "20 июня", pattern: /20\s+июн/ },
    { key: "24 июня", pattern: /24\s+июн/ },
    { key: "27 мая", pattern: /27\s+ма/ },
    { key: "25 июля", pattern: /25\s+июл/ },
    { key: "30 июля", pattern: /30\s+июл/ },
    { key: "9 августа", pattern: /9\s+август/ },
    { key: "6 августа", pattern: /6\s+август/ },
    { key: "22 августа", pattern: /22\s+август/ }
];

const PLACE_PATTERNS = [
    { key: "Грибоедова", pattern: /грибоедов/ },
    { key: "Помяловского", pattern: /помяловск/ },
    { key: "Марата", pattern: /марат/ },
    { key: "Прилукская", pattern: /прилукск/ },
    { key: "Красноармейская", pattern: /красноармейск/ },
    { key: "Москательный", pattern: /москательн/ },
    { key: "Чкаловский", pattern: /чкаловск/ },
    { key: "Воронежская", pattern: /воронежск/ },
    { key: "Косыгина", pattern: /косыгин/ },
    { key: "Новоизмайловский", pattern: /новоизмайловск/ }
];

function extractFactTokens(text, patterns) {
    const normalized = normalizeText(text);
    const result = new Set();

    patterns.forEach(item => {
        if (item.pattern.test(normalized)) result.add(item.key);
    });

    return result;
}

function setsIntersect(a, b) {
    for (const value of a) {
        if (b.has(value)) return true;
    }

    return false;
}

function isIncompleteAnswer(agentAnswer, adminAnswer, missingImportantTerms) {
    const answerLength = normalizeText(agentAnswer).length;
    const adminLength = normalizeText(adminAnswer).length;
    if (adminLength > 120 && answerLength < adminLength * 0.62) return true;
    return missingImportantTerms.length >= 4;
}

function buildAnalysis({ reasonType, reasonTitle, reasonText, recommendation, evidence, suggestedSource, topSources }) {
    return {
        reasonType,
        reasonTitle,
        reasonText,
        recommendation,
        evidence,
        suggestedSource: suggestedSource || formatSourceTitle(topSources?.[0]),
        topSources: (topSources || []).map(source => ({
            id: source.id,
            score: source.score,
            searchMode: source.searchMode,
            embeddingModel: source.embeddingModel,
            fileName: source.fileName,
            pageNumber: source.pageNumber,
            sourceGroup: source.sourceGroup,
            preview: source.preview
        })),
        summary: `${reasonTitle}. ${reasonText}`,
        description: `${reasonTitle}. ${reasonText}`
    };
}

function isLlmConfigured() {
    const config = getLlmConfig();
    return config.provider === POLLINATIONS_PROVIDER || Boolean(config.apiKey);
}

function getLlmConfig() {
    const provider = (process.env.LLM_PROVIDER || "").trim().toLowerCase();
    const usePollinations = provider === POLLINATIONS_PROVIDER;

    return {
        provider: usePollinations ? POLLINATIONS_PROVIDER : "openai-compatible",
        endpoint: process.env.LLM_ENDPOINT || process.env.OPENAI_ENDPOINT || (usePollinations ? POLLINATIONS_LEGACY_ENDPOINT : DEFAULT_LLM_ENDPOINT),
        apiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || "",
        model: process.env.LLM_MODEL || process.env.OPENAI_MODEL || (usePollinations ? POLLINATIONS_MODEL : DEFAULT_LLM_MODEL),
        timeoutMs: Number(process.env.LLM_TIMEOUT_MS || (usePollinations ? 120000 : 20000)),
        maxTokens: Number(process.env.LLM_MAX_TOKENS || 1000),
        retryCount: Number(process.env.LLM_RETRY_COUNT || (usePollinations ? 2 : 0)),
        retryDelayMs: Number(process.env.LLM_RETRY_DELAY_MS || (usePollinations ? 15000 : 1500))
    };
}

async function requestLlmAnalysis(input, baseAnalysis) {
    const config = getLlmConfig();
    const payload = buildLlmPayload(config, input, baseAnalysis, true);
    let response = await callLlmEndpoint(config, payload);

    if (!response.ok && response.status === 400) {
        response = await callLlmEndpoint(config, buildLlmPayload(config, input, baseAnalysis, false));
    }

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`LLM вернула ${response.status}: ${errorText.slice(0, 300)}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("LLM не вернула текст ответа.");

    return parseLlmJson(content);
}

function buildLlmPayload(config, input, baseAnalysis, useResponseFormat) {
    const context = {
        task: "Проанализируй ошибку ответа агента приемной комиссии.",
        allowedReasonTypes: {
            "wrong-source": "неправильно выбран источник",
            "merged-rows": "объединил несколько строк или фрагментов",
            "nonexistent-direction": "появились лишние строки, направления или приписки",
            "incomplete-answer": "ответ неполный",
            "missing-agent-source": "источник агента не сохранен",
            "needs-review": "нужна ручная проверка"
        },
        question: input.question || "",
        agentAnswer: input.agentAnswer || "",
        agentSources: normalizeAgentSources(input.agentSources || []),
        adminAnswer: input.adminAnswer || input.correctAnswer || "",
        topSources: (baseAnalysis.topSources || []).slice(0, 5),
        localAnalysis: {
            reasonType: baseAnalysis.reasonType,
            reasonTitle: baseAnalysis.reasonTitle,
            reasonText: baseAnalysis.reasonText,
            recommendation: baseAnalysis.recommendation,
            evidence: baseAnalysis.evidence || []
        }
    };

    const payload = {
        model: config.model,
        messages: [
            {
                role: "system",
                content: [
                    "Keep reasonType exactly equal to localAnalysis.reasonType; improve only explanation, recommendation, evidence, suggestedSource, and description.",
                    "reasonText must be a connected explanation of 2-4 sentences: say what the agent answered, what the provided source/admin answer says, and why this is a contradiction or distortion.",
                    "recommendation must be concrete and tied to the case, not a generic request for manual checking.",
                    "In evidence, quote short text fragments from topSources or agentSources. Do not use only file names, source ids, or page numbers as evidence.",
                    "If agentSources contains text, treat it as the agent source even when fileName/pageNumber are empty. Never claim the source is absent only because a file, page, or URL is not provided.",
                    "Write all user-facing fields in Russian. Keep the JSON compact and valid.",
                    "Ты LLM-агент анализа ошибок для приемной комиссии.",
                    "Используй только переданные вопрос, ответ агента, источник агента, правильный ответ сотрудника и top-k источники.",
                    "Не придумывай факты и не добавляй источники извне.",
                    "Верни только JSON без markdown."
                ].join(" ")
            },
            {
                role: "user",
                content: JSON.stringify(context, null, 2)
            }
        ],
        temperature: 0.1,
        max_tokens: config.maxTokens
    };

    if (useResponseFormat) {
        payload.response_format = { type: "json_object" };
    }

    return payload;
}

async function callLlmEndpoint(config, payload) {
    const headers = {
        "Content-Type": "application/json"
    };

    if (config.apiKey) {
        headers.Authorization = `Bearer ${config.apiKey}`;
    }

    for (let attempt = 0; attempt <= config.retryCount; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

        try {
            const response = await fetch(config.endpoint, {
                method: "POST",
                signal: controller.signal,
                headers,
                body: JSON.stringify(payload)
            });

            if (!shouldRetryLlmResponse(config, response) || attempt === config.retryCount) {
                return response;
            }

            await response.text().catch(() => "");
        } catch (error) {
            if (attempt === config.retryCount) throw error;
        } finally {
            clearTimeout(timeout);
        }

        await sleep(config.retryDelayMs * (attempt + 1));
    }
}

function shouldRetryLlmResponse(config, response) {
    if (config.provider === POLLINATIONS_PROVIDER && [429, 503, 504].includes(response.status)) {
        return true;
    }

    return [503, 504].includes(response.status);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parseLlmJson(content) {
    const cleaned = String(content || "")
        .trim()
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "");

    const parsed = JSON.parse(cleaned);
    return {
        reasonType: parsed.reasonType || parsed.reason_type,
        reasonTitle: parsed.reasonTitle || parsed.reason_title,
        reasonText: parsed.reasonText || parsed.reason_text,
        recommendation: parsed.recommendation,
        evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
        suggestedSource: normalizeLlmSuggestedSource(parsed.suggestedSource || parsed.suggested_source),
        description: parsed.description || parsed.summary
    };
}

function normalizeLlmSuggestedSource(value) {
    if (!value) return "";
    if (typeof value === "string") {
        return /^(agentSources|topSources|sources|фрагмент)$/i.test(value.trim()) ? "" : value;
    }
    if (Array.isArray(value)) {
        return value
            .map(normalizeLlmSuggestedSource)
            .filter(Boolean)
            .join("; ");
    }

    if (typeof value === "object") {
        return formatSourceTitle({
            id: value.id,
            fileName: value.fileName || value.file_name || value.source || value.title || "",
            pageNumber: value.pageNumber || value.page_number || value.page || ""
        }) || value.id || "";
    }

    return String(value);
}

function mergeLlmAnalysis(baseAnalysis, llmAnalysis) {
    const allowReasonOverride = process.env.LLM_ALLOW_REASON_OVERRIDE === "1";
    const llmReasonType = normalizeReasonType(llmAnalysis.reasonType, baseAnalysis.reasonType);
    const reasonType = allowReasonOverride ? llmReasonType : baseAnalysis.reasonType;
    const reasonTypeMatches = llmReasonType === baseAnalysis.reasonType || !llmAnalysis.reasonType;
    const useLlmText = allowReasonOverride || reasonTypeMatches;
    const reasonTitle = useLlmText
        ? (llmAnalysis.reasonTitle || reasonTitleByType(reasonType) || baseAnalysis.reasonTitle)
        : baseAnalysis.reasonTitle;
    const hasAgentSource = baseAnalysis.reasonType !== "missing-agent-source";
    const reasonText = sanitizeSourceMetadataWording(useLlmText
        ? (llmAnalysis.reasonText || llmAnalysis.description || baseAnalysis.reasonText)
        : baseAnalysis.reasonText, hasAgentSource) || baseAnalysis.reasonText;
    const recommendation = sanitizeSourceMetadataWording(useLlmText
        ? (llmAnalysis.recommendation || baseAnalysis.recommendation)
        : baseAnalysis.recommendation, hasAgentSource) || baseAnalysis.recommendation;
    const rawEvidence = useLlmText && llmAnalysis.evidence?.length ? llmAnalysis.evidence : baseAnalysis.evidence;
    const evidence = normalizeEvidenceForFragments(rawEvidence, baseAnalysis.topSources);
    const suggestedSource = baseAnalysis.suggestedSource === "Переданный фрагмент источника агента"
        ? baseAnalysis.suggestedSource
        : (useLlmText ? (llmAnalysis.suggestedSource || baseAnalysis.suggestedSource) : baseAnalysis.suggestedSource);
    const summary = `${reasonTitle}. ${reasonText}`;
    const config = getLlmConfig();

    return {
        ...baseAnalysis,
        reasonType,
        reasonTitle,
        reasonText,
        recommendation,
        evidence,
        suggestedSource,
        summary,
        description: sanitizeSourceMetadataWording(useLlmText ? (llmAnalysis.description || summary) : summary, hasAgentSource) || summary,
        llm: {
            used: true,
            provider: config.provider,
            model: config.model,
            endpoint: config.endpoint,
            suggestedReasonType: llmAnalysis.reasonType || null,
            reasonTypeLocked: !allowReasonOverride
        }
    };
}

function normalizeReasonType(reasonType, fallback) {
    const allowed = new Set([
        "wrong-source",
        "merged-rows",
        "nonexistent-direction",
        "incomplete-answer",
        "missing-agent-source",
        "missing-admin-answer",
        "needs-review"
    ]);

    return allowed.has(reasonType) ? reasonType : fallback;
}

function reasonTitleByType(reasonType) {
    return {
        "wrong-source": "Неправильно выбран источник",
        "merged-rows": "Объединил несколько строк в одну",
        "nonexistent-direction": "Появились лишние строки или приписки",
        "incomplete-answer": "Ответ неполный",
        "missing-agent-source": "Не указан источник агента",
        "missing-admin-answer": "Нет правильного ответа сотрудника",
        "needs-review": "Причина требует проверки"
    }[reasonType];
}

function topEvidence(sources, title = "Фрагмент найденного источника") {
    if (!sources || !sources.length) return ["По правильному ответу не найдено близких источников."];

    const fragments = sources
        .slice(0, 3)
        .map((source, index) => formatSourceFragmentEvidence(source, index, title))
        .filter(Boolean);

    return fragments.length ? fragments : ["По правильному ответу не найдено текстовых фрагментов."];
}

function normalizeEvidenceForFragments(evidence, topSources = []) {
    const cleaned = (Array.isArray(evidence) ? evidence : [])
        .map(normalizeEvidenceText)
        .filter(Boolean)
        .filter(item => !isLocationOnlyEvidence(item));

    const hasTextFragment = cleaned.some(item => /«[^»]{40,}»/.test(item) || item.toLowerCase().includes("фрагмент"));
    if (!hasTextFragment) {
        topSources
            .slice(0, 2)
            .map((source, index) => formatSourceFragmentEvidence(source, index))
            .filter(Boolean)
            .forEach(item => cleaned.push(item));
    }

    return [...new Set(cleaned)].slice(0, 6);
}

function normalizeEvidenceText(item) {
    const text = String(item || "").replace(/\s+/g, " ").trim();
    if (!text) return "";

    const missingMetadataMatch = text.match(/(?:без реального файла|без указания файла|без файла|без номера страницы|не указан(?:ы)? файл|не указан(?:ы)? номер(?:а)? страницы)/i);
    if (missingMetadataMatch) {
        const quoted = text.match(/[«"]([^»"]{8,})[»"]/);
        return quoted ? `Фрагмент источника агента: «${quoted[1]}»` : "";
    }

    const agentSourceMatch = text.match(/^agent source\s*:?\s*["«](.+?)["»]\.?$/i);
    if (agentSourceMatch) {
        return `Фрагмент источника агента: «${agentSourceMatch[1]}»`;
    }

    const topSourceMatch = text.match(/^top source\s*\d*\s*:?\s*["«](.+?)["»]\.?$/i);
    if (topSourceMatch) {
        return `Фрагмент найденного источника: «${topSourceMatch[1]}»`;
    }

    return text;
}

function isLocationOnlyEvidence(item) {
    const lower = String(item || "").toLowerCase();
    const hasQuotedFragment = /«[^»]{40,}»/.test(item);
    if (hasQuotedFragment) return false;

    return (
        lower.startsWith("top-k") ||
        lower.includes("соответствует страниц") ||
        lower.includes("указаны страницы") ||
        lower.includes("без реального файла") ||
        lower.includes("без указания файла") ||
        lower.includes("без номера страницы") ||
        lower.includes("файла pp_") ||
        (lower.includes(".json") && (lower.includes("стр.") || lower.includes("страниц")))
    );
}

function dedupeSearchResults(results) {
    const seen = new Set();

    return results.filter(item => {
        const key = sourceDuplicateKey(item);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function sourceDuplicateKey(source) {
    const textKey = normalizeText(source?.text || source?.preview || "");
    if (textKey) return textKey.slice(0, 1200);
    return normalizeText(`${source?.fileName || ""} ${source?.pageNumber || ""}`) || source?.id || "";
}

function sanitizeSourceMetadataWording(text, hasAgentSource) {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    if (!value || !hasAgentSource) return value;

    return value
        .replace(/,\s*но\s+в\s+агентских\s+источниках[^.!?]*(?:без\s+реального\s+файла|без\s+указания\s+файла|без\s+файла|без\s+номера\s+страницы|номер[а]?\s+страницы)[^.!?]*/gi, "")
        .replace(/[^.!?]*(?:без\s+реального\s+файла|без\s+указания\s+файла|без\s+файла|без\s+номера\s+страницы|не\s+указан[аы]?\s+(?:файл|номер[а]?\s+страницы))[^.!?]*[.!?]/gi, "")
        .replace(/источник(?:и)?\s+агента\s+не\s+(?:сохранен|сохранены|указан|указаны)[^.!?]*[.!?]/gi, "")
        .replace(/\s{2,}/g, " ")
        .trim();
}

function formatSourceFragmentEvidence(source, index = 0, title = "Фрагмент найденного источника") {
    const fragment = makePreview(source?.preview || source?.text || "", 360);
    if (!fragment) return "";

    const score = source?.score ? ` Сходство: ${source.score}.` : "";
    return `${title} ${index + 1}: «${fragment}»${score}`;
}

function formatSourceTitle(source) {
    if (!source) return "";
    const parts = [];
    if (source.fileName) parts.push(source.fileName);
    if (source.pageNumber) parts.push(`стр. ${source.pageNumber}`);
    return parts.join(", ") || source.id || "";
}

function makePreview(text, maxLength = MAX_SOURCE_PREVIEW) {
    const normalized = String(text || "").replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength).trim()}...`;
}

function tokenize(text) {
    return normalizeText(text)
        .match(/[а-яa-z0-9]{3,}/g)
        ?.filter(token => !STOP_WORDS.has(token))
        .filter(token => !/^\d+$/.test(token) || token.length >= 4) || [];
}

function meaningfulTokens(text) {
    return [...new Set(tokenize(text))]
        .filter(token => token.length >= 4)
        .slice(0, 160);
}

function normalizeText(text) {
    return String(text || "")
        .toLowerCase()
        .replace(/ё/g, "е")
        .replace(/[‐‑‒–—]/g, "-");
}

function countTerms(tokens) {
    return tokens.reduce((acc, token) => {
        acc[token] = (acc[token] || 0) + 1;
        return acc;
    }, {});
}

function buildVector(termCounts, idf) {
    const vector = {};
    const entries = Object.entries(termCounts);
    const total = entries.reduce((sum, [, count]) => sum + count, 0) || 1;

    entries.forEach(([term, count]) => {
        vector[term] = (count / total) * (idf.get(term) || 0);
    });

    return vector;
}

function vectorNorm(vector) {
    return Math.sqrt(Object.values(vector).reduce((sum, value) => sum + value * value, 0));
}

function cosineSimilarity(a, aNorm, b, bNorm) {
    if (!aNorm || !bNorm) return 0;

    let dot = 0;
    const [small, large] = Object.keys(a).length < Object.keys(b).length ? [a, b] : [b, a];
    Object.keys(small).forEach(term => {
        if (large[term]) dot += small[term] * large[term];
    });

    return dot / (aNorm * bNorm);
}

function denseVectorNorm(vector) {
    return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

function denseCosineSimilarity(a, aNorm, b, bNorm) {
    if (!aNorm || !bNorm || !Array.isArray(a) || !Array.isArray(b)) return 0;

    const length = Math.min(a.length, b.length);
    let dot = 0;
    for (let index = 0; index < length; index += 1) {
        dot += a[index] * b[index];
    }

    return dot / (aNorm * bNorm);
}

function tokenOverlap(aTokens, bTokens) {
    const a = new Set(aTokens);
    const b = new Set(bTokens);
    if (!a.size || !b.size) return 0;

    let matches = 0;
    a.forEach(token => {
        if (b.has(token)) matches += 1;
    });

    return matches / Math.min(a.size, b.size);
}

function roundScore(value) {
    return Math.round(value * 10000) / 10000;
}

function getSourceStats() {
    const index = loadSourceIndex();
    const embeddingIndexExists = fs.existsSync(EMBEDDING_INDEX_PATH);

    return {
        sourcePath: index.sourcePath,
        textSources: index.docs.length,
        searchMode: EMBEDDING_DISABLED ? "tf-idf" : (embeddingRuntimeError ? "tf-idf-fallback" : "semantic-embeddings"),
        embeddingModel: EMBEDDING_DISABLED ? null : EMBEDDING_MODEL,
        embeddingIndexPath: EMBEDDING_DISABLED ? null : EMBEDDING_INDEX_PATH,
        embeddingIndexReady: embeddingIndexExists,
        embeddingRuntimeReady: !EMBEDDING_DISABLED && !embeddingRuntimeError,
        embeddingRuntimeError: embeddingRuntimeError ? embeddingRuntimeError.message : ""
    };
}

module.exports = {
    analyzeErrorCase,
    analyzeErrorCaseWithLlm,
    getSourceStats,
    prepareEmbeddingIndex: () => loadEmbeddingIndex({ allowBuild: true }),
    searchSources
};
