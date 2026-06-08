# Протоколы и интеграции

## Назначение документа

Этот файл фиксирует фактические способы взаимодействия между `Node-RED`, приводом `ELMO`, узлом наклона `БУН` и системой `БЕП` в проекте НЦ-3/2.

## Актуализация 2026-06-08

- Production Dashboard-команды проходят через remote-control route/gate перед попаданием в ELMO/БУН/БЕП/настройки/журнал.
- `RemoteControlService` ведет targeted `remote_state` по Dashboard socket-клиентам, синхронизирует `remoteEnabled` с `settings.general.remoteControl` и публикует события в persistent journal.
- Все production `ui-template` для backend-сообщений работают с `passthru=false`, чтобы `remote_state`, `logs_update` и другие backend-снимки не превращались в feedback loop.

## Актуализация 2026-06-01

- Основной production-путь ELMO — UDP/XState: `CommandHandler -> ELMO XState (UDP) -> ResponseParser`. Legacy TCP `192.168.1.2:2000` оставлен выключенным fallback.
- Normal poll: атомарные `TM/PX/VX` 2 Гц; fast raw poll во время записи: атомарные `TM/PX` до 30 Гц.
- В `low` диапазоне выбранная скорость для UI/сценариев берется из оценки `PX/TM`; raw `VX` сохраняется отдельно как `velocity_raw`.
- Сценарии работают с runtime-каталогом `C:\NC3\scenarios`; UI умеет редактировать `.scn` файлы через `ScenarioFileService`.
- Протоколный формат не менялся: сценарный runtime вызывает существующие `open_protocol`, `start_recording`, `record_measurement`, `cancel_recording`.

Документ собран по четырём источникам:

- текущий production-flow `new ui flow` в [flows.json](C:/Users/Артём/.node-red/projects/LowSpeedCentrifuge3/flows.json)
- внешний Python-шлюз `nc3_bun.py`
- внешний Python-шлюз `nc3_bep.py`
- приложенные описания протоколов и рекомендации по разработке

## Карта взаимодействия

| Компонент | Роль | Протокол | Адрес / порт | Как связан с `Node-RED` |
|---|---|---|---|---|
| `ELMO` | привод внутренней оси, вращение планшайбы | текстовый `Direct Access` по UDP/XState, TCP только legacy fallback | UDP `192.168.1.2:5001` cmd, локальный `:5005` reply; TCP `192.168.1.2:2000` выключен | `udp out`/`udp in` во вкладке `ELMO XState (UDP)`, команды приходят из `CommandHandler` |
| `БУН` | управление внешней осью наклона | `UDP` + `Modbus RTU` поверх UDP | `192.168.1.5:32767` | через внешний MQTT/UDP-шлюз `nc3_bun.py` |
| `БЕП` | измерение ёмкости/зазора по каналам | кастомный бинарный `UDP` | `192.168.1.20:20001` | через внешний MQTT/UDP-шлюз `nc3_bep.py` и MQTT-топики |
| `MQTT broker` | внутренняя шина обмена | `MQTT` | `localhost:1883` | основной способ связи `Node-RED` с `БУН/БЕП`-шлюзами |

## Общая схема

1. `Node-RED` управляет `ELMO` через единый UDP/XState-транспорт; старый TCP-путь оставлен выключенным fallback.
2. `Node-RED` не работает с `БУН` напрямую по `UDP`; вместо этого общается с `nc3_bun.py` через `MQTT`.
3. `Node-RED` не работает с `БЕП` напрямую по `UDP`; вместо этого использует MQTT-шлюз `nc3_bep.py` и отдельную process-обвязку в flow.
4. Часть логики хранения данных и протоколов реализована прямо в `Node-RED` через `file`, `file in` и `ProtocolManager`.
5. Dashboard-команды перед доменными обработчиками проходят через `RC route <tab>` и `CommandGate`, который применяет remote ownership и пропускает только разрешенные view-only/emergency/release-топики.

