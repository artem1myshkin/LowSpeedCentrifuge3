# Аудит локальной версии LowSpeedCentrifuge3

Дата аудита: 2026-05-22  
Проект: `C:\Users\Артём\.node-red\projects\LowSpeedCentrifuge3`  
Runtime-окружение: `C:\NC3`  
Документация ТЗ: `C:\Users\Артём\Documents\NC3`

Этот документ пересобран по локальной Node-RED версии проекта, а не по Codex worktree. В качестве источников использованы:

- `C:\Users\Артём\.node-red\projects\LowSpeedCentrifuge3\flows.json`;
- локальные документы проекта: `README.md`, `docs\protocols-and-integrations.md`, `docs\scenario-feature-summary.md`, `docs\scenario-dataflow.html`;
- ТЗ, приложение к ТЗ, протокол БУН и рекомендации из `C:\Users\Артём\Documents\NC3`;
- runtime-файлы `C:\NC3\settings.json`, `C:\NC3\nc3_bun.py`, `C:\NC3\nc3_bep.py`, `C:\NC3\scenarios`.

## 1. Текущее состояние локального проекта

Локальный `flows.json` валиден как JSON. Git-состояние локального проекта: ветка `main`, отстает от `origin/main` на 5 комитов, есть неотслеживаемая папка `.claude`.

В локальном `flows.json` фактически есть 4 вкладки:

1. `INIT flow`
2. `new ui flow`
3. `BUN flow`
4. `SETTINGS flow`

Отдельных вкладок `BEP flow`, `JOURNAL flow`, `MONITORING flow`, `SCENARIO flow` в локальной версии нет. Журнал, протоколы, БЕП, БУН и мониторинг частично собраны внутри `new ui flow`, а управление угловой скоростью вынесено в `BUN flow`.

UI Dashboard имеет 5 страниц:

- `Мониторинг` (`/monitoring`);
- `Угловая скорость` (`/velocity`);
- `БУН/БЕП(Tilt/Gap)` (`/tilt`);
- `Настройка` (`/settings`);
- `Журнал` (`/journal`).

`package.json` не фиксирует зависимости Node-RED узлов. Для production это проблема: проект нельзя гарантированно развернуть только по репозиторию, потому что зависимости Dashboard/MQTT/TCP/file/exec/config nodes остаются внешним состоянием Node-RED.

## 2. Краткий вывод аудита

Проект находится в промежуточном рабочем состоянии: есть операторский UI, ручное управление приводом, частичная интеграция с БУН/БЕП, протоколирование и просмотр протоколов. До production-состояния не хватает нескольких системных слоев: устойчивого runtime-состояния, сценарного backend, защищенного удаленного управления, корректной персистентности настроек, формализованного журналирования, нормальной process-обвязки БЕП, тестового контура и воспроизводимого развертывания.

Критические дефекты локальной версии:

1. Сохранение настроек сломано концептуально: UI отправляет `settings_aply`, `SETTINGS flow` пишет только `global.settings`, а `SettingsPersister` ожидает `save_settings` и вообще не подключен к входящему потоку.
2. Запуск `nc3_bep.py` из Node-RED фактически не запускает скрипт: `exec`-узел выполняет только `python`, `addpay=false`, `append=""`; узел `set script path` есть, но не подключен к маршруту `start`.
3. Сценарии отсутствуют как backend-функция. Есть UI-заготовки и файлы `C:\NC3\scenarios\*.scn`, но нет загрузчика, парсера, `ScenarioManager`, удержания точности, автопереключения диапазона и записи результатов по сценарию.
4. Удаленное управление реализовано только частично: `activeSession` выставляется, но команды управления не проходят через единый backend-gate. Большинство кнопок не заблокированы по праву владения сессией.
5. Расширенный доступ в настройках небезопасен: проверка пароля закомментирована, `unlockAdvanced()` сразу открывает advanced-настройки.
6. Журнал событий живет в `global.logs` в памяти Node-RED и не является production-журналом событий по ТЗ.
7. Датчик давления из ТЗ в flow не найден.
8. Коррекция угла наклона по БЕП и круглограмме не реализована как расчетный контур; настройки для нее есть, но runtime-алгоритма нет.
9. BEP high-level топики flow (`bep/control`, `bep/write-config`, `bep/status`) не совпадают с базовым `C:\NC3\nc3_bep.py`, который подписывается на `cmd-topic` и `file-topic`, а публикует `reply-topic`, `file-rep-topic`, `ch1/data`...`ch5/data`.
10. `INIT flow` содержит `link out 1`, который ни от чего не запитан, поэтому ожидаемый стартовый fanout в БУН/БЕП UI фактически не работает.

## 3. Описание потоков и обрабатываемых данных

### 3.1. `INIT flow`

Назначение: первичная загрузка настроек и первичный опрос ELMO.

Состав:

- `Init` inject -> `Set file location` -> `Read from file` -> `function 1`;
- отдельный `Init` inject -> `polling ELMO` -> TCP `192.168.1.2:2000` -> `ResponseParser` -> `global.elmo`.

Обрабатываемые данные:

- файл `C:\NC3\settings.json`;
- JSON настроек, который кладется в `global.settings`;
- TCP-ответ ELMO на команду `MS;MO;SO;SR;PX;SP;AC;DC;VX;OL[2];`;
- распарсенный снимок ELMO, который кладется в `global.elmo`.

Что работает:

- `function 1` умеет принять строку JSON или объект и положить его в `global.settings`;
- `ResponseParser` умеет разбирать форматы `PARAM=VALUE` и `PARAM;VALUE`, декодирует младшие биты `SR`, определяет диапазон по `OL[1]`.

Проблемы:

- нет fallback-настроек при отсутствии или повреждении `C:\NC3\settings.json`;
- нет явного статуса `settings_loaded/settings_error`;
- `link out 1` не имеет входящих проводов, поэтому стартовая рассылка в `new ui flow` не происходит;
- стартовый опрос ELMO пишет `global.elmo`, но не синхронизирует все UI так же надежно, как регулярный `BUN flow`.

### 3.2. `new ui flow`

Назначение: общий UI-контур для БУН, БЕП, мониторинга, журнала, протоколов, частично удаленного управления.

UI-шаблоны:

- `БУН`;
- `BEP`;
- `Мониторинг`;
- `Журнал`.

MQTT входы:

- `bun_angle`;
- `bun_systate`;
- `ch1/data`;
- `ch2/data`;
- `ch3/data`;
- `ch4/data`;
- `ch5/data`;
- `bep/status`.

