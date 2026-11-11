#!/usr/bin/python
import socket
import time, sys, signal
import paho.mqtt.client as mqtt
import paho.mqtt.publish as publish


#defines
INIT_SKIP = (0)
PACKETS_DISPLAY = (1)

#BUN
UDP_BROADCAST = "255.255.255.255"
UDP_IP = "192.168.1.5"
UDP_PORT = 32767

#mqtt
MQTT_HOST = 'localhost'
MQTT_BUN_ANGLE_TOPIC = "bun_angle"
MQTT_BUN_SYSTATE_TOPIC = "bun_systate"
#device state (low 16 bits of SYS_STATE) + motor registers, JSON (Node-RED BUN AutoTilt)
MQTT_BUN_STATE_TOPIC = "bun_state"
MQTT_BUN_CMD_TOPIC = "bun_cmd"
MQTT_BUN_SETPOINT_CMD_TOPIC = "bun_cmd_setpoint"


#registers
FULL_STAT_REG	= 0xAAAC #R
MOTOR_STAT_REG	= 0xAAAC #R
MOTOR_SPEED_REG	= 0xAAAE #R
SYS_STATE_REG	= 0xAAB0 #RW
ANGLE_REG	= 0xAAB2 #R (new ver - 19.10.2023)
SETPOINT_REG	= 0x0004 #W
RAW_ANGLE_REG	= 0x0006 #R
COMMAND_REG	= 0xCCCC #W

#command vals
CMD_STOP = 0x00
CMD_RELEASE = 0xFF
CMD_GO = 0x01
CMD_SLOWUP = 0x02
CMD_SLOWDN =  0x03
CMD_ZERO =  0x04

#function number
FUNC_WRITE = (0x10)
FUNC_READ = (0x03)

full_stat_reg_read = [0x01, 0x03,
             (FULL_STAT_REG >> 8) & 0xff, FULL_STAT_REG & 0xff, #addr (high_low)
             0x00, 0x08,
             0xa5,0xf5] #crc16
motor_angle_reg_read = [0x01, 0x03,
             (ANGLE_REG >> 8) & 0xff, ANGLE_REG & 0xff, #addr (high_low)
             0x00, 0x02,
             0x45,0xf4] #crc16
motor_stat_reg_read = [0x01, 0x03,
             0xaa, 0xac,
             0x00, 0x02,
             0x25, 0xf2]
motor_sys_state_reg_read = [0x01, 0x03,
             0xaa, 0xb0,
             0x00, 0x02,
             0xe4, 0x34]


motor_slowup_write = [
                      0x01, 0x10,
                      0xcc, 0xcc,
                      0x00, 0x02,
                      0x04,
                      0x02, 0x00, 0x00, 0x00,
                      0xfb, 0x17]
motor_slowdown_write = [
                      0x01, 0x10,
                      0xcc, 0xcc,
                      0x00, 0x02,
                      0x04,
                      0x03, 0x00, 0x00, 0x00,
                      0xfa, 0xeb]


#general buf
buf = []
global dev_addr, sock
dev_addr = "localhost"

buf_modbus_read = [0x01, 0x03,
             (0x1122) & 0xff, (0x1122) & 0xff, #addr (high_low)
             0x00, 0x02,
             0xff,0xff] #crc16 (for 6 bytes)
buf_modbus_write = [0x01, 0x10,
             (0x1122) & 0xff, (0x1122) & 0xff, #addr (high_low)
             0x00, 0x02,
             0x04,
             99, #cmd
             0,0,0,
             0xff,0xff] #crc16 (for 11 bytes)