## Remote-control command path

Remote-control не меняет физические протоколы ELMO/БУН/БЕП, но меняет входной контракт команд из Dashboard:

1. Production `ui-template` отправляет команду через `this.send({ topic, payload })`.
2. `RC route <tab>` отделяет служебные remote-топики (`remote_claim`, `remote_release`, `remote_refresh`) и отправляет их в `RemoteControlService`.
3. Рабочие команды идут через subflow `CommandGate`.
4. Разрешенный выход gate возвращается в прежние доменные обработчики: `CommandHandler`, `ScenarioManager`, `ScenarioFileService`, Tilt/БУН, BEP MQTT/config, `SettingsNormalize`, `ProtocolManager`, `EventLogService`.
5. Заблокированный выход gate уходит в debug bus `RC PROD BLOCKED`.

`CommandGate` разрешает local `emergency_stop`, local release remote-mode через `settings_aply` с `remoteControl:false`, remote-owner команды и view-only refresh/open-file топики. Остальные local/remote non-owner рабочие команды в remote-mode блокируются. Это backend enforcement; CSS/JS-блокировки в Dashboard нужны только для клиентского UX.

## ELMO

### Транспорт и endpoint

- Протокол: текстовые команды `ELMO Platinum Direct Access`
- Production-flow: XState/UDP — команды на `192.168.1.2:5001`, ответы на локальный `:5005` (`udp out`/`udp in`)
- Legacy TCP `192.168.1.2:2000` через `tcp request` сохранен в flow выключенным fallback
- Команда завершается обязательным `CR` (`\r`)
- Переход на UDP сделан ради частоты опроса: по TCP `sit` + idle-gap потолок был ~4 Гц; по UDP с атомарными per-параметровыми командами и реассемблированием — ~30–32 Гц. См. [xstate-elmo-design.md](xstate-elmo-design.md).

Важно:

- в рекомендациях по разработке приведены примерные Ethernet-параметры `PP[23]..PP[26]`
- это справочный пример из документации, а не текущее сетевое значение production-flow
- фактические адреса ELMO в текущем проекте задаются прямо в `flows.json`: UDP `192.168.1.2:5001` и локальный reply bind `:5005`

### Как `Node-RED` работает с ELMO

Основная логика сосредоточена в функциях:

- `CommandHandler`
- `ResponseParser`
- `polling ELMO`
- `Tilt`

`Node-RED` получает команды из Vue UI по `msg.topic`, `CommandHandler` преобразует их в строки команд `ELMO`, транспорт `ELMO XState (UDP)` сериализует очередь и отправляет атомарные UDP-команды, затем `ResponseParser` разбирает ответ и собирает снимок состояния для UI.

### Команды и параметры, которые реально используются

#### Сервисные и статусные

- `SR` - статусный регистр привода
- `SO` - признак, что усилитель включен и готов к движению
- `MO` - включение/выключение привода
- `AF` - состояние remote control / abort
- `PX` - текущее положение
- `VX` - текущая скорость
- `MS` - статус движения
- `SP` - заданная скорость для позиционирования
- `AC` - ускорение
- `DC` - замедление
- `JV` - уставка скорости в режиме непрерывного вращения
- `TR[1]`, `TR[3]` - пороги/окна, используемые для настройки диапазона
- `OL[1]` - выбор пары считывающих головок энкодера
- `OL[2]` - управление тормозом внешней оси
- `EC`, `MF`, `EE[5]` - диагностика и чтение состояния ошибок/маски

#### Управляющие

- `MO=1` - включить привод
- `MO=0` - выключить привод
- `ST` - быстрая остановка
- `BG` - запуск ранее заданного движения
- `HM[1]=1` - homing / поиск нулевой метки
- `OL[2]=0/1` - выключение / включение тормоза внешней оси

#### Команды движения