MQTT выходы:

- `bun_cmd`;
- `bun_cmd_setpoint`;
- `cmd-topic`;
- `bep/control`;
- `bep/write-config`.

TCP/exec/file:

- TCP к ELMO `192.168.1.2:2000` для tilt-команд;
- `exec start nc3_bep.py`;
- `exec taskkill`;
- append/write/read file для протоколов и данных;
- `powershell.exe` для списка `C:\NC3\protocols\protocol_*.txt`.

Обрабатываемые данные:

- угол БУН из MQTT `bun_angle`;
- слово состояния БУН из `bun_systate`;
- данные каналов БЕП `ch1/data`...`ch5/data`;
- команды UI для БУН: `bun_cmd`, `bun_cmd_setpoint`, `tilt_mode`, `tilt_target`, `tilt_brake`, `reread`;
- команды UI для БЕП: `mqtt_cmd`, `board_num`, `capdac_val`, `bep_process`, `bep_config_write`;
- команды журнала: `journal_refresh`, `journal_open_file`;
- команды протокола: `open_protocol`, `close_protocol`, `start_recording`, `stop_recording`;
- файлы протоколов `C:\NC3\protocols\protocol_<timestamp>.txt`;
- raw-файлы `C:\NC3\data\data_<timestamp>.txt`;
- глобальные буферы `angle_buffer`, `logs`, `journal_state`.

Логика БУН:

- `BUN_ANGLE` приходит из MQTT;
- функция `BUN Calibration` использует `global.use_calib`, `global.v2_inp`, `global.v2_out`;
- результат уходит в UI с `msg.topic = "bun_angle"`;
- слово состояния БУН преобразуется в hex и биты, уходит в UI как `bun_sysstate`;
- UI-команды маршрутизируются в `bun_cmd`, `bun_cmd_setpoint`, `tilt_brake`;
- `tilt_brake` преобразуется в команду ELMO `OL[2]=<value>;`.

Проблемы БУН:

- `v2_inp/v2_out/use_calib` не имеют надежной инициализации;
- нет полноценного state machine наклона: ручной/автоматический режимы в UI есть, но backend не выполняет последовательность "отпустить тормоз -> задать угол -> дождаться достижения -> включить тормоз -> остановить";
- команда тормоза идет через ELMO `OL[2]`, а не через явно описанный backend-контур БУН/пневмоклапана.

Логика БЕП:

- `ch1/data`...`ch5/data` переименовываются в `Channel 1`...`Channel 5`;
- `BEP Calibration` использует `global.v1_gap_inp/out`...`global.v5_gap_inp/out`, `global.use_calib`;
- UI может отправлять низкоуровневые `mqtt_cmd` в `cmd-topic`;
- UI может отправлять `bep_config_write` в `bep/write-config`;
- есть процессные команды `bep_process = start|stop|reload`.

Проблемы БЕП:

- process-start сломан: `exec` запускает `python` без аргумента `C:\NC3\nc3_bep.py`;
- `bep/control`, `bep/write-config`, `bep/status` не соответствуют базовому `C:\NC3\nc3_bep.py`;
- преобразование емкости в физический зазор по коэффициентам из ТЗ не оформлено как проверяемая функция;
- состояние процесса БЕП не хранится как нормальное глобальное состояние с `running/error/last_seen`.

Логика протокола и журнала:

- `ProtocolManager` открывает протокол в `C:\NC3\protocols`;
- при записи очищает `global.angle_buffer`;
- `angle_buffer` накапливает точки `{t, angle}` из `PX`;
- при остановке записи считает угловую скорость линейной регрессией `angle(t)`;
- считает относительную погрешность к `global.velocity_setpoint_ticks`;
- при включенном raw-data пишет `C:\NC3\data\data_<timestamp>.txt`;
- `Журнал` показывает список протоколов и умеет открывать связанные raw-файлы.

Проблемы протокола и журнала:

- протоколирование есть, но не полностью соответствует Приложению А: нет сценарной записи, нет автоматической записи после достижения точности, нет полноценной структуры событий;
- `global.logs` хранится только в памяти;
- нет отдельного журнала ошибок/предупреждений/подтверждений с глубиной регистрации;
- нет графиков по данным протоколов, только текстовый просмотр.

### 3.3. `BUN flow`

Название вкладки исторически сбивает с толку: фактически это основной поток управления угловой скоростью ELMO, а не только БУН.

Назначение:

- ручное управление приводом планшайбы;
- чтение состояния ELMO;
- расчет диапазонов и ограничений;
- рассылка общего состояния UI;
- накопление `angle_buffer` для протоколов;
- UI-заготовка сценариев.

UI-шаблоны:

- `Угловая скорость`;
- `Сценарии`.

Основные команды UI в `CommandHandler`:

- `reread`;
- `set_motion_params`;
- `motor_on`;
- `motor_off`;
- `drive_stop`;
- `drive_bg`;
- `driveInit` / `drive_init`;
- `drive_home`;
- `set_resolution`;
- `set_velocity` / `set_jv`;
- `set_jp`;
- `set_absolute_position`;
- `set_relative_position`.

Обрабатываемые данные:

- UI-команды управления движением;
- Elmo Direct Access TCP команды и ответы;
- текущий диапазон `high/low`;
- параметры движения `SP/AC/DC/JV/JP/PA/PR`;
- состояние ELMO `PX`, `VX`, `MS`, `MO`, `SO`, `AF`, `SR`, `OL[1]`, `OL[2]`;
- глобальное состояние `drive_state`;
- буфер углов для записи `angle_buffer`.

Регулярный poll:

- inject раз в 1 секунду с `topic = poll_data`;
- команда к ELMO: `MS;PX;MO;SO;VX;OL[2];`;
- результат парсится `ResponseParser`;
- `SET GLOBAL STATE` кладет payload в `global.drive_state`;
- `GlobalStateReader` собирает полный init-state для UI.

Диапазоны:

- `high`: `CA[18] = 262144000`, минимум скорости 1 угл. секунда/с, максимум ограничивается примерно 5 град/с по `VH[2]`;
- `low`: `CA[18] = 6553600`, минимум 10 град/с, максимум до 360 град/с;
- `current_range` определяется через `OL[1]`: `0 = high`, `1 = low`.

Что работает:

