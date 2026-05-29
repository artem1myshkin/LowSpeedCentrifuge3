# Состояние проекта LowSpeedCentrifuge3

## Актуализация 2026-05-29 (UDP, атомарный poll, production bus)

Транспорт `ElmoTransport`/XStateMachine переведён с TCP `sit` на **UDP с атомарными командами** (по одной команде-параметру на датаграмму с реассемблированием в логический кадр) и компенсацией Windows-таймера — даёт ~30–32 Гц при цели 30 Гц. Production-контур `BUN flow`/`new ui flow` теперь подключён к этому транспорту через link bus: UI-команды и `tilt_brake` идут в `ELMO XState (UDP)`, ответы возвращаются в существующий `ResponseParser`. Legacy TCP-узлы оставлены в flow, но выключены.

Актуально на: 2026-05-25
Проект: `C:\Users\Артём\.node-red\projects\LowSpeedCentrifuge3`
Runtime-окружение: `C:\NC3`
Документация ТЗ: `C:\Users\Артём\Documents\NC3`

Документ описывает фактическое текущее состояние локального Node-RED проекта (по `flows.json`), что уже реализовано и что остается доделать до production. Это рабочий источник истины; устаревшие описания исправленных дефектов из прежних редакций убраны.

Источники: локальный `flows.json`, внешние Python-шлюзы `C:\NC3\nc3_bun.py` и `C:\NC3\nc3_bep.py`, `C:\NC3\settings.json`, ТЗ и приложение А к ТЗ.

## 1. Структура проекта

Вкладки `flows.json`:

1. `INIT flow` — загрузка настроек и первичный опрос ELMO.
2. `new ui flow` — основной UI-контур: БУН, БЕП, мониторинг, журнал, протоколы.
3. `BUN flow` — управление угловой скоростью ELMO (название историческое; это привод планшайбы), регулярный poll, буфер протокола, заготовка сценариев.
4. `SETTINGS flow` — UI настроек.

UI Dashboard 2, страницы:

- `Мониторинг` (`/monitoring`)
- `Угловая скорость` (`/velocity`)
- `БУН/БЕП (Tilt/Gap)` (`/tilt`)
- `Настройка` (`/settings`)
- `Журнал` (`/journal`)

Внешний runtime, который должен быть доступен:

- Node-RED с Dashboard 2, MQTT, TCP, file, exec nodes;
- MQTT broker `localhost:1883`;
- Python + `paho-mqtt`, `C:\NC3\nc3_bun.py`, `C:\NC3\nc3_bep.py`;
- `C:\NC3\settings.json`, `C:\NC3\protocols`, `C:\NC3\data`, `C:\NC3\scenarios`;
- ELMO UDP `192.168.1.2:5001` с локальным bind `:5005`, legacy ELMO TCP `192.168.1.2:2000` оставлен только как отключённый fallback, БУН UDP `192.168.1.5:32767`, БЕП UDP `192.168.1.20:20001`.

`package.json` не фиксирует версии Node-RED узлов — для воспроизводимого развертывания это нужно закрыть.

## 2. ELMO (угловая скорость)

Транспорт: UDP `Direct Access` через вкладку `ELMO XState (UDP)`: `udp out` на `192.168.1.2:5001`, `udp in` на локальном `:5005`, команды завершаются `CR`. Логика production: `CommandHandler` и `Tilt` формируют логические команды, link bus передаёт их в `ElmoTransport`, транспорт режет цепочки на атомарные UDP-команды и собирает ответы обратно, `ResponseParser` остаётся единым доменным парсером. Legacy `tcp request :2000` в `BUN flow`/`new ui flow` выключены.

Команды UI: `reread`, `driveInit`, `set_motion_params`, `motor_on/off`, `drive_stop`, `drive_bg`, `drive_home`, `set_resolution`, `set_velocity`/`set_jv`, `set_jp`, `set_absolute_position`, `set_relative_position`, `tilt_brake` (→ `OL[2]`).

`ResponseParser` понимает оба формата ответа (`PARAM=VALUE` и `PARAM;VALUE`), декодирует `SR`, определяет диапазон по `OL[1]` (`0=high`, `1=low`) и тормоз БУН по `OL[2]`.

### Диапазоны и инициализация

