/*
 * deckhand-panel's touches on Linux (touch.h): the touchscreen's evdev node,
 * read directly and grabbed, so the desktop never sees a touch meant for the
 * deck — nothing can take focus, nothing lands on another screen, and nothing
 * needs setting in the desktop.
 * The kernel gives a grab to one process and ends it when the fd closes, so a
 * helper that crashes gives the touchscreen back.
 *
 * Multitouch protocol B (slots) is read when the device has it; otherwise the
 * single-touch events (BTN_TOUCH, ABS_X, ABS_Y). A frame is acted on at its
 * SYN_REPORT: a slot given a tracking id is a contact down, at the slot's
 * position; a tracking id of -1 lifts it. Only downs and ups are reported —
 * a touch belongs to the control it started on, so movement changes nothing.
 * A lift of a slot that was never down is ignored. After SYN_DROPPED (the
 * kernel's buffer overflowed) every contact is lifted, and a slot comes back
 * only with a new tracking id: a finger still down then has to be lifted and
 * pressed again, which is better than a press that never ends.
 */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/input.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

#include "touch.h"

#define MAX_SLOTS 16
/* A slot whose state is not known (after SYN_DROPPED): ignored until it is given a new contact. */
#define SLOT_UNKNOWN -2

struct axis {
  int min, max;
};

struct slot {
  int id;       /* tracking id; -1 none */
  int x, y;
  int down;     /* reported down */
};

struct source {
  int fd;
  char path[256];
  int has_mt;
  struct axis mt_x, mt_y, st_x, st_y;
  int slot;
  struct slot slots[MAX_SLOTS];
  int st_touch, st_xv, st_yv, st_down;
  int dropping;
  /* A FIFO can give part of an event; the rest arrives with the next read. */
  unsigned char partial[sizeof(struct input_event)];
  size_t partial_len;
};

static struct source sources[MAX_TOUCH_SOURCES];
static int source_count;

static int test_bit(const unsigned long *bits, int bit) {
  return (bits[bit / (8 * sizeof(long))] >> (bit % (8 * sizeof(long)))) & 1;
}

static struct axis axis_of(int fd, int code, int test_max) {
  struct input_absinfo info;
  if (test_max > 0 || ioctl(fd, EVIOCGABS(code), &info) < 0) return (struct axis){ 0, test_max > 0 ? test_max : 1 };
  return (struct axis){ info.minimum, info.maximum };
}

static double scaled(int value, struct axis a) {
  if (a.max <= a.min) return 0;
  double u = (double)(value - a.min) / (a.max - a.min);
  return u < 0 ? 0 : u > 1 ? 1 : u;
}

int touch_open(const char *path, int grab, int test_max, char *err, size_t errlen) {
  if (source_count >= MAX_TOUCH_SOURCES) { snprintf(err, errlen, "too many touch devices"); return -1; }
  int fd = open(path, O_RDONLY | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) { snprintf(err, errlen, "cannot open %s: %s", path, strerror(errno)); return -1; }

  unsigned long abs_bits[ABS_CNT / (8 * sizeof(long)) + 1];
  memset(abs_bits, 0, sizeof abs_bits);
  int is_device = ioctl(fd, EVIOCGBIT(EV_ABS, sizeof abs_bits), abs_bits) >= 0;
  if (!is_device && !(errno == ENOTTY || errno == EINVAL) ) {
    snprintf(err, errlen, "cannot read %s: %s", path, strerror(errno));
    close(fd);
    return -1;
  }
  if (!is_device && test_max <= 0) {
    snprintf(err, errlen, "%s is not an input device", path);
    close(fd);
    return -1;
  }
  if (is_device && grab && ioctl(fd, EVIOCGRAB, 1) < 0) {
    snprintf(err, errlen, errno == EBUSY ? "%s is grabbed by another program" : "cannot grab %s: %s", path, strerror(errno));
    close(fd);
    return -1;
  }

  struct source *s = &sources[source_count];
  memset(s, 0, sizeof *s);
  s->fd = fd;
  snprintf(s->path, sizeof s->path, "%s", path);
  int axis_max = is_device ? 0 : test_max;
  s->has_mt = is_device && test_bit(abs_bits, ABS_MT_SLOT);
  s->mt_x = axis_of(fd, ABS_MT_POSITION_X, axis_max);
  s->mt_y = axis_of(fd, ABS_MT_POSITION_Y, axis_max);
  s->st_x = axis_of(fd, ABS_X, axis_max);
  s->st_y = axis_of(fd, ABS_Y, axis_max);
  for (int i = 0; i < MAX_SLOTS; i++) s->slots[i].id = -1;
  return source_count++;
}