- есть ручная установка параметров движения;
- есть проверки диапазонов скорости и ускорения;
- есть `Drive Init`, который делает `ST`, `MO=0`, настраивает параметры диапазона, включает `MO=1`, запускает один оборот `PR=CA[18]`, читает состояние;
- есть ручное переключение диапазона `set_resolution`;
- есть decode `SR[0-3]` в человекочитаемый статус.

Проблемы:

- backend не запрещает `set_resolution` при включенном приводе; в комментарии сказано, что это проверяется UI, но для production интерлок должен быть на backend;
- `Drive Init` не оформлен как state machine с проверками завершения и ошибок;
- нет явного timestamp для `drive_state`, поэтому нельзя надежно отличить "привод жив" от "последнее состояние устарело";
- `SR` декодируется только частично;
- нет давления, нет torque из реального источника, `torque` по умолчанию 0;
- сценарии в этой вкладке отсутствуют как рабочая логика.

Сценарии:

- в `Угловая скорость` есть `scenarioMode`, `selectedScenario`, `scenarioList = ["Scenario 1", "Scenario 2", "Scenario 3"]`;
- эти поля не отправляют backend-команды;
- отдельный UI-шаблон `Сценарии` хранит демо-сценарии только в `data()` Vue-компонента;
- в `C:\NC3\scenarios` есть `.scn` файлы, но Node-RED их не читает.

### 3.4. `SETTINGS flow`

Назначение: UI настроек и частичная работа с `global.settings`.

UI-команды:

- `settings_aply`;
- `reread`.

Обрабатываемые данные:

- объект настроек из UI;
- `global.settings`;
- `global.activeSession`;
- client metadata `msg._client.socketIp`.

Что работает:

- при `reread` UI получает `settings`, `activeSession`, `topic = initiation`;
- при `settings_aply` значение пишется в `global.settings`;
- UI содержит базовые и advanced-настройки: remote control, language, angle correction, periods, ranges, BEP coefficients, encoder calibration, aerostatic support diagram.

Проблемы:

- настройки не пишутся в `C:\NC3\settings.json`;
- `SettingsPersister` находится в `new ui flow`, ожидает `save_settings`, но не получает сообщений;
- пароль advanced-режима фактически отключен;
- кнопка `Drive Init` в настройках делает только `alert`, а не команду в backend;
- структура UI-настроек не совпадает полностью с `C:\NC3\settings.json`: в файле есть `rotationSpeedRanges`, в UI по умолчанию используется `rotationSpeed`;
- нет схемы валидации настроек и миграций.

## 4. Функциональные потоки данных

### 4.1. Startup/config

Источник: `C:\NC3\settings.json`  
Обработчик: `INIT flow/function 1`  
Приемники: `global.settings`, UI через `reread`

Данные:

- `general.remoteControl`;
- `general.angleCorrectionEnabled`;
- `general.language`;
- `general.angleSavingMode`;
- `advanced.readPeriodRotation`;
- `advanced.readPeriodTilt`;
- `advanced.readPeriodBEP`;
- `advanced.dataDurationSec`;
- диапазоны скорости;
- диапазон наклона;
- скорость переключения энкодеров;
- коэффициенты БЕП;
- круглограмма;
- калибровки энкодеров.

Текущий разрыв: изменения из UI не возвращаются в файл настроек.

### 4.2. ELMO / угловая скорость

Источник команд: UI `Угловая скорость`  
Обработчик: `CommandHandler`  
Транспорт: TCP `192.168.1.2:2000`  
Ответы: `ResponseParser`  
Глобальный state: `global.drive_state`, `global.current_range`, `global.drive_limits`

Данные:

- команды `MO`, `ST`, `BG`, `HM[1]`, `SP`, `AC`, `DC`, `JV`, `JP`, `PA`, `PR`, `OL[1]`, `OL[2]`;
- telemetry/status `PX`, `VX`, `MS`, `MO`, `SO`, `AF`, `SR`, `SP`, `AC`, `DC`, `TR[1]`, `TR[3]`, `SD`, `QS`, `VH[1]`, `VL[1]`, `VH[2]`;
- расчетные лимиты скорости и ускорений.

### 4.3. БУН / наклон

Источник данных: `C:\NC3\nc3_bun.py` -> MQTT  
Транспорт: MQTT `localhost:1883`  
Топики:

- вход в Node-RED: `bun_angle`, `bun_systate`;
- выход из Node-RED: `bun_cmd`, `bun_cmd_setpoint`.

Низкоуровневое железо:

- UDP `192.168.1.5:32767`;
- регистры в `nc3_bun.py`: `ANGLE_REG = 0xAAB2`, `SETPOINT_REG = 0x0004`, `RAW_ANGLE_REG = 0x0006`, `COMMAND_REG = 0xCCCC`.

Данные:

- текущий угол наклона;
- слово состояния;
- целевой угол;
- команды управления;
- состояние тормоза через `OL[2]`.

### 4.4. БЕП / зазоры

Источник данных: `C:\NC3\nc3_bep.py` -> MQTT  
Транспорт: MQTT `localhost:1883`  
Низкоуровневое железо: UDP `192.168.1.20:20001`

Фактические топики базового скрипта:

- вход в скрипт: `cmd-topic`, `file-topic`;
- выход из скрипта: `reply-topic`, `file-rep-topic`, `ch1/data`...`ch5/data`, `ch1/addr`...`ch5/addr`.

Топики, добавленные flow:

- `bep/control`;
- `bep/write-config`;
- `bep/status`.

Данные:

- емкость/код измерения по 5 каналам;
- адреса каналов;
- команды старта/остановки измерений;
- CAPDAC/board config;
- калибровочные смещения.

Текущий разрыв: flow и скрипт описывают разные уровни протокола; без адаптера high-level topics не будут работать.

### 4.5. Протоколы и raw data

Источник:

- `global.angle_buffer`, наполняемый из `PX`;
- `global.velocity_setpoint_ticks`;
- `global.bun_angle`;
- `global.current_range`.

Пути:

- протоколы: `C:\NC3\protocols\protocol_<timestamp>.txt`;
- raw data: `C:\NC3\data\data_<timestamp>.txt`.

Данные:

- заголовок протокола;
- угол наклона;
- диапазон воспроизведения;
- расчетная скорость;
- погрешность;
- имя raw-файла при включенной записи исходных данных;
- временной ряд `time, angle`.

Текущий разрыв: нет автоматического сценарного протоколирования и нет production-журнала событий.

### 4.6. Удаленное управление

Источник: `ui-control` и `msg._client`  
State: `global.activeSession`, `settings.general.remoteControl`

