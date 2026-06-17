# XState-машина транспорта ELMO — статус

## Актуализация 2026-06-11

Добавлена корневая постоянная память проекта `project-memory/`. Для ELMO/XState быстрые инварианты теперь дублируются в `project-memory/technical-notes.md`, а этот документ остается подробной стоп-линией по транспортному слою.

По текущему `scenario.js` timeout достижения скорости сценария учитывает текущую скорость и замедление `DC`, включая случай разворота через ноль. Формула `abs(targetSpeed) / AC + 10 с` остается упрощенным описанием случая разгона от нуля; фактическая реализация шире.

Текущий production-путь ELMO — `CommandHandler -> ELMO XState (UDP) -> ResponseParser`; legacy TCP оставлен в `flows.json` выключенным fallback. `ScenarioManager` больше не является планом: он выполняет `.scn` файлы из `C:\NC3\scenarios`, переключает диапазоны, запускает `Drive Init`, ждет устойчивой скорости, ведет автоматическую запись шага и поддерживает `Пауза`/`Продолжить`/`Стоп`/`Аварийный стоп`.

Production Dashboard-команды теперь дополнительно проходят через remote-control `CommandGate`: он обеспечивает local/remote ownership и display-only поведение, но не является частью XState-транспорта ELMO.

Ключевые уточнения после стендовых правок:

- свежий буфер `PX/TM` используется как выбранная скорость для UI и сценариев и в `high`, и в `low`; `VX` сохраняется как `velocity_raw` и fallback, пока буфер не готов или устарел;
- timeout ожидания скорости сценария считается после ACK `set_jp`: от текущей скорости к целевой с учетом `AC`/`DC` и резервом 10 с;
- быстрый raw poll остается только `TM/PX`; normal poll остается `TM/PX/VX` 2 Гц;
- файл-редактор сценариев работает через `ScenarioFileService`, `global.scenario_files` и `global.scenario_documents`;
- после любого `MO=1` транспорт ждёт `SO=1` до 30 секунд; если `SO` не стал `1`, он отдаёт `CMD.FAILED(reason: 'so_timeout')` и отправляет аварийные `ST`, `MO=0`.
- `node --test` в `packages/nc3-elmo-machines` проходит: 59 тестов.

Актуально на: 2026-06-11. Документ для AI-агента: что уже сделано, что НЕ сделано, какие контракты не ломать.

Полное описание фичи и решений — [xstate-elmo-design.md](xstate-elmo-design.md). Краткий per-file справочник — [xstate-elmo-files.md](xstate-elmo-files.md).

## Где сейчас стоп-линия

| Слой | Состояние | Где |
|---|---|---|
| Пакет `nc3-elmo-machines` | **Готов**, 59 тестов зелёные | `packages/nc3-elmo-machines/` |
| Node-RED-обвязка (вкладка `ELMO XState (UDP)`) | **Готова**, production-команды подключены через link bus | `flows.json`, генератор `flows/elmo-xstate-udp/build-flow.js` |
| ScenarioManager (Этап 2) | **Готов**: `.scn` runtime, диапазоны, ACK-based timeout, авто-протоколирование, pause/resume/stop/emergency-stop | `flows.json`, `packages/nc3-elmo-machines/src/scenario.js`, `scenarios/*.scn` |
| Scenario UI/editor | **Готов**: каталог `C:\NC3\scenarios`, редактирование файлов, защита от фонового автоперевыбора | `flows.json` |
| Миграция legacy `new ui flow` (Этап 3) | **Выполнена для ELMO-команд**: UI-команды ELMO/`tilt_brake` идут через XState/UDP, legacy TCP-узлы отключены | `BUN flow`, `new ui flow`, `ELMO XState (UDP)` |

## Что реализовано (коммиты)

- `1c383fb` — первичный rework TCP `sit` → UDP (был ошибочно с батчем, переоткатан ниже).
- `1a90c28` — атомарные одно-параметровые команды (фикс батч-проблемы ELMO).
- `7b9b46f` — компенсация Windows-тика (`pollOptions.timerCompensationMs`).

Каждый — на `main` (FF-merge из worktree).

### Конкретные технические инварианты

- **Транспорт по UDP**, addr `192.168.1.2:5001`, локальный bind `:5005`. См. `flows.json` узлы `9eebec7a9fcbd4c5` (udp out) и `9dcb69eb8ba2c5f5` (udp in).
- **Один сериализованный in-flight.** Никогда не отправляй два запроса параллельно — UDP не парный, корреляция запрос/ответ держится на single-in-flight + порядке.
- **Атомарные команды.** Каждый логический data-poll — это `cmds: ['TM','PX','VX']`, fast raw — `cmds: ['TM','PX']`; транспорт реассемблирует части в один логический raw. **Не возвращай батч `TM;PX;VX;` в одну команду** — ELMO отдаёт по датаграмме на параметр.
- **Эффект `sendCmd` (не `sendTcp`)**, нет `resetTcp`/socket-reset (UDP connectionless).
- **Soft timeout.** Один пропущенный ответ → `idle`, не fault. После `maxMisses` подряд (дефолт 3) → `offline` → self-heal через `RECONNECT_DELAY`.
- **Ожидание `SO=1` после `MO=1`.** Транспорт переходит в `waitingForSoReady`, опрашивает `SO` и ждёт до `soReadyTimeoutMs` (дефолт 30000 мс). Таймаут → `CMD.FAILED(reason: 'so_timeout')` + аварийные `ST`, `MO=0`.
- **`pollOptions.timerCompensationMs: 8`** задано в `flows.json` для Windows. Не убирай — без этого 30 Гц цели даёт ~22 Гц фактических.
- **Подтверждающий poll** после `MO=`, `OL[1]=`, `OL[2]=`, `AF=` — это часть контракта; меняешь — обновляй `confirmPollRoleFor` и тесты.