- `PA=<ticks>` - абсолютное позиционирование
- `PR=<ticks>` - относительное позиционирование
- `JV=<ticks_per_sec>` - непрерывное вращение с заданной скоростью

Для движения flow сначала задает параметры профиля:

- `SP`
- `AC`
- `DC`

а затем отправляет одну из команд `PA`, `PR` или `JV` и завершает запуском `BG`.

### Инициализация и переключение разрешения

По коду `CommandHandler` и рекомендациям используются две конфигурации разрешения:

- `high`
- `low`

При переключении диапазона и при `driveInit` используются команды:

- `OL[1]`
- `CA[18]`
- `S1[5]`
- `KP[2]`
- `SD`
- `QS`
- `VH[1]`
- `VL[1]`
- `VH[2]`
- `ER[3]`
- `ER[2]`
- `TR[1]`
- `TR[3]`

`driveInit` дополнительно делает:

1. `ST`
2. `MO=0`
3. применение параметров выбранного разрешения
4. `AF=0`, `EC=0`
5. чтение `SR`, `MF`, `EE[5]`
6. `MO=1`
7. один оборот через `PR=<ca18>` и `BG`
8. контрольный опрос состояния

Это соответствует задаче инициализации привода и одного оборота для инициализации сумматора `DSi`.

### Опрос состояния

В legacy TCP-flow были два характерных цикла опроса:

- основной `reread`: `OL[1]`, `TR[1]`, `AF`, `SR`, `MO`, `SO`, `PX`, `VX`, `SP`, `AC`, `DC`
- регулярный poll (1 Гц, `topic = poll_data`): `MS;TM;PX;TM;MO;SO;VX;OL[2];`

В старом TCP regular poll команда `TM` стояла до и после `PX`, а `ResponseParser` вычислял `tm_us = (tm_before + tm_after) / 2`. В текущем UDP/XState poll используется атомарная пара `TM/PX` внутри одного логического кадра; именно метка ELMO, а не системное время Node-RED, используется для буфера протокола (см. раздел про данные).

В актуальном XState/UDP-потоке `poll_data` отделен от legacy TCP-пути: обычный опрос идет 2 Гц и содержит атомарные `TM/PX/VX`, а быстрый raw-опрос включается только во время записи исходных данных и содержит только `TM/PX`. Для сценарных data-файлов используется простая пара `TM/PX`, без усреднения `TM-PX-TM` и без дополнительных параметров ELMO.

### Как ответы ELMO попадают в UI

`ResponseParser` поддерживает оба формата ответов:

- `PARAM=VALUE`
- `PARAM;VALUE`

На выходе UI получает структурированные поля:

- `position`
- `velocity`
- `velocity_raw`
- `velocity_derived`
- `velocity_source`
- `velocity_deg_per_sec`
- `ms`
- `so`
- `mo`
- `af`
- `sp`
- `ac`
- `dc`
- `jv`
- `sr`
- `resolution`
- `bun_brake`

Дополнительно `SR` декодируется в человекочитаемые ошибки:

- `Undervoltage`
- `Overvoltage`
- `STO active`
- `Sensor error`
- `Short circuit`
- `Abort input active`
- `Drive over temperature`
- `Motor over temperature`

### Сценарии

Файлы сценариев лежат в `C:\NC3\scenarios` и имеют формат:

```text
Name <имя>
ResolutionHint auto
-------------------
<скорость_град_с> <выдержка_с>
```

Комментарии начинаются с `#`. Пакетные helper-функции `parseScenarioText`, `normalizeScenario`, `selectResolutionForSpeed`, `computeSpeedReachTimeoutMs`, `listScenarioFiles` доступны Node-RED через `global.get('nc3')`.

Runtime:

