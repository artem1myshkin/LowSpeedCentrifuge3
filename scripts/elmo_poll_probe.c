/*
 * ELMO TCP poll probe.
 *
 * Purpose:
 *   Run a standalone single-socket TCP poll loop against ELMO, outside Node-RED,
 *   to verify whether the drive/network can sustain 1..30 Hz polling.
 *
 * Build, Windows MSVC:
 *   cl /nologo /W4 /O2 scripts\elmo_poll_probe.c /Fe:elmo_poll_probe.exe ws2_32.lib
 *
 * Build, Windows MinGW:
 *   gcc -O2 -Wall -Wextra -std=c11 scripts/elmo_poll_probe.c -o elmo_poll_probe.exe -lws2_32
 *
 * Build, Linux:
 *   gcc -O2 -Wall -Wextra -std=c11 scripts/elmo_poll_probe.c -o elmo_poll_probe
 */

#ifndef _WIN32
#define _POSIX_C_SOURCE 200809L
#endif

#include <ctype.h>
#include <errno.h>
#include <limits.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#pragma comment(lib, "ws2_32.lib")
typedef SOCKET socket_t;
#define CLOSESOCK closesocket
#define SOCKERRNO WSAGetLastError()
#define strtok_r strtok_s
#else
#include <arpa/inet.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>
typedef int socket_t;
#define INVALID_SOCKET (-1)
#define SOCKET_ERROR (-1)
#define CLOSESOCK close
#define SOCKERRNO errno
#endif

#define DEFAULT_HOST "192.168.1.2"
#define DEFAULT_PORT "2000"
#define DEFAULT_HZ 1.0
#define DEFAULT_DURATION_SEC 60
#define DEFAULT_IDLE_MS 80
#define DEFAULT_TIMEOUT_MS 1000
#define DEFAULT_EXTENDED_EVERY_MS 1000
#define MAX_RESPONSE 65536
#define MAX_FIELD_REPORT 512

typedef struct Options {
  const char *host;
  const char *port;
  double hz;
  int duration_sec;
  int idle_ms;
  int timeout_ms;
  int extended_every_ms;
  int all_extended;
  int quiet_raw;
} Options;

typedef struct Stats {
  long sent;
  long ok;
  long timeouts;
  long socket_errors;
  long overruns;
  double min_rtt;
  double max_rtt;
  double sum_rtt;
} Stats;

static const char *LEAN_CMDS[] = {"TM\r", "PX\r", "VX\r"};
static const char *EXT_CMDS[] = {"MS\r", "MO\r", "SO\r", "SR\r", "AF\r", "OL[1]\r", "OL[2]\r"};
static const int LEAN_CMD_COUNT = (int)(sizeof(LEAN_CMDS) / sizeof(LEAN_CMDS[0]));
static const int EXT_CMD_COUNT = (int)(sizeof(EXT_CMDS) / sizeof(EXT_CMDS[0]));

static void die(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  vfprintf(stderr, fmt, ap);
  va_end(ap);
  fputc('\n', stderr);
  exit(1);
}

static long long now_ms(void) {
#ifdef _WIN32
  return (long long)GetTickCount64();
#else
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (long long)ts.tv_sec * 1000LL + (long long)(ts.tv_nsec / 1000000LL);
#endif
}

static void sleep_ms(long long ms) {
  if (ms <= 0) return;
#ifdef _WIN32
  Sleep((DWORD)ms);
#else
  struct timespec req;
  req.tv_sec = (time_t)(ms / 1000);
  req.tv_nsec = (long)((ms % 1000) * 1000000LL);
  while (nanosleep(&req, &req) == -1 && errno == EINTR) {
  }
#endif
}

static void usage(const char *argv0) {
  printf(
      "Usage:\n"
      "  %s --hz <1..30> [options]\n\n"
      "Options:\n"
      "  --host <ip>                 ELMO host, default %s\n"
      "  --port <port>               ELMO TCP port, default %s\n"
      "  --hz <freq>                 poll frequency, 1..30 Hz\n"
      "  --duration <sec>            run duration, default %d, 0 = forever\n"
      "  --idle-ms <ms>              response idle-gap framing, default %d\n"
      "  --timeout-ms <ms>           response timeout per request, default %d\n"
      "  --extended-every-ms <ms>    send state poll at this period, default %d, 0 = never\n"
      "  --all-extended              send state poll every tick\n"
      "  --quiet-raw                 do not print escaped raw response\n"
      "  --help                      show this help\n\n"
      "Logical poll commands are sent as single-register TCP reads:\n"
      "  data:  TM, PX, VX\n"
      "  state: MS, MO, SO, SR, AF, OL[1], OL[2]\n",
      argv0, DEFAULT_HOST, DEFAULT_PORT, DEFAULT_DURATION_SEC, DEFAULT_IDLE_MS,
      DEFAULT_TIMEOUT_MS, DEFAULT_EXTENDED_EVERY_MS);
}

