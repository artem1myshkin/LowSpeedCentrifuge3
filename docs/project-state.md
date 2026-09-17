# Состояние проекта LowSpeedCentrifuge3

## Актуализация 2026-09-16: Замечания ПО от 11.09.2026 и блок Б1 Приложения Б

Ветка `claude/po-bugs-block-b1-337808`. Исправлены все 16 пунктов «Замечаний ПО 11.09.26» и выполнен блок Б1 (перевод критериев движения на средства контроллера ELMO — MS / TR) Приложения Б к ТЗ; попутно закрыты Б2.2–Б2.4 и Б3.1–Б3.8. Правки function/ui-template узлов делались через извлечение кода из `flows.json` и обратную инъекцию с сохранением CRLF; офлайн-харнесс прогонял узлы с mock `global/flow/context` (18 проверок); дымовой тест — временный userDir Node-RED на порту 1881 с этим `flows.json` (Dashboard рендерится, путь «Сохранить настройки → SettingsNormalize → apply_tr_windows → CommandHandler» отработал).

**Пакет `packages/nc3-elmo-machines` (75 тестов зелёные; было 24/68 красных после e6eef4e):**
- `MS` добавлен в периодический state-poll (`STATE_POLL_FIELDS = MO,SO,SR,MS`), `VH[2]` — в full-state poll; `SR` — в motion-poll ожидания завершения движения (бит HM[1] для поиска нулевой метки). Подстановка `ms: 3` по умолчанию убрана (`ResponseParser` отдаёт `null` → UI «нет данных»).
- Транспорт: `motionMaxMisses` (по умолчанию 6) — во время ожиданий SO=1 / motion-done потерянная UDP-датаграмма ведёт к повторному опросу, а не к ложному `ST;MO=0`; состояние `waitingForSoReady` стало вложенным (`polling`/`pause`): потерянный ответ на `SO` переопрашивается по таймауту, ответы `SO=0` разнесены паузой `motionPollDelayMs` вместо плотного цикла. `meta.minMotionMs` — «done» по MS не засчитывается раньше расчётного разгона после `BG`. `motor_on` (`ST;MO=1;…`) больше не считается operator-abort. Одноразовый `init_params` poll подчинён `initialFullState` (чинит тесты).
- `scenario.js`: `speedReadyCriterion` (`ms`|`software`, по умолчанию `ms`), `rotationCommandMode` (`JV`|`JP`, по умолчанию `JV`), `effectiveReadyCriterion` (для JP всегда `software` — MS не работает для JP), `computeRampMs`, `evaluateMsReady` (фазы `ramp` → `ms_wait` → ready/timedOut).

