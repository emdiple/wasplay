use std::io::Cursor;
use ebur128::{EbuR128, Mode};
use symphonia::core::{
    codecs::{
        audio::{well_known as audio_wk, AudioCodecId, AudioDecoderOptions},
        video::{well_known as video_wk, VideoCodecId},
        CodecParameters,
    },
    errors::Error as SymphoniaError,
    formats::{probe::Hint, FormatOptions, TrackType},
    io::{MediaSource, MediaSourceStream},
    meta::MetadataOptions,
};
use wasm_bindgen::prelude::*;

mod reader;
use reader::{read_prefix, JsReader};

// ── Public WASM API ───────────────────────────────────────────────────────────

/// Probe `bytes` and return a JSON string describing the container, codecs,
/// and audio stream parameters.
///
/// JSON shape:
/// ```json
/// {
///   "container":      "MP4",
///   "audio_codec":    "AAC",
///   "video_codec":    "H.264",   // null when no video track
///   "channels":       2,
///   "sample_rate":    44100,
///   "bits_per_sample": 16        // null when not reported by container
/// }
/// ```
#[wasm_bindgen]
pub fn get_media_info(bytes: &[u8]) -> Result<String, JsValue> {
    media_info_inner(bytes).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Measure integrated loudness directly from raw file bytes.
/// Works with audio files and video containers (mp4, mkv …).
/// Returns LUFS, or -Infinity for silent / sub-gate content.
#[wasm_bindgen]
pub fn measure_lufs_from_bytes(audio_bytes: &[u8]) -> Result<f64, JsValue> {
    from_bytes_inner(audio_bytes).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Streaming variant of [`get_media_info`]. Instead of receiving the whole file
/// as a byte slice, this takes a synchronous JS read callback
/// `(offset, len) => Uint8Array` and the total file length. Bytes are pulled
/// lazily from the underlying `File`, so the file is never fully materialised in
/// WASM memory — suitable for multi-gigabyte inputs. Intended to be driven from
/// a Web Worker using `FileReaderSync`.
#[wasm_bindgen]
pub fn get_media_info_streaming(read_fn: js_sys::Function, file_len: f64) -> Result<String, JsValue> {
    let len = file_len as u64;
    // 64 bytes: enough for every magic-byte check, including the EBML DocType
    // ("webm" vs "matroska") that sits a few dozen bytes into MKV/WebM files.
    let header = read_prefix(&read_fn, len.min(64)).map_err(|e| JsValue::from_str(&e))?;
    let container = detect_container(&header);
    let src: Box<dyn MediaSource> = Box::new(JsReader::new(read_fn, len));
    media_info_from_source(container, src).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Streaming variant of [`measure_lufs_from_bytes`]. See
/// [`get_media_info_streaming`] for the callback contract. Loudness is measured
/// by feeding decoded frames into the EBU R128 meter incrementally, so memory
/// stays flat regardless of file size.
#[wasm_bindgen]
pub fn measure_lufs_streaming(read_fn: js_sys::Function, file_len: f64) -> Result<f64, JsValue> {
    let src: Box<dyn MediaSource> = Box::new(JsReader::new(read_fn, file_len as u64));
    lufs_from_source(src).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Measure integrated loudness from pre-decoded interleaved f32 PCM.
/// Kept for callers that already have decoded audio (e.g. Web Audio pipeline).
#[wasm_bindgen]
pub fn measure_lufs(samples: &[f32], sample_rate: u32, channels: u32) -> f64 {
    let Ok(mut meter) = EbuR128::new(channels, sample_rate, Mode::I) else {
        return f64::NEG_INFINITY;
    };
    if meter.add_frames_f32(samples).is_err() {
        return f64::NEG_INFINITY;
    }
    meter.loudness_global().unwrap_or(f64::NEG_INFINITY)
}

/// Gain (dB / LU) needed to bring `measured_lufs` to `target_lufs`.
/// Positive = boost, negative = attenuate.
#[wasm_bindgen]
pub fn gain_to_target(measured_lufs: f64, target_lufs: f64) -> f64 {
    target_lufs - measured_lufs
}

// ── Media info ────────────────────────────────────────────────────────────────

fn media_info_inner(bytes: &[u8]) -> Result<String, Box<dyn std::error::Error>> {
    let container = detect_container(bytes);
    let src: Box<dyn MediaSource> = Box::new(Cursor::new(bytes.to_vec()));
    media_info_from_source(container, src)
}

fn media_info_from_source(
    container: &str,
    src: Box<dyn MediaSource>,
) -> Result<String, Box<dyn std::error::Error>> {
    let mss = MediaSourceStream::new(src, Default::default());

    let format = symphonia::default::get_probe().probe(
        &Hint::new(),
        mss,
        FormatOptions::default(),
        MetadataOptions::default(),
    )?;

    let mut audio_codec   = "unknown".to_string();
    let mut video_codec: Option<String> = None;
    let mut channels:     Option<u32>   = None;
    let mut sample_rate:  Option<u32>   = None;
    let mut bits_per_sample: Option<u32> = None;

    for track in format.tracks() {
        match &track.codec_params {
            Some(CodecParameters::Audio(p)) => {
                audio_codec      = audio_codec_name(p.codec);
                channels         = p.channels.clone().map(|c| c.count() as u32);
                sample_rate      = p.sample_rate;
                bits_per_sample  = p.bits_per_sample;
            }
            Some(CodecParameters::Video(p)) => {
                video_codec = Some(video_codec_name(p.codec));
            }
            _ => {}
        }
    }

    let video_json = match &video_codec {
        Some(v) => format!("\"{}\"", v),
        None    => "null".to_string(),
    };
    let ch  = opt_json(channels);
    let sr  = opt_json(sample_rate);
    let bps = opt_json(bits_per_sample);

    Ok(format!(
        r#"{{"container":"{container}","audio_codec":"{audio_codec}","video_codec":{video_json},"channels":{ch},"sample_rate":{sr},"bits_per_sample":{bps}}}"#
    ))
}

fn detect_container(b: &[u8]) -> &'static str {
    if b.len() >= 12 && &b[4..8] == b"ftyp" {
        // QuickTime brand distinguishes .mov from the MP4 family.
        if &b[8..12] == b"qt  " { return "MOV"; }
        return "MP4";
    }
    if b.len() >= 4 && b[0..4] == [0x1A, 0x45, 0xDF, 0xA3] {
        // EBML header — Matroska family. The DocType string ("webm" or
        // "matroska") appears within the first few dozen bytes.
        let head = &b[..b.len().min(64)];
        if head.windows(4).any(|w| w == b"webm") { return "WebM"; }
        return "MKV";
    }
    if b.len() >= 12 && &b[0..4] == b"FORM" && &b[8..12] == b"AIFF" { return "AIFF"; }
    if b.len() >= 4  && &b[0..4] == b"caff"  { return "CAF"; }
    if b.len() >= 4  && &b[0..4] == b"RIFF"  { return "WAV"; }
    if b.len() >= 4  && &b[0..4] == b"OggS"  { return "OGG"; }
    if b.len() >= 4  && &b[0..4] == b"fLaC"  { return "FLAC"; }
    if b.len() >= 3  && &b[0..3] == b"ID3"   { return "MP3"; }
    if b.len() >= 2  && b[0] == 0xff && (b[1] & 0xe0) == 0xe0 { return "MP3"; }
    "Unknown"
}

fn audio_codec_name(id: AudioCodecId) -> String {
    use audio_wk::*;
    if id == CODEC_ID_AAC        { return "AAC".into(); }
    if id == CODEC_ID_MP3        { return "MP3".into(); }
    if id == CODEC_ID_FLAC       { return "FLAC".into(); }
    if id == CODEC_ID_VORBIS     { return "Vorbis".into(); }
    if id == CODEC_ID_OPUS       { return "Opus".into(); }
    // PCM family occupies 0x100–0x1ff
    if id >= CODEC_ID_PCM_S32LE && id <= CODEC_ID_PCM_ALAW {
        return "PCM".into();
    }
    format!("Unknown ({id})")
}

fn video_codec_name(id: VideoCodecId) -> String {
    use video_wk::*;
    if id == CODEC_ID_H264 { return "H.264".into(); }
    if id == CODEC_ID_HEVC { return "H.265 (HEVC)".into(); }
    format!("Unknown ({id})")
}

fn opt_json(v: Option<u32>) -> String {
    match v {
        Some(n) => n.to_string(),
        None    => "null".to_string(),
    }
}

// ── LUFS from bytes ───────────────────────────────────────────────────────────

fn from_bytes_inner(audio_bytes: &[u8]) -> Result<f64, Box<dyn std::error::Error>> {
    let src: Box<dyn MediaSource> = Box::new(Cursor::new(audio_bytes.to_vec()));
    lufs_from_source(src)
}

fn lufs_from_source(src: Box<dyn MediaSource>) -> Result<f64, Box<dyn std::error::Error>> {
    let mss = MediaSourceStream::new(src, Default::default());

    let mut format = symphonia::default::get_probe().probe(
        &Hint::new(),
        mss,
        FormatOptions::default(),
        MetadataOptions::default(),
    )?;

    let track = format
        .default_track(TrackType::Audio)
        .ok_or("no audio track found")?;

    let track_id    = track.id;
    let audio_params = track
        .codec_params
        .as_ref()
        .ok_or("missing codec parameters")?
        .audio()
        .ok_or("track is not an audio codec")?
        .clone();

    let channels    = audio_params.channels.clone().map(|c| c.count()).unwrap_or(2) as u32;
    let sample_rate = audio_params.sample_rate.unwrap_or(48000);

    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&audio_params, &AudioDecoderOptions::default())?;

    let Ok(mut meter) = EbuR128::new(channels, sample_rate, Mode::I) else {
        return Ok(f64::NEG_INFINITY);
    };

    let mut frame_buf: Vec<f32> = Vec::new();

    loop {
        let packet = match format.next_packet()? {
            Some(p) => p,
            None    => break,
        };

        if packet.track_id != track_id { continue; }

        let audio_buf = match decoder.decode(&packet) {
            Ok(buf)                              => buf,
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(e)                               => return Err(Box::new(e)),
        };

        frame_buf.resize(audio_buf.samples_interleaved(), 0.0);
        audio_buf.copy_to_slice_interleaved(&mut frame_buf);

        if meter.add_frames_f32(&frame_buf).is_err() { break; }
    }

    Ok(meter.loudness_global().unwrap_or(f64::NEG_INFINITY))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    #[test]
    fn detect_container_matroska_family_and_mov() {
        // EBML magic + DocType "webm" within the first 64 bytes → WebM.
        let mut webm = vec![0x1A, 0x45, 0xDF, 0xA3];
        webm.extend_from_slice(&[0u8; 20]);
        webm.extend_from_slice(b"webm");
        assert_eq!(detect_container(&webm), "WebM");

        // EBML magic + "matroska" DocType → MKV.
        let mut mkv = vec![0x1A, 0x45, 0xDF, 0xA3];
        mkv.extend_from_slice(b"\x42\x82\x88matroska");
        assert_eq!(detect_container(&mkv), "MKV");

        // ftyp with QuickTime brand → MOV; any other brand → MP4.
        assert_eq!(detect_container(b"\x00\x00\x00\x14ftypqt  \x00\x00\x00\x00"), "MOV");
        assert_eq!(detect_container(b"\x00\x00\x00\x14ftypisom\x00\x00\x00\x00"), "MP4");
    }

    fn sine_pcm(freq: f32, amp: f32, secs: f32, fs: u32) -> Vec<f32> {
        let n = (secs * fs as f32) as usize;
        (0..n)
            .map(|i| amp * (2.0 * PI * freq * i as f32 / fs as f32).sin())
            .collect()
    }

    fn sine_wav_bytes(freq: f32, amp: f32, secs: f32, sample_rate: u32) -> Vec<u8> {
        let samples: Vec<i16> = sine_pcm(freq, amp, secs, sample_rate)
            .into_iter()
            .map(|s| (s * i16::MAX as f32) as i16)
            .collect();
        let data_len = (samples.len() * 2) as u32;
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_len).to_le_bytes());
        wav.extend_from_slice(b"WAVE");
        wav.extend_from_slice(b"fmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
        wav.extend_from_slice(&1u16.to_le_bytes()); // mono
        wav.extend_from_slice(&sample_rate.to_le_bytes());
        wav.extend_from_slice(&(sample_rate * 2).to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_len.to_le_bytes());
        for s in &samples { wav.extend_from_slice(&s.to_le_bytes()); }
        wav
    }

    #[test]
    fn pcm_silence_is_neg_inf() {
        assert!(measure_lufs(&vec![0.0f32; 48000], 48000, 1).is_infinite());
    }

    #[test]
    fn gain_calc() {
        assert!((gain_to_target(-21.0, -23.0) - (-2.0)).abs() < 1e-9);
    }

    #[test]
    fn bytes_returns_finite_lufs_for_tone() {
        let wav = sine_wav_bytes(1000.0, 0.5, 3.0, 48000);
        let lufs = from_bytes_inner(&wav).unwrap();
        assert!(lufs.is_finite(), "expected finite LUFS, got {lufs}");
    }

    #[test]
    fn bytes_and_pcm_agree() {
        let fs  = 48000u32;
        let pcm = sine_pcm(1000.0, 0.5, 3.0, fs);
        let wav = sine_wav_bytes(1000.0, 0.5, 3.0, fs);
        let lufs_pcm   = measure_lufs(&pcm, fs, 1);
        let lufs_bytes = from_bytes_inner(&wav).unwrap();
        assert!((lufs_pcm - lufs_bytes).abs() < 0.5,
            "PCM={lufs_pcm:.2} vs bytes={lufs_bytes:.2}");
    }

    #[test]
    fn relative_levels_track_amplitude() {
        let fs    = 48000u32;
        let loud  = sine_wav_bytes(1000.0, 0.5,  3.0, fs);
        let quiet = sine_wav_bytes(1000.0, 0.25, 3.0, fs);
        let l = from_bytes_inner(&loud).unwrap();
        let q = from_bytes_inner(&quiet).unwrap();
        assert!(l.is_finite() && q.is_finite());
        assert!((l - q - 6.0).abs() < 0.5, "expected ~6 LU drop, got {:.2}", l - q);
    }

    #[test]
    fn media_info_wav_has_correct_fields() {
        let wav  = sine_wav_bytes(440.0, 0.5, 1.0, 44100);
        let json = media_info_inner(&wav).unwrap();
        assert!(json.contains("\"container\":\"WAV\""));
        assert!(json.contains("\"audio_codec\":\"PCM\""));
        assert!(json.contains("\"video_codec\":null"));
        assert!(json.contains("\"channels\":1"));
        assert!(json.contains("\"sample_rate\":44100"));
    }
}
