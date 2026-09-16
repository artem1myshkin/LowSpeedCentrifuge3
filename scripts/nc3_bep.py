#!/usr/bin/python
# -*- coding: utf-8 -*-
"""nc3_bep.py — шлюз БЕП (блок электронных преобразователей ёмкостных датчиков зазора).

UDP (CAN-конвертер 192.168.1.20:20001) -> MQTT (localhost:1883).

Исправлена задержка ~20 с (Замечания 11.09.2026 п. 12, Приложение Б п. Б3.7):
  * старый цикл обрабатывал по ОДНОЙ датаграмме за проход и на каждый кадр открывал новое
    MQTT-соединение (publish.single, qos=2) с печатью в консоль — приёмный буфер сокета
    накапливался, в UI уходили устаревшие данные, а после снятия питания «хвост» буфера
    ещё ~20 с выдавался как живые данные;
  * теперь за проход вычитываются ВСЕ накопившиеся датаграммы и публикуется только последняя,
    через одно постоянное MQTT-соединение (client.publish, qos=0);
  * частота публикации в chN/data ограничена PUBLISH_HZ (по умолчанию 2 Гц);
  * при отсутствии пакетов дольше STALE_SEC публикуется bep/status {"stale": true} и нули
    в chN/data — UI показывает «нет данных» и сбрасывает значения;
  * bep/status публикуется раз в секунду: running/stale, счётчик пакетов, темп приёма.

Переменные окружения (необязательно): NC3_BEP_PUBLISH_HZ, NC3_BEP_STALE_SEC, NC3_BEP_LOG_SEC.
Команды MQTT (cmd-topic / file-topic) — без изменений относительно исходного шлюза.
"""
import socket, signal
import time, sys, os, json
import subprocess
import paho.mqtt.client as mqtt

# ---------------------------------------------------------------- параметры
PUBLISH_HZ = float(os.environ.get("NC3_BEP_PUBLISH_HZ", "2"))      # темп публикации chN/data
STALE_SEC = float(os.environ.get("NC3_BEP_STALE_SEC", "3"))        # нет пакетов дольше -> stale
LOG_PERIOD_SEC = float(os.environ.get("NC3_BEP_LOG_SEC", "5"))     # сводка в консоль
STATUS_PERIOD_SEC = 1.0

# mqtt host
MQTT_HOST = 'localhost'
MQTT_REQUEST_TOPIC = "cmd-topic"
MQTT_RESULTS_TOPIC = "reply-topic"
MQTT_FILE_TOPIC = "file-topic"
MQTT_FILE_REPLY_TOPIC = "file-rep-topic"
MQTT_STATUS_TOPIC = "bep/status"

# CAN converter
UDP_IP = "192.168.1.20"
UDP_PORT = 20001
FRAMES_MAX = 5  # in system total boards
FRAME_LEN = 13

# cmd string analyzing
MODE_RUN_GROUP = 1
MODE_RUN_SINGLE = 2
MODE_RUN_SINGLE_CAPDAC = 3
MODE_STOP = 4
MODE_READ = 5
MODE_WRITE = 6
MODE_ERROR = 99

mode = 0
param1 = 0
param2 = 0
param3 = 0

# file data
calib_data = [[], [], [], []]
param_number = 0
param_boards = 0

eth_start = [0x08, 0x00, 0x00,
             0x03, 0x20, 0x01, 0xaa, 0x20, 0x03, 0x33, 0x44, 0x99, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00]

boards_id_discovery = [0, 0, 0, 0, 0]

client = None
sock = None


def data_topic(channel):
    """chN/data для канала 0..4."""
    return "ch%d/data" % (channel + 1)


def addr_topic(channel):
    return "ch%d/addr" % (channel + 1)


def pub_msg(topic, dat, retain_flag=False, qos=0):
    """Публикация через постоянное соединение (без publish.single на каждый кадр)."""
    if client is None:
        return
    try:
        client.publish(topic, dat, qos=qos, retain=retain_flag)
    except Exception as ex:
        print("MQTT publish error:", ex)