**`flows.json`:**
- `ResponseParser`: комментарии восстановлены из mojibake; `OL[2]` инвертирован по факту стенда (`bun_brake = OL[2]===0`, «тормоз вкл» = зажат); `sr_status.homing_active` (бит `settings.advanced.homingSrBit`, по умолчанию 7); `TR[2]/TR[4]`; `vh2` + `vh2_resolution` → `drive_limits.speed_max_ticks` ограничивается реальным VH[2] только для текущей пары головок; `torque` удалён.
- `Tilt` (запись `OL[2]`): та же инверсия — `tilt_brake=1` (зажать) → `OL[2]=0`, `0` (отпустить) → `OL[2]=1`. Аварийный стоп (`Remote Emergency Stop`, `tilt_brake=1`) теперь действительно зажимает тормоз; авто-наклон (`BUN AutoTilt`) отпускает перед движением и зажимает после.
- `CommandHandler`: `motor_on = ST;MO=1;MO;SO;SR` (сброс незавершённого профиля перед включением, Б1.7); `driveInit` в обоих режимах — `HM[3]=3;HM[4]=2;HM[5]=0;HM[1]=0;HM[1]=1;SR` + ровно один оборот `PR=CA[18]` со скоростью/ускорением из настроек, завершение по MS (`waitForMotionDone`, `motionDoneBy:'MS'`, без привязки к PX-цели — старый критерий давал ложный таймаут после сброса счётчика при захвате метки), таймаут = 2 оборота + разгон + 30 с (минимум 60 с, было 360 с); полный режим пишет `PX=0` после параметров пары головок; `set_resolution` дописывает `PX=0` и читает обратно `PX;VH[2];TR[1..4]`, очищает буфер выборок скорости; `TR[1..4]` берутся из `settings.advanced.trWindows[res]` (градусы → метки по CA[18]); новый topic `apply_tr_windows` (из `SettingsNormalize`, выход 2 → link «settings -> ELMO command») пишет TR в привод при сохранении настроек, если окна изменились.
- `DriveInitState` переписан: статус нулевой метки `null_mark` (`unknown|searching|found|not_found`) + `global.null_mark_state`; захват метки — переход бита HM[1] в SR 1→0 (журнал «Поиск нулевой метки: метка найдена … угол от старта …°»); прогресс `progress_pct` = пройденный угол/360° по ΔPX (скачок счётчика при сбросе не учитывается), 100 % по завершении; завершение оборота без захвата → `failed` «Нулевая метка не найдена за один оборот»; на смену пары головок — сброс статуса. Журнал: `Поиск нулевой метки: started/completed/failed/required after resolution switch (high|low)`; старые записи `Drive Init: …` по-прежнему распознаются (`ScenarioManager`, `GlobalStateReader`, `EventLogService`).
- `ScenarioManager`: шаг выполняется командой из настройки (`set_jv` по умолчанию, `set_jp` при `JP`); готовность — по MS: расчётный разгон `computeRampMs` → ожидание `MS=0` → таймаут `speedReachTimeoutMs` (10 с) с ошибкой сценария и журналом; для JP — программный критерий; поиск нулевой метки перед первым шагом идёт в режиме `full` (сам включает двигатель) — сценарий стартует без ручного поиска (Б2.5); терминология в уведомлениях/журнале — «поиск нулевой метки».
- `SettingsNormalize`/`SettingsBootstrap`: новые `advanced.speedReadyCriterion`, `rotationCommandMode`, `trWindows{high,low}{positionWindowDeg,positionTimeMs,speedWindowDegSec,speedTimeMs}` (TR[2]/TR[4]=0 запрещены → 100), `homingSpeedDegSec`/`homingAccelDegSec2` (5 °/с, 1 °/с²), `homingSrBit` (7); граница автопереключения `encoderSwitchSpeed` зажимается в [мин. низкого, макс. высокого].
- `GlobalStateReader`: `elmo_link` (единый признак связи из транспорта; `global.elmo_link` пишется в On Start `ElmoTransport`), `null_mark_state`, `tr2/tr4`, `ms: null` по умолчанию, `torque` убран.
- Проводка: `BUN Calibration` → дополнительно `link in 13` Мониторинга (угол наклона без ожидания `reread`); `SettingsNormalize` — 2 выхода.
- UI `Мониторинг`: чип «Нулевая метка определена / не определена / идёт поиск» (зелёный/красный/жёлтый), «Готов» — по MS (сценарий: `scenario_state.ready`), статус ELMO — по `elmo_link` и свежести ответов (≤ 5 с), строка MS с расшифровкой, подсказки (Ethernet UDP 192.168.1.2:5001, БЕП — ёмкостные датчики зазора), «Тормоз вкл (зажат)/выкл (отпущен)», прогресс поиска — по углу, `bun_angle` без троттлинга 950 мс, момент удалён.
- UI `Угловая скорость`: кнопка «Поиск нулевой метки» (активна при MO=1), чип статуса метки, чип «Скорость: Готов/Разгон/—» (JV — по MS, JP — по допуску), MS «нет данных» при null, «Актуальные данные привода», верхняя граница ввода скорости = VH[2] привода (`drive_limits.drive_vh2_ticks`) с сообщением при превышении (не «молча»), момент удалён.
- UI `Настройка`: блоки «Критерий „Готов“ и режим вращения» (MS/программный, JV/JP, таймаут, время стабилизации, скорость/ускорение поиска метки) и «Окна и выдержки MS — TR[1..4]» раздельно по парам головок с пересчётом в метки и значениями, прочитанными из привода; «Граница автопереключения пар головок» с допустимым диапазоном и проверкой; максимум диапазона ограничен потолком VH[2] (48/360 °/с); подсказки уточнены.
- UI `BEP`: статус `stale` («Нет данных от БЕП») из `bep/status`, сброс значений каналов.

**`scripts/nc3_bep.py`** — переработанный шлюз БЕП (задержка ~20 с, Замечания п. 12 / Б3.7): вычитывание всех накопившихся датаграмм и публикация только последней через одно MQTT-соединение (`client.publish`, qos 0), частота публикации `NC3_BEP_PUBLISH_HZ` (2 Гц), `bep/status` раз в секунду (`running/stale`, счётчики), при отсутствии пакетов > `NC3_BEP_STALE_SEC` (3 с) — нули в `chN/data` и `stale:true`, без построчного вывода кадров. Файл нужно скопировать в `C:\NC3\nc3_bep.py` (runtime-копия не в git).

**Требует проверки на стенде:** физическое соответствие `OL[2]` тормозу после инверсии (Б3.1); номер бита SR для HM[1] (`homingSrBit`); поведение MS для JV на реальном приводе (окна TR); «самопроизвольное вращение при первом MO=1» (п. 13) — ПО не отправляет `BG` без команды оператора, вероятная причина — коммутационный поиск фаз привода при первом включении (проверить в EAS II).

