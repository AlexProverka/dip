# Деплой проекта на Render

Этот вариант нужен, чтобы приложение работало даже при выключенном компьютере.

## Что загружать

Загружай на GitHub только рабочие файлы приложения:

- `server.js`
- `script.js`
- `index.html`
- `style.css`
- `package.json`
- `render.yaml`
- `.node-version`
- `spbgeu-icon.svg`
- `spbgeu-icon.png`
- `spbgeu-icon-source.png`

Не нужно загружать:

- `node_modules`
- `data/dialogs.sqlite`
- `*.log`
- архивы `.rar`
- документы для диплома

## Render

1. Создай репозиторий на GitHub, например `geu-dialog`.
2. Загрузи туда файлы проекта.
3. Открой Render.
4. Нажми `New` -> `Web Service`.
5. Подключи репозиторий.
6. Укажи настройки:

```text
Runtime: Node
Build Command: пусто
Start Command: node --no-warnings server.js
Health Check Path: /api/health
```

Render выдаст постоянную ссылку вида:

```text
https://geu-dialog.onrender.com
```

Через эту ссылку приложение будет открываться с другого Wi-Fi и другого компьютера, даже если твой компьютер выключен.

## Важный нюанс про базу

SQLite-файл `data/dialogs.sqlite` на бесплатном Render может сбрасываться при перезапуске сервиса. Для показа диплома и проверки конкурсных списков это нормально. Если нужно постоянно хранить историю диалогов, потом лучше заменить SQLite на внешнюю базу, например Postgres.