Текущая логика:

- если remoteControl включен и подключился не `127.0.0.1`, `activeSession` записывается из `_client`;
- `Настройка` определяет `isActiveUser` по IP;
- большинство управляющих UI-кнопок не использует `isActiveUser`;
- backend не валидирует владельца команды.

Для production нужен единый command gate перед всеми опасными командами.

## 5. Глобальный контекст, необходимый для корректной работы

### 5.1. Внешний runtime-контекст

Для корректной работы приложения должны быть доступны:

- Node-RED с установленными Dashboard 2 UI nodes, MQTT, TCP, file, exec nodes;
- MQTT broker на `localhost:1883`;
- Python с зависимостью `paho-mqtt`;
- `C:\NC3\nc3_bun.py`;
- `C:\NC3\nc3_bep.py`;
- `C:\NC3\settings.json`;
- `C:\NC3\protocols`;
- `C:\NC3\data`;
- `C:\NC3\scenarios`;
- ELMO TCP endpoint `192.168.1.2:2000`;
- БУН UDP endpoint `192.168.1.5:32767`;
- БЕП UDP endpoint `192.168.1.20:20001`;
- сетевой доступ к оборудованию в подсети `192.168.1.x`.

### 5.2. Ключи `global context`

| Ключ | Владелец/источник | Назначение |
|---|---|---|
| `settings` | `INIT flow`, `SETTINGS flow` | Текущие настройки приложения |
| `elmo` | `INIT flow` | Первичный снимок состояния ELMO |
| `drive_state` | `BUN flow/SET GLOBAL STATE` | Основной live-state привода |
| `current_range` | `ResponseParser`, `CommandHandler` | Активный диапазон `high/low` |
| `drive_limits` | `ResponseParser`, `CommandHandler` | Расчетные лимиты скорости и ускорения |
| `velocity_setpoint_ticks` | `ProtocolManager` | Уставка скорости для расчета погрешности |
| `protocol_open` | `ProtocolManager` | Флаг открытого протокола |
| `protocol_filename` | `ProtocolManager` | Полный путь активного протокола |
| `is_recording` | `ProtocolManager` | Флаг записи raw/измерительного окна |
| `angle_buffer` | `angle_buffer` function | Временной ряд угла для расчета скорости |
| `recording_duration_sec` | `ProtocolManager` | Длительность окна записи |
| `recording_save_raw_data` | `ProtocolManager` | Нужно ли писать raw-файл |
| `logs` | `ProtocolManager` | In-memory журнал UI |
| `journal_state` | `ProtocolManager` | Состояние вкладки `Журнал` |
| `bun_angle` | ожидается от БУН контура | Текущий угол наклона |
| `values.tilt_curr` | `new ui flow/tilt_curr` | Текущий угол наклона для старого UI-контракта |
| `activeSession` | `ui-control` | Активная удаленная UI-сессия |
| `use_calib` | настройки/ручной контекст | Флаг применения калибровки |
| `v1_gap_inp/out`...`v5_gap_inp/out` | BEP калибровка | Смещения каналов БЕП |
| `v2_inp/out` | BUN калибровка | Смещение угла БУН |

Рекомендация: добавить в каждый live-state `updated_at`, `source`, `quality`, `error`, чтобы отличать актуальные данные от старых.

## 6. Глобальные состояния системы и как их определять

### 6.1. Состояние конфигурации

Состояния:

- `settings_missing`;
- `settings_invalid`;
- `settings_loaded`;
- `settings_dirty`;
- `settings_saved`.

Как определять:

- `settings_loaded`: `global.settings` является объектом и прошел schema validation;
- `settings_invalid`: ошибка чтения/парсинга `C:\NC3\settings.json`;
- `settings_dirty`: UI изменил настройки, но файл еще не записан;
- `settings_saved`: успешная запись файла и перечитывание/проверка.

Сейчас есть только неформальный `global.settings`.

### 6.2. Состояние привода ELMO

Состояния:

- `offline`;
- `online_idle`;
- `motor_off`;
- `motor_on_ready`;
- `moving`;
- `fault`;
- `initializing`;
- `range_switching`;
- `stale`.

Как определять:

- `offline/stale`: нет свежего `drive_state.updated_at` за допустимый интервал;
- `motor_off`: `drive_state.mo === false`;
- `motor_on_ready`: `mo === true`, `so === true`, `sr_status.ok === true`, `ms` не в движении;
- `moving`: по `MS` и/или `VX !== 0`;
- `fault`: `sr_status.ok === false` или ошибка TCP;
- `current_range`: `drive_state.resolution` или `global.current_range`, подтверждено `OL[1]`.

Сейчас `updated_at` отсутствует, поэтому `offline/stale` надежно не определяется.

### 6.3. Состояние диапазона энкодеров

Состояния:

- `high`;
- `low`;
- `switching`;
- `unknown`;
- `switch_failed`.

Как определять:

- `high`: `OL[1] === 0`;
- `low`: `OL[1] === 1`;
- `switching`: backend выполняет `set_resolution`/автопереключение;
- `switch_failed`: после команды `OL[1]` не совпадает с целевым диапазоном за timeout.

Сейчас есть `current_range`, но нет state machine переключения.

### 6.4. Состояние БУН/наклона

Состояния:

- `tilt_offline`;
- `tilt_manual`;
- `tilt_auto_moving`;
- `tilt_reached`;
- `tilt_brake_on`;
- `tilt_brake_off`;
- `tilt_fault`.

Как определять:

- угол: по `bun_angle`;
- слово состояния: по `bun_systate`;
- тормоз: по `OL[2]`/`drive_state.bun_brake`;
- достижение угла: по разнице `target - bun_angle` и допуску из ТЗ;
- fault: по битам `bun_systate` и отсутствию свежих данных.

Сейчас нет единого `tilt_state`.

### 6.5. Состояние БЕП

Состояния:

- `bep_process_stopped`;
- `bep_process_starting`;
- `bep_process_running`;
- `bep_process_error`;
- `bep_data_fresh`;
- `bep_data_stale`;
- `bep_gap_out_of_range`.

Как определять:

- process: по PID/exit code/stdout/stderr или внешнему supervisor;
- data freshness: timestamp последнего `chN/data`;
- gap status: расчет зазора по коэффициентам и допустимым пределам;
- communication fault: нет MQTT данных за timeout.

Сейчас BEP state не оформлен; есть UI-поток данных и частичная process-обвязка.