**Дополнение 2026-09-17 (стенд):**
- Остановка по метке (Рекомендации, разд. 6, шаг 6): при смене бита HM[1] в SR 1→0 `DriveInitState` шлёт `homing_stop` (выход 3 → link «link out 24» → `CommandHandler`: `ST;HM[7];PX;MS`). ST прерывает ожидание оборота в транспорте (`CMD.FAILED operator_aborted`), что `DriveInitState` и `ScenarioManager` трактуют как успешное завершение поиска (`stop_requested`); HM[7] и PX пишутся в журнал. Лишний оборот после захвата метки устранён.
- Критерий готовности по MS: при непрерывном JV привод может держать MS=2 и на установившейся скорости (табл. 5.2: MS=0 только при нулевой команде скорости). `evaluateMsReady` теперь считает «готов» также при факте в окне TR[3] не менее TR[4] мс (`readyBy: 'window'`); журнал фиксирует, по какому признаку достигнута скорость. Чипы «Готов» в UI — та же логика.
- Найдена вероятная причина ложного таймаута «MS=2 спустя 10 с» на первом шаге после поиска метки: state-poll (MO/SO/SR/MS) полностью подавлялся при активной быстрой raw-записи; при «висящем» флаге записи MS не обновлялся и хранил значение 2, снятое сразу после BG. State-poll теперь идёт и в fast-raw режиме (1 Гц); в `poll_data` добавлен `ms_updated_at`, сообщение об ошибке показывает возраст MS.

- Автонаклон с вкладки «Мониторинг»: вкладка слала режим `'Авто'`, а `BUN AutoTilt` распознавал только `'автомат…'` — уставка выполнялась как ручная, без автоматического тормоза. Теперь `isAutoMode` принимает `Авто/Автоматический/Auto/Automatic`, вкладка шлёт `'Автоматический'` (как «Наклон»); исправлен fallback `String(undefined)` при отсутствии `msg.mode` (аудит п. 5).

**Открыто:** операторский мануал `docs/operator-manual.md` и `project-memory/` живут только в основной рабочей копии (не в git) — обновить отдельно; Б4–Б6 не начаты.

## Актуализация 2026-07-01: исправлен обрыв команд/данных вкладки Мониторинг

Найден и исправлен баг: `RC gate monitoring` (`rc-prod-gate-monitoring`, subflow `CommandGate`, flow-tab `new ui flow`) пропускал разрешённые команды только в `RC emergency out` → `Remote Emergency Stop`, а эта функция отбрасывает всё, кроме `topic === 'emergency_stop'`. В отличие от гейтов остальных вкладок (`RC gate speed`, `RC gate scenario`, `RC gate bun`, `RC gate protocols`, `RC gate settings`), у гейта Мониторинга не было проводов к реальным обработчикам. Из-за этого с вкладки `Мониторинг`:

- `reread` не долетал до `GlobalStateReader`, поэтому `scenario_state`, `scenario_files` и `bun_angle` (а с ними и индикатор БЕП, который на этой вкладке — производная от `bun_angle`) никогда не попадали в UI: скорость/позиция/SR отображались нормально (идут отдельным путём от `poll_data`), а угол наклона, сценарий и статус БЕП — нет;
- кнопки сценария (`scenario_start/pause/resume/stop`), наклона (`bun_cmd_setpoint`/`tilt_mode`/`tilt_brake`), протокола/записи (`open_protocol/close_protocol/start_recording/stop_recording`) и переключатель «Запись исходных данных» (`settings_aply`) тоже не выполнялись.

Исправление — добавлен `link out` `RC monitoring commands out` (`mon-link-commands-out`) на выход ALLOWED гейта Мониторинга, рассылающий команды на существующие точки входа других вкладок: `GlobalStateReader` (новый `link in` `mon-link-globalstate-in` на flow-tab `ELMO XState (UDP)`), `ScenarioManager`/`DriveInitState` (через существующий `link in` `xState events -> scenario`), `ScenarioFileService` (через существующий `link in 18`), `ProtocolManager` (через существующий `link in 12`), `cmd/angle?` switch БУН-логики (новый `link in` `mon-link-tilt-in` на `BUN flow`) и `CMD?` switch настроек (новый `link in` `mon-link-settings-in` на `SETTINGS flow`). Приёмники сами фильтруют по `msg.topic`, поэтому широковещательная рассылка безопасна — тот же паттерн уже используется гейтом `RC gate speed` через `link out 13`.

## Актуализация 2026-06-11: документация, память проекта и чистка репозитория

В корне проекта добавлена папка `project-memory/` — постоянная память проекта для быстрых последующих доработок. Она фиксирует текущие runtime-пути, архитектурные инварианты, правила правки Node-RED function/ui-template nodes, особенности ELMO/БУН/БЕП, remote-control, сценариев и операторского UI. Это короткий справочник; полной истиной остается `flows.json` и текущий код.

Добавлено руководство оператора `docs/operator-manual.md` в Markdown. Оно составлено по текущему состоянию `flows.json`, `packages/nc3-elmo-machines`, `scenarios/*.scn` и проектной документации. Вкладка `Мониторинг` намеренно не описана; остальные production-вкладки (`Угловая скорость`, `БУН/БЕП(Tilt/Gap)`, `Настройка`, `Журнал`) описаны с основными кнопками, полями, настройками, типовыми операциями и местами под скриншоты.

