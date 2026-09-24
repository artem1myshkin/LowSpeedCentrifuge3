# Технические особенности и правила правки

Дата актуализации: 2026-06-11

## Node-RED function nodes

- Код `function` node - это тело функции, не CommonJS/ESM-модуль.
- Нельзя использовать `import`, `require`, `export`, `module.exports` внутри function nodes.
- Для внешней JS-логики использовать `packages/nc3-elmo-machines` и подключение через Node-RED context/API.
- Файловые операции в flow выполнять через `file` и `file in` nodes.
- Текстовые файлы писать в UTF-8.

## Dashboard 2 ui-template

- Production `ui-template` должны иметь `passthru=false`.
- Backend-состояние передается сообщениями `reread`, `init`, `logs_update`, `remote_state` и аналогичными snapshot-сообщениями.
- UI-команды отправляются через `this.send({ topic, payload })`.
- При `passthru=true` входящие backend-сообщения могут переизлучаться на выход template node и создавать feedback loop.

## Remote-control

- Флаг remote-mode хранится в `settings.general.remoteControl`.
- `RemoteControlService` ведет targeted `remote_state` для Dashboard socket-клиентов.
- Все рабочие команды production UI проходят через `RC route <tab>` и `CommandGate`.
- Local в remote-mode: display-only, разрешены local `E-stop` и снятие remote-mode из баннера настроек.
- Remote-owner получает `canControl:true`; remote non-owner блокируется.
- UI-lock нужен для UX, но реальная защита команд должна оставаться в backend `CommandGate`.

## ELMO

- Production-транспорт: UDP/XState.
- Команды отправляются на `192.168.1.2:5001`, ответы принимаются на локальном `:5005`.
- Legacy TCP `192.168.1.2:2000` оставлен в flow как выключенный fallback.
- Команды ELMO завершаются `CR`.
- Основной путь команд: UI -> `CommandHandler` -> `ELMO XState (UDP)` -> `ResponseParser`.
- Тормоз внешней оси управляется через ELMO `OL[2]`, а не через БУН.
- Таймауты транспорта: ответ на команду 1 с; 3 пропуска подряд -> offline + автоматический re-probe; после `MO=1` ожидание `SO=1` 30 с, при таймауте транспорт сам шлет `ST;MO=0` (`CMD.FAILED reason=so_timeout`); ожидание завершения движения (`waitForMotionDone`) с опросом `MS/TM/PX/VX`, при таймауте тоже `ST;MO=0` (`motion_timeout`).
- Ответ ELMO с `?` на команду записи -> событие `CMD.PART_REJECTED` -> warning в журнале ("ELMO отклонил команду ...").
- Poll-частоты: normal 2 Гц (`TM/PX/VX`), state ~1 Гц (`MO/SO/SR`), fast raw до 30 Гц при raw-записи, low-resolution velocity poll 10 Гц.

## Drive Init (разделение режимов, коммиты 352527e/e9790ef)

- Ручной `Drive Init` (кнопка, payload null -> mode `manual`): ТОЛЬКО один оборот `SP/AC/DC; PA=<base+1rev>; BG` (5 град/с, 2.5 град/с²). Не трогает MO, параметры диапазона и диагностику. Двигатель должен быть уже включен.
- Полный `Drive Init` (mode `full`/`scenario`, сценарий и автосмена диапазона): `ST; MO=0; <параметры диапазона OL[1]/CA[18]/...>; AF=0; EC=0; SR; MF; EE[5]; MO=1; SP/AC/DC; PX; PA=@PX+1rev; BG` + ожидание SO и motion-done. `PA=@PX+...` резолвится транспортом из свежего PX после смены головок.
- `DriveInitState` ведет статус (`not_done/initializing/waiting_motion/done/failed`), восстанавливает его из журнала (`Drive Init: completed/failed/required after resolution switch`) и журналирует смену кода SR (`SR error: ...` / `SR: errors cleared`).
- После `set_resolution` статус инициализации сбрасывается (`Drive Init: required after resolution switch`).
- UI БПП блокирует переключение, пока `MO || SO` (снекбар "Смена разрешения невозможна").

## Ошибки ELMO (декодирование)

- `ResponseParser.decodeSR`: биты 0-3 SR = код усилителя: 0 нет ошибок, 3 Undervoltage, 5 Overvoltage, 7 Safety/STO (на стенде STO связан с реле давления воздуха), 9 Sensor error, 11 Short, 12 Abort, 13 перегрев привода, 14 перегрев двигателя, 15 Additional Abort. UI показывает чипы с текстом.
- `EC` (сброс `EC=0` в полном init), `MF` (сбрасывается при `MO=1`), `EE[5]`, `AN[6]` парсятся в poll_buffer, но в UI не отображаются — диагностика через EAS II.
- Восстановление параметров привода (factory reset + `LD`, BAD DATABASE -> `CD[1]`) — процедура из "Рекомендаций", вне операторского UI.
- Операторская инструкция по ошибкам: `docs/operator-manual.md`, раздел 12.

## Диапазоны энкодера