### 6.6. Состояние протокола и записи

Состояния:

- `protocol_closed`;
- `protocol_open`;
- `recording_idle`;
- `recording_active`;
- `recording_error`;
- `journal_ready`;
- `journal_error`.

Как определять:

- `protocol_open`: `global.protocol_open === true` и `global.protocol_filename` непустой;
- `recording_active`: `global.is_recording === true`;
- `recording_error`: недостаточно точек, ошибка записи файла, нет протокола;
- `journal_ready`: список файлов получен и выбранный файл прочитан.

Этот контур есть частично, но без устойчивой файловой обработки ошибок и без event-log по ТЗ.

### 6.7. Состояние сценария

Целевые состояния:

- `idle`;
- `loaded`;
- `starting`;
- `running`;
- `waiting_accuracy`;
- `holding`;
- `recording_step`;
- `switching_range`;
- `paused`;
- `emergency_stop`;
- `completed`;
- `error`.

Как определять:

- только через отдельный `ScenarioManager`, который хранит `scenario_state` в global context;
- state должен содержать файл, список шагов, текущий индекс, целевую скорость, целевой диапазон, таймер удержания, статус записи, причину остановки, возможность продолжения.

Сейчас такого состояния нет.

### 6.8. Состояние удаленного управления

Состояния:

- `local_control`;
- `remote_available`;
- `remote_owned`;
- `remote_conflict`;
- `remote_disabled`.

Как определять:

- `remote_disabled`: `settings.general.remoteControl === false`;
- `local_control`: remote off и `_client.socketIp === 127.0.0.1`;
- `remote_owned`: remote on и `_client` совпадает с `global.activeSession`;
- `remote_conflict`: remote on, команда пришла не от владельца;
- `remote_available`: remote on, activeSession не установлен или истек.

Сейчас это частично реализовано только в UI настроек, не в backend.

## 7. Сопоставление с ТЗ и приложением к ТЗ

### Реализовано частично

- Операторский UI с вкладками угловой скорости, БУН/БЕП, мониторинга, настроек, журнала.
- Ручное управление угловой скоростью: `MO`, `ST`, `JV`, `JP`, `PA`, `PR`, `Drive Init`.
- Чтение положения/скорости/статусов ELMO.
- Высокий/низкий диапазон энкодеров и часть ограничений скорости.
- Интеграция с БУН через MQTT-шлюз.
- Интеграция с БЕП через MQTT-данные каналов.
- Настройки периодов, диапазонов, коэффициентов и языка в UI.
- Открытие/закрытие протокола, запись результата, запись raw data.
- Просмотр списка протоколов и связанных raw data.

### Не доведено до требований ТЗ

- Автоматическая работа по сценариям из файла.
- Автоматическое переключение диапазона в сценарии по Приложению А.
- Удержание скорости после достижения требуемой точности.
- Автоматическое открытие/ведение протокола в сценарии.
- Продолжение сценария после технологической остановки.
- Коррекция угла наклона по данным БЕП и круглограмме.
- Полноценное управление БУН в автоматическом режиме с тормозом.
- Датчик давления Festo.
- Пользовательский/технологический режим с реальным паролем.
- Production-grade удаленное управление с блокировкой локальных команд.
- Event journal с глубиной регистрации.
- Графики по предыдущим результатам.
- Полное преобразование емкости БЕП в зазор по коэффициентам.
- Валидация всех параметров по ТЗ на backend.
- Воспроизводимое развертывание.

## 8. Roadmap доведения до production

### Этап 0. Зафиксировать базу и окружение

1. Принять `C:\Users\Артём\.node-red\projects\LowSpeedCentrifuge3` как единственный рабочий проект.
2. Сделать backup текущего `flows.json` и `C:\NC3\settings.json`.
3. Зафиксировать Node-RED зависимости в `package.json`.
4. Описать runtime: Node.js, Node-RED, Dashboard, Mosquitto/MQTT, Python, `paho-mqtt`, сетевые адреса.
5. Вынести адреса/пути из function-узлов в один config/settings слой.

### Этап 1. Устранить критические runtime-дефекты

1. Починить сохранение настроек:
   - маршрут `settings_aply` должен писать `C:\NC3\settings.json`;
   - добавить schema validation;
   - вернуть UI подтверждение `settings_saved/settings_error`.
2. Починить запуск БЕП:
   - `exec` должен запускать `python C:\NC3\nc3_bep.py` или внешний supervisor;
   - убрать мертвый `set script path` или подключить его правильно;
   - привести `bep/control`, `bep/write-config`, `bep/status` к реальному контракту `nc3_bep.py` или написать адаптер.
3. Добавить timestamps и stale-detection для `drive_state`, БУН, БЕП.
4. Сделать нормальные error-сообщения UI при TCP/MQTT/file/exec ошибках.
5. Поднять `SettingsPersister` в правильное место потока или объединить с `SETTINGS flow`.

### Этап 2. Безопасность команд и глобальный state

1. Ввести единый `CommandGate` перед всеми командами ELMO/БУН/БЕП.
2. Проверять:
   - владелец remote-сессии;
   - нет активного сценария;
   - привод в допустимом состоянии;
   - команда разрешена для текущего режима.
3. Backend-интерлок для `set_resolution`: не разрешать переключение при `MO/SO/moving`.
4. Оформить `DriveInitManager` как state machine с timeout, проверками `SO/MS/SR`, логированием результата.
5. Добавить общий emergency stop: ELMO `ST`, останов сценария, останов записи, лог причины.

### Этап 3. Реализовать сценарии

1. Загрузчик файлов из `C:\NC3\scenarios`.
2. Парсер формата `.scn`: `speed_deg_per_sec duration_sec resolution`.
3. Валидация каждого шага по диапазонам high/low.
4. `ScenarioManager` с `scenario_state`.
5. Команды:
   - `scenario_list`;
   - `scenario_load`;
   - `scenario_start`;
   - `scenario_pause`;
   - `scenario_resume`;
   - `scenario_stop`;
   - `scenario_emergency_stop`.
6. Автопереключение диапазона:
   - остановить вращение;
   - показать/залогировать сообщение на 2 секунды;
   - переключить энкодерную пару;
   - выполнить `Drive Init` на один оборот;
   - показать/залогировать сообщение на 2 секунды;
   - продолжить текущий шаг.
7. Удержание скорости после достижения точности.
8. Автоматическое протоколирование и raw-data по каждому шагу.
9. UI статуса сценария: текущий файл, шаг, скорость, диапазон, таймер, состояние, причина паузы/ошибки.