Репозиторий очищен от IDE-метаданных `.idea`, которые не являются проектной логикой. В `.gitignore` добавлены правила для `.idea/`, `node_modules/`, логов, временных файлов и backup-расширений (`*.bak`, `*.backup`, `*.old`, `*.orig`, `*.tmp`, `*.temp`, `*~`).

Текущее дерево Dashboard 2 по `flows.json`:

- страницы: `Настройка ` (`/settings`), `БУН/БЕП(Tilt/Gap)` (`/tilt`), `Угловая скорость` (`/velocity`), `Мониторинг` (`/monitoring`), `Журнал` (`/journal`);
- группы: `Настройка`, `БУН/БЕП (Tilt/Gap)`, `Угловая скорость`, `Мониторинг`, `Журнал`;
- production `ui-template`: `Угловая скорость`, `Сценарии`, `БУН`, `BEP`, `Настройка`, `Журнал`, `Мониторинг`;
- все production `ui-template` работают с `passthru=false`.

Ограничения, подтвержденные по текущему коду и документации:

- advanced-панель настроек содержит поле пароля, но проверка пароля в UI-шаблоне фактически отключена;
- stale/offline-индикация аппаратных каналов остается открытой доработкой;
- БЕП имеет известное расхождение между high-level топиками production-flow и базовым контрактом `nc3_bep.py`;
- runtime-сценарии, созданные оператором в `C:\NC3\scenarios`, не синхронизируются с репозиторием автоматически.

## Актуализация 2026-06-08: удаленное управление в production UI

Remote-control перенесен из пилотной страницы на все production UI-вкладки. В `flows.json` есть отдельный flow-tab `Remote Control` с `RemoteControlService`, subflow `CommandGate`, targeted `remote_state` и шинами для journal/emergency/debug-сообщений. Тестовая Dashboard-страница `/remote-control-test` удалена.

Флаг режима берется из `settings.general.remoteControl`, а `RemoteControlService` синхронизирует состояние с настройками при connect/change/refresh. Local в remote-mode видит display-only UI, может выполнить `E-stop` и снять remote-mode отдельной кнопкой `Выключить удаленное управление` в баннере настроек. Remote-клиент берет владение кнопкой `Взять управление`; только remote-owner получает `canControl:true`.

Все production `ui-template` имеют `passthru=false` и общий UI-lock: при `!canControl` кнопки, поля ввода и switches выглядят неактивными и не принимают клики/ввод, кроме разрешенных кнопок remote-banner. Backend enforcement остается в `CommandGate`.

## Актуализация 2026-06-04: журнал событий и графики протоколов

Вкладка `Журнал` (`/journal`) расширена и считается полноэкранной рабочей страницей. Внутри нее две логические подвкладки:

- `Журнал` — журнал событий системы, сценариев и протоколирования с фильтрами по типам `info`, `record`, `warning`, `error`;
- `Протоколы` — список файлов протоколов, просмотр протокола/data-файла и построение графика по файлу данных.

Журнал событий теперь синхронизируется с файлом `C:\NC3\logs\events.jsonl`. `EventLogService` получает `logs_update`, дедуплицирует уже записанные события и пишет новые строки JSONL через `file` node `Append Event Log`; чтение выполняется через `file in` node `Read Event Log`, очистка из UI — через `file` node `Clear Event Log` с overwrite пустым содержимым. В `function` nodes по-прежнему нет `require`/`import`; вся файловая работа остается на Node-RED file nodes.

Важное правило Dashboard 2: у `ui-template` вкладки журнала `passthru=false`. Иначе входящие backend-сообщения (`logs_update`, `journal_state`) переизлучаются из выхода template node и могут замкнуть feedback loop на backend-сервисах.

График data-файла строится в `ui-template` только по кнопке `Построить`: ось X — относительное время от первой метки ELMO `TM`, ось Y по умолчанию — значение `PX` в тиках. В UI есть переключение отображения в десятичный угол с выбором разрешения `high`/`low`; новые data-файлы дополнительно пишут диапазон и разрешение энкодера, чтобы UI мог выбрать пересчет автоматически. Реализованы автошкала, mouse wheel zoom, кнопки zoom/reset и pan мышью.

## Актуализация 2026-06-01: сценарии, низкое разрешение и UI

Сценарный режим доведен до рабочего file-backed контура. Вкладка `Угловая скорость` содержит редактор сценариев, который читает, создает, сохраняет и удаляет `.scn` файлы из `C:\NC3\scenarios`; backend-узел `ScenarioFileService` держит каталог `global.scenario_files` и кэш документов `global.scenario_documents`. В `scenarios/` лежат базовые файлы для переноса на стенд, но пользовательские сценарии, созданные через UI, являются runtime-данными и должны копироваться отдельно, если их нужно версионировать.