def eth_send(socket_name, eth_mode, addr_to_set=0):
    print("[ETH_SEND] mode =", eth_mode, " addr =", addr_to_set)

    if eth_mode == "stop":
        eth_start[5] = 0x00
    elif eth_mode == "start":
        eth_start[5] = 0x01
    elif eth_mode == "start_single":
        eth_start[5] = 0x02
        p2 = int(int(param1) / 10)
        eth_start[6] = int(p2 * 16 + (int(param1) % 10))
    elif eth_mode == "start_single_capdac":
        eth_start[5] = 0x03
        p2 = int(int(param1) / 10)
        eth_start[6] = int(p2 * 16 + (int(param1) % 10))
        eth_start[7] = int(param2)
    elif eth_mode == "check":
        eth_start[5] = 0x04
        eth_start[6] = addr_to_set

    message = bytes(eth_start)
    try:
        packet_hex = " ".join(["%02X" % b for b in message])
        print("[ETH_SEND] TX -> %s:%d (%d bytes): %s" % (UDP_IP, UDP_PORT, len(message), packet_hex))
        socket_name.sendto(message, (UDP_IP, UDP_PORT))
    except Exception as ex:
        print("ERR: Eth sendto() error:", ex)
        sys.exit(0)

    if eth_mode == "stop":
        for _ in range(50):
            socket_name.sendto(message, (UDP_IP, UDP_PORT))
            time.sleep(0.02)


def cmd_analyze(cmd_string):
    global param1, param2, param3

    mode_v = MODE_ERROR
    line = cmd_string.rsplit()
    size = len(line)
    if size == 0:
        return mode_v

    param1 = 0
    param2 = 0

    if line[0] == "run":
        if size == 1:
            return MODE_RUN_GROUP
        if line[1] != "one":
            print("Not 'one' param - error")
            return mode_v
        if size == 3:
            print("Cmd - Run single board")
            param1 = line[2]
            return MODE_RUN_SINGLE
        elif size == 4:
            print("Cmd - Run single board with CAPDAC")
            param1 = line[2]
            param2 = line[3]
            return MODE_RUN_SINGLE_CAPDAC
    elif line[0] == "stop":
        print("Cmd - Stop")
        mode_v = MODE_STOP
    elif line[0] == "read":
        print("Cmd - Read")
        mode_v = MODE_READ
    elif line[0] == "write":
        print("Cmd - Write")
        if size != 4:
            print("Cmd len error!")
            return mode_v
        param1 = line[1]
        param2 = line[2]
        param3 = line[3]
        mode_v = MODE_WRITE
    else:
        print("UNKNOWN cmd")

    return mode_v


# ---------------------------------------------------------------- файл калибровки (как в исходном шлюзе)
def file_calib_read(file_name):
    global param_number, param_boards

    print("File read operation _____")
    param_number = 0
    param_boards = 0
    with open(file_name, "r") as f:
        for line in f:
            param_boards = param_boards + 1
            i = 0
            for i, value in enumerate(line.split()):
                calib_data[i].append(int(value))
            param_number = i + 1

        print("Boards total from file - %d," % param_boards, "Readed vals:")
        file_content = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
        rez_data = bytearray()

        for p in range(param_boards):
            print("Board = 0x%04x:" % (0x321 + p), "calib data - %05d," % calib_data[0][p], "%05d" % calib_data[1][p])
            file_content[3 * p] = p
            file_content[3 * p + 1] = calib_data[0][p]
            file_content[3 * p + 2] = calib_data[1][p]

        print("File data in array - ", file_content)

        for k in range(5):
            for n in range(3):
                if n == 0:
                    rez_data += file_content[3 * k + n].to_bytes(1, byteorder='little')
                else:
                    rez_data += file_content[3 * k + n].to_bytes(2, byteorder='little')

        return param_number, param_boards, rez_data


def file_calib_write(board_num, param_pos, val_write):
    global param_number, param_boards

    if param_pos > param_number:
        print("ERROR: Param position > param numbers, exit (%d >" % param_pos, "%d)" % param_number)
        return

    f = open('try', 'w')
    calib_data[param_pos][board_num] = val_write
    for k in range(param_boards):
        conv = ""
        for n in range(param_number):
            conv += str("%05d" % calib_data[n][k]) + " "
        conv += '\n'
        f.write(conv)
    f.close()