## Что НЕ реализовано (известные ограничения)

1. **Частичное восстановление выдержки сценария** не реализовано. `scenario_pause`/`scenario_emergency_stop` сохраняют текущий шаг, но `scenario_resume` выполняет шаг заново.
2. **Сценарные интерлоки в `CommandGate`** ещё не добавлены. Remote-control `CommandGate` уже закрывает ownership local/remote, но не запрещает по состоянию сценария/движения/stale hardware все конфликтующие ручные команды.
3. **Legacy TCP fallback** оставлен в `flows.json`, но выключен. Рабочий production-путь ELMO теперь идёт через `ELMO XState (UDP)`.
4. **`timeBeginPeriod(1)` на хосте** не настроен. 30 Гц достигаются компенсацией таймера в Node-RED, но поведение зависит от текущей системной гранулярности Windows.
5. **Сценарии устойчивости при потерях.** Тестировался на «чистой» сети. Поведение при штормах потерь UDP не валидировано.
6. **Wrap счётчика `TM`** (uint32 µs, ~71.6 мин) не компенсируется. Для коротких записей не критично.
7. **Индекс аналогового входа давления** (`pollOptions.analogParam`) не задан — full-state poll давление не читает.

## Как протестировать локально

```sh
cd packages/nc3-elmo-machines
node --test
```

Должно быть `# pass 59` за ~200–400 мс.

## Как протестировать на стенде

После git-pull на хосте Node-RED:

1. Перезапустить Node-RED (или сервис) — пакет грузится через `functionGlobalContext`, перезагрузка flow её не обновит.
2. На вкладке `ELMO XState (UDP)` использовать inject-узлы:
   - `manual cmd (VX)` — разовая команда.
   - `poll mode: raw fast 30Hz` — переключить в fast-режим 30 Гц.
   - `poll mode: settings/global` — сбросить override обратно в `global.settings`.
3. Смотреть debug `poll rate (valid frames/sec)` — должно быть ~30–32 Гц на 30 Гц цели.
4. `POLL.BAD_FRAME` в debug `transport events (out2)` не должны идти. Если идут — это сигнал, что либо контракт сломан, либо ELMO ведёт себя нештатно (см. § рассинхрон ниже).
5. Для проверки сценариев нужен каталог `C:\NC3\scenarios` с `.scn` файлами. После `git pull` копируй базовые файлы из `scenarios\` в этот каталог; файлы, созданные через UI на стенде, копируй обратно в репозиторий вручную, если они должны попасть в git.

## Контракты, которые НЕ ломать без согласования

- **API `effects`** (`sendCmd`, `forwardResp`, `emitEvent`, `setStatus`, `now`, `timeoutMs`, `connectTimeoutMs`, `reconnectMs`, `maxMisses`, `soReadyTimeoutMs`, `statePeriodMs`, `probeCmd`, `initialFullState`, `pollOptions`). Это контракт между пакетом и Node-RED-обвязкой.
- **События `UI.CMD`/`POLL.TICK`/`POLL.FULL_STATE`/`POLL.CONFIG`/`CONNECT`/`ELMO.RESP`/`ELMO.TIMEOUT`** — входной API машины.
- **Выходные `CMD.ACKED`/`CMD.FAILED`/`POLL.BAD_FRAME`** — потребители (UI/сценарий) подписываются на них.
- **`topic` ответов** (`poll_data`/`poll_state`/`poll_fast`) — `ResponseParser` и `angle_buffer` фильтруют по этим строкам.
- **Атомарность poll и single-in-flight.** Менять только если ELMO выкатит надёжный «батч-режим» (сейчас стенд показал, что не выкатит).
- **Выбранная скорость**: не подменяй свежую `TM/PX`-оценку обратно на raw `VX`; сценарный критерий должен использовать `velocity_deg_per_sec` / `velocity_source='tm_px_buffer'`, если они пришли из `ResponseParser`.
- **Scenario timeout**: счетчик ожидания скорости стартует только после ACK `set_jp`, а не во время `set_resolution`/`Drive Init`; расчет учитывает текущую скорость, `AC`, `DC` и резерв.

## Где смотреть для понимания

- Дизайн и журнал решений — [xstate-elmo-design.md](xstate-elmo-design.md).
- Карта файлов пакета — [xstate-elmo-files.md](xstate-elmo-files.md).
- Сценарий измерения (Этап 2) — `scenario-feature-summary.md`.
- Протоколы и legacy-flow — `protocols-and-integrations.md`.
- Память проекта — `../project-memory/technical-notes.md` и `../project-memory/current-state.md`.

## При рассинхроне (`POLL.BAD_FRAME` идут потоком)

Симптомы: `POLL.BAD_FRAME { cmd: "X", raw: "Y;..." }` где `X` ≠ параметр в `raw`.

Это значит, что in-flight рассогласован с приходящими датаграммами. Самовосстановление: на следующем тике transport заново начинает sequence, остатки уходят как BAD_FRAME для текущего шага, цикл стабилизируется. Если не стабилизируется — возможные причины:

1. Не один владелец канала (где-то ещё открыт `udp out` или `tcp request` к ELMO). Проверить `netstat -ano | findstr :5005`.
2. Высокая потеря пакетов — `maxMisses` сработает, машина перейдёт в `offline` и переподключится. Проверить сеть.
3. ELMO перенастроен (firmware/конфиг). Проверить ручным `manual cmd (VX)` — ответ должен быть `VX;<число>;`.
