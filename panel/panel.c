/*
 * deckhand-panel — shows a virtual deck on one screen.
 *
 * The daemon spawns one per virtual deck whose screen is connected, as it
 * spawns deckhand-input, and owns everything it shows: every key is rendered
 * by the daemon and arrives here as an image to place on a canvas. This
 * program only composes images into the screen's buffer and shows what
 * changed. It does nothing at rest: one poll() over its stdin and the
 * windowing system, no timer.
 *
 *   deckhand-panel --output DP-4 [--dump FILE]
 *
 * stdin, from the daemon — binary frames, little-endian:
 *   u32 length (of everything after it), u8 type, then the body
 *   'K' canvas   u32 width, u32 height, u8 r, g, b: the panel's size in its
 *                own units and its background. Clears it. The canvas is drawn
 *                scaled to fit the screen, centred.
 *   'I' image    i32 x, i32 y, u32 w, u32 h, then w × h RGBA pixels: one key,
 *                at its place on the canvas, straight alpha over the
 *                background — whatever was in its rectangle is replaced.
 *                Answered "drawn".
 *   'G' ground   u8 r, g, b, a, u32 w, u32 h, then w × h RGBA pixels: the
 *                page's background, covering the whole screen, not the canvas
 *                — a colour with its opacity (a, 255 opaque), and with w × h
 *                above 0 a picture of it at the screen's size, straight
 *                alpha, already the colour and image combined at that opacity
 *                (the daemon draws it). Replaces the canvas's colour until the
 *                next 'K'; repaints everything, so every key is sent after
 *                it. Below 255 the screen is shown see-through: whatever is
 *                behind the panel on that screen shows where the background
 *                does. Keys are drawn over it as they always are.
 *   'C' clear    the background everywhere.
 *   'B' brightness  u8 percent, 0-100: everything drawn from now on is that much
 *                darker, 0 being pure black; what is on the screen stays until
 *                drawn again, so the daemon sends the canvas and every key after it.
 *                It dims the whole deck, a see-through background included: as
 *                if black were laid over it at 100 − percent, so whatever shows
 *                through darkens too, and at 0 the screen is opaque black.
 *   'T' touch    u8 mode, then entries of u8 role and a path ending in NUL.
 *                Closes the devices read before. Mode 1, a deck: every entry
 *                opened and grabbed; role 't' is the touchscreen, whose
 *                contacts are reported, 's' a sibling (another node of the
 *                same device, such as a touchscreen's mouse twin), grabbed only
 *                so the desktop does not see it. Mode 2, pairing: every 't'
 *                read without a grab, and the first to be touched is named.
 *                Mode 0: none.
 *   'M' follow   u32 contact: report this contact's movement ("move") until it
 *                lifts — a slider's or dial's, which the daemon hit-tested on
 *                its way down. Ignored for a contact not down. Movement of any
 *                other contact is never reported, so a button's touch is
 *                exactly what it always was.
 *   'Q' quit
 *
 * stdout, to the daemon — one JSON object per line:
 *   {"ev":"ready","output":…,"width":…,"height":…,"scale":…,"transform":…,"surface":…}
 *        once the surface is shown, and again after a resize or once the
 *        output is back: the canvas is then blank, and the daemon draws
 *        everything again.
 *   {"ev":"output-lost"}  the output went away with its screen still plugged
 *        in (KWin does so when a screen wakes): nothing is shown, touches are
 *        still read, and "ready" follows when an output of the same name is
 *        announced again. The daemon quits the helper if the screen is gone.
 *   {"ev":"drawn"}       one per image, once it is on the canvas
 *   {"ev":"touch-open","device":…}             a device is being read
 *   {"ev":"touch-failed","device":…,"message":…}  it could not be opened or grabbed
 *   {"ev":"touch-gone","device":…}             it went away (unplugged)
 *   {"ev":"touch","contact":…,"edge":"down","x":…,"y":…}  in canvas units
 *   {"ev":"touch","contact":…,"edge":"move","x":…,"y":…}  a followed contact
 *        moved, in canvas units: at most once per frame of the touchscreen
 *   {"ev":"touch","contact":…,"edge":"up"}
 *   {"ev":"tap","device":…}   pairing: the first touchscreen touched
 *   {"ev":"error","message":…}  before a non-zero exit
 *
 * A touch's position is mapped back through the output's transform (a
 * rotated screen's touchscreen still reports in its own orientation) and the
 * canvas's scale and origin, so the daemon gets canvas units and hit-tests
 * there. Where the canvas does not cover the screen, a touch can fall outside
 * it; the daemon finds no control there.
 *
 * Exit: 0 asked to (Q, or stdin closed), 2 bad arguments or no such output,
 * 3 the compositor would not show the panel, 4 the windowing system went away,
 * 5 a bad frame. Losing the output is not an exit ("output-lost").
 *
 * deckhand-panel --idle DIM_MS SLEEP_MS, and --idle-probe: idle.c. Nothing is shown.
 *
 * --dump FILE writes the screen's buffer as a binary PPM on exit, for tests.
 * --touch-test-range MAX lets a touch path that is not an input device (a
 * FIFO of recorded events) be read, with both axes 0..MAX, for tests.
 */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "idle.h"