static int parse_int_arg(const char *name, const char *value, int min, int max) {
  char *end = NULL;
  long v;
  errno = 0;
  v = strtol(value, &end, 10);
  if (errno || end == value || *end != '\0' || v < min || v > max) {
    die("Invalid %s: %s (expected %d..%d)", name, value, min, max);
  }
  return (int)v;
}

static double parse_double_arg(const char *name, const char *value, double min, double max) {
  char *end = NULL;
  double v;
  errno = 0;
  v = strtod(value, &end);
  if (errno || end == value || *end != '\0' || v < min || v > max) {
    die("Invalid %s: %s (expected %.1f..%.1f)", name, value, min, max);
  }
  return v;
}

static Options parse_args(int argc, char **argv) {
  Options opt;
  int i;
  opt.host = DEFAULT_HOST;
  opt.port = DEFAULT_PORT;
  opt.hz = DEFAULT_HZ;
  opt.duration_sec = DEFAULT_DURATION_SEC;
  opt.idle_ms = DEFAULT_IDLE_MS;
  opt.timeout_ms = DEFAULT_TIMEOUT_MS;
  opt.extended_every_ms = DEFAULT_EXTENDED_EVERY_MS;
  opt.all_extended = 0;
  opt.quiet_raw = 0;

  for (i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
      usage(argv[0]);
      exit(0);
    } else if (strcmp(argv[i], "--host") == 0 && i + 1 < argc) {
      opt.host = argv[++i];
    } else if (strcmp(argv[i], "--port") == 0 && i + 1 < argc) {
      opt.port = argv[++i];
    } else if (strcmp(argv[i], "--hz") == 0 && i + 1 < argc) {
      opt.hz = parse_double_arg("--hz", argv[++i], 1.0, 30.0);
    } else if (strcmp(argv[i], "--duration") == 0 && i + 1 < argc) {
      opt.duration_sec = parse_int_arg("--duration", argv[++i], 0, INT_MAX);
    } else if (strcmp(argv[i], "--idle-ms") == 0 && i + 1 < argc) {
      opt.idle_ms = parse_int_arg("--idle-ms", argv[++i], 1, 5000);
    } else if (strcmp(argv[i], "--timeout-ms") == 0 && i + 1 < argc) {
      opt.timeout_ms = parse_int_arg("--timeout-ms", argv[++i], 1, 60000);
    } else if (strcmp(argv[i], "--extended-every-ms") == 0 && i + 1 < argc) {
      opt.extended_every_ms = parse_int_arg("--extended-every-ms", argv[++i], 0, 600000);
    } else if (strcmp(argv[i], "--all-extended") == 0) {
      opt.all_extended = 1;
    } else if (strcmp(argv[i], "--quiet-raw") == 0) {
      opt.quiet_raw = 1;
    } else {
      die("Unknown or incomplete argument: %s (use --help)", argv[i]);
    }
  }

  return opt;
}

static void socket_startup(void) {
#ifdef _WIN32
  WSADATA wsa;
  int rc = WSAStartup(MAKEWORD(2, 2), &wsa);
  if (rc != 0) die("WSAStartup failed: %d", rc);
#endif
}

static void socket_cleanup(void) {
#ifdef _WIN32
  WSACleanup();
#endif
}

static socket_t connect_tcp(const char *host, const char *port) {
  struct addrinfo hints;
  struct addrinfo *res = NULL;
  struct addrinfo *p;
  socket_t s = INVALID_SOCKET;
  int rc;

  memset(&hints, 0, sizeof(hints));
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  hints.ai_protocol = IPPROTO_TCP;

  rc = getaddrinfo(host, port, &hints, &res);
  if (rc != 0) {
#ifdef _WIN32
    die("getaddrinfo(%s:%s) failed: %d", host, port, rc);
#else
    die("getaddrinfo(%s:%s) failed: %s", host, port, gai_strerror(rc));
#endif
  }

  for (p = res; p != NULL; p = p->ai_next) {
    int one = 1;
    s = socket(p->ai_family, p->ai_socktype, p->ai_protocol);
    if (s == INVALID_SOCKET) continue;
    setsockopt(s, IPPROTO_TCP, TCP_NODELAY, (const char *)&one, sizeof(one));
    if (connect(s, p->ai_addr, (int)p->ai_addrlen) == 0) break;
    CLOSESOCK(s);
    s = INVALID_SOCKET;
  }

  freeaddrinfo(res);
  if (s == INVALID_SOCKET) die("Could not connect to %s:%s", host, port);
  return s;
}

