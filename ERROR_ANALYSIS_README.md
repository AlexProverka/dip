# Агент анализа ошибок

## Что подается на вход

Один проверяемый случай состоит из четырех полей:

- `question` - вопрос абитуриента;
- `agentAnswer` - ответ агента;
- `agentSources` - источник или источники, по которым агент сделал ответ;
- `adminAnswer` - правильный ответ сотрудника приемной комиссии.

## Как получаются тестовые данные

1. Вопросы взяты из присланного перечня.
2. Правильные ответы сотрудника ПК взяты с официальных страниц СПбГЭУ:
   - `https://unecon.ru/ob-universitete/organy-upravleniya-i-struktura/struct/obshchezhitiya/voprosy/`
   - `https://unecon.ru/chasto-zadavaemye-voprosy/`
   - `https://unecon.ru/priem/vopros-otvet/`
   - `https://unecon.ru/dod`
3. База источников для поиска лежит в `data/combined_data.json`.
4. При поиске игнорируются записи с `"label": "TABLE"`, используются только текстовые источники.
5. Ответ агента в тестах сделан искусственно: правильный ответ обрезается, смешивается с похожим ответом или получает лишнюю приписку.

## Как работает анализ

1. По `adminAnswer` запускается семантический поиск по embedding-индексу `combined_data`.
2. Текстовые источники переводятся в эмбеддинги моделью `Xenova/paraphrase-multilingual-MiniLM-L12-v2`, а затем сравниваются с эмбеддингом правильного ответа по cosine similarity.
3. Поиск возвращает `topK` наиболее близких текстовых источников.
4. Если embedding-модель недоступна, включается резервный локальный поиск TF-IDF, чтобы интерфейс и анализ не падали.
5. Агент сравнивает найденные источники с `agentSources` и самим `agentAnswer`.
6. Если задан API-ключ LLM, найденные источники и базовый анализ дополнительно отправляются в модель, которая формулирует итоговое описание ошибки в JSON.
7. Если API-ключа нет, используется локальная логика сравнения без внешней LLM.
8. На выходе формируется описание причины ошибки:
   - `wrong-source` - неправильно выбран источник;
   - `merged-rows` - объединены несколько строк или фрагментов;
   - `nonexistent-direction` - появились лишние строки или приписки;
   - `incomplete-answer` - ответ неполный;
   - `missing-agent-source` - источник агента не сохранен;
   - `needs-review` - нужна ручная проверка.

## Как запустить тест

```powershell
& 'C:\Users\Acer\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' run_error_analysis_tests.js
```

Тестовые кейсы лежат в `data/error_analysis_test_cases.json`.
Отчет создается в `data/error_analysis_report.json`.

## Как построить embedding-индекс

После установки зависимостей можно заранее построить индекс источников:

```powershell
npm install
npm run build:embeddings
```

Скрипт создает `data/source_embedding_index.json`. На Render это выполняется автоматически через `render.yaml`.

## Как включить LLM

По умолчанию проект работает без внешней модели. Чтобы включить LLM-слой, нужно задать переменную окружения:

```powershell
$env:OPENAI_API_KEY = "ваш_api_ключ"
$env:OPENAI_MODEL = "gpt-4o-mini"
```

После этого `/api/error-analysis` будет использовать LLM для финальной формулировки причины ошибки.

Проверка тестов с LLM:

```powershell
& 'C:\Users\Acer\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' run_error_analysis_tests.js --llm
```

Отчет с LLM создается в `data/error_analysis_report_llm.json`.

Если нужен другой OpenAI-compatible провайдер, можно задать:

### Pollinations без OpenAI-квоты

OpenAI-ключ не нужен, но данные отправляются во внешний LLM-сервис:

```powershell
$env:LLM_PROVIDER = "pollinations"
$env:LLM_MODEL = "openai-fast"
$env:LLM_TIMEOUT_MS = "120000"
$env:LLM_MAX_TOKENS = "1000"
& 'C:\Users\Acer\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' run_error_analysis_tests.js --llm
```

```powershell
$env:LLM_ENDPOINT = "https://api.openai.com/v1/chat/completions"
$env:LLM_API_KEY = "ваш_api_ключ"
$env:LLM_MODEL = "gpt-4o-mini"
```

## API

Поиск источников:

```http
POST /api/source-search
```

```json
{
  "query": "правильный ответ сотрудника",
  "topK": 5
}
```

Анализ ошибки:

```http
POST /api/error-analysis
```

```json
{
  "question": "Вопрос абитуриента",
  "agentAnswer": "Ответ агента",
  "agentSources": [
    {
      "title": "Название источника",
      "text": "Фрагмент, который использовал агент"
    }
  ],
  "adminAnswer": "Правильный ответ сотрудника",
  "topK": 5
}
```