def modbus_cmd(cmd_type):

    buf_modbus_write[1] = 0x10
    buf_modbus_write[2] = (COMMAND_REG >> 8) & 0xff
    buf_modbus_write[3] = (COMMAND_REG) & 0xff
        
    if cmd_type == "go":
        buf_modbus_write[7] = CMD_GO
    elif cmd_type == "stop":
        buf_modbus_write[7] = CMD_STOP
    elif cmd_type == "release":
        buf_modbus_write[7] = CMD_RELEASE        
    elif cmd_type == "slowdown":
        buf_modbus_write[7] = CMD_SLOWDN
    elif cmd_type == "slowup":
        buf_modbus_write[7] = CMD_SLOWUP
    elif cmd_type == "zero":
        buf_modbus_write[7] = CMD_ZERO
    elif cmd_type == "setpoint":
        #change addr
        buf_modbus_write[2] = (SETPOINT_REG >> 8) & 0xff
        buf_modbus_write[3] = (SETPOINT_REG) & 0xff
    else:
        print("cmd wrong!")
        return

    if cmd_type == "setpoint":
        #no further for setpoint
        return

    #command register is 32-bit: command byte (byte7) + 3 zero bytes.
    #Must be cleared every time, otherwise stale data from a previous
    #setpoint write leaks into bytes 8..10 and the device gets e.g.
    #0x00008C01 instead of 0x01 and ignores the command (see vendor
    #reference code: tempbuf1[8]=tempbuf1[9]=tempbuf1[10]=0).
    buf_modbus_write[8] = 0
    buf_modbus_write[9] = 0
    buf_modbus_write[10] = 0

    #crc calc
    crc_val = crc16_algo(buf_modbus_write[0:11])
    buf_modbus_write[11] = crc_val & 0xff
    buf_modbus_write[12] = (crc_val >> 8) & 0xff
        
    #print
    packet_in_hex = [format(k, '02x') for k in buf_modbus_write] 
    print("Rez buf modbus (%s):" % cmd_type, packet_in_hex)
        
    return

def modbus_read(cmd_type):

    if cmd_type == "motor_stat":
        buf_modbus_read[2] = (MOTOR_STAT_REG >> 8) & 0xff
        buf_modbus_read[3] = (MOTOR_STAT_REG) & 0xff
    elif cmd_type == "motor_speed":
        buf_modbus_read[2] = (MOTOR_SPEED_REG >> 8) & 0xff
        buf_modbus_read[3] = (MOTOR_SPEED_REG) & 0xff
    elif cmd_type == "sys_state":
        buf_modbus_read[2] = (SYS_STATE_REG >> 8) & 0xff
        buf_modbus_read[3] = (SYS_STATE_REG) & 0xff    
    elif cmd_type == "angle":
        buf_modbus_read[2] = (ANGLE_REG >> 8) & 0xff
        buf_modbus_read[3] = (ANGLE_REG) & 0xff  
    elif cmd_type == "raw_angle":
        buf_modbus_read[2] = (RAW_ANGLE_REG >> 8) & 0xff
        buf_modbus_read[3] = (RAW_ANGLE_REG) & 0xff     
    else:
        print("cmd wrong!")
        return
    
    #crc calc
    crc_val = crc16_algo(buf_modbus_read[0:6])
    buf_modbus_read[6] = crc_val & 0xff
    buf_modbus_read[7] = (crc_val >> 8) & 0xff
        
    #print
    packet_in_hex = [format(k, '02x') for k in buf_modbus_read] 
    print("Rez buf (%s):" % cmd_type, packet_in_hex)
        
    return

def on_connect(client, userdata, flags, rc):
    print("Connected to mqtt server")
    print('Subscribing to "%s" topic' % MQTT_BUN_CMD_TOPIC)
    print('Subscribing to "%s" topic' % MQTT_BUN_SETPOINT_CMD_TOPIC)
    client.subscribe(MQTT_BUN_CMD_TOPIC, qos=2)
    client.subscribe(MQTT_BUN_SETPOINT_CMD_TOPIC, qos=2)
    return