- `ScenarioFileService` читает/пишет `.scn` через file nodes и публикует `scenario_catalog`;
- `ScenarioManager` на `scenario_start` загружает файл, нормализует шаги и отправляет команды через существующий `CommandHandler`;
- если шаг требует другой диапазон, runtime отправляет `drive_stop`, затем `set_resolution`, `driveInit` и повторяет текущий шаг;
- ожидание скорости начинается после `CMD.ACKED` для `set_jv`, timeout = `abs(targetSpeed)/AC + 10 с`;
- при достижении устойчивого допуска runtime вызывает `start_recording`, после выдержки — `record_measurement`;
- `scenario_pause`/`scenario_emergency_stop` отменяют текущую запись и сохраняют текущий шаг, `scenario_resume` выполняет этот шаг заново.

## БУН

### Транспорт и endpoint

- Протокол: `UDP`
- Порт: `32767`
- Устройство определяется через broadcast `Handshake`
- После handhshake обмен идет адресно на IP устройства
- В текущем `nc3_bun.py` целевой IP задан как `192.168.1.5`
- Modbus-адрес устройства: `1`

### Механика соединения

По `Протокол_БУН.docx`:

1. Клиент отправляет broadcast `"Handshake"` на `udp/32767`
2. Устройство отвечает `"Ack"`
3. После этого клиент использует IP-адрес ответившего устройства
4. Далее по тому же `UDP`-сокету на `32767` отправляются обычные пакеты `Modbus RTU`
5. Если валидные пакеты не приходят примерно `1500 мс`, соединение считается разорванным

В `nc3_bun.py` это реализовано напрямую:

- bind на локальный `UDP 32767`
- broadcast `Handshake`
- чтение ответа
- запоминание `dev_addr`
- последующий обмен с тем же IP

### Роль `Node-RED`

`Node-RED` не формирует Modbus-пакеты сам. Он общается с `БУН` через MQTT-топики:

- входящие в `Node-RED`:
  - `bun_angle`
  - `bun_systate`
- исходящие из `Node-RED`:
  - `bun_cmd`
  - `bun_cmd_setpoint`

То есть цепочка выглядит так:

`Node-RED -> MQTT localhost:1883 -> nc3_bun.py -> UDP/Modbus -> БУН`

и обратно:

`БУН -> nc3_bun.py -> MQTT -> Node-RED UI`

### Команды БУН

Внешний UI отправляет в `Node-RED` команды управления наклоном, а `Node-RED` передает их в `nc3_bun.py` через `bun_cmd`:

- `go`
- `stop`
- `release`
- `slowup`
- `slowdown`
- `zero`

Задание целевого угла идет через отдельный топик:

- `bun_cmd_setpoint`

В `nc3_bun.py` эти команды преобразуются в запись `Modbus RTU` в регистр `COMMAND_REG` или `SETPOINT_REG`.

### Регистры БУН

В `Протокол_БУН.docx` перечислены регистры:

- `0xAAAC` - `MOTOR_STAT_REG`
- `0xAAAE` - `MOTOR_SPEED_REG`
- `0xAAB0` - `SYS_STATE_REG`
- `0x0002` - `ANGLE_REG`
- `0x0004` - `SETPOINT_REG`
- `0x0006` - `RAW_ANGLE_REG1`
- `0x0008` - `RAW_ANGLE_REG2`
- `0xCCCC` - `COMMAND_REG`

В `nc3_bun.py` есть важное отличие:

- `ANGLE_REG` задан как `0xAAB2`
- рядом есть комментарий `new ver - 19.10.2023`

Это означает, что скрипт уже адаптирован под более новую версию карты регистров, чем та, что описана в приложенном `docx`.

### Команды Modbus, которые реально используются

Функции Modbus:

- `0x03` - чтение
- `0x10` - запись нескольких регистров

Значения команд для `COMMAND_REG`:

- `0x00` - `STOP`
- `0xFF` - `RELEASE`
- `0x01` - `GO`
- `0x02` - `SLOWUP`
- `0x03` - `SLOWDN`
- `0x04` - `ZERO`