int touch_fd(int i) { return i >= 0 && i < source_count ? sources[i].fd : -1; }

const char *touch_path(int i) { return i >= 0 && i < source_count ? sources[i].path : ""; }

static void lift_all(int index, touch_contact_fn fn) {
  struct source *s = &sources[index];
  for (int i = 0; i < MAX_SLOTS; i++)
    if (s->slots[i].down) {
      s->slots[i].down = 0;
      fn(index, i, 0, 0, 0);
    }
  if (s->st_down) {
    s->st_down = 0;
    fn(index, 0, 0, 0, 0);
  }
}

/* The frame is complete: report what went down and what came up. */
static void sync_frame(int index, touch_contact_fn fn) {
  struct source *s = &sources[index];
  if (s->has_mt) {
    for (int i = 0; i < MAX_SLOTS; i++) {
      struct slot *sl = &s->slots[i];
      if (sl->id >= 0 && !sl->down) {
        sl->down = 1;
        fn(index, i, 1, scaled(sl->x, s->mt_x), scaled(sl->y, s->mt_y));
      } else if (sl->id < 0 && sl->down) {
        sl->down = 0;
        fn(index, i, 0, 0, 0);
      }
    }
    return;
  }
  if (s->st_touch == 1 && !s->st_down) {
    s->st_down = 1;
    fn(index, 0, 1, scaled(s->st_xv, s->st_x), scaled(s->st_yv, s->st_y));
  } else if (s->st_touch == 0 && s->st_down) {
    s->st_down = 0;
    fn(index, 0, 0, 0, 0);
  }
}

static void handle_event(int index, const struct input_event *ev, touch_contact_fn fn) {
  struct source *s = &sources[index];
  if (ev->type == EV_SYN) {
    if (ev->code == SYN_DROPPED) {
      lift_all(index, fn);
      for (int i = 0; i < MAX_SLOTS; i++) s->slots[i].id = SLOT_UNKNOWN;
      s->st_touch = 0;
      s->dropping = 1;
    } else if (ev->code == SYN_REPORT) {
      if (s->dropping) s->dropping = 0;
      else sync_frame(index, fn);
    }
    return;
  }
  if (s->dropping) return;
  if (ev->type == EV_KEY && ev->code == BTN_TOUCH) {
    s->st_touch = ev->value ? 1 : 0;
    return;
  }
  if (ev->type != EV_ABS) return;
  if (ev->code == ABS_X) s->st_xv = ev->value;
  else if (ev->code == ABS_Y) s->st_yv = ev->value;
  else if (ev->code == ABS_MT_SLOT || ev->code == ABS_MT_TRACKING_ID || ev->code == ABS_MT_POSITION_X || ev->code == ABS_MT_POSITION_Y) {
    s->has_mt = 1; /* a recording says so by sending it */
    if (ev->code == ABS_MT_SLOT) {
      s->slot = ev->value;
      return;
    }
    if (s->slot < 0 || s->slot >= MAX_SLOTS) return;
    struct slot *sl = &s->slots[s->slot];
    if (ev->code == ABS_MT_TRACKING_ID) sl->id = ev->value < 0 ? -1 : ev->value;
    else if (ev->code == ABS_MT_POSITION_X) sl->x = ev->value;
    else sl->y = ev->value;
  }
}

static void close_source(int index) {
  struct source *s = &sources[index];
  if (s->fd >= 0) close(s->fd);
  s->fd = -1;
}

int touch_read(int index, touch_contact_fn fn) {
  struct source *s = &sources[index];
  if (s->fd < 0) return -1;
  for (;;) {
    unsigned char buf[sizeof(struct input_event) * 64];
    memcpy(buf, s->partial, s->partial_len);
    ssize_t n = read(s->fd, buf + s->partial_len, sizeof buf - s->partial_len);
    if (n < 0 && errno == EINTR) continue;
    if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return 0;
    if (n <= 0) {
      /* ENODEV: unplugged. 0: the end of a recording. */
      lift_all(index, fn);
      close_source(index);
      return -1;
    }
    size_t have = s->partial_len + (size_t)n, at = 0;
    for (; have - at >= sizeof(struct input_event); at += sizeof(struct input_event)) {
      struct input_event ev;
      memcpy(&ev, buf + at, sizeof ev);
      handle_event(index, &ev, fn);
    }
    s->partial_len = have - at;
    memcpy(s->partial, buf + at, s->partial_len);
  }
}

void touch_close_all(void) {
  for (int i = 0; i < source_count; i++) close_source(i);
  source_count = 0;
}
