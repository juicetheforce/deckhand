/*
 * deckhand-panel on Wayland (platform.h).
 *
 * The surface is a layer-shell surface on the overlay layer, anchored to every
 * edge of the chosen output, with keyboard interactivity "none": it never
 * takes the keyboard (confirmed by the stage 0 probe on KWin). Where the
 * compositor has no layer-shell (GNOME), a fullscreen xdg_toplevel on that
 * output instead — it takes focus once, when it appears.
 *
 * The output is found by the name xdg-output gives it, which every compositor
 * Deckhand has met sets to the DRM connector's ("DP-4"). Only
 * libwayland-client is linked; the protocols' code is generated and committed
 * (protocol/).
 *
 * Buffers: two shared-memory buffers the size of the surface in pixels. The
 * canvas is drawn in memory of its own; presenting copies it into a buffer the
 * compositor has let go of, and commits only when the last frame was shown.
 *
 * The output can go away while its screen is still plugged in: KWin removes
 * a screen's output when it wakes from power saving, and adds it back a
 * moment later. So losing the output does not end the helper: the surface is
 * taken down, the canvas kept, and the surface made again when an output of
 * the same name is announced — an event, no timer. Whether the screen is
 * still plugged in is the daemon's to judge, from the kernel; it quits this
 * helper when it is not.
 */

#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
#include <wayland-client.h>

#include "platform.h"
#include "protocol/wlr-layer-shell-unstable-v1-client.h"
#include "protocol/xdg-output-unstable-v1-client.h"
#include "protocol/xdg-shell-client.h"

#define MAX_OUTPUTS 16

struct output {
  struct wl_output *wl;
  struct zxdg_output_v1 *xdg;
  uint32_t global;
  char name[64];
  int scale;
  int transform;
};

struct buffer {
  struct wl_buffer *wl;
  uint32_t *pixels;
  size_t size;
  int busy;
};

static struct wl_display *display;
static struct wl_registry *registry;
static struct wl_compositor *compositor;
static uint32_t compositor_version;
static struct wl_shm *shm;
static struct zwlr_layer_shell_v1 *layer_shell;
static struct xdg_wm_base *wm_base;
static struct zxdg_output_manager_v1 *output_manager;
/* A slot is free when wl is NULL: outputs come and go with every wake. */
static struct output outputs[MAX_OUTPUTS];
static struct output *target;
static char target_name[64];
/* The output went away; waiting for one of the same name. */
static int waiting;
static struct output *announced;
/* The compositor closed the surface while the output stayed: made again, a few times. */
static int reopened;

static struct wl_surface *surface;
static struct zwlr_layer_surface_v1 *layer_surface;
static struct xdg_surface *xdg_surface;
static struct xdg_toplevel *toplevel;

static int logical_w, logical_h;
static int configured, size_changed, closed_by_compositor, target_removed, surface_new;
static struct buffer buffers[2];
static uint32_t *canvas;
static int canvas_w, canvas_h;
static int damage_x0, damage_y0, damage_x1, damage_y1, damaged;
static struct wl_callback *frame_pending;

/* ---- outputs ---- */

static void output_geometry(void *data, struct wl_output *o, int32_t x, int32_t y, int32_t pw, int32_t ph, int32_t subpixel,
                            const char *make, const char *model, int32_t transform) {
  (void)o; (void)x; (void)y; (void)pw; (void)ph; (void)subpixel; (void)make; (void)model;
  ((struct output *)data)->transform = transform;
}
static void output_mode(void *data, struct wl_output *o, uint32_t flags, int32_t w, int32_t h, int32_t refresh) {
  (void)data; (void)o; (void)flags; (void)w; (void)h; (void)refresh;
}
static void output_done(void *data, struct wl_output *o) { (void)data; (void)o; }
static void output_scale(void *data, struct wl_output *o, int32_t factor) {
  (void)o;
  ((struct output *)data)->scale = factor > 0 ? factor : 1;
}
/* Designated, so headers with or without wl_output's later events (name, description) build alike. */
static const struct wl_output_listener output_listener = { .geometry = output_geometry, .mode = output_mode, .done = output_done, .scale = output_scale };

