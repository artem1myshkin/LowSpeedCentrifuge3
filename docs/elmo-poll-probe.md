# ELMO TCP poll probe

> **Исторический (TCP).** Этот пробник измерял предел TCP-опроса и подтвердил ~4-Гц потолок `sit` + idle-gap. Проект перешёл на **UDP** — текущую частоту проще смотреть прямо во вкладке `ELMO XState (UDP)` (inject `poll mode: raw fast 30Hz` + debug `poll rate`). В актуальном runtime normal poll — `TM/PX/VX` 2 Гц, fast raw poll — `TM/PX` до 30 Гц, а скорость в `low` диапазоне выбирается из буфера `PX/TM`. См. `docs/xstate-elmo-design.md` (дизайн) и `docs/xstate-elmo-status.md` (текущее состояние).

Актуально на: 2026-05-27 (TCP-эпоха).

Файл программы: `scripts/elmo_poll_probe.c`.

Назначение: проверить реальный предел TCP-опроса ELMO вне Node-RED и вне XStateMachine. Утилита открывает один TCP socket к `192.168.1.2:2000`, последовательно отправляет команды с заданной частотой `1..30 Hz`, собирает ответы по idle-gap и печатает CSV-подобный лог с RTT, пропусками полей, дублями и overruns.

## Почему этот тест нужен

На момент TCP-теста в Node-RED использовался `tcp request` в режиме `sit` и `FrameSplitter`, который завершал кадр после периода тишины. Если один логический poll состоит из нескольких физических TCP read-команд, то минимальное время такого poll ограничено:

```text
logical_poll_time >= command_count * idle_gap_ms + TCP/ELMO overhead
```

При текущем idle gap `80 ms`:

| Режим | Команд в poll | Теоретический потолок без overhead |
|---|---:|---:|
| `vx` | 1 | около `12.5 Hz` |
| `fast-seek` (`VX/PX`) | 2 | около `6.25 Hz` |
| `fast-data` (`VX/PX/TM`) | 3 | около `4.16 Hz` |

Поэтому наблюдение `30 Hz -> ~3.2 valid frames/sec` соответствует текущей физической схеме и не доказывает баг ELMO само по себе. Для 30 Hz нужно либо надежно уменьшать idle gap, либо читать несколько регистров одним batch-запросом, либо иметь другой признак конца ответа вместо ожидания тишины.

## Сборка

На удаленном Windows-хосте перейди в каталог проекта после `git pull`:

```bat
cd C:\Users\user\.node-red\projects\LowSpeedCentrifuge3
```

MSVC Build Tools:

```bat
cl /nologo /W4 /O2 scripts\elmo_poll_probe.c /Fe:elmo_poll_probe.exe ws2_32.lib
```

MinGW-w64:

```bat
gcc -O2 -Wall -Wextra -std=c11 scripts\elmo_poll_probe.c -o elmo_poll_probe.exe -lws2_32
```

Проверка:

```bat
elmo_poll_probe.exe --help
```

## Подготовка стенда

Перед тестом нужно исключить конкуренцию за ELMO TCP:

1. Остановить Node-RED или выключить flows/nodes, которые ходят в `192.168.1.2:2000`.
2. Остановить сторонний софт, который может держать ELMO socket.
3. Проверить активные соединения:

```bat
netstat -ano | findstr 192.168.1.2:2000
```

До запуска пробника желательно не видеть `ESTABLISHED` к `192.168.1.2:2000`. Во время теста должна быть одна TCP-сессия от `elmo_poll_probe.exe`.

## Режимы утилиты

Режим задается через `--mode`.

| Режим | Что отправляется | Зачем нужен |
|---|---|---|
| `data` | `TM`, `PX`, `VX` отдельными read-командами | Обычный data poll транспорта |
| `fast-seek` | `VX`, `PX` отдельными read-командами | Исторический быстрый poll до устойчивой скорости; в актуальном runtime не используется как отдельный режим |
| `fast-data` | `VX`, `PX`, `TM` отдельными read-командами | Исторический быстрый raw poll; актуальный UDP fast raw читает только `TM/PX` |
| `vx` | только `VX` | Проверка максимума для одного регистра |
| `batch-seek` | один запрос `VX;PX;` | Проверить, выдерживает ли ELMO batch для seek |
| `batch-data` | один запрос `VX;PX;TM;` | Проверить, выдерживает ли ELMO batch для raw data |

По умолчанию используется `--mode data`.

State poll (`MO`, `SO`, `SR`) можно добавлять периодически:

```bat
--extended-every-ms 1000
```

Для теста чистого data/fast пути state poll лучше выключать:

