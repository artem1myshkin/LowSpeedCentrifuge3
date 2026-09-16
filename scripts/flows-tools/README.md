# flows-tools

Утилиты для правки и офлайн-проверки function/ui-template узлов `flows.json`.

- `extract.js <flows.json> <outDir>` — выгружает код узлов в `<outDir>/<tab>/<name>__<id>.js|.vue` (On Start функции — `*.init.js`).
- `inject.js <flows.json> <srcDir>` — записывает отредактированный код обратно (по id в имени файла), сохраняя CRLF и отступ 4 пробела без завершающего перевода строки (roundtrip без изменений для git).
- `fnharness.js <flows.json> <pkgDir>` — офлайн-прогон ключевых function-узлов (CommandHandler, ResponseParser, Tilt, DriveInitState, ScenarioManager, SettingsNormalize) с mock `global/flow/context`; `pkgDir` — путь к `packages/nc3-elmo-machines`.

Пример:

```bash
node scripts/flows-tools/fnharness.js flows.json packages/nc3-elmo-machines
```