static void xdg_output_position(void *data, struct zxdg_output_v1 *x, int32_t a, int32_t b) { (void)data; (void)x; (void)a; (void)b; }
static void xdg_output_size(void *data, struct zxdg_output_v1 *x, int32_t a, int32_t b) { (void)data; (void)x; (void)a; (void)b; }
static void xdg_output_done(void *data, struct zxdg_output_v1 *x) { (void)data; (void)x; }
static void xdg_output_name(void *data, struct zxdg_output_v1 *x, const char *name) {
  (void)x;
  struct output *o = data;
  snprintf(o->name, sizeof o->name, "%s", name);
  if (waiting && !strcmp(o->name, target_name)) announced = o;
}
static void xdg_output_description(void *data, struct zxdg_output_v1 *x, const char *d) { (void)data; (void)x; (void)d; }
static const struct zxdg_output_v1_listener xdg_output_listener = {
  xdg_output_position, xdg_output_size, xdg_output_done, xdg_output_name, xdg_output_description,
};

/* ---- registry ---- */

static uint32_t min_u32(uint32_t a, uint32_t b) { return a < b ? a : b; }

static void registry_global(void *data, struct wl_registry *r, uint32_t name, const char *interface, uint32_t version) {
  (void)data;
  if (!strcmp(interface, wl_compositor_interface.name)) {
    compositor_version = min_u32(version, 4);
    compositor = wl_registry_bind(r, name, &wl_compositor_interface, compositor_version);
  } else if (!strcmp(interface, wl_shm_interface.name)) {
    shm = wl_registry_bind(r, name, &wl_shm_interface, 1);
  } else if (!strcmp(interface, zwlr_layer_shell_v1_interface.name)) {
    layer_shell = wl_registry_bind(r, name, &zwlr_layer_shell_v1_interface, min_u32(version, 4));
  } else if (!strcmp(interface, xdg_wm_base_interface.name)) {
    wm_base = wl_registry_bind(r, name, &xdg_wm_base_interface, 1);
  } else if (!strcmp(interface, zxdg_output_manager_v1_interface.name)) {
    output_manager = wl_registry_bind(r, name, &zxdg_output_manager_v1_interface, min_u32(version, 3));
  } else if (!strcmp(interface, wl_output_interface.name)) {
    struct output *o = NULL;
    for (int i = 0; i < MAX_OUTPUTS && !o; i++)
      if (!outputs[i].wl) o = &outputs[i];
    if (!o) return;
    o->global = name;
    o->scale = 1;
    o->name[0] = 0;
    o->wl = wl_registry_bind(r, name, &wl_output_interface, min_u32(version, 2));
    wl_output_add_listener(o->wl, &output_listener, o);
    /* After start-up, its name is asked for at once (at start-up, platform_open asks for all). */
    if (output_manager && target_name[0]) {
      o->xdg = zxdg_output_manager_v1_get_xdg_output(output_manager, o->wl);
      zxdg_output_v1_add_listener(o->xdg, &xdg_output_listener, o);
    }
  }
}

static void registry_global_remove(void *data, struct wl_registry *r, uint32_t name) {
  (void)data; (void)r;
  for (int i = 0; i < MAX_OUTPUTS; i++) {
    struct output *o = &outputs[i];
    if (!o->wl || o->global != name) continue;
    if (o == target) {
      target_removed = 1;
      target = NULL;
    }
    if (o == announced) announced = NULL;
    if (o->xdg) zxdg_output_v1_destroy(o->xdg);
    wl_output_destroy(o->wl);
    memset(o, 0, sizeof *o);
  }
}
static const struct wl_registry_listener registry_listener = { registry_global, registry_global_remove };

/* ---- surfaces ---- */

static void layer_configure(void *data, struct zwlr_layer_surface_v1 *s, uint32_t serial, uint32_t w, uint32_t h) {
  (void)data;
  zwlr_layer_surface_v1_ack_configure(s, serial);
  if ((int)w != logical_w || (int)h != logical_h) size_changed = 1;
  logical_w = (int)w;
  logical_h = (int)h;
  configured = 1;
}
static void layer_closed(void *data, struct zwlr_layer_surface_v1 *s) {
  (void)data; (void)s;
  closed_by_compositor = 1;
}
static const struct zwlr_layer_surface_v1_listener layer_listener = { layer_configure, layer_closed };