### Что публикует `nc3_bun.py`

Скрипт публикует в MQTT:

- `bun_systate` - значение `SYS_STATE`
- `bun_angle` - текущий угол

Угол публикуется как знаковое 32-битное значение. В скрипте есть комментарии, что это значение связано с угловыми секундами, но в production-flow далее оно уже обрабатывается как прикладное значение угла.

### Особенность текущего polling

Хотя в `Протокол_БУН.docx` упоминается частый опрос, текущее `nc3_bun.py` в рабочем цикле делает примерно:

- периодический запрос `full_stat`
- публикацию `bun_systate`
- публикацию угла `bun_angle`

То есть `Node-RED` зависит от внешнего Python-процесса как от MQTT-шлюза и не знает деталей UDP/Modbus на уровне flow.

## БЕП

### Транспорт и endpoint

- Протокол между шлюзом и устройством: кастомный бинарный `UDP`
- Endpoint: `192.168.1.20:20001`
- Шлюз: `nc3_bep.py`
- Внутренняя шина обмена с `Node-RED`: `MQTT localhost:1883`

### Роль `nc3_bep.py`

`nc3_bep.py` выполняет сразу три функции:

- принимает команды от MQTT
- отправляет бинарные UDP-команды в сторону `БЕП`
- публикует результаты измерений и адреса каналов обратно в MQTT

Цепочка такая:

`Node-RED -> MQTT -> nc3_bep.py -> UDP -> БЕП`

и обратно:

`БЕП -> nc3_bep.py -> MQTT -> Node-RED`

### MQTT-топики скрипта `nc3_bep.py`

Командные:

- `cmd-topic`
- `file-topic`

Ответы:

- `reply-topic`
- `file-rep-topic`

Данные каналов:

- `ch1/data`
- `ch2/data`
- `ch3/data`
- `ch4/data`
- `ch5/data`

Адреса / обнаружение плат:

- `ch1/addr`
- `ch2/addr`
- `ch3/addr`
- `ch4/addr`
- `ch5/addr`

### Команды `nc3_bep.py`

Через `cmd-topic` скрипт понимает строковые команды:

- `run`
- `run one <board>`
- `run one <board> <capdac>`
- `stop`

Через `file-topic`:

- `read`
- `write <board> <param_pos> <value>`

### Что делает каждая команда

- `run` - запуск группового обмена
- `run one N` - запуск обмена для одной платы
- `run one N CAPDAC` - запуск одной платы с конкретным `CAPDAC`
- `stop` - остановка обмена
- `read` - чтение калибровочного файла
- `write ...` - запись калибровочных параметров в локальный файл

### Низкоуровневый UDP-протокол БЕП

В `nc3_bep.py` подготовлен бинарный пакет `eth_start`, который отправляется на `192.168.1.20:20001`.

Режимы задаются полем `eth_start[5]`:

- `0x00` - `stop`
- `0x01` - `start`
- `0x02` - `start_single`
- `0x03` - `start_single_capdac`
- `0x04` - `check`

Обнаружение плат идет перебором адресов `0x21..0x2F`.

### Формат данных

Скрипт ожидает данные пакетами, где один кадр имеет длину `13` байт.

Из каждого кадра извлекаются:

- адрес платы `raw_addr`
- измеренное значение `cap_val`
- номер канала, вычисляемый из адреса

После этого измерение публикуется в один из топиков `chN/data`.

### Как `Node-RED` использует данные БЕП

В production-flow:

- `ch1/data ... ch5/data` переименовываются в `Channel 1 ... Channel 5`
- далее проходят через функцию `BEP Calibration`
- затем попадают в UI `BEP`

Калибровка в текущем flow линейная и строится на разнице:

- `vN_gap_inp - vN_gap_out`

То есть это не полная физическая модель пересчета ёмкости в зазор, а прикладная корректировка текущих значений.

### Process-обвязка BEP в production-flow

