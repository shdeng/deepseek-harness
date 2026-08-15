# @deepseek-ai/dsh-host-directory-picker-desktop

English | [中文](README.zh.md)

Desktop Provider for the [`ctx.directoryPicker`](../directory-picker/README.md) capability seam. It is both a Consumer of `ctx.desktopNative.pickDirectory()` and the Provider of the seam's stable `{ kind: 'native', pick(signal) }` capability. The Desktop profile mounts this package together with the existing native client flow, so workspace selection still travels through `host.pickDirectory`; no WebView picker command remains.

## Model Experience

None, as this package only adapts operator directory selection.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- The product currently consumes a single-directory chooser. A file chooser should be added only with its own Service Definition and Consumer vocabulary.