static void wm_ping(void *data, struct xdg_wm_base *b, uint32_t serial) {
  (void)data;
  xdg_wm_base_pong(b, serial);
}
static const struct xdg_wm_base_listener wm_listener = { wm_ping };

static int pending_w, pending_h;
static void toplevel_configure(void *data, struct xdg_toplevel *t, int32_t w, int32_t h, struct wl_array *states) {
  (void)data; (void)t; (void)states;
  pending_w = w;
  pending_h = h;
}
static void toplevel_close(void *data, struct xdg_toplevel *t) {
  (void)data; (void)t;
  closed_by_compositor = 1;
}
static const struct xdg_toplevel_listener toplevel_listener = { .configure = toplevel_configure, .close = toplevel_close };

static void xdg_surface_configure(void *data, struct xdg_surface *s, uint32_t serial) {
  (void)data;
  xdg_surface_ack_configure(s, serial);
  if (pending_w > 0 && pending_h > 0) {
    if (pending_w != logical_w || pending_h != logical_h) size_changed = 1;
    logical_w = pending_w;
    logical_h = pending_h;
    configured = 1;
  }
}
static const struct xdg_surface_listener xdg_surface_listener = { xdg_surface_configure };

/* ---- buffers ---- */

static void buffer_release(void *data, struct wl_buffer *b) {
  (void)b;
  ((struct buffer *)data)->busy = 0;
}
static const struct wl_buffer_listener buffer_listener = { buffer_release };

static void free_shm_buffers(void) {
  for (int i = 0; i < 2; i++) {
    if (buffers[i].wl) wl_buffer_destroy(buffers[i].wl);
    if (buffers[i].pixels) munmap(buffers[i].pixels, buffers[i].size);
    memset(&buffers[i], 0, sizeof buffers[i]);
  }
}

static void free_buffers(void) {
  free_shm_buffers();
  free(canvas);
  canvas = NULL;
}

static int make_buffers(int w, int h, char *err, size_t errlen) {
  free_buffers();
  size_t stride = (size_t)w * 4, size = stride * (size_t)h;
  canvas = calloc((size_t)w * h, 4);
  if (!canvas) { snprintf(err, errlen, "out of memory"); return 5; }
  canvas_w = w;
  canvas_h = h;
  for (int i = 0; i < 2; i++) {
    int fd = memfd_create("deckhand-panel", MFD_CLOEXEC);
    if (fd < 0 || ftruncate(fd, (off_t)size) < 0) {
      snprintf(err, errlen, "cannot make a shared-memory buffer: %s", strerror(errno));
      if (fd >= 0) close(fd);
      return 4;
    }
    void *px = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (px == MAP_FAILED) { close(fd); snprintf(err, errlen, "cannot map a buffer"); return 4; }
    struct wl_shm_pool *pool = wl_shm_create_pool(shm, fd, (int32_t)size);
    buffers[i].wl = wl_shm_pool_create_buffer(pool, 0, w, h, (int32_t)stride, WL_SHM_FORMAT_XRGB8888);
    wl_buffer_add_listener(buffers[i].wl, &buffer_listener, &buffers[i]);
    wl_shm_pool_destroy(pool);
    close(fd);
    buffers[i].pixels = px;
    buffers[i].size = size;
  }
  return 0;
}

static int fit_surface(struct panel_output *info, char *err, size_t errlen) {
  int scale = target->scale > 0 ? target->scale : 1;
  info->scale = scale;
  info->transform = target->transform;
  info->width = logical_w * scale;
  info->height = logical_h * scale;
  if (compositor_version >= 3) wl_surface_set_buffer_scale(surface, scale);
  return make_buffers(info->width, info->height, err, errlen);
}

/* ---- platform.h ---- */

static struct panel_output *current;
static void make_surface(struct panel_output *info);

