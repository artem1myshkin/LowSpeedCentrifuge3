# Текущее состояние проекта

Дата актуализации: 2026-06-11

## Назначение

LowSpeedCentrifuge3 - Node-RED Dashboard 2 проект для операторского управления стендом НЦ-3/2:

- воспроизведение угловой скорости приводом ELMO;
- ручное и сценарное управление скоростью;
- управление наклоном БУН;
- прием и отображение данных БЕП;
- протоколирование измерений и raw-data;
- журнал событий;
- production remote-control с владением управлением.

## Основные файлы

- `flows.json` - основной production flow.
- `flows/elmo-xstate-udp.flow.json` - отдельный flow для ELMO XState/UDP.
- `packages/nc3-elmo-machines/src/` - reusable JS-логика транспорта, парсинга, очереди, опроса, сценариев и пересчета разрешений.
- `scenarios/*.scn` - базовые сценарии для переноса в runtime.
- `docs/` - проектная и эксплуатационная документация.

## Runtime-пути

- Проект Node-RED на стенде: `C:\Users\Артём\.node-red\projects\LowSpeedCentrifuge3`.
- Runtime-каталог: `C:\NC3`.
- Настройки: `C:\NC3\settings.json`.
- Протоколы: `C:\NC3\protocols`.
- Raw-data: `C:\NC3\data`.
- Сценарии: `C:\NC3\scenarios`.
- Журнал событий: `C:\NC3\logs\events.jsonl`.

## Dashboard-страницы

- `Угловая скорость` (`/velocity`) - привод, сценарии, протоколирование.
- `БУН/БЕП(Tilt/Gap)` (`/tilt`) - наклон и БЕП.
- `Настройка` (`/settings`) - общие и расширенные параметры.
- `Журнал` (`/journal`) - события, протоколы, data-графики.
- `Мониторинг` (`/monitoring`) - есть в flow, но не входит в руководство оператора 2026-06-11.

## Что реализовано

- ELMO UDP/XState вместо legacy TCP.
- Normal poll 2 Гц по `TM/PX/VX`; low-range velocity poll 10 Гц.
- Fast raw poll до 30 Гц только во время raw-записи.
- Расчет фактической скорости из свежего буфера `PX/TM`, включая low-range.
- Переключение диапазона `high/low` с сохранением физических `SP/AC/DC`.
- `Drive Init` разделен: ручной (только один оборот) и полный сценарный (ST, MO=0, параметры диапазона, EC=0, диагностика, MO=1, оборот) — см. technical-notes.
- Автозащиты транспорта: SO-таймаут 30 с и motion-таймаут с автоматическим `ST;MO=0`; offline после 3 пропусков с самовосстановлением.
- Декодирование ошибок SR (биты 0-3) с выводом в UI и журналированием смены кода.
- Протоколы и data-файлы с метками времени ELMO `TM`.
- Сценарный runtime через `.scn`, `ScenarioManager`, автосмену диапазона, pause/resume/stop/emergency-stop, авто-`Drive Init` перед шагом.
- Редактор `.scn` файлов в UI.
- Persistent event journal (восстановление статуса Drive Init из журнала).
- Remote-control через `RemoteControlService` и `CommandGate`.
- Руководство оператора: `docs/operator-manual.md` (v0.2, сверено с кодом 2026-06-11; раздел 12 — обработка ошибок ELMO).

## Открытые зоны

- Stale/offline-индикация для всех аппаратных каналов не закрыта полностью.
- БЕП: в документации отмечено расхождение high-level flow-топиков и контракта базового `nc3_bep.py`.
- `nc3_bep.py`/process supervision требует проверки на реальном runtime.
- Пароль advanced-настроек в UI-шаблоне фактически не проверяется.
- Runtime-сценарии из `C:\NC3\scenarios` не синхронизируются с git автоматически.