В `new ui flow` поверх низкоуровневого MQTT-обмена есть отдельная process-логика:

- входной UI-топик `bep_process`
- команды `start`, `stop`, `reload`
- роутер `bep_process_router`
- `exec`-узел `start nc3_bep.py`
- graceful stop через MQTT `bep/control`
- аварийный stop через `taskkill /PID ... /F`

Также используются MQTT-топики более высокого уровня:

- `bep/status`
- `bep/control`
- `bep/write-config`

### Важное расхождение по BEP

Приложенный `nc3_bep.py` и production-flow описывают два близких, но не полностью одинаковых слоя интеграции:

- низкоуровневый MQTT/UDP-шлюз использует `cmd-topic`, `reply-topic`, `file-topic`, `file-rep-topic`, `chN/data`
- production-flow поверх этого уже использует `bep/status`, `bep/control`, `bep/write-config`

Практически это означает одно из двух:

- либо в runtime используется модифицированная версия `nc3_bep.py`
- либо существует дополнительная обвязка/адаптер между production UI и базовым шлюзом

Это расхождение нужно учитывать при любых дальнейших доработках.

## Как UI `Node-RED` инициирует обмен

### Для ELMO

UI шлет во flow такие топики:

- `driveInit`
- `reread`
- `set_motion_params`
- `set_absolute_position`
- `set_relative_position`
- `set_resolution`

Они обрабатываются функцией `CommandHandler`, превращаются в текстовые команды `ELMO` и уходят в единый `ELMO XState (UDP)` transport.

### Для БУН

UI шлет:

- `bun_cmd`
- `bun_cmd_setpoint`
- `tilt_mode`
- `tilt_target`

Непосредственно на железо уходят именно MQTT-команды `bun_cmd` и `bun_cmd_setpoint`, которые потом подхватывает `nc3_bun.py`.

### Для тормоза внешней оси

Отдельно важно, что тормоз внешней оси управляется не через `БУН`, а через `ELMO`:

- UI формирует `tilt_brake`
- flow превращает его в `OL[2]=...`
- команда уходит в `ELMO` через `ELMO XState (UDP)`

### Для БЕП

UI шлет:

- `mqtt_cmd`
- `bep_process`
- `bep_config_write`
- `board_num`
- `capdac_val`

Дальше flow либо:

- публикует MQTT-команду для шлюза
- либо запускает/останавливает внешний процесс
- либо пересылает новую конфигурацию в `bep/write-config`

## Файлы данных и протоколов в `Node-RED`

В flow есть функция `ProtocolManager`, которая создает:

- файл протокола в `C:\NC3\protocols\protocol_<timestamp>.txt`
- файл данных в `C:\NC3\data\data_<timestamp>.txt`
- файл журнала событий в `C:\NC3\logs\events.jsonl`

Для этого используются события:

- `open_protocol`
- `close_protocol`
- `start_recording`
- `record_measurement` / `stop_recording`
- `reread` (для синхронизации `Журнала` и кнопки записи)
- `event_log_refresh`
- `event_log_clear`

Это уже прикладной уровень поверх обмена с `ELMO`, `БУН` и `БЕП`.

### Журнал событий

Persistent event journal реализован отдельным узлом `EventLogService` в `new ui flow`. Источник событий — `logs_update` от `ProtocolManager` и `journal_event` от сценариев/сервисных узлов. `EventLogService` нормализует события, дедуплицирует уже записанные строки и синхронизирует `global.logs` с файлом `C:\NC3\logs\events.jsonl`.

Файловые операции выполняются только Node-RED nodes:

- `Append Event Log` (`file`) дописывает JSONL-строки в `C:\NC3\logs\events.jsonl`;
- `Read Event Log` (`file in`) читает журнал при `event_log_refresh` и первичной загрузке UI;
- `Clear Event Log` (`file`) очищает файл overwrite-записью пустого содержимого при `event_log_clear`.

