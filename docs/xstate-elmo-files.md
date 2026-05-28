# Пакет `nc3-elmo-machines` — справочник по файлам

Актуально на: 2026-05-28. Краткая карта: что в каком файле и какие функции. Без полного кода — за деталями в `packages/nc3-elmo-machines/src/`.

Поведение системы целиком — [xstate-elmo-design.md](xstate-elmo-design.md). Текущее состояние — [xstate-elmo-status.md](xstate-elmo-status.md).

`ElmoTransport` — **транспортная** XState-машина (один владелец UDP-канала к ELMO, очередь, опрос), не машина процесса измерения. Машина чистая: весь ввод-вывод вынесен в `effects`, тестируется через `node --test` без Node-RED.

## Карта файлов

| Файл | Роль |
|---|---|
| `index.js` | Точка входа: реэкспорт публичного API. |
| `elmoTransport.js` | XState-машина транспорта: состояния, очередь, атомарный poll, ACK/таймауты. |
| `poll.js` | Построение poll-конвертов и расчёт частоты опроса. |
| `parse.js` | Минимальный парсер скаляров из ответа ELMO (для решений транспорта). |
| `queue.js` | Приоритетная очередь с одним in-flight. |
| `res.js` | Константы разрешения энкодера, пересчёт °↔ticks. |
| `util.js` | Мелочи (`ensureCr`, `clamp`). |

---

## `index.js`

Реэкспортирует: `createElmoTransport`, `startElmoTransport`, `parseElmoScalars`, `RES`, `ticksPerRev`, `ticksPerDeg`, `degPerSecToTicks`, `priorityInsert`, `dequeue`, `PRIORITY`, `DATA_POLL`, `buildPollEnvelope`, `buildStatePoll`, `buildFullStatePoll`, `computePollDelayMs`, `omegaDegPerSec`, `computeRateHz`, `ensureCr`.

Пакет грузится в Node-RED через `functionGlobalContext` (`global.get('nc3')`), `xstate` — внутренняя зависимость.

---

## `elmoTransport.js`

### Фабрики

| Функция | Назначение |
|---|---|
| `createElmoTransport(effects)` | Собирает и возвращает XState-машину с заданными эффектами. |
| `startElmoTransport(effects, input)` | `createActor(...).start()` за один вызов. |

### `effects` (DI)

| Эффект | Назначение | Дефолт |
|---|---|---|
| `sendCmd(cmd)` | Отправить одну командную датаграмму (`udp out`). | no-op |
| `forwardResp(raw, topic)` | Переслать сырой склеенный ответ дальше с восстановленным topic. | no-op |
| `emitEvent(evt)` | Доменное событие (`CMD.ACKED/FAILED`, `POLL.BAD_FRAME`). | no-op |
| `setStatus(st)` | `node.status(...)`. | no-op |
| `now()` | Часы. Инъектируемы. | `Date.now` |
| `timeoutMs` | Watchdog ответа. | `1000` |
| `connectTimeoutMs` | Watchdog probe. | `2000` |
| `reconnectMs` | Пауза `offline` перед повторным probe. | `1000` |
| `maxMisses` | Подряд таймаутов до `offline`. | `3` |
| `statePeriodMs` | Минимальный период state-poll. | `1000` |
| `probeCmd` | Команда probe. | `'TM'` |
| `initialFullState` | Full-state после connect. | `true` |
| `pollOptions` | `{ minHz, maxHz, analogParam, timerCompensationMs }`. | `{}` |

### Контекст (ключевое)

`queue` (приоритетная очередь), `inFlight` (текущий запрос с `cursor`/`parts` для атомарного poll), `resolution`, `vx`, `omegaSource` (`measured`/`setpoint`), `setpointDegS`, `lastExtendedAt`, `missCount`, `pollConfig`/`fastRawActive`, `fastStable`/`fastStableCount`/`lastFastVx`/`lastFastPollStartedAt`.

### Guards / delays

| Имя | Тип | Назначение |
|---|---|---|
| `hasWork` | guard | В очереди есть запрос. |
| `tooManyMisses` | guard | После инкремента число пропусков достигнет `maxMisses`. |
| `hasNextPollPart` | guard | Текущий poll — атомарный батч, пришедшая часть валидна и есть ещё команды. |
| `POLL_DELAY` | delay | `computePollDelayMs` для самотактируемого poll. |
| `TIMEOUT` | delay | Watchdog ответа = `timeoutMs`. |
| `CONNECT_TIMEOUT` | delay | Watchdog probe = `connectTimeoutMs`. |
| `RECONNECT_DELAY` | delay | Пауза в `offline` перед повторным probe. |