Две пары головок энкодера: `high` (разрешение 0,005°, `CA[18]=262144000`) и `low` (0,2°, `CA[18]=6553600`). Диапазоны скоростей по ТЗ: high `1″/с … 20°/с`, low `10 … 360°/с`; в настройках хранятся `advanced.rotationSpeedRanges.high/low.min/max` (DMS/град/рад), применяются в `CommandHandler`/`ResponseParser` для `drive_limits` и `VH[2]`.

`Drive Init`: `ST`, `MO=0`, применение параметров диапазона, `AF=0`/`EC=0`, чтение `SR`/`MF`/`EE[5]`, `MO=1`, один оборот `PR=CA[18]`+`BG`, контрольный опрос.

### Опрос состояния

Регулярный опрос владеется `ElmoTransport`: self-clocked poll 1..30 Гц с `timerCompensationMs=8`, атомарные команды `TM`/`PX`/`VX` и периодический state/full-state poll. При raw-записи частота берётся из настроек `advanced.rawDataPollHz` и ограничивается 30 Гц. Старый repeating inject `poll_data` и TCP poll builder выключены.

## 3. Протоколы, данные и метки времени

`ProtocolManager` создает:

- протокол `C:\NC3\protocols\protocol_<timestamp>.txt`;
- data-файл `C:\NC3\data\data_<timestamp>.txt`.

### Источник временного ряда — метки `TM` ELMO

Временной ряд формируется только из меток `TM` ELMO, т.к. детерминированы по времени часы контроллера привода, а не runtime Node-RED:

- `ResponseParser` берет `tm_us = (tm_before + tm_after) / 2` (бракетинг `PX` двумя `TM`);
- `angle_buffer` пишет точки `{ t: tm_us/1e6, tm_us, angle, position_ticks, resolution }`, пока `is_recording`, обрезая буфер по `recording_duration_sec`;
- точка без `tm_us` отбрасывается (системное время не подставляется);
- `finalizeRecording` считает скорость линейной регрессией `angle(t)`, погрешность к `velocity_setpoint_ticks`, и пишет колонку `Время` сырыми метками `t = tm_us / 1e6` (без вычитания `t0`) для наглядности абсолютного времени ELMO; на расчет скорости это не влияет.

### Запись: одно нажатие + авто-таймер

- кнопка `Запись` на `Угловая скорость` одноразовая: `start_recording` → кнопка блокируется;
- `ProtocolManager` сохраняет `recording_ends_at` и взводит серверный таймер на `dataDurationSec`;
- по истечении запись завершается автоматически (результат в протокол, при raw-флаге — data-файл), `is_recording` сбрасывается, кнопка снова активна;
- таймер очищается при `stop_recording`/`record_measurement`/`close_protocol` и в `On Stop` узла;
- `recording_ends_at` транслируется в `logs_update` и init-снимок `GlobalStateReader`, поэтому при смене вкладок блокировка и обратный отсчет восстанавливаются из backend.

### Формат файлов

Заголовок пишется реальными переводами строк. Строка колонок протокола: `Значение_скорости Погрешность Файл_данных # градус/с %`. При raw-режиме имя data-файла попадает в строку измерения, и `Журнал` открывает его по ссылке. Сохранение угла наклона в заголовке зависит от `settings.general.angleSavingMode` (`header`/`none`).

Известное ограничение: серверный таймер записи живет в процессе Node-RED. Переход между вкладками он переживает (дедлайн в global). При полном redeploy потока таймер сбрасывается, а `is_recording` в global остается — тогда запись завершается только через `Закрыть протокол`. При необходимости можно добавить восстановление по `recording_ends_at` в `On Start`.

## 4. Настройки

Контур устойчив: `Настройка` шлет `settings_aply` → `SettingsNormalize` нормализует структуру и кладет в global → `SettingsPersist` пишет `C:\NC3\settings.json` штатным `file` node (`utf8`). `INIT flow` парсит JSON из `file in`, нормализует и заполняет `global.settings`, `ui_language`, `drive_speed_ranges`, `recording_duration_sec`, `drive_limits_override`; у `file in` включен выход ошибки для defaults.

Язык интерфейса — единый источник `settings.general.language`, нормализуется к `russian/english` во всех компонентах. Периоды чтения сохраняются, но runtime-периодичность опроса пока не меняется.

Открыто: защита advanced-настроек паролем (без небезопасной browser-only криптографии), вынос сетевых адресов ELMO/БУН/БЕП/MQTT из hardcode в настройки, аудит изменений настроек, schema-валидация и миграции.

