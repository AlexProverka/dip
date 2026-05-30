const { getSourceStats, prepareEmbeddingIndex } = require("./error_analysis_agent");

async function main() {
    const statsBefore = getSourceStats();
    console.log(`Источник: ${statsBefore.sourcePath}`);
    console.log(`Текстовых источников: ${statsBefore.textSources}`);
    console.log(`Embedding-модель: ${statsBefore.embeddingModel}`);
    console.log(`Файл индекса: ${statsBefore.embeddingIndexPath}`);

    const index = await prepareEmbeddingIndex();

    console.log(`Готово: ${index.docs.length} embedding-фрагментов`);
    console.log(`Модель: ${index.model}`);
    console.log(`Индекс: ${index.indexPath}`);
}

main().catch(error => {
    console.error("Не удалось построить embedding-индекс:", error);
    process.exitCode = 1;
});