`ScenarioManager` теперь поддерживает `scenario_start`, `scenario_pause`, `scenario_resume`, `scenario_stop`, `scenario_emergency_stop`. Пауза и аварийный стоп отменяют текущую запись, отправляют `drive_stop` и сохраняют текущий шаг; `Продолжить` запускает этот шаг заново. Частичное восстановление уже отработанного времени выдержки не реализовано намеренно, чтобы не смешивать неполное окно измерения с протоколом.

Таймаут достижения скорости начинается только после `CMD.ACKED` для `set_jp`. Значение вычисляется от текущей скорости до целевой с учетом `AC` и, при торможении или смене направления через ноль, `DC`; запас по умолчанию составляет 10 с. Упрощенная формула `abs(targetSpeed) / AC + 10 с` остается частным случаем старта из нулевой скорости. Это исключает учет времени, потраченного на смену разрешения и `Drive Init`.

При свежем буфере `PX/TM` выбранная фактическая скорость для UI и сценариев берется из него и в `high`, и в `low`; `VX` сохраняется как `velocity_raw` и используется только как fallback, пока буфер не готов или устарел.

Настройки приведены к фактическому поведению: блок `Период опроса` удален, legacy-ключи `readPeriodRotation/readPeriodTilt/readPeriodBEP` вычищаются при нормализации, `Длительность файла данных` вынесена из продвинутых настроек. Продвинутые настройки оставлены для raw-опроса, диапазонов, допуска/устойчивости и сценарных таймаутов. При `set_resolution` физические `SP/AC/DC` сохраняются в град/с и град/с² и пересчитываются в тики нового разрешения с учетом текущих ограничений.

Вкладка `Угловая скорость` получила blur-валидацию DMS-полей: во время ввода поле не зажимается, после потери фокуса минуты/секунды приводятся к `0..59`, отрицательные минуты/секунды становятся `0`, а градусы скорости могут быть отрицательными для обратного вращения. Верстка вкладок `Угловая скорость` и `Сценарии` адаптирована под открытое боковое меню: длинные имена файлов обрезаются, таблица и кнопки сценариев переносятся без перекрытий.

## Актуализация 2026-05-29: сценарии и буфер

`ScenarioManager` подключен в `BUN flow` поверх текущего `ELMO XState (UDP)`: вкладка `Угловая скорость` отправляет `scenario_start`/`scenario_stop`, менеджер читает файлы из `C:\NC3\scenarios`, нормализует шаги через `nc3.normalizeScenario`, отправляет `set_jp`/`set_resolution`/`driveInit` через существующий `CommandHandler`, слушает `CMD.ACKED`/`CMD.FAILED` из transport event bus и `poll_data` из `ResponseParser`.

Сценарный шаг начинает выдержку только после устойчивого достижения скорости. Критерий задается настройкой `settings.general.speedReadyTolerancePercent` на вкладке `Настройка`, диапазон 0..100 %, а время устойчивости остается в `advanced.speedStableTimeMs`. Timeout ожидания скорости при выполнении шага вычисляется от текущей скорости до целевой с учетом `AC/DC` и 10-секундного запаса; `advanced.speedReachTimeoutMs` остается fallback для evaluator-а.

Опрос теперь разделен по назначению: нормальный режим держит 2 Гц (`TM/PX/VX`), быстрый raw-режим включается только при `is_recording && is_recording_raw && recording_save_raw_data` и читает только `TM/PX` с частотой до 30 Гц. `angle_buffer` хранит чистые метки ELMO `{ t: TM/1e6, tm_us: TM, ticks: PX, angle, resolution }` без `t-t0`, без усреднения `TM-before/TM-after` и без дополнительных параметров ELMO в data-файле.

Готовые файлы сценариев находятся в `scenarios/`: `high_resolution.scn`, `low_resolution.scn`, `range_switch.scn`. Для стенда они копируются в `C:\NC3\scenarios`.

## Актуализация 2026-05-29 (UDP, атомарный poll, production bus)

Транспорт `ElmoTransport`/XStateMachine переведён с TCP `sit` на **UDP с атомарными командами** (по одной команде-параметру на датаграмму с реассемблированием в логический кадр) и компенсацией Windows-таймера — даёт ~30–32 Гц при цели 30 Гц. Production-контур `BUN flow`/`new ui flow` теперь подключён к этому транспорту через link bus: UI-команды и `tilt_brake` идут в `ELMO XState (UDP)`, ответы возвращаются в существующий `ResponseParser`. Legacy TCP-узлы оставлены в flow, но выключены.

Актуально на: 2026-06-11
Проект: `C:\Users\Артём\.node-red\projects\LowSpeedCentrifuge3`
Runtime-окружение: `C:\NC3`
Документация ТЗ: `C:\Users\Артём\Documents\NC3`

Документ описывает фактическое текущее состояние локального Node-RED проекта (по `flows.json`), что уже реализовано и что остается доделать до production. Это рабочий источник истины; устаревшие описания исправленных дефектов из прежних редакций убраны.