### Actions

| Action | Назначение |
|---|---|
| `enqueueCmd` | Положить команду в очередь; при `setpointDegS` включить setpoint-источник. |
| `enqueuePoll` | Поставить data- (и при необходимости state-) poll; в fast-режиме — `fast_seek`/`fast_data`; dedup по роли. |
| `enqueueFullStatePoll` / `enqueueInitialFullStatePoll` | Полный диагностический poll (вручную / после connect). |
| `enqueueConfirmPoll` | После `MO=`/`OL[1]=`/`OL[2]=`/`AF=` поставить подтверждающий poll. |
| `enqueueDiagnosticOnBadPoll` | На невалидный fast-кадр поставить `full_state` с приоритетом `init` и сбросить fast-стабильность. |
| `takeNext` | Снять головной запрос из очереди; для fast-poll зафиксировать `lastFastPollStartedAt`. |
| `sendInFlight` / `sendProbe` | Отправить через `sendCmd` текущую команду (`cmds[cursor]`) / probe. |
| `collectPollPart` | Принять валидную часть атомарного poll: добавить raw в `parts`, инкрементировать `cursor`. |
| `ingestResp` | Из реассемблированного `rawFor(env,raw)` обновить контекст и fast-стабильность. Не заменяет `ResponseParser`. |
| `forwardAndAck` | Валидировать через `responseValidation`; невалидно → `POLL.BAD_FRAME` (с `part`/`cmd`); валидно → `forwardResp` + (для команд) `CMD.ACKED`. |
| `failInFlight` | Для команды — `CMD.FAILED` (`reason: 'timeout'`). |
| `bumpMiss` / `resetMiss` | Инкремент/сброс счётчика пропусков. |
| `freeInFlight` | Очистить `inFlight`. |
| `configurePoll` | Применить `POLL.CONFIG`. |
| `statusOffline`/`Connecting`/`Idle`/`Busy` | `node.status(...)`. |

### Внутренние хелперы

`normalizeEnvelope` (нормализация конверта), `pollRoleOf`/`topicFor`/`isAckable`, `hasPollRole`/`hasAnyFastPoll`/…`InFlight` (dedup), `isBatchPoll`/`cursorOf`/`commandFor`/`rawFor` (атомарный multi-part: какая команда сейчас и как склеить части), `validatePollResponse` / `validateCurrentPollPart` / `responseValidation` (валидация целого кадра, текущей части, и их комбинации), `confirmPollRoleFor`, `fastStabilityPatch`, `normalizePollConfig`/`shouldFastPoll`/`fastPollRoleFor`.

### Состояния

`offline` → `connecting` → `connected{idle, sending, awaiting, sendingNextPart, dispatch}` → (на ошибке) `offline`. Полная state-диаграмма с переходами — в [xstate-elmo-design.md §3.4](xstate-elmo-design.md).

Входные события: `UI.CMD`, `POLL.TICK`, `POLL.FULL_STATE`, `POLL.CONFIG`, `CONNECT`, `ELMO.RESP`, `ELMO.TIMEOUT`.

---

## `poll.js`

UDP + атомарные команды: один логический poll — последовательность `cmds` (по одной команде на параметр), каждая → одна датаграмма-ответ, потом транспорт собирает части в один логический raw.

| Функция / константа | Назначение |
|---|---|
| `DATA_POLL` / `LEAN_POLL` | `'TM;PX;VX;'` — display-константа (поля data-poll), не отправляется как одна строка. |
| `buildPollFields(role, options)` | Список полей роли (`data`/`state`/`full_state`/`fast_seek`/`fast_data`); `analogParam` опционально для full_state. |
| `buildStatePoll` / `buildFullStatePoll` (`buildExtendedPoll`) | Текстовое представление полей (display). |
| `buildPollEnvelope(args)` | Конверт poll: `cmds` (атомарные команды), `cursor`/`parts`, `cmd = cmds[0]`, `required` (полный список ключей), `partRequired` (по каждой части), `priority`, `pollRole`, `meta.topic`. |
| `shouldExtend(lastExtendedAt, now, statePeriodMs)` | Пора ли добавить медленный state-poll. |
| `omegaDegPerSec(vx, resolution)` | `VX` (ticks/s) → °/с по разрешению. |
| `computeRateHz(omega, options)` | `clamp(|ω|/12, minHz, maxHz)`. |
| `computePollDelayMs(context, options)` | Задержка до следующего poll. В fast-режиме — start-to-start от `fastRawPollHz`. `options.timerCompensationMs` (дефолт 0) вычитается перед `max(1,...)` — компенсация гранулярности Windows-таймера. |