static int wait_readable(socket_t s, int timeout_ms) {
  fd_set rfds;
  struct timeval tv;
  int rc;

  FD_ZERO(&rfds);
  FD_SET(s, &rfds);
  tv.tv_sec = timeout_ms / 1000;
  tv.tv_usec = (timeout_ms % 1000) * 1000;

#ifdef _WIN32
  rc = select(0, &rfds, NULL, NULL, &tv);
#else
  rc = select(s + 1, &rfds, NULL, NULL, &tv);
#endif
  return rc;
}

static int send_all(socket_t s, const char *buf, size_t len) {
  size_t off = 0;
  while (off < len) {
    int n = send(s, buf + off, (int)(len - off), 0);
    if (n == SOCKET_ERROR || n == 0) return -1;
    off += (size_t)n;
  }
  return 0;
}

static int recv_idle_frame(socket_t s, char *out, size_t cap, int timeout_ms,
                           int idle_ms, int *chunks, int *truncated) {
  long long start = now_ms();
  size_t total = 0;
  int got_any = 0;
  *chunks = 0;
  *truncated = 0;

  if (cap == 0) return -3;

  for (;;) {
    int wait_ms;
    int rc;
    char tmp[4096];
    int n;

    if (got_any) {
      wait_ms = idle_ms;
    } else {
      long long elapsed = now_ms() - start;
      long long remain = (long long)timeout_ms - elapsed;
      if (remain <= 0) {
        out[0] = '\0';
        return -2;
      }
      wait_ms = remain > INT_MAX ? INT_MAX : (int)remain;
    }

    rc = wait_readable(s, wait_ms);
    if (rc == 0) {
      if (got_any) {
        out[total < cap ? total : cap - 1] = '\0';
        return (int)total;
      }
      out[0] = '\0';
      return -2;
    }
    if (rc < 0) {
      out[0] = '\0';
      return -1;
    }

    n = recv(s, tmp, (int)sizeof(tmp), 0);
    if (n == 0) {
      out[total < cap ? total : cap - 1] = '\0';
      return -4;
    }
    if (n == SOCKET_ERROR) {
      out[total < cap ? total : cap - 1] = '\0';
      return -1;
    }

    got_any = 1;
    (*chunks)++;

    if (total + (size_t)n >= cap) {
      size_t room = cap - 1 - total;
      if (room > 0) {
        memcpy(out + total, tmp, room);
        total += room;
      }
      out[total] = '\0';
      *truncated = 1;
    } else {
      memcpy(out + total, tmp, (size_t)n);
      total += (size_t)n;
      out[total] = '\0';
    }
  }
}

static int recv_poll_sequence(socket_t s, const char **cmds, int cmd_count,
                              char *out, size_t cap, int timeout_ms,
                              int idle_ms, int *chunks, int *truncated) {
  int i;
  size_t total = 0;
  *chunks = 0;
  *truncated = 0;
  if (cap == 0) return -3;
  out[0] = '\0';

  for (i = 0; i < cmd_count; i++) {
    char part[MAX_RESPONSE];
    int part_chunks = 0;
    int part_truncated = 0;
    int rc;

    if (send_all(s, cmds[i], strlen(cmds[i])) != 0) return -5;

    rc = recv_idle_frame(s, part, sizeof(part), timeout_ms, idle_ms,
                         &part_chunks, &part_truncated);
    *chunks += part_chunks;
    if (part_truncated) *truncated = 1;
    if (rc < 0) return rc;

    if (total + (size_t)rc >= cap) {
      size_t room = cap - 1 - total;
      if (room > 0) {
        memcpy(out + total, part, room);
        total += room;
      }
      out[total] = '\0';
      *truncated = 1;
    } else {
      memcpy(out + total, part, (size_t)rc);
      total += (size_t)rc;
      out[total] = '\0';
    }
  }

  return (int)total;
}