def on_message(client, userdata, msg):
    global sock
    
    if msg.topic == MQTT_BUN_CMD_TOPIC:
        #check cmd
        cmd_string = msg.payload.decode()
        #print("CMD got - %s" % cmd_string)
        print("(%.3f)" % (time.time() % 10000), "RX: ",  end='')
        
        if cmd_string == "go":
            print("cmd GO detected",  end='')
        elif cmd_string == "stop":
            print("cmd STOP detected",  end='')           
        elif cmd_string == "slowdown":
            print("cmd SLOWDOWN detected",  end='')
        elif cmd_string == "slowup":
            print("cmd SLOWUP detected",  end='')
        elif cmd_string == "release":
            print("cmd RELEASE detected",  end='')
        elif cmd_string == "zero":
            print("cmd ZERO detected",  end='')
        else:
            print("cmd not supported!")
            return

        print(", ",  end='')
        
        #make modbus data
        modbus_cmd(cmd_string)
        
        #send
        message = bytes(buf_modbus_write)

        try:
            #go
            sock.sendto(message, (dev_addr, UDP_PORT))
            #print("Eth send ok, addr:", dev_addr)
        except Exception as ex:
            print("ERR: Eth sendto() error:", ex)
            #sys.exit(0)

    elif msg.topic == MQTT_BUN_SETPOINT_CMD_TOPIC:
        #set dst angle
        cmd_string = msg.payload.decode()
        angle_target = int(cmd_string)
        print("Setpoint: %d arcsec (%.6f deg)" % (angle_target, angle_target / 3600.0))
    
        #make modbus data
        modbus_cmd("setpoint")
    
        #set angle in secs
        #angle_target *= 3600
        buf_modbus_write[7] = angle_target & 0xff
        buf_modbus_write[8] = (angle_target >> 8) & 0xff
        buf_modbus_write[9] = (angle_target >> 16) & 0xff
        buf_modbus_write[10] = (angle_target >> 24) & 0xff

        #crc recalc
        crc_val = crc16_algo(buf_modbus_write[0:11])
        buf_modbus_write[11] = crc_val & 0xff
        buf_modbus_write[12] = (crc_val >> 8) & 0xff

        #print
        packet_in_hex = [format(k, '02x') for k in buf_modbus_write] 
        print("Rez buf modbus (setpoint):", packet_in_hex)
        
        #send
        message = bytes(buf_modbus_write)

        try:
            #go
            sock.sendto(message, (dev_addr, UDP_PORT))
            #print("Eth send ok, addr:", dev_addr)
        except Exception as ex:
            print("ERR: Eth sendto() error:", ex)
            #sys.exit(0)
            
        
    else:
        print("topic unknown - %s" % msg.topic)
        
    return


