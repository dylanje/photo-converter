//! Photo Converter backend.
//!
//! Everything happens locally. This crate has no networking code and the app's
//! capability file grants no network, shell or filesystem-wide permissions.

use image::{
    codecs::{avif::AvifEncoder, jpeg::JpegEncoder, png::PngEncoder, tiff::TiffEncoder, webp::WebPEncoder},
    DynamicImage, ImageDecoder, ImageEncoder, ImageFormat, ImageReader, Rgb, RgbImage, RgbaImage,
};
use moxcms::{ColorProfile, Layout, TransformExecutor, TransformOptions};
use serde::Deserialize;
use std::{
    borrow::Cow,
    fs::File,
    io::{BufWriter, Write},
    path::{Path, PathBuf},
};

#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Target {
    Jpeg,
    Png,
    Webp,
    Avif,
    Bmp,
    Tiff,
    Gif,
}

impl Target {
    fn extension(self) -> &'static str {
        match self {
            Target::Jpeg => "jpg",
            Target::Png => "png",
            Target::Webp => "webp",
            Target::Avif => "avif",
            Target::Bmp => "bmp",
            Target::Tiff => "tiff",
            Target::Gif => "gif",
        }
    }
}

/// A decoded image plus its embedded ICC color profile, if it has one.
struct Loaded {
    img: DynamicImage,
    icc: Option<Vec<u8>>,
}

/// Decode an image and apply its EXIF orientation so photos are not rotated
/// after conversion. The ICC profile is kept so colors can be preserved.
/// All other metadata (EXIF, GPS) is dropped, which is the privacy-friendly default.
fn load(path: &Path) -> Result<Loaded, String> {
    let reader = ImageReader::open(path)
        .map_err(|e| format!("Can't open file: {e}"))?
        .with_guessed_format()
        .map_err(|e| format!("Can't read file: {e}"))?;
    let mut decoder = reader
        .into_decoder()
        .map_err(|e| format!("Unsupported or damaged image: {e}"))?;
    let orientation = decoder.orientation().map_err(|e| e.to_string())?;
    let icc = decoder.icc_profile().ok().flatten();
    let mut img = DynamicImage::from_decoder(decoder)
        .map_err(|e| format!("Unsupported or damaged image: {e}"))?;
    img.apply_orientation(orientation);
    Ok(Loaded { img, icc })
}

/// Convert pixels from the image's embedded profile to sRGB.
/// Returns `None` when there is nothing to do or the profile can't be used
/// (for example a grayscale or CMYK profile), in which case the pixels are left as they are.
fn to_srgb(img: &DynamicImage, icc: &[u8]) -> Option<DynamicImage> {
    let src = ColorProfile::new_from_slice(icc).ok()?;
    let dst = ColorProfile::new_srgb();
    let (w, h) = (img.width(), img.height());
    if img.color().has_alpha() {
        let rgba = img.to_rgba8();
        let t = src
            .create_transform_8bit(Layout::Rgba, &dst, Layout::Rgba, TransformOptions::default())
            .ok()?;
        let mut out = vec![0u8; rgba.as_raw().len()];
        t.transform(rgba.as_raw(), &mut out).ok()?;
        RgbaImage::from_raw(w, h, out).map(DynamicImage::ImageRgba8)
    } else {
        let rgb = img.to_rgb8();
        let t = src
            .create_transform_8bit(Layout::Rgb, &dst, Layout::Rgb, TransformOptions::default())
            .ok()?;
        let mut out = vec![0u8; rgb.as_raw().len()];
        t.transform(rgb.as_raw(), &mut out).ok()?;
        RgbImage::from_raw(w, h, out).map(DynamicImage::ImageRgb8)
    }
}

/// For formats that cannot hold a profile: 8-bit pixels converted to sRGB.
fn srgb_8bit(img: &DynamicImage, icc: Option<&[u8]>) -> DynamicImage {
    let base = to_8bit(img);
    match icc.and_then(|p| to_srgb(&base, p)) {
        Some(converted) => converted,
        None => base,
    }
}