### Этап 4. Протоколы, журнал, измерения

1. Привести формат протокола и raw data к Приложению А.
2. Добавить расчет критерия "скорость достигнута".
3. Добавить хранение событий в файл/БД, а не только `global.logs`.
4. Добавить уровни событий: error, warning, info, confirmation.
5. Добавить настройку глубины регистрации.
6. Добавить графики raw data и предыдущих результатов.
7. Добавить тестовые fixtures для парсинга протоколов и сценариев.

### Этап 5. БУН, БЕП, коррекции, давление

1. Сделать `TiltManager`:
   - ручной режим;
   - автоматический режим;
   - отпуск тормоза;
   - команда угла;
   - ожидание достижения;
   - включение тормоза;
   - останов.
2. Реализовать расчет угла с поправкой по БЕП и круглограмме.
3. Реализовать преобразование БЕП емкость -> зазор по коэффициентам.
4. Добавить контроль fresh/stale/out-of-range для каждого канала БЕП.
5. Добавить датчик давления Festo в flow, UI, журнал и global state.
6. Проверить и зафиксировать расхождения `Протокол_БУН.docx` против `nc3_bun.py`.

### Этап 6. Production-развертывание

1. Оформить запуск как набор служб:
   - Node-RED;
   - MQTT broker;
   - `nc3_bun.py`;
   - `nc3_bep.py`.
2. Добавить health-check страницу:
   - ELMO online/stale;
   - MQTT connected;
   - БУН online/stale;
   - БЕП process/data;
   - filesystem writable;
   - active remote owner.
3. Добавить логирование stdout/stderr Python-шлюзов в файлы.
4. Добавить restart policy для Python-шлюзов.
5. Добавить smoke-test без железа на mocked MQTT/TCP.
6. Добавить hardware-in-loop чеклист приемки.
7. Обновить `README.md`, убрать устаревшие утверждения о production-flow и описать фактическую архитектуру.

## 9. Приоритетный порядок работ

P0:

1. Починить `settings_aply -> C:\NC3\settings.json`.
2. Починить запуск `nc3_bep.py`.
3. Добавить freshness/error state для ELMO/БУН/БЕП.
4. Ввести backend `CommandGate`.

P1:

1. Реализовать `ScenarioManager`.
2. Реализовать автопереключение диапазона с `Drive Init`.
3. Привести протокол и raw data к Приложению А.
4. Сделать persistent event journal.

P2:

1. Довести БУН auto tilt sequence.
2. Реализовать BEP capacitance-to-gap и коррекцию наклона.
3. Добавить датчик давления.
4. Добавить графики и анализ протоколов.

P3:

1. Production installer/services.
2. Документация эксплуатации.
3. Автотесты и HIL-приемка.

## 10. Минимальные acceptance checks перед production

1. После перезапуска Node-RED настройки читаются из `C:\NC3\settings.json`, меняются из UI и сохраняются обратно.
2. При выключенном MQTT UI показывает БУН/БЕП offline, а не старые значения.
3. При выключенном ELMO UI показывает drive offline/stale, команды блокируются.
4. `Drive Init` имеет понятный результат: success/error/timeout.
5. `set_resolution` невозможен при движении или включенном приводе.
6. `nc3_bep.py` запускается/останавливается штатно, статус виден в UI.
7. Сценарий из `C:\NC3\scenarios` выполняется от начала до конца.
8. При шаге вне текущего диапазона выполняется автопереключение по Приложению А.
9. Протокол и raw data создаются автоматически в сценарии.
10. Event journal переживает перезапуск Node-RED.
11. Remote mode блокирует команды всех клиентов, кроме владельца сессии.
12. Advanced-настройки реально защищены паролем.

## 13. Обновление после рефактора настроек и протоколов от 2026-05-22


Работа выполнена в локальной папке проекта: `C:\Users\Артём\.node-red\projects\LowSpeedCentrifuge3`. Worktree-версия как источник кода не использовалась.

### 13.1. Что изменено в `flows.json`

1. Контур настроек переведен на устойчивую схему: Vue-вкладка `Настройка` отправляет `settings_aply`, `SettingsNormalize` нормализует структуру, кладет значения в global context, а запись `C:\NC3\settings.json` выполняет штатный Node-RED `file` node с `encoding: utf8`. В `function`-узлах больше нет `require`/`import`.
2. Инициализация настроек через `INIT flow` теперь парсит JSON строку из `file in`, нормализует настройки и заполняет `global.settings`, `global.ui_language`, `global.drive_speed_ranges`, `global.recording_duration_sec`, `global.drive_limits_override`. У `file in` включен выход ошибки, чтобы отсутствующий/битый файл не оставлял систему без defaults.
3. Настройка языка переведена на единый источник `settings.general.language`; `GlobalStateReader`, `БУН`, `БЕП`, `Угловая скорость` и `Настройка` нормализуют `Russian/English/russian/english/en` к рабочим значениям UI.
4. Диапазоны скоростей вращения разделены по разрешениям `high` и `low`: настройки хранят `advanced.rotationSpeedRanges.high/low.min/max`, поддерживают DMS, десятичные градусы и радианы, и применяются в `CommandHandler`/`ResponseParser` при расчете `drive_limits` и `VH[2]`.
5. Периоды чтения сохраняются в настройках, но runtime-периодичность опроса пока намеренно не меняется.
6. Удаленное управление не трогалось. Поправка угла наклона по БЕП не реализовывалась. Калибровочные коэффициенты БЕП/энкодеров оставлены как есть.
7. Режим сохранения угла наклона в протоколе теперь учитывает `settings.general.angleSavingMode`: при `header` строка `Угол_наклона_оси_вращения` пишется в заголовок, при `none` не пишется.
8. Все Vue-template компоненты теперь отправляют `reread` после `mounted()`. `GlobalStateReader` возвращает единый `topic=init` с `payload.settings`, `payload.elmo`, полями протокола, `bun_angle`, `bun_brake`, `logs`. Для `Журнал` добавлен ответ `ProtocolManager` на `reread`.
9. `БУН` получил ввод требуемого угла в трех режимах: DMS, десятичные градусы, радианы. Во внешний MQTT `bun_cmd_setpoint` по-прежнему отправляются угловые секунды, как требует текущий протокол БУН.
10. В `ResponseParser` добавлен разбор `TM` ELMO. Создана отдельная ветка опроса `ELMO PX/TM sample poll`: `inject -> ELMO PX/TM command -> tcp request -> ELMO PX/TM parser -> angle_buffer`.
11. `angle_buffer` больше не использует `Date.now()`; время образца берется из `TM` в микросекундах и хранится как `t = tm_us / 1e6`, `tm_us`, `angle`, `position_ticks`, `resolution`. Длительность буфера берется из `global.recording_duration_sec` или `settings.advanced.dataDurationSec`.
12. Старый путь `poll_data -> angle_buffer` отключен, чтобы в буфер протокола не попадали образцы с системным временем Node-RED.

