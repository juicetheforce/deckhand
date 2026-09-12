/*
 * deckhand-input — resident uinput helper.
 *
 * Creates one virtual keyboard at startup and holds it open for the life of
 * the process. Reads newline-delimited commands on stdin, emits evdev events.
 *
 * Because this injects at the evdev layer it works identically under X11 and
 * Wayland, needs no portal permission prompt, and is visible to games that
 * read input through SDL/libinput.
 *
 * Protocol (stdin, one command per line; replies "OK" or "ERR <reason>"):
 *
 *   TAP <code> [code...]   press codes in order, release in reverse
 *   DOWN <code> [code...]  press and hold
 *   UP <code> [code...]    release
 *   PING                   liveness check
 *
 * Codes are numeric Linux evdev keycodes (see linux/input-event-codes.h).
 * All human-readable key naming lives in the TypeScript side (src/keymap.ts)
 * so this file never needs to change.
 *
 * Build:  make
 * Needs:  read/write access to /dev/uinput (see udev/60-deckhand.rules)
 */

#include <errno.h>
#include <fcntl.h>
#include <linux/uinput.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

#define MAX_CODES 16
#define LINE_MAX_LEN 512

/* Delay between press and release of a tap, and between chained events.
 * Some applications drop keystrokes that arrive in the same event batch. */
#define TAP_DELAY_US 12000
#define CHAIN_DELAY_US 1500

static int uinput_fd = -1;

static void emit(int type, int code, int value) {
    struct input_event ev;
    memset(&ev, 0, sizeof(ev));
    ev.type = type;
    ev.code = code;
    ev.value = value;
    if (write(uinput_fd, &ev, sizeof(ev)) < 0) {
        fprintf(stderr, "deckhand-input: write failed: %s\n", strerror(errno));
    }
}

static void sync_report(void) { emit(EV_SYN, SYN_REPORT, 0); }

static void press(int code) {
    emit(EV_KEY, code, 1);
    sync_report();
}

static void release(int code) {
    emit(EV_KEY, code, 0);
    sync_report();
}

static void cleanup(void) {
    if (uinput_fd >= 0) {
        ioctl(uinput_fd, UI_DEV_DESTROY);
        close(uinput_fd);
        uinput_fd = -1;
    }
}

static void on_signal(int sig) {
    (void)sig;
    cleanup();
    _exit(0);
}

static int setup_device(void) {
    struct uinput_setup usetup;
    int i;

    uinput_fd = open("/dev/uinput", O_WRONLY | O_NONBLOCK);
    if (uinput_fd < 0) {
        fprintf(stderr,
                "deckhand-input: cannot open /dev/uinput: %s\n"
                "  Install udev/60-deckhand.rules and re-plug, or check that "
                "the uinput module is loaded (sudo modprobe uinput).\n",
                strerror(errno));
        return -1;
    }

    if (ioctl(uinput_fd, UI_SET_EVBIT, EV_KEY) < 0) {
        fprintf(stderr, "deckhand-input: UI_SET_EVBIT failed: %s\n", strerror(errno));
        return -1;
    }

    /* Enable keyboard keycodes only (1..248). Deliberately stopping short of
     * the BTN_* range at 0x100 keeps compositors from classifying this device
     * as a mouse or gamepad. */
    for (i = 1; i <= 248; i++) {
        ioctl(uinput_fd, UI_SET_KEYBIT, i);
    }

    memset(&usetup, 0, sizeof(usetup));
    usetup.id.bustype = BUS_VIRTUAL;
    usetup.id.vendor = 0x1209;  /* pid.codes generic */
    usetup.id.product = 0xdec4;
    usetup.id.version = 1;
    snprintf(usetup.name, sizeof(usetup.name), "deckhand virtual keyboard");

    if (ioctl(uinput_fd, UI_DEV_SETUP, &usetup) < 0) {
        fprintf(stderr, "deckhand-input: UI_DEV_SETUP failed: %s\n", strerror(errno));
        return -1;
    }
    if (ioctl(uinput_fd, UI_DEV_CREATE) < 0) {
        fprintf(stderr, "deckhand-input: UI_DEV_CREATE failed: %s\n", strerror(errno));
        return -1;
    }

    /* udev and the compositor need a moment to notice the new device.
     * Events emitted before this settles are silently discarded. */
    usleep(250000);
    return 0;
}

/* Parse whitespace-separated keycodes from `rest` into `codes`.
 * Returns the count, or -1 on a malformed or out-of-range value. */
static int parse_codes(char *rest, int *codes) {
    int count = 0;
    char *tok = strtok(rest, " \t\r\n");
    while (tok != NULL) {
        char *end = NULL;
        long v = strtol(tok, &end, 10);
        if (end == tok || *end != '\0' || v < 1 || v > 248) return -1;
        if (count >= MAX_CODES) return -1;
        codes[count++] = (int)v;
        tok = strtok(NULL, " \t\r\n");
    }
    return count;
}

int main(void) {
    char line[LINE_MAX_LEN];

    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);
    signal(SIGHUP, on_signal);
    /* Don't die if the parent goes away mid-write. */
    signal(SIGPIPE, SIG_IGN);

    if (setup_device() != 0) {
        cleanup();
        return 1;
    }

    /* The daemon waits for this before sending anything. */
    printf("READY\n");
    fflush(stdout);

    while (fgets(line, sizeof(line), stdin) != NULL) {
        int codes[MAX_CODES];
        int count, i;
        char *rest;
        char *cmd = strtok(line, " \t\r\n");

        if (cmd == NULL) continue;

        if (strcmp(cmd, "PING") == 0) {
            printf("OK\n");
            fflush(stdout);
            continue;
        }

        rest = strtok(NULL, "");
        if (rest == NULL) {
            printf("ERR missing-codes\n");
            fflush(stdout);
            continue;
        }

        count = parse_codes(rest, codes);
        if (count <= 0) {
            printf("ERR bad-codes\n");
            fflush(stdout);
            continue;
        }

        if (strcmp(cmd, "TAP") == 0) {
            for (i = 0; i < count; i++) {
                press(codes[i]);
                usleep(CHAIN_DELAY_US);
            }
            usleep(TAP_DELAY_US);
            for (i = count - 1; i >= 0; i--) {
                release(codes[i]);
                usleep(CHAIN_DELAY_US);
            }
            printf("OK\n");
        } else if (strcmp(cmd, "DOWN") == 0) {
            for (i = 0; i < count; i++) {
                press(codes[i]);
                usleep(CHAIN_DELAY_US);
            }
            printf("OK\n");
        } else if (strcmp(cmd, "UP") == 0) {
            for (i = count - 1; i >= 0; i--) {
                release(codes[i]);
                usleep(CHAIN_DELAY_US);
            }
            printf("OK\n");
        } else {
            printf("ERR unknown-command\n");
        }
        fflush(stdout);
    }

    cleanup();
    return 0;
}