Роли: `data` (`TM`, `PX`, `VX`), `state` (`MO`, `SO`, `SR`), `full_state` (`MS`, `MO`, `SO`, `SR`, `AF`, `OL[1]`, `OL[2]`), `fast_seek` (`VX`, `PX`), `fast_data` (`VX`, `PX`, `TM`).

---

## `parse.js`

| Функция | Назначение |
|---|---|
| `parseElmoScalars(raw)` | Достаёт из сырого ответа только нужные транспорту скаляры (`TM`, `PX`, `VX`, `MS`, `MO`, `SO`, `SR`, `AF`, `OL[1]`, `OL[2]`). Понимает `PARAM=VALUE`, `PARAM;VALUE`, `PARAM\rVALUE`; для дублей берёт последнее. `OL[1]=1` → `resolution='low'`. Не заменяет доменный `ResponseParser`. |

---

## `queue.js`

Единая сериализованная очередь, один in-flight. Приоритет: `cmd`/`init`(3) > `fastPoll`(2.5) > `tilt`(2) > `poll`(1), стабильный FIFO.

| Функция / константа | Назначение |
|---|---|
| `PRIORITY` | Карта приоритетов по `kind`. |
| `priorityOf(env)` | Приоритет конверта (явный или по `kind`). |
| `priorityInsert(queue, env)` | Вставка с сохранением сортировки по убыванию приоритета. |
| `dequeue(queue)` | `{ inFlight, queue }` — снять голову. |
| `hasKind(queue, kind)` | Есть ли в очереди конверт данного `kind`. |

---

## `res.js`

Константы разрешения энкодера (зеркало `CommandHandler.RES` в `flows.json`).

| Функция / константа | Назначение |
|---|---|
| `RES` | Параметры `high`/`low` (`ca18`, `sp_def`, `vh2`, …). |
| `resKey(resolution)` | Нормализует к `'high'`/`'low'`. |
| `ticksPerRev(resolution)` | Тиков на оборот (`CA[18]`). |
| `ticksPerDeg(resolution)` | Тиков на градус. |
| `degPerSecToTicks(degPerSec, resolution)` | °/с → ticks/s. |

---

## `util.js`

| Функция | Назначение |
|---|---|
| `ensureCr(cmd)` | Гарантирует завершающий `CR` (ELMO Direct Access требует CR). |
| `clamp(value, min, max)` | Ограничение в диапазон. |

---

## Тесты

`packages/nc3-elmo-machines/test/` (`node --test`):

- `elmoTransport.test.js` — поведение машины: connect/poll/ACK/таймауты/fast-raw/offline.
- `helpers.test.js` — poll/queue/util.
- `parse.test.js` — парсер.

Эффекты и часы мокаются; путь таймаута проверяется инъекцией `ELMO.TIMEOUT`. Все актеры останавливаются в top-level `after`-хуке, чтобы открытые `setTimeout` не задерживали выход node:test.

## Node-RED интеграция (вкратце)

Вкладка `ELMO XState (UDP)` в `flows.json`. Узлы:

- `ElmoTransport` (function, 3 выхода) — фабрика через `nc3.startElmoTransport(...)`.
- `udp out` → `192.168.1.2:5001`, local bind `:5005`.
- `udp in` → `:5005` → `change: msg.elmo_raw=true` → обратно в transport.
- Тестовые inject-узлы (`manual cmd`, `poll tick`, `full state once`, `POLL.CONFIG` пресеты) + debug + `PollRateMeter`.

Эквивалент во flow-генераторе — `flows/elmo-xstate-udp/build-flow.js` → `flows/elmo-xstate-udp.flow.json`. Canonical-источник — сам `flows.json`.