int platform_open(const char *name, struct panel_output *info, char *err, size_t errlen) {
  display = wl_display_connect(NULL);
  if (!display) { snprintf(err, errlen, "no Wayland display"); return 4; }
  registry = wl_display_get_registry(display);
  wl_registry_add_listener(registry, &registry_listener, NULL);
  wl_display_roundtrip(display);
  if (!compositor || !shm) { snprintf(err, errlen, "the compositor lacks wl_compositor or wl_shm"); return 4; }
  if (!output_manager) { snprintf(err, errlen, "the compositor has no xdg-output, so outputs cannot be found by name"); return 4; }
  snprintf(target_name, sizeof target_name, "%s", name);
  for (int i = 0; i < MAX_OUTPUTS; i++) {
    if (!outputs[i].wl) continue;
    outputs[i].xdg = zxdg_output_manager_v1_get_xdg_output(output_manager, outputs[i].wl);
    zxdg_output_v1_add_listener(outputs[i].xdg, &xdg_output_listener, &outputs[i]);
  }
  wl_display_roundtrip(display);
  for (int i = 0; i < MAX_OUTPUTS; i++)
    if (outputs[i].wl && !strcmp(outputs[i].name, name)) target = &outputs[i];
  if (!target) { snprintf(err, errlen, "no output named %s", name); return 2; }

  if (!layer_shell && !wm_base) { snprintf(err, errlen, "the compositor has neither layer-shell nor xdg-shell"); return 4; }
  if (wm_base) xdg_wm_base_add_listener(wm_base, &wm_listener, NULL);
  make_surface(info);
  while (!configured && !closed_by_compositor) {
    if (wl_display_dispatch(display) < 0) { snprintf(err, errlen, "lost the Wayland connection"); return 4; }
  }
  if (closed_by_compositor || logical_w <= 0 || logical_h <= 0) { snprintf(err, errlen, "the compositor would not show the surface"); return 3; }
  size_changed = 0;
  surface_new = 0;
  snprintf(info->name, sizeof info->name, "%s", name);
  current = info;
  return fit_surface(info, err, errlen);
}

/* The surface on the target output, committed with no buffer: its size comes
 * with the compositor's configure. */
static void make_surface(struct panel_output *info) {
  configured = 0;
  surface_new = 1;
  surface = wl_compositor_create_surface(compositor);
  if (layer_shell) {
    layer_surface = zwlr_layer_shell_v1_get_layer_surface(layer_shell, surface, target->wl, ZWLR_LAYER_SHELL_V1_LAYER_OVERLAY, "deckhand-panel");
    zwlr_layer_surface_v1_add_listener(layer_surface, &layer_listener, NULL);
    zwlr_layer_surface_v1_set_anchor(layer_surface, ZWLR_LAYER_SURFACE_V1_ANCHOR_TOP | ZWLR_LAYER_SURFACE_V1_ANCHOR_BOTTOM |
                                                        ZWLR_LAYER_SURFACE_V1_ANCHOR_LEFT | ZWLR_LAYER_SURFACE_V1_ANCHOR_RIGHT);
    zwlr_layer_surface_v1_set_exclusive_zone(layer_surface, -1);
    zwlr_layer_surface_v1_set_keyboard_interactivity(layer_surface, ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_NONE);
    zwlr_layer_surface_v1_set_size(layer_surface, 0, 0);
    info->surface_kind = "layer-shell";
  } else {
    xdg_surface = xdg_wm_base_get_xdg_surface(wm_base, surface);
    xdg_surface_add_listener(xdg_surface, &xdg_surface_listener, NULL);
    toplevel = xdg_surface_get_toplevel(xdg_surface);
    xdg_toplevel_add_listener(toplevel, &toplevel_listener, NULL);
    xdg_toplevel_set_title(toplevel, "Deckhand panel");
    xdg_toplevel_set_app_id(toplevel, "io.github.juicetheforce.Deckhand.panel");
    xdg_toplevel_set_fullscreen(toplevel, target->wl);
    info->surface_kind = "fullscreen-window";
  }
  wl_surface_commit(surface);
}