/// Try to embed the profile in the output. If the encoder can't carry one,
/// convert the pixels to sRGB instead, so colors look the same either way.
fn prepare<'a, E: ImageEncoder>(
    enc: &mut E,
    img: &'a DynamicImage,
    icc: Option<&[u8]>,
) -> Cow<'a, DynamicImage> {
    match icc {
        None => Cow::Borrowed(img),
        Some(p) => {
            if enc.set_icc_profile(p.to_vec()).is_ok() {
                Cow::Borrowed(img)
            } else {
                match to_srgb(img, p) {
                    Some(converted) => Cow::Owned(converted),
                    None => Cow::Borrowed(img),
                }
            }
        }
    }
}

/// JPEG has no transparency, so composite onto white instead of black.
fn flatten_on_white(img: &DynamicImage) -> RgbImage {
    let rgba = img.to_rgba8();
    let mut out = RgbImage::new(rgba.width(), rgba.height());
    for (x, y, p) in rgba.enumerate_pixels() {
        let a = p[3] as u32;
        let blend = |c: u8| -> u8 { ((c as u32 * a + 255 * (255 - a) + 127) / 255) as u8 };
        out.put_pixel(x, y, Rgb([blend(p[0]), blend(p[1]), blend(p[2])]));
    }
    out
}

/// 8-bit RGB or RGBA, whichever keeps the image's transparency.
fn to_8bit(img: &DynamicImage) -> DynamicImage {
    if img.color().has_alpha() {
        DynamicImage::ImageRgba8(img.to_rgba8())
    } else {
        DynamicImage::ImageRgb8(img.to_rgb8())
    }
}

fn encode(
    img: &DynamicImage,
    icc: Option<&[u8]>,
    target: Target,
    quality: u8,
    out: &Path,
) -> Result<(), String> {
    let file = File::create(out).map_err(|e| format!("Can't create output file: {e}"))?;
    let mut w = BufWriter::new(file);

    let result = match target {
        Target::Jpeg => {
            let rgb = DynamicImage::ImageRgb8(flatten_on_white(img));
            let mut enc = JpegEncoder::new_with_quality(&mut w, quality);
            let data = prepare(&mut enc, &rgb, icc);
            data.write_with_encoder(enc)
        }
        Target::Png => {
            let mut enc = PngEncoder::new(&mut w);
            let data = prepare(&mut enc, img, icc);
            data.write_with_encoder(enc)
        }
        Target::Webp => {
            let base = to_8bit(img);
            let mut enc = WebPEncoder::new_lossless(&mut w);
            let data = prepare(&mut enc, &base, icc);
            data.write_with_encoder(enc)
        }
        Target::Tiff => {
            let mut enc = TiffEncoder::new(&mut w);
            let data = prepare(&mut enc, img, icc);
            data.write_with_encoder(enc)
        }
        // AVIF, BMP and GIF cannot carry the profile here, so convert to sRGB.
        Target::Avif => {
            // Speed 6 is a good balance between size and time for photos.
            srgb_8bit(img, icc)
                .write_with_encoder(AvifEncoder::new_with_speed_quality(&mut w, 6, quality))
        }
        Target::Bmp => srgb_8bit(img, icc).write_to(&mut w, ImageFormat::Bmp),
        Target::Gif => DynamicImage::ImageRgba8(srgb_8bit(img, icc).to_rgba8())
            .write_to(&mut w, ImageFormat::Gif),
    };

    result.map_err(|e| format!("Conversion failed: {e}"))?;
    w.flush().map_err(|e| format!("Can't write output file: {e}"))
}

/// `name.ext`, or `name (1).ext`, `name (2).ext`... Never overwrites a file.
fn unique_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let first = dir.join(format!("{stem}.{ext}"));
    if !first.exists() {
        return first;
    }
    let mut n = 1u32;
    loop {
        let candidate = dir.join(format!("{stem} ({n}).{ext}"));
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}

