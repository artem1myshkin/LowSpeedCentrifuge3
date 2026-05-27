# ELMO poll probe: независимый TCP-тестер опроса

Актуально на: 2026-05-26.

Файл программы:

```text
scripts/elmo_poll_probe.c
```

Назначение: проверить гипотезу, что проблема находится не в Node-RED/XState, а в самом ELMO, TCP-ответах ELMO или допустимой частоте опроса. Программа работает полностью вне Node-RED: открывает один TCP socket к ELMO, отправляет poll-команды с заданной частотой 1..30 Гц и печатает сырые ответы, RTT, пропуски, дубликаты полей и overruns.

---

## 1. Какая частота опроса сейчас в XState transport

Текущая XStateMachine не опрашивает ELMO на фиксированной частоте. Частота считается в `packages/nc3-elmo-machines/src/poll.js`:

```text
rate_hz = clamp(abs(omega_deg_s) / 12, 1, 30)
delay_ms = round(1000 / rate_hz)
```

Источник `omega_deg_s`:

- обычно `VX`, пересчитанный из ticks/s в deg/s через текущее разрешение `high/low`;
- сразу после команды скорости может использоваться `meta.setpointDegS`, если producer его передал.

Границы:

```text
минимум: 1 Гц
максимум: 30 Гц
```

State poll выполняется примерно раз в:

```text
statePeriodMs = 1000 ms
```

То есть при покое или очень малой скорости фактический self-poll будет около `1 Гц`. По твоему логу `ELMO_TX` с state poll шел примерно раз в секунду, а `VX` был около `0` / `9 ticks/s`, поэтому на тот момент транспорт реально опрашивал ELMO примерно на нижней границе, то есть около `1 Гц`.

---

## 2. Что именно симулирует программа

Программа симулирует poll из текущей XStateMachine:

Lean poll, отправляется на большинстве тиков:

```text
TM;PX;VX;
```

State poll, по умолчанию раз в 1000 ms:

```text
MS;MO;SO;SR;AF;OL[1];OL[2];
```

Это соответствует идее сценарного data poll:

- `TM` - время ELMO;
- `PX` - позиция;
- `VX` - скорость;
- `MS/MO/SO/SR/AF/OL[1]/OL[2]` - информативные регистры состояния/диапазона/ошибок, теперь отдельным state poll.

Каждая команда завершается `\r`.

Ответ собирается по idle gap: программа читает TCP chunks, пока после последнего chunk не наступит тишина `--idle-ms` миллисекунд. По умолчанию:

```text
--idle-ms 80
```

Это похоже на текущую схему `FrameSplitter` в режиме `sit`.

---

## 3. Сборка на Windows

Перед сборкой перейди в каталог проекта:

```bat
cd C:\Users\user\.node-red\projects\LowSpeedCentrifuge3
```

### Вариант A: MSVC Build Tools

Открой `Developer Command Prompt for VS` и выполни:

```bat
cl /nologo /W4 /O2 scripts\elmo_poll_probe.c /Fe:elmo_poll_probe.exe ws2_32.lib
```

Результат:

```text
elmo_poll_probe.exe
```

### Вариант B: MinGW-w64

Если установлен `gcc` из MinGW-w64:

```bat
gcc -O2 -Wall -Wextra -std=c11 scripts\elmo_poll_probe.c -o elmo_poll_probe.exe -lws2_32
```

Проверка:

```bat
elmo_poll_probe.exe --help
```

---

## 4. Сборка на Linux

Если нужно собрать с Linux-машины:

```bash
gcc -O2 -Wall -Wextra -std=c11 scripts/elmo_poll_probe.c -o elmo_poll_probe
```

---

## 5. Подготовка стенда перед запуском

Перед тестом нужно исключить конкуренцию за ELMO TCP:

1. Остановить или отключить Node-RED flows, которые ходят в `192.168.1.2:2000`.
2. Остановить сторонние программы, которые могут держать ELMO socket.
3. Проверить, что нет активных TCP-сессий:

```bat
netstat -ano | findstr 192.168.1.2:2000
```

Перед запуском тестера желательно не видеть `ESTABLISHED` к `192.168.1.2:2000`.

После запуска тестера должна быть ровно одна TCP-сессия:

```bat
netstat -ano | findstr 192.168.1.2:2000
```

---

## 6. Примеры запуска

### 1 Гц, 60 секунд

```bat
elmo_poll_probe.exe --host 192.168.1.2 --port 2000 --hz 1 --duration 60
```

### 5 Гц, 60 секунд

```bat
elmo_poll_probe.exe --host 192.168.1.2 --port 2000 --hz 5 --duration 60
```

### 10 Гц, 60 секунд

```bat
elmo_poll_probe.exe --host 192.168.1.2 --port 2000 --hz 10 --duration 60
```

### 30 Гц, 60 секунд

```bat
elmo_poll_probe.exe --host 192.168.1.2 --port 2000 --hz 30 --duration 60
```

### Бесконечный тест 30 Гц

Остановить можно через `Ctrl+C`.

```bat
elmo_poll_probe.exe --host 192.168.1.2 --port 2000 --hz 30 --duration 0
```

