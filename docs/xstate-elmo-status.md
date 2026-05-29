# XState-машина транспорта ELMO — статус

## Актуализация 2026-05-29

Стоп-линия сдвинута: `ScenarioManager` runtime теперь подключен к production-flow. Он не открывает отдельный транспорт, а использует существующий `CommandHandler -> ELMO XState (UDP) -> ResponseParser` и получает события `CMD.ACKED`/`CMD.FAILED` из `ELMO event bus out`.

Текущий контракт poll:

- обычный poll: фиксированные 2 Гц, `TM/PX/VX`, используется для UI и ожидания `Готов` в сценарии;
- raw poll: до 30 Гц только при активной записи и флаге raw, `TM/PX`, используется для `angle_buffer`;
- `CMD.ACKED` и `CMD.FAILED` теперь содержат `topic` и `meta`, чтобы сценарный runtime мог отличить ack `set_jv` от остальных команд.

`node --test` в `packages/nc3-elmo-machines` проходит: 52 теста.

Актуально на: 2026-05-29. Документ для AI-агента: что уже сделано, что НЕ сделано, какие контракты не ломать.

Полное описание фичи и решений — [xstate-elmo-design.md](xstate-elmo-design.md). Краткий per-file справочник — [xstate-elmo-files.md](xstate-elmo-files.md).

## Где сейчас стоп-линия

| Слой | Состояние | Где |
|---|---|---|
| Пакет `nc3-elmo-machines` | **Готов**, 52 теста зелёные | `packages/nc3-elmo-machines/` |
| Node-RED-обвязка (вкладка `ELMO XState (UDP)`) | **Готова**, production-команды подключены через link bus | `flows.json`, генератор `flows/elmo-xstate-udp/build-flow.js` |
| ScenarioManager (Этап 2) | **Готова первая рабочая интеграция**: parser/helpers, `.scn` файлы, UI start/stop, ожидание `Готов`, автозапись протокола | `flows.json`, `packages/nc3-elmo-machines/src/scenario.js`, `scenarios/*.scn` |
| Миграция legacy `new ui flow` (Этап 3) | **Частично**: UI-команды ELMO/`tilt_brake` идут через XState/UDP, legacy TCP-узлы отключены | `BUN flow`, `new ui flow`, `ELMO XState (UDP)` |

## Что реализовано (коммиты)

- `1c383fb` — первичный rework TCP `sit` → UDP (был ошибочно с батчем, переоткатан ниже).
- `1a90c28` — атомарные одно-параметровые команды (фикс батч-проблемы ELMO).
- `7b9b46f` — компенсация Windows-тика (`pollOptions.timerCompensationMs`).

Каждый — на `main` (FF-merge из worktree).

### Конкретные технические инварианты

- **Транспорт по UDP**, addr `192.168.1.2:5001`, локальный bind `:5005`. См. `flows.json` узлы `9eebec7a9fcbd4c5` (udp out) и `9dcb69eb8ba2c5f5` (udp in).
- **Один сериализованный in-flight.** Никогда не отправляй два запроса параллельно — UDP не парный, корреляция запрос/ответ держится на single-in-flight + порядке.
- **Атомарные команды.** Каждый логический poll — это `cmds: ['TM','PX','VX']` (data), реассемблируется в один логический raw. **Не возвращай батч `TM;PX;VX;` в одну команду** — ELMO отдаёт по датаграмме на параметр.
- **Эффект `sendCmd` (не `sendTcp`)**, нет `resetTcp`/socket-reset (UDP connectionless).
- **Soft timeout.** Один пропущенный ответ → `idle`, не fault. После `maxMisses` подряд (дефолт 3) → `offline` → self-heal через `RECONNECT_DELAY`.
- **`pollOptions.timerCompensationMs: 8`** задано в `flows.json` для Windows. Не убирай — без этого 30 Гц цели даёт ~22 Гц фактических.
- **Подтверждающий poll** после `MO=`, `OL[1]=`, `OL[2]=`, `AF=` — это часть контракта; меняешь — обновляй `confirmPollRoleFor` и тесты.