static void append_text(char *dst, size_t cap, const char *fmt, ...) {
  size_t len = strlen(dst);
  va_list ap;
  if (len >= cap) return;
  va_start(ap, fmt);
  vsnprintf(dst + len, cap - len, fmt, ap);
  va_end(ap);
}

static int token_is_number(const char *s) {
  char *end = NULL;
  if (!s || !*s) return 0;
  errno = 0;
  (void)strtod(s, &end);
  return errno == 0 && end != s && *end == '\0';
}

static int field_index(const char *field, const char **fields, int field_count) {
  int i;
  for (i = 0; i < field_count; i++) {
    if (strcmp(field, fields[i]) == 0) return i;
  }
  return -1;
}

static void trim_ascii(char *s) {
  char *p = s;
  char *end;
  while (*p && isspace((unsigned char)*p)) p++;
  if (p != s) memmove(s, p, strlen(p) + 1);
  end = s + strlen(s);
  while (end > s && isspace((unsigned char)end[-1])) {
    end--;
    *end = '\0';
  }
}

static void analyze_response(const char *raw, int extended, char *missing,
                             size_t missing_cap, char *dups, size_t dups_cap) {
  static const char *lean_fields[] = {"TM", "PX", "VX"};
  static const char *ext_fields[] = {"MS", "MO", "SO", "SR", "AF", "OL[1]", "OL[2]"};
  const char **fields = extended ? ext_fields : lean_fields;
  int field_count = extended ? (int)(sizeof(ext_fields) / sizeof(ext_fields[0]))
                             : (int)(sizeof(lean_fields) / sizeof(lean_fields[0]));
  int counts[16];
  char buf[MAX_RESPONSE];
  char *tok;
  char *ctx = NULL;
  int i;

  memset(counts, 0, sizeof(counts));
  missing[0] = '\0';
  dups[0] = '\0';

  strncpy(buf, raw ? raw : "", sizeof(buf) - 1);
  buf[sizeof(buf) - 1] = '\0';

  for (tok = strtok_r(buf, ";\r\n", &ctx); tok != NULL; tok = strtok_r(NULL, ";\r\n", &ctx)) {
    char *eq;
    char param[64];
    int idx;

    trim_ascii(tok);
    if (!*tok || token_is_number(tok)) continue;

    eq = strchr(tok, '=');
    if (eq) {
      size_t n = (size_t)(eq - tok);
      if (n >= sizeof(param)) n = sizeof(param) - 1;
      memcpy(param, tok, n);
      param[n] = '\0';
      trim_ascii(param);
      idx = field_index(param, fields, field_count);
      if (idx >= 0) counts[idx]++;
      continue;
    }

    idx = field_index(tok, fields, field_count);
    if (idx >= 0) counts[idx]++;
  }

  for (i = 0; i < field_count; i++) {
    if (counts[i] == 0) append_text(missing, missing_cap, "%s%s", missing[0] ? "|" : "", fields[i]);
    if (counts[i] > 1) append_text(dups, dups_cap, "%s%s:%d", dups[0] ? "|" : "", fields[i], counts[i]);
  }
}

static void print_escaped(const char *s) {
  const unsigned char *p = (const unsigned char *)(s ? s : "");
  putchar('"');
  while (*p) {
    unsigned char c = *p++;
    switch (c) {
      case '\r':
        fputs("\\r", stdout);
        break;
      case '\n':
        fputs("\\n", stdout);
        break;
      case '\t':
        fputs("\\t", stdout);
        break;
      case '"':
        fputs("\\\"", stdout);
        break;
      case '\\':
        fputs("\\\\", stdout);
        break;
      default:
        if (c < 32 || c > 126) {
          printf("\\x%02X", c);
        } else {
          putchar((int)c);
        }
    }
  }
  putchar('"');
}

static int should_send_extended(const Options *opt, long long now, long long *last_extended) {
  if (opt->all_extended) return 1;
  if (opt->extended_every_ms <= 0) return 0;
  if (*last_extended == 0 || now - *last_extended >= opt->extended_every_ms) {
    *last_extended = now;
    return 1;
  }
  return 0;
}