### Worst-case: state poll на каждом тике

Это тяжелее, чем текущая XStateMachine, потому что информативные регистры читаются каждый poll.

```bat
elmo_poll_probe.exe --host 192.168.1.2 --port 2000 --hz 30 --duration 60 --all-extended
```

### Поменять idle gap

Если ответы склеиваются или режутся, проверь несколько значений:

```bat
elmo_poll_probe.exe --hz 10 --duration 60 --idle-ms 30
elmo_poll_probe.exe --hz 10 --duration 60 --idle-ms 80
elmo_poll_probe.exe --hz 10 --duration 60 --idle-ms 150
```

### Убрать raw из вывода

```bat
elmo_poll_probe.exe --hz 30 --duration 60 --quiet-raw
```

---

## 7. Формат вывода

Программа печатает CSV-подобные строки:

```text
seq,kind,scheduled_ms,late_ms,rtt_ms,period_overrun_ms,bytes,chunks,truncated,status,missing,dups,raw
```

Поля:

| Поле | Значение |
|---|---|
| `seq` | номер poll-запроса |
| `kind` | `lean` или `extended` |
| `scheduled_ms` | плановое время отправки от старта теста |
| `late_ms` | насколько отправка опоздала относительно графика |
| `rtt_ms` | время от send до завершения idle-gap ответа |
| `period_overrun_ms` | насколько RTT превысил период опроса |
| `bytes` | размер собранного ответа |
| `chunks` | сколько TCP chunks пришло на один ответ |
| `truncated` | `1`, если ответ не поместился в буфер |
| `status` | `OK`, `TIMEOUT` или `ERR` |
| `missing` | ожидаемые поля, которых нет в ответе |
| `dups` | поля, которые встретились больше одного раза |
| `raw` | raw-ответ с escaped `\r`, `\n` |

В конце печатается summary:

```text
# summary sent=... ok=... timeouts=... socket_errors=... overruns=... rtt_ms_min=... rtt_ms_avg=... rtt_ms_max=...
```

---

## 8. Как интерпретировать результат

### Нормально

Для выбранной частоты:

- `status=OK`;
- `timeouts=0`;
- `socket_errors=0`;
- `period_overrun_ms=0` или редко небольшое значение;
- `missing=-`;
- `dups=-` или объяснимые повторы, если ELMO реально так отвечает;
- `rtt_ms` заметно меньше периода.

Периоды:

| Частота | Период |
|---:|---:|
| 1 Гц | 1000 ms |
| 5 Гц | 200 ms |
| 10 Гц | 100 ms |
| 20 Гц | 50 ms |
| 30 Гц | 33.3 ms |

Для 30 Гц полный цикл `send + response + idle gap` должен укладываться примерно в 33 ms. Если `--idle-ms 80`, то 30 Гц физически не получится без overruns, потому что один только idle gap больше периода. Для 30 Гц нужно тестировать меньший idle gap или подтвердить реальный terminator ответа ELMO.

### Признак ограничения ELMO или TCP

- На 1 Гц все хорошо, на 10/20/30 Гц появляются `TIMEOUT`.
- Растет `period_overrun_ms`.
- Ответы приходят с `missing` полями.
- Появляются странные `dups` вроде `PX:2|VX:2` на одном запросе.
- `chunks` сильно растет и ответ не успевает собираться до следующего периода.

### Признак проблемы framing/idle-gap

- При большом `--idle-ms` ответы склеиваются.
- При слишком маленьком `--idle-ms` ответы режутся на неполные куски.
- Изменение `--idle-ms` резко меняет `missing/dups`.

В этом случае проблема может быть не в ELMO как таковом, а в отсутствии подтвержденного end-of-frame marker.

---

## 9. Рекомендуемая серия тестов

Сначала проверить baseline:

```bat
elmo_poll_probe.exe --hz 1 --duration 30
```

Затем ступенями:

```bat
elmo_poll_probe.exe --hz 5 --duration 30
elmo_poll_probe.exe --hz 10 --duration 30
elmo_poll_probe.exe --hz 20 --duration 30
elmo_poll_probe.exe --hz 30 --duration 30
```

Если на 30 Гц есть overruns, проверить влияние idle gap:

```bat
elmo_poll_probe.exe --hz 30 --duration 30 --idle-ms 10
elmo_poll_probe.exe --hz 30 --duration 30 --idle-ms 20
elmo_poll_probe.exe --hz 30 --duration 30 --idle-ms 30
```

Потом worst-case:

```bat
elmo_poll_probe.exe --hz 30 --duration 30 --all-extended --idle-ms 20
```

Сохранять вывод в файл:

```bat
elmo_poll_probe.exe --hz 30 --duration 60 > elmo_30hz_probe.csv
```

---

## 10. Важное ограничение тестера

Тестер не управляет приводом и не посылает команды движения. Он только читает регистры.

Если нужно проверить динамический режим при реальной скорости, сначала нужно безопасно вывести привод на нужную скорость другим штатным способом, затем остановить конкурирующие TCP-клиенты и запустить тестер. Делать это нужно только в безопасной стендовой процедуре.