# ---------------------------------------------------------------- MQTT
def on_connect(cl, userdata, flags, rc):
    print("Connected to mqtt server (rc=%s)" % rc)
    print('Subscribing to "' + MQTT_REQUEST_TOPIC + '" topic')
    print('Subscribing to "' + MQTT_FILE_TOPIC + '" topic')
    cl.subscribe(MQTT_REQUEST_TOPIC, qos=2)
    cl.subscribe(MQTT_FILE_TOPIC, qos=2)


def on_message(cl, userdata, msg):
    global mode, param1, param2, param3

    try:
        cmd_string = msg.payload.decode()

        if msg.topic == MQTT_FILE_TOPIC:
            print("FILE topic - handle")
            mode = cmd_analyze(cmd_string)

            if mode == MODE_READ:
                _, _, rez_string = file_calib_read("try")
                pub_msg(MQTT_RESULTS_TOPIC, "Read file OK", qos=2)
                pub_msg(MQTT_FILE_REPLY_TOPIC, rez_string, qos=2)
                return
            elif mode == MODE_WRITE:
                board_num = int(param1)
                param_pos = int(param2)
                param_val = int(param3)

                if board_num < 321 or board_num > 380:
                    print("Board number is out of range (%d)" % board_num)
                    return
                if param_pos < 0 or param_pos > 2:
                    print("Calib vals number is out of range (%d)" % param_pos)
                    return
                if param_val < 0 or param_val > 65535:
                    print("Calib value is out of range (%d)" % param_val)
                    return

                file_calib_write(board_num - 321, param_pos, param_val)
                pub_msg(MQTT_RESULTS_TOPIC, "Write file OK", qos=2)
                return
            return

        mode = cmd_analyze(cmd_string)
        if mode == MODE_ERROR:
            return
        elif mode == MODE_RUN_GROUP:
            eth_send(sock, "start")
            pub_msg(MQTT_RESULTS_TOPIC, "Start group OK", qos=2)
        elif mode == MODE_RUN_SINGLE:
            eth_send(sock, "start_single")
            pub_msg(MQTT_RESULTS_TOPIC, "Start single OK", qos=2)
        elif mode == MODE_RUN_SINGLE_CAPDAC:
            eth_send(sock, "start_single_capdac")
            pub_msg(MQTT_RESULTS_TOPIC, "Start single with CAPDAC OK", qos=2)
        elif mode == MODE_STOP:
            eth_send(sock, "stop")
            pub_msg(MQTT_RESULTS_TOPIC, "Stop group OK", qos=2)

    except Exception as ex:
        print("Exception:", ex)


# ---------------------------------------------------------------- порт
def get_port_pids(port):
    """Вернуть список PID процессов, занимающих UDP-порт."""
    try:
        result = subprocess.run(["netstat", "-ano"], capture_output=True, text=True, timeout=5)
        pids = []
        for line in result.stdout.splitlines():
            parts = line.split()
            if len(parts) >= 2 and parts[0].upper() == "UDP":
                if parts[1].endswith(":%d" % port):
                    try:
                        pids.append((int(parts[-1]), line.strip()))
                    except ValueError:
                        pass
        return pids
    except Exception as e:
        print("[PORT CHECK] netstat error: %s" % e)
        return []


def kill_port_owner(port):
    """Проверить порт и убить занимающий его процесс (если есть)."""
    my_pid = os.getpid()
    pids = get_port_pids(port)
    if not pids:
        print("[PORT CHECK] port %d is free." % port)
        return
    for pid, line in pids:
        if pid == my_pid:
            continue
        print("[PORT CHECK] port %d busy, PID %d: %s -> taskkill" % (port, pid, line))
        try:
            subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True, text=True, timeout=5)
        except Exception as e:
            print("[PORT CHECK] cannot kill PID %d: %s" % (pid, e))
    time.sleep(0.5)


def signal_handler(sig, frame):
    print("INTERRUPT ----> exit")
    try:
        pub_msg(MQTT_STATUS_TOPIC, json.dumps({"ok": False, "running": False, "stale": True, "reason": "exit"}), retain_flag=True)
        time.sleep(0.2)
    except Exception:
        pass
    sys.exit(0)