```bat
--extended-every-ms 0
```

## Базовая матрица тестов

Сначала проверить один регистр. Это верхний предел для TCP/ELMO при текущем framing:

```bat
elmo_poll_probe.exe --mode vx --hz 1 --duration 30 --extended-every-ms 0
elmo_poll_probe.exe --mode vx --hz 10 --duration 30 --extended-every-ms 0
elmo_poll_probe.exe --mode vx --hz 30 --duration 30 --extended-every-ms 0
```

Потом проверить текущий быстрый seek:

```bat
elmo_poll_probe.exe --mode fast-seek --hz 10 --duration 30 --extended-every-ms 0
elmo_poll_probe.exe --mode fast-seek --hz 30 --duration 30 --extended-every-ms 0
```

Потом проверить текущий быстрый raw data:

```bat
elmo_poll_probe.exe --mode fast-data --hz 10 --duration 30 --extended-every-ms 0
elmo_poll_probe.exe --mode fast-data --hz 30 --duration 30 --extended-every-ms 0
```

После этого проверить batch-гипотезу:

```bat
elmo_poll_probe.exe --mode batch-seek --hz 30 --duration 30 --extended-every-ms 0
elmo_poll_probe.exe --mode batch-data --hz 30 --duration 30 --extended-every-ms 0
```

Если batch-режимы дают `missing=-`, `dups=-`, `timeouts=0`, `socket_errors=0` и мало/нет `overruns`, это сильный аргумент переходить с серии одиночных read-команд на batch для быстрых данных. Если batch дает пропуски/дубли, значит ELMO или текущий framing ненадежно держит такой формат.

## Проверка влияния idle gap

Текущий Node-RED `FrameSplitter` использует idle-gap framing. Чтобы понять предел, прогони одинаковый режим с разными `--idle-ms`:

```bat
elmo_poll_probe.exe --mode fast-data --hz 30 --duration 30 --idle-ms 80 --extended-every-ms 0
elmo_poll_probe.exe --mode fast-data --hz 30 --duration 30 --idle-ms 40 --extended-every-ms 0
elmo_poll_probe.exe --mode fast-data --hz 30 --duration 30 --idle-ms 20 --extended-every-ms 0
elmo_poll_probe.exe --mode fast-data --hz 30 --duration 30 --idle-ms 10 --extended-every-ms 0
```

Интерпретация:

- если при меньшем `idle-ms` растет `missing`, кадр режется слишком рано;
- если при большем `idle-ms` растет `overruns`, задержка framing слишком большая;
- если при batch-режимах появляются `dups`, ELMO может повторять часть ответа или ответы склеиваются;
- если `rtt_ms_avg` стабильно выше периода poll, заданная частота физически недостижима.

## Формат вывода

Заголовок:

```text
# mode=fast-data hz=30.000 period_ms=33.333 duration_sec=30 idle_ms=80 ...
# csv: seq,kind,scheduled_ms,late_ms,rtt_ms,period_overrun_ms,bytes,chunks,truncated,status,missing,dups,raw
```

Поля:

| Поле | Значение |
|---|---|
| `seq` | номер логического poll |
| `kind` | режим текущего poll |
| `scheduled_ms` | плановое время старта от начала теста |
| `late_ms` | насколько поздно стартовал poll |
| `rtt_ms` | время от отправки первой команды до завершения ответа по idle gap |
| `period_overrun_ms` | насколько `rtt_ms` превышает целевой период |
| `bytes` | байт в собранном ответе |
| `chunks` | сколько TCP chunks было получено |
| `truncated` | был ли переполнен буфер ответа |
| `status` | `OK`, `TIMEOUT` или `ERR` |
| `missing` | отсутствующие ожидаемые поля |
| `dups` | дубли ожидаемых полей |
| `raw` | escaped raw-ответ, можно скрыть через `--quiet-raw` |

Итог:

```text
# summary sent=... ok=... timeouts=... socket_errors=... overruns=... rtt_ms_min=... rtt_ms_avg=... rtt_ms_max=...
```

## Критерии результата

Режим можно считать устойчивым, если:

- `timeouts=0`;
- `socket_errors=0`;
- `missing=-` почти во всех строках;
- `dups=-` почти во всех строках;
- `overruns` отсутствуют или редкие и маленькие;
- `rtt_ms_avg` заметно меньше целевого периода.

Пример: для `30 Hz` период `33.3 ms`. Если `fast-data` с `idle-ms 80` показывает `rtt_ms_avg` около `250..320 ms`, это не проблема счетчика частоты, а следствие трех последовательных read-команд и ожидания тишины после каждой.
