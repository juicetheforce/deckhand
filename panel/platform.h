/*
 * What deckhand-panel's core needs from a windowing system: one fullscreen
 * surface on a named output, a pixel buffer to draw into, and a way to show
 * what changed. wayland.c implements it; an X11, Windows or macOS file would
 * implement the same few functions, and panel.c would not change.
 */
#ifndef DECKHAND_PANEL_PLATFORM_H
#define DECKHAND_PANEL_PLATFORM_H

#include <stddef.h>
#include <stdint.h>

struct panel_output {
  char name[64];
  /* The surface's size in buffer pixels: logical size × scale. */
  int width, height;
  int scale;
  /* wl_output's transform: 0 normal, 1–3 rotated 90/180/270, 4–7 flipped. */
  int transform;
  /* "layer-shell" or "fullscreen-window". */
  const char *surface_kind;
};

/* Connect, find the output by name, map a fullscreen surface on it and wait
 * for its size. 0 on success; otherwise an exit code (see panel.c) with the
 * reason in err. */
int platform_open(const char *output, struct panel_output *info, char *err, size_t errlen);

/* The fd to poll for the windowing system's events. */
int platform_fd(void);

/* Read and handle pending events. Returns 0, or an exit code when the
 * surface cannot be shown (3) or the connection was lost (4). Sets *resized
 * when the surface's size changed, or it was shown again: the canvas is then
 * new and blank. Sets *lost when the output went away: nothing is shown until
 * an output of the same name comes back, and *resized says when it has. */
int platform_dispatch(int *resized, int *lost);

/* Flush outgoing requests; call before poll(). */
void platform_prepare(void);

/* The pixel buffer to draw into, 0xAARRGGBB with alpha ignored (XRGB8888),
 * width × height, stride in pixels. Valid until the next resize. */
uint32_t *platform_canvas(int *width, int *height, int *stride);

/* Mark a rectangle as changed. Shown by the next platform_present(). */
void platform_damage(int x, int y, int w, int h);

/* Show what changed, if the compositor is ready for a frame; otherwise it is
 * shown when it is. */
void platform_present(void);

void platform_close(void);

#endif
