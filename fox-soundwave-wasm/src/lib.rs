use std::io::Cursor;
use symphonia::core::{
    codecs::audio::AudioDecoderOptions,
    errors::Error as SymphoniaError,
    formats::{FormatOptions, TrackType, probe::Hint},
    io::{MediaSource, MediaSourceStream},
    meta::MetadataOptions,
};
use wasm_bindgen::prelude::*;

mod reader;
use reader::JsReader;

/// Decode `audio_bytes` (any container/codec supported by symphonia: mp3, aac,
/// flac, ogg, wav, m4a …) and return `num_peaks` peak-amplitude values in
/// [0.0, 1.0].  Each value is the maximum absolute sample across all channels
/// within that time slice — ready to draw as a symmetric waveform on a Canvas.
///
/// Throws a JS error string on unsupported format or decode failure.
#[wasm_bindgen]
pub fn extract_peaks(audio_bytes: &[u8], num_peaks: u32) -> Result<Vec<f32>, JsValue> {
    let src: Box<dyn MediaSource> = Box::new(Cursor::new(audio_bytes.to_vec()));
    peaks_from_source(src, num_peaks).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Streaming variant of [`extract_peaks`]. Takes a synchronous JS read callback
/// `(offset, len) => Uint8Array` plus the total file length, and pulls encoded
/// audio lazily from the underlying `File`. When the container reports a total
/// frame count, peaks are accumulated one bucket at a time so the full decoded
/// PCM never needs to live in memory — enabling waveforms for very large files.
/// Intended to be driven from a Web Worker using `FileReaderSync`.
#[wasm_bindgen]
pub fn extract_peaks_streaming(
    read_fn: js_sys::Function,
    file_len: f64,
    num_peaks: u32,
) -> Result<Vec<f32>, JsValue> {
    let src: Box<dyn MediaSource> = Box::new(JsReader::new(read_fn, file_len as u64));
    peaks_from_source(src, num_peaks).map_err(|e| JsValue::from_str(&e.to_string()))
}

fn peaks_from_source(
    src: Box<dyn MediaSource>,
    num_peaks: u32,
) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
    if num_peaks == 0 {
        return Ok(vec![]);
    }

    let mss = MediaSourceStream::new(src, Default::default());

    let mut format = symphonia::default::get_probe().probe(
        &Hint::new(),
        mss,
        FormatOptions::default(),
        MetadataOptions::default(),
    )?;

    // Grab track info before the mutable borrow loop.
    let track = format
        .default_track(TrackType::Audio)
        .ok_or("no audio track found")?;

    let track_id = track.id;
    let num_frames = track.num_frames;
    // Clone so we can drop the immutable borrow on `format` before the loop.
    let audio_params = track
        .codec_params
        .as_ref()
        .ok_or("missing codec parameters")?
        .audio()
        .ok_or("track is not an audio track")?
        .clone();

    let channels = audio_params
        .channels
        .clone()
        .map(|c| c.count())
        .unwrap_or(2)
        .max(1) as u64;

    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&audio_params, &AudioDecoderOptions::default())?;

    let np = num_peaks as usize;

    // When the container reports a playable frame count, bucket each interleaved
    // sample directly by its global index — O(1) memory beyond the peak array.
    if let Some(total) = num_frames.map(|f| f * channels).filter(|&t| t > 0) {
        let bucket = ((total as f64 / num_peaks as f64).ceil() as u64).max(1);
        let mut peaks = vec![0.0f32; np];
        let mut global_idx: u64 = 0;
        let mut frame_buf: Vec<f32> = Vec::new();

        while let Some(packet) = format.next_packet()? {
            if packet.track_id != track_id {
                continue;
            }
            let audio_buf = match decoder.decode(&packet) {
                Ok(buf) => buf,
                Err(SymphoniaError::DecodeError(_)) => continue,
                Err(e) => return Err(Box::new(e)),
            };
            frame_buf.resize(audio_buf.samples_interleaved(), 0.0);
            audio_buf.copy_to_slice_interleaved(&mut frame_buf);

            for &s in &frame_buf {
                let b = (global_idx / bucket) as usize;
                if b < np {
                    let a = s.abs();
                    if a > peaks[b] {
                        peaks[b] = a;
                    }
                }
                global_idx += 1;
            }
        }
        return Ok(peaks);
    }

    // Unknown frame count (rare): fall back to accumulate-then-bucket.
    let mut all_samples: Vec<f32> = Vec::new();
    let mut frame_buf: Vec<f32> = Vec::new();

    while let Some(packet) = format.next_packet()? {
        if packet.track_id != track_id {
            continue;
        }
        let audio_buf = match decoder.decode(&packet) {
            Ok(buf) => buf,
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(e) => return Err(Box::new(e)),
        };
        frame_buf.resize(audio_buf.samples_interleaved(), 0.0);
        audio_buf.copy_to_slice_interleaved(&mut frame_buf);
        all_samples.extend_from_slice(&frame_buf);
    }

    if all_samples.is_empty() {
        return Ok(vec![0.0; np]);
    }

    let chunk_size = ((all_samples.len() as f64 / num_peaks as f64).ceil() as usize).max(1);
    let mut peaks: Vec<f32> = all_samples
        .chunks(chunk_size)
        .take(np)
        .map(|chunk| chunk.iter().copied().map(f32::abs).fold(0.0f32, f32::max))
        .collect();
    peaks.resize(np, 0.0);

    Ok(peaks)
}