# ---------------------------------------------------------------- разбор пакета
def parse_packet(data):
    """Разобрать датаграмму CAN-конвертера: кадры по 13 байт -> {канал: ёмкость}."""
    frames_num = int(len(data) / FRAME_LEN)
    values = {}
    for n in range(frames_num):
        base = FRAME_LEN * n
        raw_addr = data[6 + base]
        channel = raw_addr - 33  # 0x21 -> ch0
        if channel < 0 or channel >= FRAMES_MAX:
            continue
        cap_val = data[10 + base] + data[11 + base] * 0x100 + data[12 + base] * 0x10000
        values[channel] = cap_val
    return values


# ---------------------------------------------------------------- старт
signal.signal(signal.SIGINT, signal_handler)

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
kill_port_owner(UDP_PORT)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.bind(("", UDP_PORT))
sock.settimeout(0.05)  # короткий таймаут: цикл не блокируется, буфер вычитывается полностью
print("[SOCKET] UDP socket bound to port %d" % UDP_PORT)

client = mqtt.Client()
client.on_connect = on_connect
client.on_message = on_message
client.reconnect_delay_set(min_delay=1, max_delay=5)
client.connect(MQTT_HOST, port=1883, keepalive=30)
client.loop_start()

print("[BEP] publish %.2f Hz, stale after %.1f s" % (PUBLISH_HZ, STALE_SEC))

publish_period = 1.0 / max(0.1, PUBLISH_HZ)
t_start = time.time()
last_rx = 0.0
last_pub = 0.0
last_status = 0.0
last_log = 0.0
rx_count = 0
rx_count_at_log = 0
pub_count = 0
last_values = {}
stale_reported = False
zeroed = False

while True:
    # 1. Вычитать ВСЕ накопившиеся датаграммы, оставить последнюю (устраняет накопление буфера).
    latest = None
    drained = 0
    while True:
        try:
            data, addr = sock.recvfrom(2048)
        except socket.timeout:
            break
        except BlockingIOError:
            break
        except Exception as ex:
            print("[RX] socket error:", ex)
            break
        latest = data
        drained += 1
        rx_count += 1
        if drained >= 200:
            break

    now = time.time()
    if latest is not None and len(latest) >= FRAME_LEN:
        values = parse_packet(latest)
        if values:
            last_values = values
            last_rx = now
            zeroed = False
            if stale_reported:
                print("[BEP] data resumed")
                stale_reported = False

    stale = (last_rx == 0.0) or (now - last_rx > STALE_SEC)

    # 2. Публикация последних значений не чаще PUBLISH_HZ.
    if not stale and last_values and (now - last_pub) >= publish_period:
        for ch, cap_val in last_values.items():
            pub_msg(data_topic(ch), str(cap_val))
        pub_count += 1
        last_pub = now

    # 3. Нет данных: один раз обнулить каналы, чтобы UI сбросил значения.
    if stale and not zeroed and last_rx != 0.0:
        for ch in range(FRAMES_MAX):
            pub_msg(data_topic(ch), "0")
        zeroed = True
        if not stale_reported:
            print("[BEP] no packets for %.1f s -> stale" % (now - last_rx))
            stale_reported = True

    # 4. Статус процесса раз в секунду.
    if now - last_status >= STATUS_PERIOD_SEC:
        uptime = int(now - t_start)
        status = {
            "ok": not stale,
            "running": True,
            "stale": stale,
            "uptime_s": uptime,
            "packets": rx_count,
            "published": pub_count,
            "publish_hz": PUBLISH_HZ,
            "last_rx_age_s": None if last_rx == 0.0 else round(now - last_rx, 2),
        }
        pub_msg(MQTT_STATUS_TOPIC, json.dumps(status), retain_flag=True)
        last_status = now

    # 5. Краткая сводка в консоль (без построчного вывода каждого кадра).
    if now - last_log >= LOG_PERIOD_SEC:
        rate = (rx_count - rx_count_at_log) / max(0.001, now - last_log) if last_log else 0.0
        rx_count_at_log = rx_count
        last_log = now
        vals = " ".join("ch%d=%d" % (ch + 1, v) for ch, v in sorted(last_values.items()))
        print("[BEP] %s rx=%d (%.1f pkt/s) pub=%d %s" % ("STALE" if stale else "ok", rx_count, rate, pub_count, vals))

    if latest is None:
        time.sleep(0.01)