## 5. БУН (наклон)

`Node-RED` не работает с БУН по UDP напрямую — через MQTT-шлюз `nc3_bun.py`:

- вход: `bun_angle`, `bun_systate`;
- выход: `bun_cmd`, `bun_cmd_setpoint`;
- цепочка: `Node-RED → MQTT → nc3_bun.py → UDP/Modbus RTU → БУН`.

Команды `bun_cmd`: `go`, `stop`, `release`, `slowup`, `slowdown`, `zero`. Тормоз внешней оси управляется не через БУН, а через ELMO `OL[2]`. `БУН` UI принимает требуемый угол в DMS/град/рад, во внешний `bun_cmd_setpoint` уходят угловые секунды.

Расхождение: в `Протокол_БУН.docx` `ANGLE_REG=0x0002`, в `nc3_bun.py` — `0xAAB2` (новая версия карты регистров).

Открыто: автоматический режим наклона (последовательность `тормоз выкл → GO → достижение угла → тормоз вкл → привод выкл`) как backend state machine; критерий достижения угла и timeout; поправка отображаемого угла по деформации опоры (по БЕП и круглограмме, по приложению А).

## 6. БЕП (зазоры)

`Node-RED → MQTT → nc3_bep.py → UDP → БЕП`. Базовый `nc3_bep.py`:

- командные топики: `cmd-topic`, `file-topic`;
- ответы: `reply-topic`, `file-rep-topic`;
- данные: `ch1/data … ch5/data`, адреса `ch1/addr … ch5/addr`;
- команды: `run`, `run one <board> [<capdac>]`, `stop`, `read`, `write <board> <param_pos> <value>`.

В flow каналы переименовываются в `Channel 1…5`, проходят `BEP Calibration` (линейная коррекция `vN_gap_inp − vN_gap_out`) и идут в UI `BEP`.

Открыто:

- запуск процесса сломан: `exec` `start nc3_bep.py` выполняет `python` без аргумента `C:\NC3\nc3_bep.py` (`addpay=false`, `append=""`);
- топики flow `bep/control`, `bep/write-config`, `bep/status` не совпадают с контрактом `nc3_bep.py` (`cmd-topic`/`file-topic`/`reply-topic`/`chN/data`) — нужен адаптер или правка скрипта;
- пересчет емкости в зазор по коэффициентам ТЗ не оформлен как проверяемая функция;
- нет состояния процесса БЕП (`running/error/last_seen`) и контроля fresh/stale по каналам.

## 7. Удаленное управление

`activeSession` выставляется из `_client`, если `remoteControl` включен и подключился не `127.0.0.1`. `Настройка` определяет `isActiveUser` по IP. Backend не валидирует владельца команды, большинство кнопок не заблокированы по праву сессии. Для production нужен единый command gate перед опасными командами.

## 8. Глобальный контекст

| Ключ | Источник | Назначение |
|---|---|---|
| `settings` | INIT/SETTINGS | Текущие настройки |
| `elmo` | INIT flow | Первичный снимок ELMO |
| `drive_state` | `SET GLOBAL STATE` | Live-state привода |
| `current_range` | `ResponseParser`/`CommandHandler` | Диапазон `high/low` |
| `drive_limits` | `ResponseParser`/`CommandHandler` | Лимиты скорости/ускорения |
| `velocity_setpoint_ticks` | `ProtocolManager` | Уставка для расчета погрешности |
| `protocol_open` / `protocol_filename` | `ProtocolManager` | Открытый протокол |
| `is_recording` / `is_recording_raw` | `ProtocolManager` | Активная запись / запись raw |
| `recording_ends_at` | `ProtocolManager` | Дедлайн авто-завершения записи |
| `recording_duration_sec` | `ProtocolManager`/настройки | Длительность окна записи |
| `recording_save_raw_data` | UI/`ProtocolManager` | Пользовательский флаг raw |
| `angle_buffer` | `angle_buffer` | Ряд `{t, angle}` по меткам `TM` |
| `logs` / `journal_state` | `ProtocolManager` | In-memory журнал и состояние вкладки |
| `bun_angle` / `bun_brake` | БУН-контур / `ResponseParser` | Угол наклона / тормоз `OL[2]` |
| `activeSession` | `ui-control` | Активная удаленная сессия |
| `use_calib`, `vN_*` | калибровка | Коэффициенты БЕП/энкодеров |

