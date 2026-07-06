# KPI

## Состав очищенного проекта

- `database/kpi.sqlite`: текущая рабочая база KPI.
- `database/kpi_init.sql`: схема и служебный SQL для базы.
- `database/import_kpi_workbook.js`: импорт основного KPI workbook в базу.
- `database/parse_kpi_workbook.ps1`: парсер workbook для импорта.
- `database/xlsx_upload_parser.js`: парсер Excel-загрузок для дисциплины и согласования договоров.
- `viewer/`: локальный интерфейс просмотра и загрузки данных.
- `inputs/`: исходные Excel-файлы, которые участвуют в пересчёте и загрузках.

## Что сознательно не перенесено

- `server*.log`, `*.tmp`, `tmp-workbook.json` и прочие временные артефакты.
- резервные и промежуточные SQLite/JSON-файлы.
- текстовые заметки, промпты и HTML-черновики, не участвующие в расчётах.

## Быстрый запуск

1. Откройте папку `viewer`.
2. Запустите `start-localhost.cmd`.
3. Локальный сервер поднимется на порту по умолчанию из `viewer/server.js`.