Источники: локальный `flows.json`, внешние Python-шлюзы `C:\NC3\nc3_bun.py` и `C:\NC3\nc3_bep.py`, `C:\NC3\settings.json`, ТЗ и приложение А к ТЗ.

## 1. Структура проекта

Вкладки `flows.json`:

1. `INIT flow` — загрузка настроек и первичный опрос ELMO.
2. `new ui flow` — основной UI-контур: БУН, БЕП, мониторинг, журнал, протоколы.
3. `BUN flow` — управление угловой скоростью ELMO (название историческое; это привод планшайбы), регулярный poll, буфер протокола, сценарный runtime и редактор файлов.
4. `SETTINGS flow` — UI настроек.
5. `ELMO XState (UDP)` — единый UDP-транспорт ELMO и production link bus.
6. `Remote Control` — `RemoteControlService`, `CommandGate` и remote-control link bus.

UI Dashboard 2, страницы:

- `Мониторинг` (`/monitoring`)
- `Угловая скорость` (`/velocity`)
- `БУН/БЕП (Tilt/Gap)` (`/tilt`)
- `Настройка` (`/settings`)
- `Журнал` (`/journal`) — подвкладки `Журнал` и `Протоколы`

Внешний runtime, который должен быть доступен:

- Node-RED с Dashboard 2, MQTT, TCP, file, exec nodes;
- MQTT broker `localhost:1883`;
- Python + `paho-mqtt`, `C:\NC3\nc3_bun.py`, `C:\NC3\nc3_bep.py`;
- `C:\NC3\settings.json`, `C:\NC3\protocols`, `C:\NC3\data`, `C:\NC3\scenarios`, `C:\NC3\logs`;
- ELMO UDP `192.168.1.2:5001` с локальным bind `:5005`, legacy ELMO TCP `192.168.1.2:2000` оставлен только как отключённый fallback, БУН UDP `192.168.1.5:32767`, БЕП UDP `192.168.1.20:20001`.

`package.json` не фиксирует версии Node-RED узлов — для воспроизводимого развертывания это нужно закрыть.

## 2. ELMO (угловая скорость)

Транспорт: UDP `Direct Access` через вкладку `ELMO XState (UDP)`: `udp out` на `192.168.1.2:5001`, `udp in` на локальном `:5005`, команды завершаются `CR`. Логика production: `CommandHandler` и `Tilt` формируют логические команды, link bus передаёт их в `ElmoTransport`, транспорт режет цепочки на атомарные UDP-команды и собирает ответы обратно, `ResponseParser` остаётся единым доменным парсером. Legacy `tcp request :2000` в `BUN flow`/`new ui flow` выключены.

Команды UI: `reread`, `driveInit`, `set_motion_params`, `motor_on/off`, `drive_stop`, `drive_bg`, `drive_home`, `set_resolution`, `set_velocity`/`set_jv`, `set_jp`, `set_absolute_position`, `set_relative_position`, `tilt_brake` (→ `OL[2]`).

`ResponseParser` понимает оба формата ответа (`PARAM=VALUE` и `PARAM;VALUE`), декодирует `SR`, определяет диапазон по `OL[1]` (`0=high`, `1=low`) и тормоз БУН по `OL[2]`.

### Диапазоны и инициализация

Две пары головок энкодера: `high` (разрешение 0,005°, `CA[18]=262144000`) и `low` (0,2°, `CA[18]=6553600`). Диапазоны скоростей по ТЗ: high `1″/с … 20°/с`, low `10 … 360°/с`; в настройках хранятся `advanced.rotationSpeedRanges.high/low.min/max` (DMS/град/рад), применяются в `CommandHandler`/`ResponseParser` для `drive_limits` и `VH[2]`.

`Drive Init`: `ST`, `MO=0`, применение параметров диапазона, `AF=0`/`EC=0`, чтение `SR`/`MF`/`EE[5]`, `MO=1`, один оборот через `PA=<текущий PX + CA[18]>`+`BG` при `SP=5°/с`, `AC=DC=2.5°/с²`, контрольный опрос.

### Опрос состояния

Регулярный опрос владеется `ElmoTransport`: normal `poll_data` идет фиксированно 2 Гц атомарными командами `TM`/`PX`/`VX`, state/full-state poll читает `MO/SO/SR` и `MS/MO/SO/SR/AF/OL[1]/OL[2]`. При raw-записи включается быстрый `fast_data` только `TM`/`PX`; частота берётся из `advanced.rawDataPollHz`, ограничивается 30 Гц, и компенсируется `timerCompensationMs=8`. Старый repeating inject `poll_data` и TCP poll builder выключены.

При свежем буфере `PX/TM` фактическая скорость выбирается из оценки по временным меткам и в `high`, и в `low`; `VX` остается в payload как `velocity_raw` и fallback, пока буфер не готов или устарел.

## 3. Протоколы, данные и метки времени

`ProtocolManager` создает:

- протокол `C:\NC3\protocols\protocol_<timestamp>.txt`;
- data-файл `C:\NC3\data\data_<timestamp>.txt`.

