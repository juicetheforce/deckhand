# Wayland protocols

The XML files are copied unchanged from upstream; the `.c` and `-client.h`
files are generated from them by `wayland-scanner` 1.26.0 (`make protocols`
in `panel/`), and committed so that building deckhand-panel needs only
libwayland-client.

| File | From | sha256 |
| --- | --- | --- |
| `xdg-shell.xml` | wayland-protocols 1.45, `stable/xdg-shell/` | `9d9e27038ca722f159a361293f8c6cd270dab907ab52de5b8ecfbb8d6b9651c2` |
| `xdg-output-unstable-v1.xml` | wayland-protocols 1.45, `unstable/xdg-output/` | `363d547c3eefe8959160cac903ff90b311d4b183005557d73640d9df2cfd7f79` |
| `wlr-layer-shell-unstable-v1.xml` | wlr-protocols, `unstable/` (fetched 2026-10-16) | `87e0b9c837aecd6977f76f3c47d73088b7159871f5d979dc1840f6cadb5e2ed8` |

Each carries its own licence in its `<copyright>` block, repeated in the
generated files.
