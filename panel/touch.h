/*
 * What deckhand-panel's core needs from a source of touches: a device opened
 * (and on Linux grabbed, so the desktop never sees its touches), and each
 * contact as it goes down and comes up, in the device's own coordinates
 * scaled to 0..1. evdev.c implements it for Linux; a Windows or macOS file
 * would implement the same functions, and panel.c would not change.
 */
#ifndef DECKHAND_PANEL_TOUCH_H
#define DECKHAND_PANEL_TOUCH_H

#include <stddef.h>

#define MAX_TOUCH_SOURCES 8

/* A contact went down (down = 1, at u, v: 0..1 across and down the device)
 * or came up (down = 0; u and v are 0). contact is unique within its source. */
typedef void (*touch_contact_fn)(int source, int contact, int down, double u, double v);

/* Open a device. grab: take it for this process alone (EVIOCGRAB).
 * test_max: when > 0, a path that is not an input device (a FIFO of recorded
 * events, for the tests) is read with both axes 0..test_max; otherwise it is
 * refused. Returns the source's index, or -1 with the reason in err. */
int touch_open(const char *path, int grab, int test_max, char *err, size_t errlen);

/* The fd to poll, or -1 once the source is closed. */
int touch_fd(int source);

const char *touch_path(int source);

/* Read what the source has, calling fn for each contact down or up. Returns
 * 0, or -1 when the device went away: every contact still down is reported up
 * first, and the source is closed. */
int touch_read(int source, touch_contact_fn fn);

/* Close every source; a grab ends when its fd closes. */
void touch_close_all(void);

#endif