CRC16_XMODEM_TABLE = [
	0x0000, 0xC0C1, 0xC181, 0x0140, 0xC301, 0x03C0, 0x0280, 0xC241,
	0xC601, 0x06C0, 0x0780, 0xC741, 0x0500, 0xC5C1, 0xC481, 0x0440,
	0xCC01, 0x0CC0, 0x0D80, 0xCD41, 0x0F00, 0xCFC1, 0xCE81, 0x0E40,
	0x0A00, 0xCAC1, 0xCB81, 0x0B40, 0xC901, 0x09C0, 0x0880, 0xC841,
	0xD801, 0x18C0, 0x1980, 0xD941, 0x1B00, 0xDBC1, 0xDA81, 0x1A40,
	0x1E00, 0xDEC1, 0xDF81, 0x1F40, 0xDD01, 0x1DC0, 0x1C80, 0xDC41,
	0x1400, 0xD4C1, 0xD581, 0x1540, 0xD701, 0x17C0, 0x1680, 0xD641,
	0xD201, 0x12C0, 0x1380, 0xD341, 0x1100, 0xD1C1, 0xD081, 0x1040,
	0xF001, 0x30C0, 0x3180, 0xF141, 0x3300, 0xF3C1, 0xF281, 0x3240,
	0x3600, 0xF6C1, 0xF781, 0x3740, 0xF501, 0x35C0, 0x3480, 0xF441,
	0x3C00, 0xFCC1, 0xFD81, 0x3D40, 0xFF01, 0x3FC0, 0x3E80, 0xFE41,
	0xFA01, 0x3AC0, 0x3B80, 0xFB41, 0x3900, 0xF9C1, 0xF881, 0x3840,
	0x2800, 0xE8C1, 0xE981, 0x2940, 0xEB01, 0x2BC0, 0x2A80, 0xEA41,
	0xEE01, 0x2EC0, 0x2F80, 0xEF41, 0x2D00, 0xEDC1, 0xEC81, 0x2C40,
	0xE401, 0x24C0, 0x2580, 0xE541, 0x2700, 0xE7C1, 0xE681, 0x2640,
	0x2200, 0xE2C1, 0xE381, 0x2340, 0xE101, 0x21C0, 0x2080, 0xE041,
	0xA001, 0x60C0, 0x6180, 0xA141, 0x6300, 0xA3C1, 0xA281, 0x6240,
	0x6600, 0xA6C1, 0xA781, 0x6740, 0xA501, 0x65C0, 0x6480, 0xA441,
	0x6C00, 0xACC1, 0xAD81, 0x6D40, 0xAF01, 0x6FC0, 0x6E80, 0xAE41,
	0xAA01, 0x6AC0, 0x6B80, 0xAB41, 0x6900, 0xA9C1, 0xA881, 0x6840,
	0x7800, 0xB8C1, 0xB981, 0x7940, 0xBB01, 0x7BC0, 0x7A80, 0xBA41,
	0xBE01, 0x7EC0, 0x7F80, 0xBF41, 0x7D00, 0xBDC1, 0xBC81, 0x7C40,
	0xB401, 0x74C0, 0x7580, 0xB541, 0x7700, 0xB7C1, 0xB681, 0x7640,
	0x7200, 0xB2C1, 0xB381, 0x7340, 0xB101, 0x71C0, 0x7080, 0xB041,
	0x5000, 0x90C1, 0x9181, 0x5140, 0x9301, 0x53C0, 0x5280, 0x9241,
	0x9601, 0x56C0, 0x5780, 0x9741, 0x5500, 0x95C1, 0x9481, 0x5440,
	0x9C01, 0x5CC0, 0x5D80, 0x9D41, 0x5F00, 0x9FC1, 0x9E81, 0x5E40,
	0x5A00, 0x9AC1, 0x9B81, 0x5B40, 0x9901, 0x59C0, 0x5880, 0x9841,
	0x8801, 0x48C0, 0x4980, 0x8941, 0x4B00, 0x8BC1, 0x8A81, 0x4A40,
	0x4E00, 0x8EC1, 0x8F81, 0x4F40, 0x8D01, 0x4DC0, 0x4C80, 0x8C41,
	0x4400, 0x84C1, 0x8581, 0x4540, 0x8701, 0x47C0, 0x4680, 0x8641,
	0x8201, 0x42C0, 0x4380, 0x8341, 0x4100, 0x81C1, 0x8081, 0x4040]

def crc16_algo(data):
    crc = 0xffff
    for byte in data:
        crc = ((crc>>8)&0x00ff) ^ CRC16_XMODEM_TABLE[(crc&0xff)^byte]

    return crc & 0xffff

    
def eth_send(socket_name, eth_mode):
    global dev_addr

    if eth_mode == "full_stat":
        buf = full_stat_reg_read
    elif eth_mode == "motor_angle_reg_read":
        buf = motor_angle_reg_read
    elif eth_mode == "motor_stat_reg_read":
        buf = motor_stat_reg_read
    elif eth_mode == "motor_sys_state_reg_read":
        buf = motor_sys_state_reg_read
    elif eth_mode == "slowup":
        buf = motor_slowup_write
    elif eth_mode == "slowdown":
        buf = motor_slowdown_write          
    elif eth_mode == "handshake":
        buf = str.encode("Handshake")

    message = bytes(buf)

    try:
        #send
        if eth_mode == "handshake":
            socket_name.sendto(message, (UDP_BROADCAST, UDP_PORT))
        else:
            socket_name.sendto(message, (dev_addr, UDP_PORT))
            #print("dev_addr = ", dev_addr)

    except Exception as ex:
        print("ERR: Eth sendto() error:", ex)
        sys.exit(0)

    #print("(%f) Send - ok" % time.time(), ", message - %s" % eth_mode)

    return buf