## Что НЕ реализовано (известные ограничения)

1. **Полный pause/resume сценариев** ещё не реализован. Есть штатные `scenario_start`/`scenario_stop`; продолжение после аварии и восстановление остатка выдержки оставлены на следующую итерацию.
2. **CommandGate для конфликтующих ручных команд** ещё не выделен. Сейчас `ScenarioManager` отправляет команды через общий путь, но ручной UI не блокируется отдельным арбитром.
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

Должно быть `# pass 52` за ~200–300 мс.

## Как протестировать на стенде

После git-pull на хосте Node-RED:

1. Перезапустить Node-RED (или сервис) — пакет грузится через `functionGlobalContext`, перезагрузка flow её не обновит.
2. На вкладке `ELMO XState (UDP)` использовать inject-узлы:
   - `manual cmd (VX)` — разовая команда.
   - `poll mode: raw fast 30Hz` — переключить в fast-режим 30 Гц.
   - `poll mode: settings/global` — сбросить override обратно в `global.settings`.
3. Смотреть debug `poll rate (valid frames/sec)` — должно быть ~30–32 Гц на 30 Гц цели.
4. `POLL.BAD_FRAME` в debug `transport events (out2)` не должны идти. Если идут — это сигнал, что либо контракт сломан, либо ELMO ведёт себя нештатно (см. § рассинхрон ниже).

## Контракты, которые НЕ ломать без согласования

- **API `effects`** (`sendCmd`, `forwardResp`, `emitEvent`, `setStatus`, `now`, `timeoutMs`, `connectTimeoutMs`, `reconnectMs`, `maxMisses`, `statePeriodMs`, `probeCmd`, `initialFullState`, `pollOptions`). Это контракт между пакетом и Node-RED-обвязкой.
- **События `UI.CMD`/`POLL.TICK`/`POLL.FULL_STATE`/`POLL.CONFIG`/`CONNECT`/`ELMO.RESP`/`ELMO.TIMEOUT`** — входной API машины.
- **Выходные `CMD.ACKED`/`CMD.FAILED`/`POLL.BAD_FRAME`** — потребители (UI/сценарий) подписываются на них.
- **`topic` ответов** (`poll_data`/`poll_state`/`poll_fast`) — `ResponseParser` и `angle_buffer` фильтруют по этим строкам.
- **Атомарность poll и single-in-flight.** Менять только если ELMO выкатит надёжный «батч-режим» (сейчас стенд показал, что не выкатит).

## Где смотреть для понимания

- Дизайн и журнал решений — [xstate-elmo-design.md](xstate-elmo-design.md).
- Карта файлов пакета — [xstate-elmo-files.md](xstate-elmo-files.md).
- Сценарий измерения (Этап 2) — `scenario-feature-summary.md`.
- Протоколы и legacy-flow — `protocols-and-integrations.md`.
- Память проекта — `[[project-xstate-integration]]`.

## При рассинхроне (`POLL.BAD_FRAME` идут потоком)

Симптомы: `POLL.BAD_FRAME { cmd: "X", raw: "Y;..." }` где `X` ≠ параметр в `raw`.

Это значит, что in-flight рассогласован с приходящими датаграммами. Самовосстановление: на следующем тике transport заново начинает sequence, остатки уходят как BAD_FRAME для текущего шага, цикл стабилизируется. Если не стабилизируется — возможные причины:

1. Не один владелец канала (где-то ещё открыт `udp out` или `tcp request` к ELMO). Проверить `netstat -ano | findstr :5005`.
2. Высокая потеря пакетов — `maxMisses` сработает, машина перейдёт в `offline` и переподключится. Проверить сеть.
3. ELMO перенастроен (firmware/конфиг). Проверить ручным `manual cmd (VX)` — ответ должен быть `VX;<число>;`.