### Источник временного ряда — метки `TM` ELMO

Временной ряд формируется только из меток `TM` ELMO, т.к. детерминированы по времени часы контроллера привода, а не runtime Node-RED:

- `ResponseParser` берет `tm_us` из атомарного `TM` того же логического кадра, что и `PX`;
- `angle_buffer` пишет точки `{ t: tm_us/1e6, tm_us, ticks, angle, resolution }`, пока `is_recording`, обрезая буфер по длительности текущей записи;
- точка без `tm_us` отбрасывается (системное время не подставляется);
- `finalizeRecording` считает скорость линейной регрессией по десятичному углу, погрешность к `velocity_setpoint_ticks`, а в data-файл пишет колонки `Время  Значение # секунда  тики` с сырыми метками `t = tm_us / 1e6` (без вычитания `t0`); на расчет скорости сдвиг времени не влияет.

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

Язык интерфейса — единый источник `settings.general.language`, нормализуется к `russian/english` во всех компонентах. Блок `Период опроса` удален из UI; legacy-ключи периодов чтения удаляются при нормализации настроек. `settings.advanced.dataDurationSec` сохраняется в файле настроек, но в UI показан как обычная настройка `Длительность файла данных` и синхронизируется в `global.recording_duration_sec`.

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

Remote-control переведен из изолированного пилота в production UI-вкладки. В `flows.json` есть общий `RemoteControlService`, subflow `CommandGate`, targeted `remote_state` для Dashboard socket-клиентов и общий UI-паттерн claim/display-only/E-stop.

Эксперимент в LAN 2026-06-05 подтвердил базовую модель: local и remote получают разные `remote_state`, remote claim выставляет `ownerIp`, local уходит в display-only, remote-owner получает `canControl:true`. На основании эксперимента production-вкладки подключены через `RC route <tab>` и `RC gate <tab>`: `Угловая скорость`, `Сценарии`, `БУН`, `BEP`, `Настройка`, `Журнал`, `Мониторинг`.

Флаг режима берется из `settings.general.remoteControl`: `SettingsNormalize` дополнительно отправляет `remote_flag` в `RemoteControlService`. Legacy-цепочка `Remote? -> correct ip? -> Set session` отключена от `ui-control`, чтобы не было параллельной модели владения. `Мониторинг` переведен на `passthru=false`, потому что production-шаблон теперь принимает backend `remote_state`.

Backend enforcement выполняется в `CommandGate`; UI guard вокруг `this.send` нужен только для удобного поведения кнопок. Local в remote-mode может снять только `remoteControl:false` и отправить `emergency_stop`; remote-owner может управлять; remote non-owner блокируется. `Remote Emergency Stop` отправляет `drive_stop`, `motor_off`, `tilt_brake`, `scenario_emergency_stop` и `journal_event`.

После production-переноса тестовая Dashboard-страница `/remote-control-test` и pilot UI/debug-узлы удалены. Сервисные remote-control узлы находятся на flow-tab `Remote Control`. Все production `ui-template` получают root-класс `remote-locked` при `!canControl`: кнопки, поля ввода и switches выглядят неактивными и блокируются по `pointer-events`, кроме кнопок remote-banner (`Взять управление`, local `E-stop`). На localhost снятие remote-mode выполняется отдельной кнопкой `Выключить удаленное управление` в баннере настроек; switch внутри формы остается заблокированным вместе с остальными настройками.

Актуальная краткая память по remote-control зафиксирована в `project-memory/technical-notes.md` и в разделе 7 настоящего документа. Отдельный файл `remote-control-plan.md` в текущем дереве проекта отсутствует.

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
| `angle_buffer` | `angle_buffer` | Ряд `{t, tm_us, ticks, angle, resolution}` по меткам `TM/PX` |
| `logs` / `journal_state` | `ProtocolManager` / `EventLogService` | Журнал событий, состояние вкладки и синхронизация с `C:\NC3\logs\events.jsonl` |
| `scenario_state` | `ScenarioManager` | Текущий сценарий, шаг, статус, таймеры, pause/resume |
| `scenario_files` / `scenario_documents` | `ScenarioFileService` | Каталог и кэш файлов `.scn` из `C:\NC3\scenarios` |
| `bun_angle` / `bun_brake` | БУН-контур / `ResponseParser` | Угол наклона / тормоз `OL[2]` |
| `activeSession` | legacy remote-скелет | Не используется production remote-control; legacy-цепочка отключена от `ui-control` |
| `remoteSession` | `RemoteControlService` | Состояние remote-mode: флаг, owner socket/IP/role |
| `connectedClients` | `RemoteControlService` | Подключенные Dashboard socket-клиенты для targeted `remote_state` |
| `use_calib`, `vN_*` | калибровка | Коэффициенты БЕП/энкодеров |

Рекомендация: добавить в live-state `updated_at`/`source`/`quality`/`error` для отличия свежих данных от устаревших (сейчас stale-detection нет).

## 9. Что реализовано