def crc_control():
    #crc check
    buf_dat = bytearray(motor_angle_reg_read[0:6])
    crc_rez = crc16_algo(buf_dat)
    print("CRC rez = 0x%4x" % crc_rez)
    #set
    motor_angle_reg_read[6] = crc_rez & 0xff
    motor_angle_reg_read[7] = (crc_rez >> 8) & 0xff
    buf_hex = bytearray(motor_angle_reg_read)
    print("rez data : ", motor_angle_reg_read)
    return
    #sys.exit(0)


def signal_handler(sig, frame):
    print("INTERRUPT ----> exit")
    sys.exit(0)
    
signal.signal(signal.SIGINT, signal_handler)

if(0):
    modbus_cmd("go")
    modbus_cmd("stop")
    modbus_cmd("release")
    modbus_cmd("zero")
    modbus_cmd("slowup")
    modbus_cmd("slowdown")

    modbus_read("motor_stat")
    modbus_read("motor_speed")
    modbus_read("sys_state")
    modbus_read("angle")
    modbus_read("raw_angle")
    sys.exit(0)

if(1):
    #mqtt
    client = mqtt.Client()
    client.on_connect = on_connect
    client.on_message = on_message
    client.connect(MQTT_HOST, port=1883, keepalive=30)
    #thread mode
    client.loop_start()
    #blocking way
    #client.loop_forever()

#eth
sock = socket.socket(socket.AF_INET, # Internet
                     socket.SOCK_DGRAM) # UDP