#[cfg(test)]
fn inner(audio_bytes: &[u8], num_peaks: u32) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
    let src: Box<dyn MediaSource> = Box::new(Cursor::new(audio_bytes.to_vec()));
    peaks_from_source(src, num_peaks)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    fn sine_wav_bytes(freq: f32, amp: f32, secs: f32, sample_rate: u32) -> Vec<u8> {
        let num_samples = (secs * sample_rate as f32) as usize;
        let samples: Vec<i16> = (0..num_samples)
            .map(|i| {
                let t = i as f32 / sample_rate as f32;
                (amp * (2.0 * PI * freq * t).sin() * i16::MAX as f32) as i16
            })
            .collect();

        let data_len = (num_samples * 2) as u32;
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_len).to_le_bytes());
        wav.extend_from_slice(b"WAVE");
        wav.extend_from_slice(b"fmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
        wav.extend_from_slice(&1u16.to_le_bytes()); // mono
        wav.extend_from_slice(&sample_rate.to_le_bytes());
        wav.extend_from_slice(&(sample_rate * 2).to_le_bytes()); // byte rate
        wav.extend_from_slice(&2u16.to_le_bytes()); // block align
        wav.extend_from_slice(&16u16.to_le_bytes()); // bits/sample
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_len.to_le_bytes());
        for s in &samples {
            wav.extend_from_slice(&s.to_le_bytes());
        }
        wav
    }

    #[test]
    fn returns_correct_peak_count() {
        let wav = sine_wav_bytes(440.0, 0.5, 2.0, 44100);
        let peaks = inner(&wav, 100).unwrap();
        assert_eq!(peaks.len(), 100);
    }

    #[test]
    fn peaks_in_range() {
        let wav = sine_wav_bytes(440.0, 0.5, 2.0, 44100);
        let peaks = inner(&wav, 50).unwrap();
        for &p in &peaks {
            assert!((0.0..=1.0).contains(&p), "peak out of range: {p}");
        }
    }

    #[test]
    fn silence_gives_zero_peaks() {
        let wav = sine_wav_bytes(0.0, 0.0, 1.0, 44100);
        let peaks = inner(&wav, 64).unwrap();
        for &p in &peaks {
            assert!(p < 1e-4, "expected near-zero peak, got {p}");
        }
    }

    #[test]
    fn zero_num_peaks_returns_empty() {
        let wav = sine_wav_bytes(440.0, 0.5, 1.0, 44100);
        let peaks = inner(&wav, 0).unwrap();
        assert!(peaks.is_empty());
    }

    #[test]
    fn louder_signal_produces_higher_peaks() {
        let quiet = sine_wav_bytes(440.0, 0.25, 2.0, 44100);
        let loud = sine_wav_bytes(440.0, 0.75, 2.0, 44100);
        let quiet_max = inner(&quiet, 50)
            .unwrap()
            .into_iter()
            .fold(0.0f32, f32::max);
        let loud_max = inner(&loud, 50).unwrap().into_iter().fold(0.0f32, f32::max);
        assert!(loud_max > quiet_max, "loud={loud_max}, quiet={quiet_max}");
    }
}
