/*
 * deckhand-panel's idle mode: the compositor counts, so Deckhand keeps no timer.
 *
 *   deckhand-panel --idle DIM_MS SLEEP_MS   0 leaves that one out
 *   deckhand-panel --idle-probe             whether this desktop offers it
 *
 * Asks for ext_idle_notifier_v1's plain notification, which respects idle
 * inhibitors, so a playing video or a game keeps the decks lit. Then blocks in
 * poll(), and shows nothing.
 *
 * stdout, one JSON object per line:
 *   {"ev":"available"}                       --idle-probe: the desktop offers it
 *   {"ev":"unavailable"}                     it does not: exit 3
 *   {"ev":"ready"}                           asked; the timeouts are running
 *   {"ev":"idled","level":"dim"|"sleep"}     idle that long
 *   {"ev":"resumed","level":"dim"|"sleep"}   no longer idle
 *   {"ev":"error","message":…}               then exit 2 (no connection) or 4 (lost)
 *
 * It quits when stdin closes, so it never outlives the daemon.
 * --idle-test-protocol NAME, tests only: look for NAME instead of the real
 * interface, which is how a test sees a desktop without it.
 */
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <wayland-client.h>

#include "idle.h"
#include "protocol/ext-idle-notify-v1-client.h"

static struct ext_idle_notifier_v1 *notifier;
static struct wl_seat *seat;
static const char *wanted = "ext_idle_notifier_v1";

static void say(const char *line) {
  fputs(line, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

static void registry_global(void *data, struct wl_registry *r, uint32_t name, const char *interface, uint32_t version) {
  (void)data;
  (void)version;
  if (!strcmp(interface, wanted)) notifier = wl_registry_bind(r, name, &ext_idle_notifier_v1_interface, 1);
  else if (!strcmp(interface, "wl_seat") && !seat) seat = wl_registry_bind(r, name, &wl_seat_interface, 1);
}

static void registry_remove(void *data, struct wl_registry *r, uint32_t name) {
  (void)data;
  (void)r;
  (void)name;
}

static const struct wl_registry_listener registry_listener = { registry_global, registry_remove };

static void on_idled(void *data, struct ext_idle_notification_v1 *n) {
  (void)n;
  char line[64];
  snprintf(line, sizeof line, "{\"ev\":\"idled\",\"level\":\"%s\"}", (const char *)data);
  say(line);
}

static void on_resumed(void *data, struct ext_idle_notification_v1 *n) {
  (void)n;
  char line[64];
  snprintf(line, sizeof line, "{\"ev\":\"resumed\",\"level\":\"%s\"}", (const char *)data);
  say(line);
}

static const struct ext_idle_notification_v1_listener notification_listener = { on_idled, on_resumed };

static void ask(uint32_t ms, const char *level) {
  if (ms == 0) return;
  struct ext_idle_notification_v1 *n = ext_idle_notifier_v1_get_idle_notification(notifier, ms, seat);
  ext_idle_notification_v1_add_listener(n, &notification_listener, (void *)level);
}

/* A timeout in ms, or -1: 0 up to about 49 days, which uint32 holds. */
static long long parse_ms(const char *text) {
  char *end = NULL;
  long long v = strtoll(text, &end, 10);
  if (end == text || *end != '\0' || v < 0 || v > 4000000000LL) return -1;
  return v;
}

int idle_main(int argc, char **argv) {
  int probe = 0;
  long long dim = 0, sleep_ms = 0;
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--idle-probe")) probe = 1;
    else if (!strcmp(argv[i], "--idle") && i + 2 < argc) {
      dim = parse_ms(argv[++i]);
      sleep_ms = parse_ms(argv[++i]);
    } else if (!strcmp(argv[i], "--idle-test-protocol") && i + 1 < argc) wanted = argv[++i];
    else {
      fprintf(stderr, "usage: deckhand-panel --idle DIM_MS SLEEP_MS | --idle-probe\n");
      return 1;
    }
  }
  if (dim < 0 || sleep_ms < 0 || (!probe && dim == 0 && sleep_ms == 0)) {
    fprintf(stderr, "usage: deckhand-panel --idle DIM_MS SLEEP_MS | --idle-probe\n");
    return 1;
  }

  struct wl_display *display = wl_display_connect(NULL);
  if (!display) {
    say("{\"ev\":\"error\",\"message\":\"cannot connect to the Wayland display\"}");
    return 2;
  }
  struct wl_registry *registry = wl_display_get_registry(display);
  wl_registry_add_listener(registry, &registry_listener, NULL);
  wl_display_roundtrip(display);
  if (!notifier || !seat) {
    say("{\"ev\":\"unavailable\"}");
    wl_display_disconnect(display);
    return 3;
  }
  if (probe) {
    say("{\"ev\":\"available\"}");
    wl_display_disconnect(display);
    return 0;
  }

  ask((uint32_t)dim, "dim");
  ask((uint32_t)sleep_ms, "sleep");
  wl_display_flush(display);
  say("{\"ev\":\"ready\"}");

  struct pollfd fds[2] = { { wl_display_get_fd(display), POLLIN, 0 }, { 0, POLLIN, 0 } };
  for (;;) {
    while (wl_display_prepare_read(display) != 0) {
      if (wl_display_dispatch_pending(display) < 0) goto lost;
    }
    if (wl_display_flush(display) < 0) {
      wl_display_cancel_read(display);
      goto lost;
    }
    if (poll(fds, 2, -1) < 0) {
      wl_display_cancel_read(display);
      continue;
    }
    if (fds[1].revents) {
      /* The daemon has gone, or told it to stop by closing the pipe. */
      wl_display_cancel_read(display);
      wl_display_disconnect(display);
      return 0;
    }
    if (fds[0].revents & POLLIN) {
      if (wl_display_read_events(display) < 0) goto lost;
    } else {
      wl_display_cancel_read(display);
      if (fds[0].revents) goto lost;
    }
    if (wl_display_dispatch_pending(display) < 0) goto lost;
  }

lost:
  say("{\"ev\":\"error\",\"message\":\"the Wayland connection was lost\"}");
  return 4;
}