socket.socket.setsockopt(sock, socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.bind(('', UDP_PORT))
sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
sock.settimeout(0.1)#timeout



if INIT_SKIP == 0:
    #connect
    print("(%f) ETH: send handshake" % time.time())
    eth_send(sock, "handshake")
    try:
        data, addr = sock.recvfrom(1024) # buffer size is 1024 bytes
        print("(%f)" % (time.time() % 10000), "RX: %s" % data, "addr:", addr)
        data, addr = sock.recvfrom(1024) # buffer size is 1024 bytes
        print("(%f)" % (time.time() % 10000), "RX: %s" % data, "addr:", addr)
        dev_addr = addr[0]
        #print(dev_addr)

    except socket.timeout:
        err_time = time.time()
        print("(%f) ERR ETH: timeout" % err_time)
        sys.exit(0)


angle_v = 0


time_start = time.time()
time_state = time_start + 0.5 #for shift in time from angle read


while(1):

    #continue


    if time.time() - time_state > 1:

        #read state
        cmd = "full_stat"
        buf_sended = eth_send(sock, cmd)

        packet_in_hex = [format(k, '02x') for k in buf_sended]
        if PACKETS_DISPLAY > 0:
                print("(%.3f) TX: command =" % (time.time() % 10000), "%s:" % cmd, packet_in_hex)
        else:
                print("(%.3f) TX: command =" % (time.time() % 10000), "%s" % cmd)


        time_state = time.time()


        #cmd = "slowdown"
        cmd = "motor_angle_reg_read"
        #cmd = "motor_stat_reg_read"
        #read angle
        #eth_send(sock, "motor_angle_reg_read")





    try:
        data, addr = sock.recvfrom(1024) # buffer size is 1024 bytes
        packet_in_hex = [format(k, '02x') for k in data]

        #check ip    
        if addr[0] != dev_addr:
            print("____own packet - ignore")
            continue

        #check function type (read/write)
        if(data[1] != FUNC_READ):
            #reply for write cmd
            print("(%.3f)" % (time.time() % 10000), "RX: %s," % packet_in_hex,  end='')
            print("___reply for write - no display in angle")
            continue

        if PACKETS_DISPLAY > 0:
            print("(%.3f)" % (time.time() % 10000), "RX: %s," % packet_in_hex, "addr_ip:", addr[0], ", addr_port:", addr[1])
        else:
            print("(%.3f)" % (time.time() % 10000), "RX: addr_ip:", addr[0], "addr_port:", addr[1])


        #state
        print("SYS_STATE: byte[5] = 0x%02x" % data[5+2*4], ", byte[6] = 0x%02x" % data[6+2*4])
        sys_state_word = data[5+2*4] + data[6+2*4]*0x100
        #publish
        topic_name = MQTT_BUN_SYSTATE_TOPIC
        print(" -> to MQTT topic: '%s'" % topic_name, ", value = 0x%04x" % sys_state_word)
        publish.single(topic_name, sys_state_word, hostname=MQTT_HOST, qos=2)
           
        
        #angle pos
        angle_val = data[15] + data[16]*0x0100 + data[17]*0x010000 + data[18]*0x01000000

        #convert to sign
        if(angle_val & 0x80000000):
            angle_val = -0x100000000 + angle_val
        #from secs to degrees
        #angle_val /= 3600
        #angle_val = round(angle_val)
        #angle_v += 1
        #angle_val = angle_v
        #topic select
        if buf_sended[1] == 0x03:
            topic_name = MQTT_BUN_ANGLE_TOPIC
        else:
            #write cmd
            topic_name = "bun_cmd_reply"
            
        
        #print(" -> to MQTT topic: '%s'" % topic_name, ", value = 0x%x" % angle_val)
        print(" -> to MQTT topic: '%s'" % topic_name, ", value = %+d" % angle_val)
        publish.single(topic_name, angle_val, hostname=MQTT_HOST, qos=2)

        #device state register for Node-RED: published AFTER the angle, so the angle of the same
        #poll is already there when the state says the movement is over.
        #full_stat reply: data[3..6] MOTOR_STAT, data[7..10] MOTOR_SPEED, data[11..14] SYS_STATE, data[15..18] ANGLE.
        #SYS_STATE low 16 bits = device state (codes from the vendor BUN.exe, "Device status"):
        #0 Released, 1 Release received, 2 Stop received, 3 Stopped, 4 Go received, 5 Seting (moving to
        #the setpoint), 6 Slow Up received, 7 Rotating slow Up, 8 Slow Down received, 9 Rotating slow Down,
        #10 Hard stop received. High 16 bits = GPIO (published as bun_systate).
        if buf_sended[1] == 0x03 and len(data) >= 19:
            dev_state = data[11] + data[12]*0x100
            motor_stat = data[3] + data[4]*0x100 + data[5]*0x10000 + data[6]*0x1000000
            motor_speed = data[7] + data[8]*0x100 + data[9]*0x10000 + data[10]*0x1000000
            if(motor_speed & 0x80000000):
                motor_speed = -0x100000000 + motor_speed
            state_json = '{"state": %d, "gpio": %d, "motor_stat": %d, "motor_speed": %d}' % (dev_state, sys_state_word, motor_stat, motor_speed)
            print(" -> to MQTT topic: '%s'" % MQTT_BUN_STATE_TOPIC, ", value = %s" % state_json)
            publish.single(MQTT_BUN_STATE_TOPIC, state_json, hostname=MQTT_HOST, qos=2)
        
    except socket.timeout:
        err_time = time.time()
        #print("(%.3f) ERR ETH: timeout" % err_time)
        
    except Exception as ex:
        err_time = time.time()
        print("(%.3f) ERR ETH: " % err_time, ex)
        #print("ETH_UDP - no reply")
        k += 1

    