Рекомендация: добавить в live-state `updated_at`/`source`/`quality`/`error` для отличия свежих данных от устаревших (сейчас stale-detection нет).

## 9. Что реализовано

- Операторский UI: угловая скорость, БУН/БЕП, мониторинг, настройки, журнал.
- Ручное управление приводом: `MO`, `ST`, `JV`, `JP`, `PA`, `PR`, `Drive Init`.
- Чтение положения/скорости/статусов ELMO, диапазоны high/low и ограничения скорости.
- Сохранение/загрузка настроек в `C:\NC3\settings.json` (`SettingsNormalize`/`SettingsPersist`/`file`), единый язык, диапазоны скоростей.
- Протокол и data-файл: метки времени от ELMO `TM`, расчет скорости регрессией, погрешность.
- Запись одним нажатием с авто-таймером и восстановлением состояния кнопки между вкладками.
- Журнал протоколов и связанных data-файлов (просмотр, ссылки).
- Интеграция БУН (MQTT) и данных каналов БЕП (MQTT).

## 10. Что открыто (роадмап)

P0:

1. Починить запуск `nc3_bep.py` (`exec` должен запускать `python C:\NC3\nc3_bep.py` или supervisor).
2. Привести топики БЕП flow к контракту `nc3_bep.py` или написать адаптер.
3. Добавить timestamps/stale-detection для `drive_state`, БУН, БЕП и понятные error-сообщения UI при TCP/MQTT/file/exec ошибках.
4. Единый `CommandGate` перед командами ELMO/БУН/БЕП (владелец сессии, состояние привода, нет активного сценария, интерлок `set_resolution` при движении/включенном приводе).

P1:

1. `ScenarioManager` (см. `scenario-feature-summary.md`): загрузка `.scn`, парсер, state machine, удержание после достижения точности, авто-протоколирование шага.
2. Автопереключение диапазонов по приложению А: остановка, сообщение на 2 с с записью в журнал, `OL[1]`, `Drive Init`, продолжение сценария с текущего шага.
3. Persistent event journal (файл/БД) с уровнями событий вместо только `global.logs`.

P2:

1. БУН auto tilt sequence как state machine.
2. Пересчет емкости БЕП в зазор и поправка угла наклона по круглограмме.
3. Датчик давления Festo (протокол, пороги, поведение при падении давления) в flow/UI/журнал.
4. Графики по данным протоколов.

P3:

1. Воспроизводимое развертывание (фиксация версий узлов, автозапуск служб, health-checks, backup/restore).
2. Документация эксплуатации и приемочные испытания, simulator mode без железа.

## 11. Acceptance checks перед production

1. Настройки переживают перезапуск Node-RED, читаются и сохраняются из UI.
2. При выключенном MQTT/ELMO UI показывает offline/stale, опасные команды блокируются.
3. `Drive Init` дает понятный результат success/error/timeout.
4. `set_resolution` невозможен при движении/включенном приводе.
5. `nc3_bep.py` запускается/останавливается штатно, статус виден в UI.
6. Сценарий из `C:\NC3\scenarios` выполняется от начала до конца, с автопереключением диапазона и авто-протоколированием.
7. Протокол и data-файл создаются корректно, метки времени — от ELMO `TM`.
8. Remote mode блокирует команды всех клиентов, кроме владельца; advanced-настройки защищены паролем.
9. Event journal переживает перезапуск Node-RED.

## 12. Открытые вопросы по железу и методикам

- Точный формат ответа ELMO на `PX;TM;` и единицы `TM` (подтвердить, что бракетинг `MS;TM;PX;TM;…` дает корректные микросекундные метки).
- Допустимая частота опроса для протокола (сейчас 1 Гц; нужна ли выше для плотности data-файла).
- Численный критерий «скорость достигнута» (абс./отн. ошибка, время устойчивости) и timeout сценарного шага.
- Единицы регистров БУН и биты `SYS_STATE_REG`; критерий достижения угла и timeout автоматического режима.
- Формула пересчета емкости БЕП в зазор и алгоритм поправки угла наклона по круглограмме (приложение А).
- Протокол подключения датчика давления Festo SPAU-P10RW и пороги предупреждение/авария.