- Операторский UI: угловая скорость, БУН/БЕП, мониторинг, настройки, журнал.
- Удаленное управление production UI: local display-only, remote claim/owner, backend `CommandGate`, local `E-stop` и local release remote-mode из баннера настроек.
- Ручное управление приводом: `MO`, `ST`, `JV`, `JP`, `PA`, `PR`, `Drive Init`.
- Чтение положения/скорости/статусов ELMO, диапазоны high/low и ограничения скорости.
- Сохранение/загрузка настроек в `C:\NC3\settings.json` (`SettingsNormalize`/`SettingsPersist`/`file`), единый язык, диапазоны скоростей.
- Протокол и data-файл: метки времени от ELMO `TM`, расчет скорости регрессией, погрешность.
- Запись одним нажатием с авто-таймером и восстановлением состояния кнопки между вкладками.
- Вкладка `Журнал`: persistent event journal в `C:\NC3\logs\events.jsonl`, фильтрация событий по типу, очистка из UI, журнал протоколов и связанных data-файлов (просмотр, ссылки).
- Графики по data-файлам протоколов: построение по кнопке, тики по умолчанию, пересчет в десятичный угол, автошкала, zoom/reset и pan в UI.
- Интеграция БУН (MQTT) и данных каналов БЕП (MQTT).
- Сценарный runtime: `.scn` файлы, автопереключение диапазона, `Drive Init`, ожидание устойчивой скорости, автоматическая запись шага, pause/resume/stop/emergency-stop.
- Редактор сценариев в UI: каталог `C:\NC3\scenarios`, создание/редактирование/сохранение/удаление файлов, защита от автопереключения выбранного файла при фоновой перечитке.
- Низкое разрешение: выбранная скорость берется из буфера `PX/TM`, а не из скачущего `VX`.
- Переключение разрешения сохраняет физические `SP/AC/DC` в градусах с учетом ограничений.

## 10. Что открыто (роадмап)

P0:

1. Починить запуск `nc3_bep.py` (`exec` должен запускать `python C:\NC3\nc3_bep.py` или supervisor).
2. Привести топики БЕП flow к контракту `nc3_bep.py` или написать адаптер.
3. Добавить timestamps/stale-detection для `drive_state`, БУН, БЕП и понятные error-сообщения UI при TCP/MQTT/file/exec ошибках.
4. Расширить `CommandGate` интерлоками состояния установки: движение/включенный привод для `set_resolution`, активный сценарий для ручных конфликтующих команд, offline/stale hardware-state.

P1:

1. Частичное восстановление выдержки сценария после паузы/аварии, если это будет подтверждено методикой испытаний.
2. Эксплуатационная синхронизация runtime-сценариев: явный backup/copy из `C:\NC3\scenarios` в репозиторий, если операторские правки должны попадать в git.

P2:

1. БУН auto tilt sequence как state machine.
2. Пересчет емкости БЕП в зазор и поправка угла наклона по круглограмме.
3. Датчик давления Festo (протокол, пороги, поведение при падении давления) в flow/UI/журнал.

P3:

1. Воспроизводимое развертывание (фиксация версий узлов, автозапуск служб, health-checks, backup/restore).
2. Документация эксплуатации и приемочные испытания, simulator mode без железа.

## 11. Acceptance checks перед production

1. Настройки переживают перезапуск Node-RED, читаются и сохраняются из UI.
2. При выключенном MQTT/ELMO UI показывает offline/stale, опасные команды блокируются.
3. `Drive Init` дает понятный результат success/error/timeout.
4. `set_resolution` при смене диапазона сохраняет физические `SP/AC/DC` в град/с и град/с² с учетом ограничений нового диапазона.
5. `nc3_bep.py` запускается/останавливается штатно, статус виден в UI.
6. Сценарий из `C:\NC3\scenarios` выполняется от начала до конца, с автопереключением диапазона и авто-протоколированием.
7. Протокол и data-файл создаются корректно: метки времени — от ELMO `TM`, второй столбец data-файла — тики `PX`, скорость — расчетом в град/с.
8. Remote mode блокирует команды всех клиентов, кроме владельца; advanced-настройки защищены паролем.
9. Event journal читается из `C:\NC3\logs\events.jsonl`, переживает перезапуск Node-RED и очищается из UI без feedback loop в Dashboard 2.

## 12. Открытые вопросы по железу и методикам

- Долговременный wrap `TM` (uint32 µs, около 71,6 мин) и нужна ли компенсация для длинных записей.
- Достаточность текущего критерия «скорость достигнута» для всех стендовых режимов: процентный допуск + время устойчивости, timeout `abs(speed)/AC + 10 с`.
- Единицы регистров БУН и биты `SYS_STATE_REG`; критерий достижения угла и timeout автоматического режима.
- Формула пересчета емкости БЕП в зазор и алгоритм поправки угла наклона по круглограмме (приложение А).
- Протокол подключения датчика давления Festo SPAU-P10RW и пороги предупреждение/авария.
