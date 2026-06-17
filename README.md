# LowSpeedCentrifuge3

# Rules

1. Ask, don't assume. If something is unclear or underspecified, ask before writing a single line. Never make silent assumptions about intent, architecture, or requirements.

2. Simplest solution first. Always implement the simplest thing that could work. Do not add abstractions, layers, or flexibility that weren't explicitly requested.

3. Don't touch unrelated code. If a file or function is not directly part of the current task, do not modify it, even if you think it could be improved.

4. Flag uncertainty explicitly. If you are not confident about an approach, a library's behavior, or a technical detail, say so before proceeding. Confidence without certainty causes more damage than admitting a gap.

5. For the actual and correct requirements, read the documentation related to the project. If it’s not enough, always ask for the full context.

6. Work with all project files as UTF-8. Do not change file encoding, line endings, or escaping unless the task explicitly requires it. Node-RED file nodes that write text files must use `utf8`.

7. Node-RED `function` node code is the body of a function, not a standalone module. Do not use `import`, `require`, `requier`, `export`, or `module.exports` inside flow functions. Return `msg`, `null`, `[msg1, msg2]`, or nested arrays for multiple messages on one output.

8. If a Node-RED function needs external modules, do not load them directly from the function. Configure them through Node-RED settings (`functionGlobalContext` or explicitly enabled external modules) and access them via the provided context/API.

9. Dashboard 2 `ui-template` code runs in the browser, so it cannot read Node-RED `global`/`flow` context directly. Backend state must be passed through messages on `reread`/init flows. UI commands must use `this.send({ topic, payload })`, and UI state refresh should use `msg` watchers or `this.$socket.on("msg-input:" + this.id, ...)`.

10. Do not add module-style JavaScript to `ui-template` nodes. The current Dashboard 2 templates may use the documented Options API wrapper, but helper logic must stay self-contained and must not use `import`, `require`, or CommonJS.

11. Dashboard 2 `ui-template` nodes that receive backend messages must keep `passthru` disabled (`passthru=false`) unless a deliberate echo path is required and documented. With `passthru=true`, incoming backend messages are emitted from the template output and can create feedback/rerender loops when the template is wired back to backend services.

Node-RED references used for these rules:

- [Writing Functions](https://nodered.org/docs/user-guide/writing-functions)
- [Dashboard 2 ui-template](https://dashboard.flowfuse.com/nodes/widgets/ui-template.html)


# Описание проекта

LowSpeedCentrifuge3 — Node-RED Dashboard 2 проект для стенда НЦ-3/2. Основной production-flow хранится в `flows.json`; reusable-логика транспорта ELMO, парсинга, очередей, пересчета разрешений и сценариев вынесена в `packages/nc3-elmo-machines`.

Перед доработкой проекта читать:

1. `project-memory/README.md` — постоянная память проекта и порядок навигации.
2. `project-memory/current-state.md` — краткое текущее состояние.
3. `project-memory/technical-notes.md` — технические инварианты и ограничения.
4. `docs/project-state.md` — расширенное состояние проекта.
5. `flows.json` — окончательная истина по текущему Node-RED flow.

Основная документация:

- `docs/operator-manual.md` — руководство оператора в Markdown.
- `docs/project-state.md` — фактическое состояние проекта, реализованные функции и роадмап.
- `docs/protocols-and-integrations.md` — интеграции ELMO/БУН/БЕП, протоколы, файлы данных и журнал.
- `docs/scenario-feature-summary.md` — сценарный режим, формат `.scn`, runtime и UI-редактор.
- `docs/xstate-elmo-design.md` — дизайн и журнал решений по ELMO XState/UDP.
- `docs/xstate-elmo-status.md` — краткий статус транспорта ELMO и стоп-линии для доработок.
- `docs/xstate-elmo-files.md` — per-file справочник пакета `nc3-elmo-machines`.

Runtime-окружение стенда использует `C:\NC3`: настройки, сценарии, протоколы, data-файлы и persistent-журнал событий. Пользовательские runtime-сценарии из `C:\NC3\scenarios` не попадают в git автоматически.