int main(int argc, char **argv) {
  Options opt = parse_args(argc, argv);
  socket_t sock;
  long long start_ms;
  long long end_ms;
  long long next_tick;
  long long last_extended = 0;
  long seq = 0;
  double period_ms = 1000.0 / opt.hz;
  Stats stats;

  memset(&stats, 0, sizeof(stats));
  stats.min_rtt = 1e30;

  socket_startup();
  sock = connect_tcp(opt.host, opt.port);

  printf("# ELMO poll probe connected to %s:%s\n", opt.host, opt.port);
  printf("# hz=%.3f period_ms=%.3f duration_sec=%d idle_ms=%d timeout_ms=%d extended_every_ms=%d all_extended=%d\n",
         opt.hz, period_ms, opt.duration_sec, opt.idle_ms, opt.timeout_ms,
         opt.extended_every_ms, opt.all_extended);
  printf("# csv: seq,kind,scheduled_ms,late_ms,rtt_ms,period_overrun_ms,bytes,chunks,truncated,status,missing,dups,raw\n");
  fflush(stdout);

  start_ms = now_ms();
  end_ms = opt.duration_sec == 0 ? 0 : start_ms + (long long)opt.duration_sec * 1000LL;
  next_tick = start_ms;

  while (end_ms == 0 || now_ms() < end_ms) {
    long long before_send;
    long long after_recv;
    long long scheduled = next_tick;
    long long late;
    long long rtt;
    long long overrun;
    int extended;
    const char **cmds;
    int cmd_count;
    const char *kind;
    char response[MAX_RESPONSE];
    int chunks = 0;
    int truncated = 0;
    int rc;
    char missing[MAX_FIELD_REPORT];
    char dups[MAX_FIELD_REPORT];

    sleep_ms(next_tick - now_ms());
    before_send = now_ms();
    late = before_send - scheduled;
    if (late < 0) late = 0;

    extended = should_send_extended(&opt, before_send, &last_extended);
    cmds = extended ? EXT_CMDS : LEAN_CMDS;
    cmd_count = extended ? EXT_CMD_COUNT : LEAN_CMD_COUNT;
    kind = extended ? "state" : "data";

    seq++;
    stats.sent++;

    rc = recv_poll_sequence(sock, cmds, cmd_count, response, sizeof(response),
                            opt.timeout_ms, opt.idle_ms, &chunks, &truncated);
    if (rc == -5) {
      stats.socket_errors++;
      fprintf(stderr, "send failed at seq=%ld socket_errno=%d\n", seq, SOCKERRNO);
      break;
    }

    after_recv = now_ms();
    rtt = after_recv - before_send;
    overrun = rtt - (long long)(period_ms + 0.5);
    if (overrun < 0) overrun = 0;
    if (overrun > 0) stats.overruns++;

    missing[0] = '\0';
    dups[0] = '\0';

    if (rc >= 0) {
      stats.ok++;
      if ((double)rtt < stats.min_rtt) stats.min_rtt = (double)rtt;
      if ((double)rtt > stats.max_rtt) stats.max_rtt = (double)rtt;
      stats.sum_rtt += (double)rtt;
      analyze_response(response, extended, missing, sizeof(missing), dups, sizeof(dups));

      printf("%ld,%s,%lld,%lld,%lld,%lld,%d,%d,%d,OK,%s,%s,",
             seq, kind, scheduled - start_ms, late, rtt, overrun, rc, chunks, truncated,
             missing[0] ? missing : "-", dups[0] ? dups : "-");
      if (opt.quiet_raw) {
        printf("-\n");
      } else {
        print_escaped(response);
        putchar('\n');
      }
    } else {
      const char *status = "ERR";
      if (rc == -2) {
        status = "TIMEOUT";
        stats.timeouts++;
      } else {
        stats.socket_errors++;
      }
      printf("%ld,%s,%lld,%lld,%lld,%lld,0,%d,0,%s,-,-,-\n",
             seq, kind, scheduled - start_ms, late, rtt, overrun, chunks, status);
      if (rc != -2) break;
    }

    fflush(stdout);
    next_tick = start_ms + (long long)((double)seq * period_ms + 0.5);
  }

  CLOSESOCK(sock);
  socket_cleanup();

  printf("# summary sent=%ld ok=%ld timeouts=%ld socket_errors=%ld overruns=%ld",
         stats.sent, stats.ok, stats.timeouts, stats.socket_errors, stats.overruns);
  if (stats.ok > 0) {
    printf(" rtt_ms_min=%.3f rtt_ms_avg=%.3f rtt_ms_max=%.3f",
           stats.min_rtt, stats.sum_rtt / (double)stats.ok, stats.max_rtt);
  }
  putchar('\n');
  return stats.socket_errors ? 2 : (stats.timeouts ? 1 : 0);
}