fn convert_blocking(
    path: &str,
    target: Target,
    quality: u8,
    out_dir: Option<&str>,
) -> Result<String, String> {
    let src = Path::new(path);
    let stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("Invalid file name")?;
    let dir = match out_dir {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => src
            .parent()
            .map(Path::to_path_buf)
            .ok_or("Invalid file path")?,
    };

    let loaded = load(src)?;
    let out = unique_path(&dir, stem, target.extension());
    if let Err(e) = encode(&loaded.img, loaded.icc.as_deref(), target, quality.clamp(1, 100), &out) {
        let _ = std::fs::remove_file(&out);
        return Err(e);
    }
    Ok(out.to_string_lossy().into_owned())
}

/// Convert one file. Returns the path of the new file.
#[tauri::command]
async fn convert_one(
    path: String,
    target: Target,
    quality: u8,
    out_dir: Option<String>,
) -> Result<String, String> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        convert_blocking(&path, target, quality, out_dir.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?;
    result
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![convert_one])
        .run(tauri::generate_context!())
        .expect("error while running Photo Converter");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pc-test-{}-{}", name, std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn unique_path_never_overwrites() {
        let dir = temp_dir("unique");
        let first = unique_path(&dir, "photo", "png");
        assert_eq!(first.file_name().unwrap(), "photo.png");
        std::fs::write(&first, b"x").unwrap();
        let second = unique_path(&dir, "photo", "png");
        assert_eq!(second.file_name().unwrap(), "photo (1).png");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn converts_between_all_targets() {
        let dir = temp_dir("convert");
        let src = dir.join("in.png");
        let mut img = image::RgbaImage::new(64, 64);
        for p in img.pixels_mut() {
            *p = image::Rgba([200, 80, 40, 128]);
        }
        img.save(&src).unwrap();

        for target in [
            Target::Jpeg,
            Target::Png,
            Target::Webp,
            Target::Avif,
            Target::Bmp,
            Target::Tiff,
            Target::Gif,
        ] {
            let out = convert_blocking(src.to_str().unwrap(), target, 80, None)
                .unwrap_or_else(|e| panic!("{target:?} failed: {e}"));
            assert!(Path::new(&out).metadata().unwrap().len() > 0, "{target:?} empty");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn garbage_input_is_an_error_and_leaves_no_output() {
        let dir = temp_dir("garbage");
        let src = dir.join("bad.jpg");
        std::fs::write(&src, b"not an image").unwrap();
        assert!(convert_blocking(src.to_str().unwrap(), Target::Png, 80, None).is_err());
        assert!(!dir.join("bad.png").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A flat-colored PNG tagged with a Display P3 profile.
    fn write_p3_png(path: &Path) {
        let icc = ColorProfile::new_display_p3().encode().unwrap();
        let mut img = RgbImage::new(64, 64);
        for p in img.pixels_mut() {
            *p = Rgb([200, 100, 50]);
        }
        let mut enc = PngEncoder::new(BufWriter::new(File::create(path).unwrap()));
        enc.set_icc_profile(icc).unwrap();
        DynamicImage::ImageRgb8(img).write_with_encoder(enc).unwrap();
    }

    fn has_profile(path: &str) -> bool {
        let mut d = ImageReader::open(path)
            .unwrap()
            .with_guessed_format()
            .unwrap()
            .into_decoder()
            .unwrap();
        d.icc_profile().unwrap().is_some()
    }

    #[test]
    fn color_profile_is_kept_where_the_format_supports_it() {
        let dir = temp_dir("icc-keep");
        let src = dir.join("p3.png");
        write_p3_png(&src);
        assert!(has_profile(src.to_str().unwrap()), "test input should carry a profile");

        for target in [Target::Png, Target::Jpeg] {
            let out = convert_blocking(src.to_str().unwrap(), target, 90, None).unwrap();
            assert!(has_profile(&out), "{target:?} lost the color profile");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn formats_without_profile_support_are_converted_to_srgb() {
        let dir = temp_dir("icc-srgb");
        let src = dir.join("p3.png");
        write_p3_png(&src);

        let out = convert_blocking(src.to_str().unwrap(), Target::Bmp, 90, None).unwrap();
        let px = image::open(&out).unwrap().to_rgb8().get_pixel(0, 0).0;
        assert_ne!(px, [200, 100, 50], "pixels should have been converted from P3 to sRGB");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
