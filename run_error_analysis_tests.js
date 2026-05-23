const fs = require("fs");
const path = require("path");
const {
    analyzeErrorCase,
    analyzeErrorCaseWithLlm,
    getSourceStats
} = require("./error_analysis_agent");

const CASES_PATH = path.join(__dirname, "data", "error_analysis_test_cases.json");
const USE_LLM = process.argv.includes("--llm");
const REPORT_PATH = path.join(__dirname, "data", USE_LLM
    ? "error_analysis_report_llm.json"
    : "error_analysis_report.json");

async function main() {
    const cases = JSON.parse(fs.readFileSync(CASES_PATH, "utf8"));
    const stats = getSourceStats();
    const analyzer = USE_LLM ? analyzeErrorCaseWithLlm : analyzeErrorCase;

    const results = [];
    for (const testCase of cases) {
        const analysis = await analyzer({
            question: testCase.question,
            agentAnswer: testCase.agent_answer,
            agentSources: testCase.agent_sources,
            adminAnswer: testCase.admin_answer,
            topK: 5
        });

        results.push({
            id: testCase.id,
            question: testCase.question,
            expected_error_type: testCase.expected_error_type,
            actual_error_type: analysis.reasonType,
            matched_expected: analysis.reasonType === testCase.expected_error_type,
            description: analysis.description,
            suggested_source: analysis.suggestedSource,
            top_sources: analysis.topSources,
            evidence: analysis.evidence,
            llm: analysis.llm || { used: false }
        });
    }

    const report = {
        generatedAt: new Date().toISOString(),
        mode: USE_LLM ? "llm" : "local",
        sourceStats: stats,
        total: results.length,
        matchedExpected: results.filter(item => item.matched_expected).length,
        results
    };

    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");

    console.log(`Источник: ${stats.sourcePath}`);
    console.log(`Текстовых источников: ${stats.textSources}`);
    console.log(`Режим: ${USE_LLM ? "LLM" : "локальный"}`);
    if (USE_LLM) {
        const llmUsed = results.filter(item => item.llm?.used).length;
        const llmErrors = results.filter(item => item.llm?.error).length;
        console.log(`LLM вызвана: ${llmUsed}/${results.length}`);
        if (llmUsed === 0 && llmErrors === 0) {
            console.log("LLM-ключ не задан, все кейсы обработаны локальным fallback.");
        } else if (llmErrors > 0) {
            console.log(`LLM не дала успешный ответ для ${llmErrors} кейсов, использован локальный fallback. Детали есть в отчете.`);
        }
    }
    console.log(`Тестов: ${report.total}`);
    console.log(`Совпало с ожидаемой меткой: ${report.matchedExpected}/${report.total}`);
    console.log(`Отчет: ${REPORT_PATH}`);
    console.log("");

    results.forEach(item => {
        const status = item.matched_expected ? "OK" : "CHECK";
        console.log(`[${status}] ${item.id}: ${item.actual_error_type} — ${item.question}`);
        console.log(`  ${item.description}`);
        if (item.llm?.used) console.log(`  LLM: ${item.llm.model}`);
        if (item.suggested_source) console.log(`  Источник: ${item.suggested_source}`);
    });
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