/* Takes the surface down; the canvas stays, so drawing goes on meanwhile. */
static void drop_surface(void) {
  if (frame_pending) wl_callback_destroy(frame_pending);
  frame_pending = NULL;
  free_shm_buffers();
  if (layer_surface) zwlr_layer_surface_v1_destroy(layer_surface);
  if (toplevel) xdg_toplevel_destroy(toplevel);
  if (xdg_surface) xdg_surface_destroy(xdg_surface);
  if (surface) wl_surface_destroy(surface);
  layer_surface = NULL;
  toplevel = NULL;
  xdg_surface = NULL;
  surface = NULL;
  configured = 0;
  surface_new = 0;
}

int platform_fd(void) { return wl_display_get_fd(display); }

void platform_prepare(void) { wl_display_flush(display); }

int platform_dispatch(int *resized, int *lost) {
  if (wl_display_dispatch(display) < 0) return 4;
  if (target_removed) {
    /* The output went away: wait for it to be announced again. */
    target_removed = closed_by_compositor = 0;
    drop_surface();
    reopened = 0;
    waiting = 1;
    *lost = 1;
  } else if (closed_by_compositor) {
    /* Closed with the output still there: made again, but not forever. */
    closed_by_compositor = 0;
    drop_surface();
    if (++reopened > 3) return 3;
    make_surface(current);
  }
  if (waiting && announced) {
    target = announced;
    announced = NULL;
    waiting = 0;
    make_surface(current);
  }
  if (surface_new && configured) {
    char err[128];
    surface_new = 0;
    size_changed = 0;
    if (logical_w <= 0 || logical_h <= 0) return 3;
    if (fit_surface(current, err, sizeof err)) return 4;
    *resized = 1;
    return 0;
  }
  if (size_changed && surface) {
    char err[128];
    size_changed = 0;
    if (fit_surface(current, err, sizeof err)) return 4;
    *resized = 1;
  }
  return 0;
}

uint32_t *platform_canvas(int *width, int *height, int *stride) {
  *width = canvas_w;
  *height = canvas_h;
  *stride = canvas_w;
  return canvas;
}

void platform_damage(int x, int y, int w, int h) {
  if (w <= 0 || h <= 0) return;
  if (!damaged) {
    damage_x0 = x; damage_y0 = y; damage_x1 = x + w; damage_y1 = y + h;
    damaged = 1;
    return;
  }
  if (x < damage_x0) damage_x0 = x;
  if (y < damage_y0) damage_y0 = y;
  if (x + w > damage_x1) damage_x1 = x + w;
  if (y + h > damage_y1) damage_y1 = y + h;
}

static void frame_done(void *data, struct wl_callback *cb, uint32_t time) {
  (void)data; (void)time;
  wl_callback_destroy(cb);
  frame_pending = NULL;
  platform_present();
}
static const struct wl_callback_listener frame_listener = { frame_done };

void platform_present(void) {
  if (!damaged || frame_pending || !surface || surface_new) return;
  struct buffer *b = !buffers[0].busy ? &buffers[0] : !buffers[1].busy ? &buffers[1] : NULL;
  if (!b) return; /* shown when a buffer comes back: its release is an event, and dispatch presents again */
  memcpy(b->pixels, canvas, b->size);
  wl_surface_attach(surface, b->wl, 0, 0);
  if (compositor_version >= 4)
    wl_surface_damage_buffer(surface, damage_x0, damage_y0, damage_x1 - damage_x0, damage_y1 - damage_y0);
  else
    wl_surface_damage(surface, 0, 0, INT32_MAX, INT32_MAX);
  frame_pending = wl_surface_frame(surface);
  wl_callback_add_listener(frame_pending, &frame_listener, NULL);
  wl_surface_commit(surface);
  b->busy = 1;
  damaged = 0;
}

void platform_close(void) {
  free_buffers();
  if (layer_surface) zwlr_layer_surface_v1_destroy(layer_surface);
  if (toplevel) xdg_toplevel_destroy(toplevel);
  if (xdg_surface) xdg_surface_destroy(xdg_surface);
  if (surface) wl_surface_destroy(surface);
  if (display) {
    wl_display_flush(display);
    wl_display_disconnect(display);
  }
}