Dashboard 2 `ui-template` вкладки `Журнал` должен иметь `passthru=false`: входящие backend-сообщения `logs_update`/`journal_state` не должны переизлучаться из выхода template node, иначе возможен feedback loop между UI и backend-сервисами. Команды UI отправляются через `this.send({ topic, payload })`.

### Источник временного ряда (метки времени ELMO)

Временной ряд для расчета скорости и для data-файла формируется **только из меток `TM` ELMO**, потому что детерминированными по времени являются часы контроллера привода, а не runtime Node-RED.

- XState/UDP raw-poll для записи исходных данных шлет только `TM/PX`;
- `ResponseParser` кладет в payload `tm_us` и `position`;
- `angle_buffer` пишет точки `{ t: tm_us / 1e6, tm_us, ticks, angle, resolution }` пока `is_recording === true`, обрезая буфер по длительности текущей записи;
- если в ответе нет `tm_us`, точка отбрасывается (системное время не подставляется);
- data-файл содержит только временную метку ELMO и значение `PX` в тиках, без `VX`, `MO`, `SO`, `SR` и других параметров ELMO;
- `ProtocolManager.finalizeRecording` считает скорость линейной регрессией по десятичному углу, а в data-файл пишет колонки `Время  Значение # секунда  тики` с сырыми метками `t = tm_us / 1e6` (без вычитания `t0`). На расчет скорости это не влияет — наклон регрессии инвариантен к сдвигу времени.

### Поведение записи (одно нажатие + авто-таймер)

- кнопка `Запись` на вкладке `Угловая скорость` — одноразовая: по нажатию отправляется `start_recording`, кнопка блокируется;
- `ProtocolManager` при `start_recording` сохраняет `recording_ends_at` в global context и взводит серверный таймер на `dataDurationSec`;
- по истечении таймера запись завершается автоматически (строка результата в протокол, при включенном raw-режиме — data-файл), `is_recording` сбрасывается, кнопка снова активна;
- таймер очищается при `stop_recording` / `record_measurement` / `close_protocol` и в `On Stop` узла `ProtocolManager`;
- `recording_ends_at` транслируется в `logs_update` и в init-снимке `GlobalStateReader`, поэтому при переходе между вкладками блокировка кнопки и обратный отсчет восстанавливаются из backend.

### Прочее поведение протокола

- заголовок протокола записывается с реальными переводами строк, а не с текстом `\n`;
- после разделителя `-------------------` идет строка колонок `Значение_скорости Погрешность Файл_данных # градус/с %`;
- при включенной опции `Запись исходных данных` строка измерения содержит имя `data_<timestamp>.txt` после значения скорости и погрешности;
- подвкладка `Протоколы` во вкладке `Журнал` распознает это имя как ссылку, открывает файл из `C:\NC3\data` и по кнопке строит график по тикам `PX`; UI умеет переключить ось Y в десятичный угол с пересчетом по `high`/`low`, есть автошкала, zoom/reset и pan;
- при закрытии протокола во время активной записи `ProtocolManager` сначала завершает запись и формирует строку результата, а затем добавляет финальный маркер `=====`;
- активные флаги записи в global context: `is_recording` и `is_recording_raw`; дедлайн записи — `recording_ends_at`;
- пользовательское состояние чекбокса raw-data остается в `recording_save_raw_data`, чтобы UI не терял выбранное значение после остановки записи.

## Что считать актуальным при разработке

Если нужен фактический production-контракт, ориентироваться нужно в таком порядке:

1. `flows.json`
2. текущие внешние Python-шлюзы
3. приложенные `docx` как справочную базу

Особенно важно помнить про два расхождения:

- `БУН`: в `docx` указан `ANGLE_REG = 0x0002`, а в `nc3_bun.py` используется `0xAAB2`
- `БЕП`: low-level MQTT-топики скрипта и high-level MQTT/process-топики production-flow не полностью совпадают