#include "platform.h"
#include "touch.h"

/* An image larger than this (bytes of frame) is refused: 8192 × 8192 RGBA. */
#define MAX_FRAME (8192u * 8192u * 4u + 64u)

static struct panel_output out;

/* The canvas, in the daemon's units, and where it lands on the screen. */
static unsigned canvas_w, canvas_h;
/*
 * The background ('K' sets an opaque colour, 'G' a page's): one premultiplied
 * ARGB pixel, or a picture of it at ground_w × ground_h (also premultiplied),
 * stretched to the screen if the screen has since changed size. Below opaque,
 * the buffers are shown with their alpha (platform_translucent).
 */
static uint32_t ground = 0xff000000;
static uint32_t *ground_px;
static unsigned ground_w, ground_h;
/* The deck's brightness, a percent: 'B'. */
static unsigned brightness = 100;
static double scale = 1.0;
static int origin_x, origin_y;

static unsigned char *inbuf;
static size_t in_len, in_cap;

static void emit(const char *line) {
  fputs(line, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

/* A string as JSON, quotes included; anything not printable ASCII becomes "?". */
static void json_string(char *dst, size_t len, const char *src) {
  size_t j = 0;
  if (len < 3) { if (len) dst[0] = 0; return; }
  dst[j++] = '"';
  for (size_t i = 0; src[i] && j < len - 3; i++) {
    char c = src[i];
    if (c == '"' || c == '\\') dst[j++] = '\\';
    dst[j++] = (c >= 0x20 && c < 0x7f) ? c : '?';
  }
  dst[j++] = '"';
  dst[j] = 0;
}

static void emit_error(const char *message) {
  char line[600], safe[520];
  json_string(safe, sizeof safe, message);
  snprintf(line, sizeof line, "{\"ev\":\"error\",\"message\":%s}", safe);
  emit(line);
}

/* {"ev":<ev>,"device":<path>[,"message":<message>]} */
static void emit_device(const char *ev, const char *path, const char *message) {
  char line[900], dev[300], msg[520];
  json_string(dev, sizeof dev, path);
  if (message) {
    json_string(msg, sizeof msg, message);
    snprintf(line, sizeof line, "{\"ev\":\"%s\",\"device\":%s,\"message\":%s}", ev, dev, msg);
  } else {
    snprintf(line, sizeof line, "{\"ev\":\"%s\",\"device\":%s}", ev, dev);
  }
  emit(line);
}

static void emit_ready(void) {
  char line[400];
  snprintf(line, sizeof line,
           "{\"ev\":\"ready\",\"output\":\"%s\",\"width\":%d,\"height\":%d,\"scale\":%d,\"transform\":%d,\"surface\":\"%s\"}",
           out.name, out.width, out.height, out.scale, out.transform, out.surface_kind);
  emit(line);
}

/* Larger than any screen; no frame the daemon sends comes near it. */
#define MAX_IMAGE_COORD 32767

static uint32_t u32_at(const unsigned char *p) {
  return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}

/* Work out where the canvas lands on the screen: as large as fits, centred. */
static void place_canvas(void) {
  int w, h, stride;
  platform_canvas(&w, &h, &stride);
  if (canvas_w == 0 || canvas_h == 0) {
    scale = 1.0;
    origin_x = origin_y = 0;
    return;
  }
  double sx = (double)w / canvas_w, sy = (double)h / canvas_h;
  scale = sx < sy ? sx : sy;
  origin_x = (int)((w - canvas_w * scale) / 2);
  origin_y = (int)((h - canvas_h * scale) / 2);
}

/* A channel at the deck's brightness. */
static inline unsigned dimmed(unsigned channel) {
  return brightness == 100 ? channel : channel * brightness / 100;
}

/* An alpha at the deck's brightness: the black laid over the deck adds its own. */
static inline unsigned veiled(unsigned alpha) {
  return brightness == 100 ? alpha : (alpha * brightness + 255 * (100 - brightness)) / 100;
}

static uint32_t argb(unsigned a, unsigned r, unsigned g, unsigned b) {
  return (uint32_t)a << 24 | (uint32_t)r << 16 | (uint32_t)g << 8 | b;
}

/* A premultiplied pixel at the deck's brightness: darker, and as opaque as the veil makes it. */
static uint32_t veil(uint32_t p) {
  if (brightness == 100) return p;
  return argb(veiled(p >> 24), dimmed((p >> 16) & 0xff), dimmed((p >> 8) & 0xff), dimmed(p & 0xff));
}

/* The background under a screen pixel, at the deck's brightness, premultiplied. */
static uint32_t ground_at(int x, int y, int sw, int sh) {
  if (!ground_px) return veil(ground);
  unsigned gx = (unsigned)((uint64_t)x * ground_w / (unsigned)sw), gy = (unsigned)((uint64_t)y * ground_h / (unsigned)sh);
  if (gx >= ground_w) gx = ground_w - 1;
  if (gy >= ground_h) gy = ground_h - 1;
  return veil(ground_px[(size_t)gy * ground_w + gx]);
}

/* Whether any of the background lets what is behind the screen through. */
static int ground_see_through(void) {
  return (ground >> 24) < 255;
}

/* A new background, replacing the last; its picture (or NULL) is now owned here. */
static void set_ground(uint32_t colour, uint32_t *picture, unsigned w, unsigned h) {
  free(ground_px);
  ground = colour;
  ground_px = picture;
  ground_w = picture ? w : 0;
  ground_h = picture ? h : 0;
  platform_translucent(ground_see_through());
}

static void fill_background(void) {
  int w, h, stride;
  uint32_t *px = platform_canvas(&w, &h, &stride);
  if (!px) return;
  if (!ground_px) {
    uint32_t fill = veil(ground);
    for (int y = 0; y < h; y++)
      for (int x = 0; x < w; x++) px[y * stride + x] = fill;
  } else {
    for (int y = 0; y < h; y++)
      for (int x = 0; x < w; x++) px[y * stride + x] = ground_at(x, y, w, h);
  }
  platform_damage(0, 0, w, h);
}

/* A 'G' frame's body: the colour, then the picture, straight alpha, made premultiplied. */
static int take_ground(const unsigned char *body, size_t len) {
  if (len < 12) { emit_error("bad background frame"); return 5; }
  unsigned a = body[3];
  uint32_t colour = argb(a, body[0] * a / 255, body[1] * a / 255, body[2] * a / 255);
  uint32_t w = u32_at(body + 4), h = u32_at(body + 8);
  if (w > MAX_IMAGE_COORD || h > MAX_IMAGE_COORD || (size_t)w * h * 4 != len - 12) { emit_error("bad background frame"); return 5; }
  uint32_t *picture = NULL;
  if (w > 0 && h > 0) {
    picture = malloc((size_t)w * h * 4);
    if (!picture) { emit_error("out of memory"); return 5; }
    const unsigned char *p = body + 12;
    for (size_t i = 0; i < (size_t)w * h; i++, p += 4) picture[i] = argb(p[3], p[0] * p[3] / 255, p[1] * p[3] / 255, p[2] * p[3] / 255);
  }
  set_ground(colour, picture, w, h);
  fill_background();
  return 0;
}

/* One key: RGBA, straight alpha, over the background. Scaled nearest-neighbour
 * when the canvas is not the screen's size.
 *
 * Its rectangle is put back to the background first, then the image blended
 * over it: what was there before never shows through. An image is
 * transparent wherever nothing is drawn — the corners around a round
 * control — and the daemon combines overlapping controls into one image
 * (src/drivers/panel-compose.ts), so blending over the old pixels would build
 * a shape's soft edge up over its own last one. An opaque image is the same
 * either way, and covers whatever the background lets through. */
static void draw_image(int x, int y, unsigned w, unsigned h, const unsigned char *rgba) {
  int sw, sh, stride;
  uint32_t *px = platform_canvas(&sw, &sh, &stride);
  if (!px) return;
  int x0 = origin_x + (int)(x * scale), y0 = origin_y + (int)(y * scale);
  int x1 = origin_x + (int)((x + (int)w) * scale), y1 = origin_y + (int)((y + (int)h) * scale);
  if (x0 < 0) x0 = 0;
  if (y0 < 0) y0 = 0;
  if (x1 > sw) x1 = sw;
  if (y1 > sh) y1 = sh;
  if (x1 <= x0 || y1 <= y0) return;
  for (int ty = y0; ty < y1; ty++) {
    int sy = (int)((ty - origin_y) / scale) - y;
    if (sy < 0) sy = 0;
    if (sy >= (int)h) sy = (int)h - 1;
    for (int tx = x0; tx < x1; tx++) {
      int sx = (int)((tx - origin_x) / scale) - x;
      if (sx < 0) sx = 0;
      if (sx >= (int)w) sx = (int)w - 1;
      const unsigned char *s = rgba + ((size_t)sy * w + (size_t)sx) * 4;
      uint32_t *d = &px[ty * stride + tx];
      unsigned a = s[3];
      if (a == 255) {
        *d = 0xff000000u | (uint32_t)dimmed(s[0]) << 16 | (uint32_t)dimmed(s[1]) << 8 | dimmed(s[2]);
        continue;
      }
      /* The background is already at this brightness, and premultiplied: the image over it. */
      uint32_t under = ground_at(tx, ty, sw, sh);
      if (a == 0) {
        *d = under;
        continue;
      }
      unsigned ua = under >> 24, ur = (under >> 16) & 0xff, ug = (under >> 8) & 0xff, ub = under & 0xff;
      unsigned r = (dimmed(s[0]) * a + ur * (255 - a)) / 255;
      unsigned g = (dimmed(s[1]) * a + ug * (255 - a)) / 255;
      unsigned b = (dimmed(s[2]) * a + ub * (255 - a)) / 255;
      *d = argb(a + ua * (255 - a) / 255, r, g, b);
    }
  }
  platform_damage(x0, y0, x1 - x0, y1 - y0);
}



/* ---- touch ---- */

/* 0 none, 1 a deck (grabbed, contacts reported), 2 pairing (not grabbed, the first touched named). */
static int touch_mode;
/* Per source: whether its contacts are reported ('t'), or it is a sibling only grabbed ('s'). */
static char touch_role[MAX_TOUCH_SOURCES];
static int touch_test_max;
static int tapped;

/* The contacts down (as reported: source × 100 + contact), and whether the daemon follows each ('M'). */
#define MAX_CONTACTS (MAX_TOUCH_SOURCES * 16)
static struct { int id; int followed; } contacts_down[MAX_CONTACTS];
static int contacts_down_n;

static int contact_slot(int id) {
  for (int i = 0; i < contacts_down_n; i++)
    if (contacts_down[i].id == id) return i;
  return -1;
}

/*
 * A point on the device, 0..1 in its own orientation, to the surface's
 * orientation: the inverse of the output's transform (wl_output: 1–3 rotated
 * 90, 180, 270 degrees counter-clockwise; 4–7 flipped around the vertical
 * axis, then rotated). Only transform 0 has been seen on a real touchscreen.
 */
static void untransform(double u, double v, double *lu, double *lv) {
  switch (out.transform) {
    case 1: *lu = 1 - v; *lv = u; break;
    case 2: *lu = 1 - u; *lv = 1 - v; break;
    case 3: *lu = v; *lv = 1 - u; break;
    case 4: *lu = 1 - u; *lv = v; break;
    case 5: *lu = v; *lv = u; break;
    case 6: *lu = u; *lv = 1 - v; break;
    case 7: *lu = 1 - v; *lv = 1 - u; break;
    default: *lu = u; *lv = v; break;
  }
}

static void on_contact(int source, int contact, int down, double u, double v) {
  if (touch_role[source] != 't') return;
  if (touch_mode == 2) {
    if (down && !tapped) {
      tapped = 1;
      emit_device("tap", touch_path(source), NULL);
    }
    return;
  }
  char line[200];
  /* Unique across sources: the daemon tracks contacts by this alone. */
  int id = source * 100 + contact;
  int at = contact_slot(id);
  if (!down) {
    if (at >= 0) contacts_down[at] = contacts_down[--contacts_down_n];
    snprintf(line, sizeof line, "{\"ev\":\"touch\",\"contact\":%d,\"edge\":\"up\"}", id);
    emit(line);
    return;
  }
  /* A move is reported only for a contact the daemon follows. */
  if (down == 2 && (at < 0 || !contacts_down[at].followed)) return;
  if (down == 1) {
    if (at < 0 && contacts_down_n < MAX_CONTACTS) at = contacts_down_n++;
    if (at >= 0) contacts_down[at].id = id, contacts_down[at].followed = 0;
  }
  double lu, lv;
  untransform(u, v, &lu, &lv);
  int w, h, stride;
  platform_canvas(&w, &h, &stride);
  double x = (lu * w - origin_x) / scale, y = (lv * h - origin_y) / scale;
  snprintf(line, sizeof line, "{\"ev\":\"touch\",\"contact\":%d,\"edge\":\"%s\",\"x\":%.1f,\"y\":%.1f}", id, down == 2 ? "move" : "down", x, y);
  emit(line);
}

/* A 'T' frame: close what was read, open what it names. */
static int set_touch(const unsigned char *body, size_t len) {
  if (len < 1 || body[0] > 2) { emit_error("bad touch frame"); return 5; }
  touch_close_all();
  contacts_down_n = 0;
  touch_mode = body[0];
  tapped = 0;
  size_t at = 1;
  while (at < len) {
    char role = (char)body[at++];
    const unsigned char *end = memchr(body + at, 0, len - at);
    if (!end || (role != 't' && role != 's')) { emit_error("bad touch frame"); return 5; }
    const char *path = (const char *)body + at;
    at = (size_t)(end - body) + 1;
    if (touch_mode == 0 || (touch_mode == 2 && role != 't')) continue;
    char err[400];
    int source = touch_open(path, touch_mode == 1, touch_test_max, err, sizeof err);
    if (source < 0) {
      emit_device("touch-failed", path, err);
      continue;
    }
    touch_role[source] = role;
    emit_device("touch-open", path, NULL);
  }
  return 0;
}

/* Handle every whole frame in the input buffer. Returns 0, -1 to quit, or an exit code. */
static int handle_frames(void) {
  size_t at = 0;
  int result = 0;
  while (in_len - at >= 5) {
    uint32_t len = u32_at(inbuf + at);
    if (len < 1 || len > MAX_FRAME) {
      emit_error("bad frame length");
      return 5;
    }
    if (in_len - at - 4 < len) break;
    const unsigned char *body = inbuf + at + 5;
    size_t body_len = len - 1;
    switch (inbuf[at + 4]) {
      case 'K':
        if (body_len != 11) { emit_error("bad canvas frame"); return 5; }
        canvas_w = u32_at(body);
        canvas_h = u32_at(body + 4);
        /* An opaque colour: the page's own background, if it has one, follows ('G'). */
        set_ground(0xff000000u | (uint32_t)body[8] << 16 | (uint32_t)body[9] << 8 | body[10], NULL, 0, 0);
        place_canvas();
        fill_background();
        break;
      case 'G': {
        int c = take_ground(body, body_len);
        if (c) return c;
        break;
      }
      case 'I': {
        if (body_len < 16) { emit_error("bad image frame"); return 5; }
        int x = (int)u32_at(body), y = (int)u32_at(body + 4);
        unsigned w = u32_at(body + 8), h = u32_at(body + 12);
        /* Before any arithmetic on them: within these, neither the size below
         * nor draw_image's coordinates can overflow. */
        if (w > MAX_IMAGE_COORD || h > MAX_IMAGE_COORD || x > MAX_IMAGE_COORD || x < -MAX_IMAGE_COORD || y > MAX_IMAGE_COORD || y < -MAX_IMAGE_COORD) {
          emit_error("bad image frame");
          return 5;
        }
        if ((size_t)w * h * 4 != body_len - 16) { emit_error("image size does not match its pixels"); return 5; }
        if (w > 0 && h > 0) draw_image(x, y, w, h, body + 16);
        emit("{\"ev\":\"drawn\"}");
        break;
      }
      case 'C':
        fill_background();
        break;
      case 'B':
        if (body_len != 1 || body[0] > 100) { emit_error("bad brightness frame"); return 5; }
        brightness = body[0];
        break;
      case 'T': {
        int c = set_touch(body, body_len);
        if (c) return c;
        break;
      }
      case 'M': {
        if (body_len != 4) { emit_error("bad follow frame"); return 5; }
        int at = contact_slot((int)u32_at(body));
        if (at >= 0) contacts_down[at].followed = 1;
        break;
      }
      case 'Q':
        result = -1;
        break;
      default:
        emit_error("unknown frame type");
        return 5;
    }
    at += 4 + len;
    if (result) break;
  }
  memmove(inbuf, inbuf + at, in_len - at);
  in_len -= at;
  return result;
}

/* Read what stdin has. Returns 0, 1 at end of input, or an exit code. */
static int read_input(void) {
  for (;;) {
    if (in_cap - in_len < 65536) {
      size_t cap = in_cap ? in_cap * 2 : 1 << 20;
      if (cap > MAX_FRAME + (1u << 20)) cap = MAX_FRAME + (1u << 20);
      if (cap <= in_cap) { emit_error("input frame too large"); return 5; }
      unsigned char *grown = realloc(inbuf, cap);
      if (!grown) { emit_error("out of memory"); return 5; }
      inbuf = grown;
      in_cap = cap;
    }
    ssize_t n = read(0, inbuf + in_len, in_cap - in_len);
    if (n > 0) {
      in_len += (size_t)n;
      continue;
    }
    if (n == 0) return 1;
    if (errno == EAGAIN || errno == EWOULDBLOCK) return 0;
    if (errno == EINTR) continue;
    return 1;
  }
}

/* The screen's buffer as a binary PPM (premultiplied colour, as shown), and
 * its alpha beside it as FILE.alpha, a binary PGM: 255 everywhere while the
 * background is opaque. */
static void write_dump(const char *path) {
  int w, h, stride;
  uint32_t *px = platform_canvas(&w, &h, &stride);
  if (!px) return;
  FILE *f = fopen(path, "wb");
  if (!f) return;
  fprintf(f, "P6\n%d %d\n255\n", w, h);
  for (int y = 0; y < h; y++)
    for (int x = 0; x < w; x++) {
      uint32_t p = px[y * stride + x];
      unsigned char rgb[3] = { (p >> 16) & 0xff, (p >> 8) & 0xff, p & 0xff };
      fwrite(rgb, 1, 3, f);
    }
  fclose(f);
  char alpha_path[4096];
  snprintf(alpha_path, sizeof alpha_path, "%s.alpha", path);
  f = fopen(alpha_path, "wb");
  if (!f) return;
  fprintf(f, "P5\n%d %d\n255\n", w, h);
  for (int y = 0; y < h; y++)
    for (int x = 0; x < w; x++) fputc(ground_see_through() ? (int)(px[y * stride + x] >> 24) : 255, f);
  fclose(f);
}

int main(int argc, char **argv) {
  const char *output = NULL, *dump = NULL;
  /* The idle mode shows nothing: idle.c has all of it. */
  if (argc > 1 && !strncmp(argv[1], "--idle", 6)) return idle_main(argc, argv);
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--output") && i + 1 < argc) output = argv[++i];
    else if (!strcmp(argv[i], "--dump") && i + 1 < argc) dump = argv[++i];
    else if (!strcmp(argv[i], "--touch-test-range") && i + 1 < argc) touch_test_max = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--version")) { puts("deckhand-panel 1"); return 0; }
    else { fprintf(stderr, "usage: deckhand-panel --output NAME [--dump FILE] [--touch-test-range MAX]\n"); return 2; }
  }
  if (!output) { fprintf(stderr, "usage: deckhand-panel --output NAME [--dump FILE] [--touch-test-range MAX]\n"); return 2; }

  signal(SIGPIPE, SIG_IGN);
  char err[256] = "";
  int code = platform_open(output, &out, err, sizeof err);
  if (code) {
    emit_error(err);
    return code;
  }
  fcntl(0, F_SETFL, fcntl(0, F_GETFL) | O_NONBLOCK);
  place_canvas();
  fill_background();
  platform_present();
  emit_ready();

  int exit_code = 0;
  for (;;) {
    platform_prepare();
    struct pollfd fds[2 + MAX_TOUCH_SOURCES] = { { .fd = 0, .events = POLLIN }, { .fd = platform_fd(), .events = POLLIN } };
    for (int i = 0; i < MAX_TOUCH_SOURCES; i++) fds[2 + i] = (struct pollfd){ .fd = touch_fd(i), .events = POLLIN };
    if (poll(fds, 2 + MAX_TOUCH_SOURCES, -1) < 0) {
      if (errno == EINTR) continue;
      exit_code = 4;
      break;
    }
    if (fds[1].revents) {
      int resized = 0, lost = 0;
      int c = platform_dispatch(&resized, &lost);
      if (c) { exit_code = c; emit_error(c == 3 ? "the compositor would not show the panel" : "lost the windowing system"); break; }
      if (lost) emit("{\"ev\":\"output-lost\"}");
      if (resized) {
        place_canvas();
        fill_background();
        emit_ready();
      }
    }
    for (int i = 0; i < MAX_TOUCH_SOURCES; i++) {
      if (fds[2 + i].fd < 0 || !fds[2 + i].revents) continue;
      char path[256];
      snprintf(path, sizeof path, "%s", touch_path(i));
      if (touch_read(i, on_contact) < 0) emit_device("touch-gone", path, NULL);
    }
    if (fds[0].revents) {
      int r = read_input();
      int handled = handle_frames();
      if (handled == -1) break;
      if (handled > 0) { exit_code = handled; break; }
      if (r == 1) break;
      if (r > 1) { exit_code = r; break; }
    }
    platform_present();
  }
  if (dump) write_dump(dump);
  touch_close_all();
  platform_close();
  return exit_code;
}