### 13.2. Проверки

- `flows.json` успешно парсится как JSON.
- Все `function`-узлы проходят синтаксическую проверку через `new Function(...)`.
- Все Vue `<script>` блоки проходят синтаксическую проверку после замены `export default` на `return`.
- В `function` и `ui-template` узлах нет ключевых слов/вызовов `require`, `import`, а также опечатки `requier`.
- В `angle_buffer` больше нет `Date.now() / 1000`.

### 13.3. Обновленный роадмап доведения до production

#### Этап 0. Runtime-контракт и настройки

Статус: частично выполнен.

Сделано:

- нормализация и запись настроек в `C:\NC3\settings.json` через Node-RED `file` node;
- загрузка настроек в global context при инициализации;
- единый язык интерфейса через `settings.general.language`;
- диапазоны скорости `high/low` с DMS/deg/rad и применением к backend-лимитам;
- хранение длительности буфера данных;
- сохранение угла наклона в протоколе по настройке `angleSavingMode`;
- запрет `require/import` в Node-RED function/ui-template коде.

Осталось:

- проверить реальный deploy Node-RED после перезапуска runtime;
- определить, должен ли bootstrap автоматически создавать `C:\NC3\settings.json`, если файла нет;
- вынести настройки сети ELMO/БУН/БЕП из hardcode в настройки;
- восстановить защищенный доступ к advanced-настройкам без небезопасной browser-only криптографии внутри шаблона.

#### Этап 1. Стабилизация runtime и reread

Статус: частично выполнен.

Сделано:

- все Vue-компоненты отправляют `reread` после монтирования;
- `GlobalStateReader` возвращает единый снимок состояния;
- `Журнал` получает состояние через `ProtocolManager` по `reread`;
- `Мониторинг` и `Сценарии` подключены к `GlobalStateReader`.

Осталось:

- заменить статичные/демо-значения `Мониторинг` на полностью реальные значения УУВ/БУН/БЕП/давления;
- формализовать `system_state`: startup, ready, fault, recording, scenario_running, manual_control, remote_locked;
- добавить единый журнал ошибок/предупреждений с уровнями и кодами;
- сделать backend-gate команд по состояниям привода, протокола, remote session и авариям.

#### Этап 2. Протоколы, данные и временная синхронизация

Статус: начато.

Сделано:

- создан отдельный опрос `PX;TM;`;
- `angle_buffer` формируется по `TM`, а не по системному времени Node-RED;
- длительность буфера берется из настроек;
- `ProtocolManager` учитывает настройку сохранения угла наклона.

Осталось:

- проверить реальный формат ответа ELMO на `PX;TM;` и порядок параметров;
- определить формат raw data file и набор колонок;
- реализовать привязку буфера `PX/TM` к записям скорости/протокола;
- решить, нужны ли в data-файле одновременно `TM`, `PX`, `VX`, `JV/SP`, `BEP`, `BUN angle`, давление;
- сделать атомарное завершение записи: запись протокола и data-файла должны быть согласованы.

#### Этап 3. Сценарный режим

Статус: не реализован как backend.

Нужно сделать:

- файловый список сценариев из `C:\NC3\scenarios`;
- парсер формата `Значение_скорости Время_поддержания`;
- state machine `ScenarioManager`;
- ожидание достижения точности перед стартом удержания;
- запись результата шага в протокол;
- создание data-файла на каждый шаг при включенной записи исходных данных;
- пауза/стоп/аварийный стоп/продолжение сценария;
- продолжение сценария после смены диапазона и Drive Init.

#### Этап 4. Переключение диапазонов

Статус: частично подготовлено настройками и backend-лимитами.

Нужно сделать:

- определить точную границу переключения high/low и hysteresis;
- при выходе сценарного шага за текущий диапазон останавливать вращение;
- переключать `OL[1]`, выполнять Drive Init, логировать событие;
- продолжать сценарий с текущего шага после успешной инициализации;
- обеспечить ручной и автоматический режимы переключения по приложению А.

#### Этап 5. БУН/БЕП/коррекция наклона

Статус: отложено до методик.

Нужно сделать после уточнений:

- формализовать алгоритм автоматического задания наклона по приложению А;
- реализовать state machine БУН: ручной режим, автоматический режим, отпускание тормоза, GO, достижение угла, включение тормоза;
- определить пересчет данных БЕП в зазор/поправку угла;
- реализовать поправку отображаемого угла наклона только после утверждения методики;
- привести MQTT-топики БЕП в соответствие с `nc3_bep.py` или изменить скрипт и документировать новый контракт.

#### Этап 6. Production hardening

Нужно сделать:

- фиксированный список Node-RED модулей и версий;
- backup/restore `flows.json`, `settings.json`, сценариев, протоколов;
- systemd/nssm/pm2 или другой способ автозапуска Node-RED, MQTT и Python-шлюзов;
- health checks для ELMO, БУН, БЕП, MQTT, файловой системы;
- журнал аудита действий оператора;
- тестовый стенд или simulator mode для ELMO/БУН/БЕП;
- регламент приемочных испытаний.

### 13.4. Уточняющие вопросы для завершения production-разработки

#### Настройки и runtime

1. Должна ли программа сама создавать `C:\NC3\settings.json` с defaults при первом запуске, если файла нет, или отсутствие файла должно быть ошибкой оператора/инсталляции?
2. Какие настройки должны быть доступны оператору, инженеру и администратору отдельно? Нужна ли ролевая модель или достаточно пароля на advanced?
3. Где должен храниться пароль/секрет advanced-доступа: в файле настроек, в Node-RED credential storage, в ОС или пока допускается фиксированный пароль?
4. Какие параметры сети ELMO/БУН/БЕП/MQTT должны быть редактируемыми из UI, а какие фиксируются при пусконаладке?
5. Нужен ли аудит изменения настроек: кто, когда, что изменил, старое/новое значение?