- `high`: `CA[18]=262144000`, разрешение 0,005 градуса, default range 1 угл. сек/с .. 20 град/с.
- `low`: `CA[18]=6553600`, разрешение 0,2 градуса, default range 10 .. 360 град/с.
- Граница автопереключения сценария: 20 град/с.
- Гистерезис: 5 град/с.
- Абсолютный максимум `low`: 360 град/с.

## Протоколы и raw-data

- Протокол: `C:\NC3\protocols\protocol_<timestamp>.txt`.
- Data-файл: `C:\NC3\data\data_<timestamp>.txt`.
- Временной ряд строится только из ELMO `TM` и `PX`.
- Системное время Node-RED не подставлять вместо `TM`.
- Raw fast poll включается только при активной записи и включенном флаге raw-data.
- `recording_ends_at` хранится в global context и восстанавливает UI-состояние между вкладками.

## Сценарии

- Runtime-каталог: `C:\NC3\scenarios`.
- Репозиторные примеры: `scenarios/high_resolution.scn`, `low_resolution.scn`, `range_switch.scn`.
- Формат шага: `<скорость_град_с> <выдержка_с>`.
- `ScenarioManager` выполняет шаг через существующий ELMO command path.
- Выдержка начинается только после устойчивого достижения допуска.
- `scenario_resume` сейчас повторяет текущий шаг с начала, не восстанавливает остаток выдержки.
- При автосмене диапазона сценарий останавливает привод, выполняет переключение, `Drive Init` и повторяет текущий шаг.

## БУН

- Node-RED не формирует UDP/Modbus сам.
- Цепочка: Node-RED -> MQTT -> `nc3_bun.py` -> UDP/Modbus -> БУН.
- Основные MQTT-топики: `bun_cmd`, `bun_cmd_setpoint`, `bun_angle`, `bun_systate`.
- Команды UI: `go`, `stop`, `release`, `slowup`, `slowdown`, `zero`.
- В текущем `nc3_bun.py` используется новая карта регистров: `ANGLE_REG=0xAAB2`, а не старое `0x0002` из docx.
- БУН — отдельная страница `Tilt Control` (flow `BUN flow`); БЕП — отдельная страница `Gap Control` (flow `BEP flow`).
- `nc3_bun.py` при старте делает handshake и `sys.exit()` при таймауте устройства, поэтому отсутствие `bun_angle`/`bun_systate` достаточно надёжно означает «скрипт не работает».

## БЕП

- Цепочка: Node-RED -> MQTT -> `nc3_bep.py` -> UDP -> БЕП.
- Базовый шлюз использует `cmd-topic`, `file-topic`, `reply-topic`, `file-rep-topic`, `chN/data`.
- Production flow дополнительно использует high-level `bep/control`, `bep/write-config`, `bep/status`.
- Это расхождение нельзя игнорировать при доработке БЕП: нужен адаптер или согласование runtime-версии `nc3_bep.py`. Реальный `nc3_bep.py` НЕ публикует `bep/status` — поэтому статус скрипта в UI определяется по свежести `chN/data`, а не по `bep/status`.

## Перезапуск python-скриптов из UI (2026-06-18)

- UI-кнопки `Запустить/Перезапустить/Остановить` шлют `{topic:'bun_process'|'bep_process', payload:'start'|'restart'|'stop'}` через RC-gate → switch (`cmd/angle?` для БУН, `cmd?` для БЕП) → router switch (`payload`) → `exec`-ноды.
- По 3 `exec`-ноды на скрипт, фиксированные PowerShell-команды (`addpay:false`, `winHide:true`, ids `a1b2c3d4e5f600xx`):
  - start: `Start-Process cmd -ArgumentList '/k python C:\NC3\nc3_*.py'` — отдельное видимое окно консоли (как `Run nc3_*.lnk`), переживает рестарт Node-RED;
  - stop: kill по командной строке (`Get-CimInstance Win32_Process | ? CommandLine -like '*nc3_*.py*' | Stop-Process -Force`) — бьёт только нужный python+cmd, не трогает второй скрипт;
  - restart: kill; `Start-Sleep 800ms`; launch.
- Предполагается, что Node-RED работает в пользовательской сессии (иначе окно консоли не будет видно на рабочем столе).
- Индикация «работает/не отвечает/ожидание» — фронтенд по data-freshness: БУН heartbeat = `bun_angle`/`bun_sysstate` (порог 6 с), БЕП = `chN/data` (порог 5 с, измерение на стенде всегда включено). Watchdog 1 Гц в шаблоне. НЕ зависит от расхождения high-level MQTT-протокола.
- Старая орфанная инфраструктура процесс-контроля БЕП осталась на табе `new ui flow` (привязана к легаси-шаблону `Мониторинг`, spawn-режим `python`) — не трогалась.

## Чистота репозитория

- `.idea/`, `node_modules/`, логи, временные файлы и backup-файлы игнорируются.
- Не добавлять runtime-данные из `C:\NC3` без явного решения.
- Пользовательские сценарии, созданные на стенде через UI, переносить в `scenarios/` вручную только если они должны версионироваться.

