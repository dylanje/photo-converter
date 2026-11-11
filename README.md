# Photo Converter

A fast, beautiful photo format converter for Windows. Drop in photos, pick a format, done.

- **Private.** Everything runs on your machine. No accounts, no tracking, no telemetry.
- **Offline.** There is no networking code in the app, and its content security policy blocks outside connections.
- **Open source.** MIT licensed.
- **Small.** Built with [Tauri](https://tauri.app) and Rust, not a bundled browser.

The only "statistics" are a counter of how many photos you have converted, stored locally on your device and shown in the footer. It is never sent anywhere.

## Formats

| | Read | Write | Notes |
|---|---|---|---|
| JPG | yes | yes | Quality slider. Transparency is flattened onto white. |
| PNG | yes | yes | Lossless. |
| WebP | yes | yes | Written lossless for now. |
| AVIF | no | yes | Quality slider. Reading AVIF is planned. |
| GIF | yes | yes | Single frame, 256 colors. |
| BMP | yes | yes | |
| TIFF | yes | yes | |
| HEIC | no | no | Planned (needs libheif). |

Photos are rotated according to their EXIF orientation. Color profiles are kept in JPG, PNG, WebP and TIFF where the encoder allows; for formats that cannot hold one (BMP, GIF, AVIF) the pixels are converted to sRGB so colors look the same. All other metadata is dropped, so location data in the original is not copied. Converted files are never saved over existing ones; a name like `photo (1).png` is used instead.

## Develop

Requirements on Windows: [Node.js](https://nodejs.org), [Rust](https://rustup.rs), Visual Studio C++ Build Tools, and WebView2 (preinstalled on Windows 10/11).

```
npm install
npm run dev      # run the app
npm run build    # produce the installer in src-tauri/target/release/bundle/nsis
cargo test --manifest-path src-tauri/Cargo.toml
```

The UI is plain HTML, CSS and JS in `src/` (no bundler). The conversion code is in `src-tauri/src/lib.rs`.

## Roadmap

- HEIC and AVIF input
- Lossy WebP with a quality slider
- Resize and strip-metadata options
- Folder drop and batch rename