#### УУВ / ELMO / диапазоны скорости

6. Подтвердить фактические диапазоны high/low в градусах/с: текущие defaults high `1 угл.сек/с .. 20 град/с`, low `10 .. 360 град/с` корректны?
7. Нужен ли hysteresis при автоматическом выборе диапазона, чтобы скорость около границы не вызывала повторные переключения?
8. Что делать, если текущая скорость попадает в пересечение high/low: оставлять текущий диапазон или выбирать по точности?
9. Какие точные критерии `скорость достигнута`: абсолютная ошибка, относительная ошибка, время устойчивости, допустимые колебания?
10. Какой timeout ожидания достижения скорости считать ошибкой сценария?
11. Какие параметры ELMO должны писаться в data-файл вместе с `PX/TM`: `VX`, `JV`, `SP`, `MS`, `SR`, `SO/MO`, `AF`, ошибки?
12. Подтвердить реальный формат ответа ELMO на группу `PX;TM;`: приходит `PX;<value>;TM;<value>`, `PX=<value>;TM=<value>` или возможен другой формат/эхо команд?
13. Нужно ли синхронизировать `VX` той же временной меткой `TM`, то есть опрашивать `PX;VX;TM;` вместо `PX;TM;`?
14. Какая допустимая частота опроса `PX/TM` для протокола: 10 Гц, 30 Гц, 100 Гц или другое значение? Сейчас ветка поставлена как 10 Гц для снижения риска нагрузки.

#### Протоколы и файлы данных

15. Должен ли угол наклона сохраняться только в заголовке протокола или также в каждой строке результата/каждом data-файле?
16. Если `angleSavingMode=none`, нужно ли полностью скрывать угол из всех файлов или только из заголовка протокола?
17. Какой окончательный формат строки результата в протоколе: поля, единицы, количество знаков, комментарии, разделители?
18. Как именовать data-файлы: по времени, по протоколу, по шагу сценария, по заданной скорости?
19. При ошибке записи data-файла надо ли останавливать установку или только фиксировать ошибку в журнале?
20. Нужна ли защита от перезаписи протоколов/data-файлов с одинаковыми именами?
21. Где должны храниться протоколы и данные в production: `C:\NC3\protocols`, `C:\NC3\data` или другая структура?
22. Какие события обязательны для журнала: запуск ПО, вход/выход оператора, Drive Init, смена диапазона, старт/стоп записи, ошибки связи, аварийный стоп, изменение настроек?

#### Сценарии

23. Утвердить формат файла сценария: только строки `скорость время`, заголовок обязателен, комментарии разрешены?
24. В каких единицах скорость в сценарии: только градус/с или нужны DMS/радианы?
25. Время удержания начинается после достижения точности или после отправки команды скорости? В приложении А указано после достижения точности, нужно подтвердить.
26. Что делать при недостижении точности: повторить команду, остановить шаг, остановить сценарий, предложить оператору выбор?
27. При смене диапазона сценарий должен продолжаться автоматически всегда или только после подтверждения оператора?
28. Нужна ли пауза сценария с удержанием текущей скорости или пауза всегда означает остановку вращения?
29. Что считать результатом шага сценария: среднюю скорость за время удержания, последнюю скорость, min/max/std, интеграл по `PX/TM`?

#### БУН / наклон

30. Подтвердить единицы `ANGLE_REG` и `SETPOINT_REG` БУН: угловые секунды, как сейчас предполагает UI и MQTT payload?
31. В автоматическом режиме БУН должен сам выполнять последовательность `тормоз выкл -> GO -> достижение угла -> тормоз вкл -> привод выкл`, или часть этой логики уже реализована в прошивке БУН?
32. Какие биты `SYS_STATE_REG` означают режимы/ошибки/готовность/достижение уставки?
33. Какой критерий достижения угла наклона и timeout для автоматического режима?
34. Команды `ZERO` и `GO` в документе БУН помечены как частично отключенные. Их можно использовать сейчас на реальном стенде?
35. Нужно ли сохранять в протокол фактический угол БУН до/после каждого измерения или только значение на момент открытия протокола?

#### БЕП / зазоры / коррекция

36. Какая точная формула пересчета сырых показаний БЕП/емкости в зазор в микрометрах?
37. Какие калибровочные коэффициенты используются для каждого канала БЕП, в каком порядке и с какими единицами?
38. Как из пяти каналов БЕП вычисляется деформация аэростатической опоры и поправка к углу наклона?
39. Нужно ли применять поправку только к отображаемому углу или также к протоколу/алгоритмам управления?
40. Как обрабатывать неисправный/отключенный канал БЕП: исключать из расчета, блокировать измерения, предупреждать оператора?
41. Какой допустимый диапазон зазоров и какие пороги аварий/предупреждений?
42. Должны ли данные БЕП записываться в data-файлы синхронно с `PX/TM`, и если да, как синхронизировать их по времени?
43. Нужно ли менять `nc3_bep.py` под текущие Node-RED топики или наоборот привести flow к уже существующим `cmd-topic/file-topic/reply-topic/chN/data`?

#### Датчик давления и безопасность

44. Какой протокол подключения Festo SPAU-P10RW: Modbus, IO-Link, аналоговый вход, дискретные выходы, Ethernet?
45. Какие пороги давления считаются предупреждением и аварией?
46. При падении давления нужно только предупреждение или немедленная остановка/запрет запуска?
47. Какие сигналы STO/безопасности доступны в Node-RED через ELMO/PLC и какие должны блокировать UI-команды?
48. Нужен ли отдельный аварийный журнал, не очищаемый при перезапуске Node-RED?

#### Удаленное управление

49. Должно ли удаленное управление быть эксклюзивной сессией одного клиента или достаточно локальной блокировки вкладки?
50. Какой timeout владения сессией и как оператор должен забирать управление при зависшем клиенте?
51. Нужно ли логировать IP/имя клиента для каждой команды управления?
52. Какие команды должны быть доступны удаленно, а какие только локально у установки?

#### Развертывание и приемка

53. Какая целевая ОС production-ПК и способ автозапуска: служба Windows, NSSM, PM2, автологин + Node-RED?
54. Нужно ли поставлять simulator mode для приемки без реального ELMO/БУН/БЕП?
55. Какие приемочные тесты считать обязательными: Drive Init, ручное вращение, сценарий, БУН, БЕП, протокол, обрыв связи, авария давления?
56. Какая политика backup: сколько хранить протоколы/data/settings/scenarios и где делать резервные копии?
