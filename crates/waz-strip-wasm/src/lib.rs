use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

// ── Public types ──────────────────────────────────────────────────────────────

/// Metadata about a single keyframe extracted from an MP4 container.
/// The caller receives this and feeds `data` into WebCodecs `VideoDecoder`.
#[derive(Serialize, Deserialize, Debug)]
pub struct KeyframeInfo {
    /// Presentation timestamp in seconds.
    pub timestamp_s: f64,
    /// Byte offset of the sample within the file. `u64` so sample positions past
    /// the 4 GB mark (large videos) are represented correctly.
    pub byte_offset: u64,
    /// Byte length of the encoded sample data.
    pub byte_length: u32,
    /// Sequential index among all extracted keyframes.
    pub index: u32,
}

/// Codec configuration string needed to initialise `VideoDecoder`.
/// `codec` follows the WebCodecs codec registry (e.g. `"avc1.42E01E"`).
/// `description` is the raw AVCC/HVCC box bytes required by some codecs.
#[derive(Serialize, Deserialize, Debug)]
pub struct CodecConfig {
    pub codec: String,
    /// Base-64 encoded codec-private data (avcC / hvcC box contents).
    /// Empty string when not present.
    pub description_b64: String,
    pub width: u32,
    pub height: u32,
}

/// Full result returned by `scan_keyframes`.
#[derive(Serialize, Deserialize, Debug)]
pub struct ScanResult {
    pub config: CodecConfig,
    pub keyframes: Vec<KeyframeInfo>,
    /// Total video duration in seconds (0 when unknown).
    pub duration_s: f64,
}

/// One encoded video sample (frame), in decode order — everything WebCodecs
/// `VideoDecoder` needs to decode it sequentially (no `<video>` seeking).
#[derive(Serialize, Deserialize, Debug)]
pub struct SampleInfo {
    /// Presentation timestamp in seconds (DTS + composition offset from `ctts`).
    /// This is the timestamp to stamp on the `EncodedVideoChunk`.
    pub pts_s: f64,
    /// Decode timestamp in seconds (samples are listed in DTS order).
    pub dts_s: f64,
    pub byte_offset: u64,
    pub byte_length: u32,
    pub is_keyframe: bool,
}

/// Full sample table returned by `scan_samples` — the demuxer output that feeds
/// a `VideoDecoder`-based render, replacing per-frame `<video>` seeking.
#[derive(Serialize, Deserialize, Debug)]
pub struct SampleTable {
    pub config: CodecConfig,
    pub samples: Vec<SampleInfo>,
    pub duration_s: f64,
}

// ── WASM exports ──────────────────────────────────────────────────────────────

/// Scan an MP4 byte buffer and return codec configuration + keyframe locations.
///
/// JavaScript usage:
/// ```js
/// const result = JSON.parse(scan_keyframes(bytes));
/// // result.config  → { codec, description_b64, width, height }
/// // result.keyframes → [{ timestamp_s, byte_offset, byte_length, index }, …]
/// ```
///
/// After receiving this, the caller should:
/// 1. Initialise a `VideoDecoder` with `result.config`.
/// 2. For each keyframe, slice `result.keyframes[i].byte_offset` from the
///    original buffer and enqueue it as an `EncodedVideoChunk` (type = "key").
/// 3. In the `VideoDecoder.output` callback, draw each `VideoFrame` onto an
///    `OffscreenCanvas` and transfer the `ImageBitmap` to the timeline strip.
#[wasm_bindgen]
pub fn scan_keyframes(mp4_bytes: &[u8]) -> Result<String, JsValue> {
    scan_inner(mp4_bytes).map_err(|e| JsValue::from_str(&e))
}

/// Scan an MP4 and return the **full** video sample table (every frame, in decode
/// order, with PTS/DTS, byte range, and keyframe flag) plus codec config — the
/// demuxer output for a `VideoDecoder`-based render. Sample bytes are read on
/// demand via [`get_keyframe_bytes`] / [`get_keyframe_bytes_streaming`].
#[wasm_bindgen]
pub fn scan_samples(mp4_bytes: &[u8]) -> Result<String, JsValue> {
    samples_inner(mp4_bytes).map_err(|e| JsValue::from_str(&e))
}

/// Extract the raw bytes of a single keyframe by its scan-result index.
/// This avoids sending the full file buffer back through JS for every chunk.
#[wasm_bindgen]
pub fn get_keyframe_bytes(
    mp4_bytes: &[u8],
    byte_offset: u32,
    byte_length: u32,
) -> Result<Vec<u8>, JsValue> {
    slice_keyframe(mp4_bytes, byte_offset, byte_length)
        .map_err(|e| JsValue::from_str(&e))
}

fn slice_keyframe(data: &[u8], byte_offset: u32, byte_length: u32) -> Result<Vec<u8>, String> {
    let start = byte_offset as usize;
    let end = start + byte_length as usize;
    if end > data.len() {
        return Err("keyframe range out of bounds".to_string());
    }
    Ok(data[start..end].to_vec())
}

// ── Streaming API (worker + FileReaderSync) ───────────────────────────────────
// These variants take a synchronous JS read callback `(offset, len) => Uint8Array`
// instead of the whole file. The scan only ever needs the `moov` box, so a large
// video is walked box-by-box and only its (comparatively tiny) metadata is read —
// the multi-gigabyte `mdat` is skipped entirely and never enters WASM memory.

/// Streaming variant of [`scan_keyframes`]. Locates the `moov` box by walking the
/// top-level box structure via the callback, reads only that box, and parses it.
#[wasm_bindgen]
pub fn scan_keyframes_streaming(
    read_fn: js_sys::Function,
    file_len: f64,
) -> Result<String, JsValue> {
    let moov = find_moov(&read_fn, file_len as u64).map_err(|e| JsValue::from_str(&e))?;
    scan_inner(&moov).map_err(|e| JsValue::from_str(&e))
}

/// Streaming variant of [`scan_samples`] — reads only the `moov` box via the
/// callback, so the multi-gigabyte `mdat` is never loaded to build the table.
#[wasm_bindgen]
pub fn scan_samples_streaming(read_fn: js_sys::Function, file_len: f64) -> Result<String, JsValue> {
    let moov = find_moov(&read_fn, file_len as u64).map_err(|e| JsValue::from_str(&e))?;
    samples_inner(&moov).map_err(|e| JsValue::from_str(&e))
}

/// Streaming variant of [`get_keyframe_bytes`]. Reads a single sample's byte range
/// directly from the file via the callback. `byte_offset` is `f64` so offsets past
/// the 4 GB mark survive the JS boundary intact.
#[wasm_bindgen]
pub fn get_keyframe_bytes_streaming(
    read_fn: js_sys::Function,
    byte_offset: f64,
    byte_length: u32,
) -> Result<Vec<u8>, JsValue> {
    js_read_range(&read_fn, byte_offset as u64, byte_length as u64)
        .map_err(|e| JsValue::from_str(&e))
}

/// Invoke the JS read callback and collect the returned bytes.
fn js_read_range(read_fn: &js_sys::Function, offset: u64, len: u64) -> Result<Vec<u8>, String> {
    let ret = read_fn
        .call2(
            &JsValue::NULL,
            &JsValue::from_f64(offset as f64),
            &JsValue::from_f64(len as f64),
        )
        .map_err(|_| "read callback threw".to_string())?;
    ret.dyn_into::<js_sys::Uint8Array>()
        .map(|a| a.to_vec())
        .map_err(|_| "read callback did not return a Uint8Array".to_string())
}

/// Walk the top-level ISOBMFF boxes and return the raw bytes of the `moov` box.
/// Box contents other than `moov` (notably `mdat`) are skipped by seeking past
/// their declared size — they are never read.
fn find_moov(read_fn: &js_sys::Function, file_len: u64) -> Result<Vec<u8>, String> {
    let mut pos: u64 = 0;
    while pos + 8 <= file_len {
        let header = js_read_range(read_fn, pos, 16.min(file_len - pos))?;
        if header.len() < 8 {
            break;
        }
        let size32 = u32::from_be_bytes(header[0..4].try_into().unwrap()) as u64;
        let name = &header[4..8];

        let box_size = if size32 == 1 {
            if header.len() < 16 {
                return Err("truncated 64-bit box header".to_string());
            }
            u64::from_be_bytes(header[8..16].try_into().unwrap())
        } else if size32 == 0 {
            file_len - pos // box extends to end of file
        } else {
            size32
        };

        if box_size < 8 {
            break; // malformed / degenerate box size
        }

        if name == b"moov" {
            return js_read_range(read_fn, pos, box_size);
        }
        pos += box_size;
    }
    Err("moov box not found — not a valid MP4?".to_string())
}

/// Given a desired thumbnail count, select up to `count` keyframes evenly
/// distributed across the video duration. Returns a JSON array of indices
/// into the original `keyframes` array from `scan_keyframes`.
#[wasm_bindgen]
pub fn select_thumbnail_keyframes(
    scan_result_json: &str,
    count: u32,
) -> Result<String, JsValue> {
    let result: ScanResult =
        serde_json::from_str(scan_result_json).map_err(|e| JsValue::from_str(&e.to_string()))?;

    if count == 0 || result.keyframes.is_empty() {
        return Ok("[]".to_string());
    }

    let total = result.keyframes.len();
    let n = (count as usize).min(total);

    let indices: Vec<u32> = if n == 1 {
        vec![0]
    } else {
        (0..n)
            .map(|i| {
                let frac = i as f64 / (n - 1) as f64;
                ((frac * (total - 1) as f64).round() as usize).min(total - 1) as u32
            })
            .collect()
    };

    serde_json::to_string(&indices).map_err(|e| JsValue::from_str(&e.to_string()))
}

// ── Core parser ───────────────────────────────────────────────────────────────

fn scan_inner(data: &[u8]) -> Result<String, String> {
    let mut parser = Mp4Parser::new(data);
    parser.parse()?;

    let result = ScanResult {
        config: parser.config,
        keyframes: parser.keyframes,
        duration_s: parser.duration_s,
    };

    serde_json::to_string(&result).map_err(|e| e.to_string())
}

fn samples_inner(data: &[u8]) -> Result<String, String> {
    let mut parser = Mp4Parser::new(data);
    parser.parse()?;

    let result = SampleTable {
        config: parser.config,
        samples: parser.samples,
        duration_s: parser.duration_s,
    };

    serde_json::to_string(&result).map_err(|e| e.to_string())
}

// ── Minimal MP4 parser ────────────────────────────────────────────────────────
// Parses just enough of the ISO Base Media File Format (ISOBMFF) to locate
// keyframe sample offsets without decoding any video pixels.

struct Mp4Parser<'a> {
    data: &'a [u8],
    config: CodecConfig,
    keyframes: Vec<KeyframeInfo>,
    samples: Vec<SampleInfo>,
    duration_s: f64,
}

impl<'a> Mp4Parser<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self {
            data,
            config: CodecConfig {
                codec: "avc1.42E01E".to_string(),
                description_b64: String::new(),
                width: 0,
                height: 0,
            },
            keyframes: Vec::new(),
            samples: Vec::new(),
            duration_s: 0.0,
        }
    }

    fn parse(&mut self) -> Result<(), String> {
        // Walk top-level boxes to find `moov`
        let mut pos = 0usize;
        while pos + 8 <= self.data.len() {
            let (size, name) = read_box_header(self.data, pos)?;
            if size == 0 { break; }

            if &name == b"moov" {
                self.parse_moov(pos + 8, pos + size)?;
                break;
            }
            pos += size;
        }

        if self.keyframes.is_empty() {
            return Err("no keyframes found — is this a valid MP4 with video?".to_string());
        }

        Ok(())
    }

    fn parse_moov(&mut self, start: usize, end: usize) -> Result<(), String> {
        let mut pos = start;
        while pos + 8 <= end.min(self.data.len()) {
            let (size, name) = read_box_header(self.data, pos)?;
            if size == 0 { break; }
            let box_end = (pos + size).min(end);

            match &name {
                b"mvhd" => { self.parse_mvhd(pos + 8)?; }
                b"trak" => { self.parse_trak(pos + 8, box_end)?; }
                _ => {}
            }
            pos = box_end;
        }
        Ok(())
    }

    fn parse_mvhd(&mut self, pos: usize) -> Result<(), String> {
        if pos >= self.data.len() { return Ok(()); }
        let version = self.data[pos];
        // FullBox: version(1) + flags(3) = 4 bytes before the date fields
        let (duration, timescale) = if version == 1 {
            let ts  = read_u32(self.data, pos + 4 + 8 + 8)?;
            let dur = read_u64(self.data, pos + 4 + 8 + 8 + 4)?;
            (dur as f64, ts)
        } else {
            let ts  = read_u32(self.data, pos + 4 + 4 + 4)?;
            let dur = read_u32(self.data, pos + 4 + 4 + 4 + 4)? as u64;
            (dur as f64, ts)
        };
        if timescale > 0 {
            self.duration_s = duration / timescale as f64;
        }
        Ok(())
    }

    fn parse_trak(&mut self, start: usize, end: usize) -> Result<(), String> {
        // Collect mdia first
        let mut mdia_range: Option<(usize, usize)> = None;
        let mut pos = start;
        while pos + 8 <= end.min(self.data.len()) {
            let (size, name) = read_box_header(self.data, pos)?;
            if size == 0 { break; }
            let box_end = (pos + size).min(end);
            if &name == b"mdia" { mdia_range = Some((pos + 8, box_end)); }
            pos = box_end;
        }

        if let Some((s, e)) = mdia_range {
            self.parse_mdia(s, e)?;
        }
        Ok(())
    }

    fn parse_mdia(&mut self, start: usize, end: usize) -> Result<(), String> {
        let mut hdlr_type = [0u8; 4];
        let mut mdhd_timescale = 0u32;
        let mut minf_range: Option<(usize, usize)> = None;

        let mut pos = start;
        while pos + 8 <= end.min(self.data.len()) {
            let (size, name) = read_box_header(self.data, pos)?;
            if size == 0 { break; }
            let box_end = (pos + size).min(end);

            match &name {
                b"hdlr" => {
                    // version(1) + flags(3) + pre_defined(4) + handler_type(4)
                    if pos + 8 + 8 + 4 <= self.data.len() {
                        hdlr_type.copy_from_slice(&self.data[pos + 8 + 8..pos + 8 + 8 + 4]);
                    }
                }
                b"mdhd" => {
                    let inner = pos + 8;
                    let version = if inner < self.data.len() { self.data[inner] } else { 0 };
                    // FullBox: version(1) + flags(3) = 4 bytes before date fields
                    mdhd_timescale = if version == 1 {
                        read_u32(self.data, inner + 4 + 8 + 8).unwrap_or(0)
                    } else {
                        read_u32(self.data, inner + 4 + 4 + 4).unwrap_or(0)
                    };
                }
                b"minf" => { minf_range = Some((pos + 8, box_end)); }
                _ => {}
            }
            pos = box_end;
        }

        // Only process video tracks
        if &hdlr_type != b"vide" { return Ok(()); }

        if let Some((s, e)) = minf_range {
            self.parse_minf(s, e, mdhd_timescale)?;
        }
        Ok(())
    }

    fn parse_minf(&mut self, start: usize, end: usize, timescale: u32) -> Result<(), String> {
        let mut pos = start;
        while pos + 8 <= end.min(self.data.len()) {
            let (size, name) = read_box_header(self.data, pos)?;
            if size == 0 { break; }
            let box_end = (pos + size).min(end);
            if &name == b"stbl" {
                self.parse_stbl(pos + 8, box_end, timescale)?;
            }
            pos = box_end;
        }
        Ok(())
    }

    fn parse_stbl(&mut self, start: usize, end: usize, timescale: u32) -> Result<(), String> {
        let mut stsd_pos: Option<usize> = None;
        let mut stts_data: Option<(usize, usize)> = None; // (pos, end) of stts contents
        let mut stss_data: Option<(usize, usize)> = None;
        let mut stsc_data: Option<(usize, usize)> = None;
        let mut stsz_data: Option<(usize, usize)> = None;
        let mut stco_data: Option<(usize, usize)> = None;
        let mut co64_data: Option<(usize, usize)> = None;
        let mut ctts_data: Option<(usize, usize)> = None;

        let mut pos = start;
        while pos + 8 <= end.min(self.data.len()) {
            let (size, name) = read_box_header(self.data, pos)?;
            if size == 0 { break; }
            let box_end = (pos + size).min(end);
            let inner = pos + 8; // skip box header

            match &name {
                b"stsd" => { stsd_pos = Some(inner); }
                b"stts" => { stts_data = Some((inner, box_end)); }
                b"stss" => { stss_data = Some((inner, box_end)); }
                b"stsc" => { stsc_data = Some((inner, box_end)); }
                b"stsz" => { stsz_data = Some((inner, box_end)); }
                b"stco" => { stco_data = Some((inner, box_end)); }
                b"co64" => { co64_data = Some((inner, box_end)); }
                b"ctts" => { ctts_data = Some((inner, box_end)); }
                _ => {}
            }
            pos = box_end;
        }

        // Parse codec config from stsd
        if let Some(p) = stsd_pos {
            self.parse_stsd(p)?;
        }

        // Build sample table
        let stts = stts_data.map(|(p, e)| parse_stts(self.data, p, e)).transpose()?;
        let stss = stss_data.map(|(p, e)| parse_stss(self.data, p, e)).transpose()?;
        let stsc = stsc_data.map(|(p, e)| parse_stsc(self.data, p, e)).transpose()?;
        let stsz = stsz_data.map(|(p, e)| parse_stsz(self.data, p, e)).transpose()?;
        let ctts = ctts_data.map(|(p, e)| parse_ctts(self.data, p, e)).transpose()?;

        let chunk_offsets: Option<Vec<u64>> = if let Some((p, e)) = co64_data {
            Some(parse_co64(self.data, p, e)?)
        } else if let Some((p, e)) = stco_data {
            Some(parse_stco(self.data, p, e)?.into_iter().map(|x| x as u64).collect())
        } else {
            None
        };

        let Some(stts) = stts else { return Ok(()); };
        let Some(stsc) = stsc else { return Ok(()); };
        let Some(stsz) = stsz else { return Ok(()); };
        let Some(offsets) = chunk_offsets else { return Ok(()); };

        // Expand stts into per-sample DTS
        let sample_count: u32 = stts.iter().map(|(count, _)| count).sum();
        let mut sample_dts: Vec<u64> = Vec::with_capacity(sample_count as usize);
        let mut dts = 0u64;
        for (count, delta) in &stts {
            for _ in 0..*count {
                sample_dts.push(dts);
                dts += *delta as u64;
            }
        }

        // Expand stsc into per-chunk sample counts
        // stsc entries: (first_chunk, samples_per_chunk, sample_description_index)
        let total_chunks = offsets.len();
        let mut chunk_sample_count: Vec<u32> = vec![0; total_chunks];
        for (i, &(first_chunk, spc, _)) in stsc.iter().enumerate() {
            let last_first = if i + 1 < stsc.len() { stsc[i + 1].0 as usize } else { total_chunks + 1 };
            for chunk_idx in (first_chunk as usize - 1)..(last_first - 1).min(total_chunks) {
                chunk_sample_count[chunk_idx] = spc;
            }
        }

        // Build per-sample byte offsets from chunk offsets + sample sizes
        let mut sample_byte_offsets: Vec<u64> = Vec::with_capacity(sample_count as usize);
        let mut sample_idx = 0usize;
        for (chunk_idx, &chunk_off) in offsets.iter().enumerate() {
            let n = chunk_sample_count.get(chunk_idx).copied().unwrap_or(0) as usize;
            let mut off = chunk_off;
            for _ in 0..n {
                sample_byte_offsets.push(off);
                let size = stsz.get(sample_idx).copied().unwrap_or(0) as u64;
                off += size;
                sample_idx += 1;
            }
        }

        // Determine which samples are keyframes
        let is_keyframe: Vec<bool> = if let Some(ref kf_list) = stss {
            let kf_set: std::collections::HashSet<u32> = kf_list.iter().copied().collect();
            (1..=sample_count).map(|i| kf_set.contains(&i)).collect()
        } else {
            // No stss → all samples are keyframes (e.g. intra-only streams)
            vec![true; sample_count as usize]
        };

        // Expand ctts into a per-sample composition offset (0 when absent).
        let sample_cts: Vec<i64> = if let Some(entries) = &ctts {
            let mut v = Vec::with_capacity(sample_count as usize);
            for (count, offset) in entries {
                for _ in 0..*count {
                    v.push(*offset);
                }
            }
            v
        } else {
            vec![0i64; sample_count as usize]
        };

        let ts = timescale.max(1) as f64;

        // Full per-sample table (all samples, in decode order) for VideoDecoder.
        for i in 0..sample_count as usize {
            let dts_val = sample_dts.get(i).copied().unwrap_or(0) as i64;
            let cts = sample_cts.get(i).copied().unwrap_or(0);
            let pts = (dts_val + cts).max(0);
            self.samples.push(SampleInfo {
                pts_s: pts as f64 / ts,
                dts_s: dts_val as f64 / ts,
                byte_offset: sample_byte_offsets.get(i).copied().unwrap_or(0),
                byte_length: stsz.get(i).copied().unwrap_or(0),
                is_keyframe: is_keyframe.get(i).copied().unwrap_or(false),
            });
        }

        let mut kf_index = 0u32;

        for (sample_num, is_kf) in is_keyframe.iter().enumerate() {
            if !is_kf { continue; }
            let dts_val = sample_dts.get(sample_num).copied().unwrap_or(0);
            let byte_off = sample_byte_offsets.get(sample_num).copied().unwrap_or(0);
            let size = stsz.get(sample_num).copied().unwrap_or(0);

            self.keyframes.push(KeyframeInfo {
                timestamp_s: dts_val as f64 / ts,
                byte_offset: byte_off,
                byte_length: size,
                index: kf_index,
            });
            kf_index += 1;
        }

        Ok(())
    }

    fn parse_stsd(&mut self, pos: usize) -> Result<(), String> {
        // stsd: version(1) + flags(3) + entry_count(4) + entries…
        if pos + 8 >= self.data.len() { return Ok(()); }
        let _entry_count = read_u32(self.data, pos + 4)?;
        // First entry starts at pos+8; it's a SampleEntry box
        let entry_start = pos + 8;
        if entry_start + 8 >= self.data.len() { return Ok(()); }
        let (_, entry_name) = read_box_header(self.data, entry_start)?;
        let entry_inner = entry_start + 8 + 6 + 2; // skip header + reserved(6) + data_ref_index(2)

        match &entry_name {
            b"avc1" | b"avc3" => {
                self.parse_avc_box(entry_inner)?;
            }
            b"hvc1" | b"hev1" => {
                self.parse_hevc_box(entry_inner)?;
            }
            _ => {}
        }
        Ok(())
    }

    fn parse_avc_box(&mut self, pos: usize) -> Result<(), String> {
        // VisualSampleEntry: reserved(16) + width(2) + height(2) + ...
        if pos + 24 > self.data.len() { return Ok(()); }
        self.config.width  = read_u16(self.data, pos + 16)? as u32;
        self.config.height = read_u16(self.data, pos + 18)? as u32;

        // Find avcC box within the remaining bytes of this entry
        let mut inner = pos + 70; // skip the standard VisualSampleEntry fields
        let limit = (pos + 512).min(self.data.len());
        while inner + 8 < limit {
            let (sz, nm) = read_box_header(self.data, inner)?;
            if sz == 0 { break; }
            if &nm == b"avcC" {
                let avcc_data = &self.data[inner + 8..(inner + sz).min(self.data.len())];
                // Derive codec string: avc1.<profile><constraint><level>
                if avcc_data.len() >= 4 {
                    let profile    = avcc_data[1];
                    let constraint = avcc_data[2];
                    let level      = avcc_data[3];
                    self.config.codec = format!("avc1.{:02X}{:02X}{:02X}", profile, constraint, level);
                }
                self.config.description_b64 = base64_encode(avcc_data);
                break;
            }
            inner += sz;
        }
        Ok(())
    }

    fn parse_hevc_box(&mut self, pos: usize) -> Result<(), String> {
        if pos + 24 > self.data.len() { return Ok(()); }
        self.config.width  = read_u16(self.data, pos + 16)? as u32;
        self.config.height = read_u16(self.data, pos + 18)? as u32;

        let mut inner = pos + 70;
        let limit = (pos + 512).min(self.data.len());
        while inner + 8 < limit {
            let (sz, nm) = read_box_header(self.data, inner)?;
            if sz == 0 { break; }
            if &nm == b"hvcC" {
                let hvcc_data = &self.data[inner + 8..(inner + sz).min(self.data.len())];
                self.config.codec = "hvc1.1.6.L93.B0".to_string(); // common baseline
                self.config.description_b64 = base64_encode(hvcc_data);
                break;
            }
            inner += sz;
        }
        Ok(())
    }
}

// ── Low-level MP4 table parsers ───────────────────────────────────────────────

fn parse_stts(data: &[u8], pos: usize, _end: usize) -> Result<Vec<(u32, u32)>, String> {
    // version(1) + flags(3) + entry_count(4) + entries[(sample_count(4), sample_delta(4))]
    let count = read_u32(data, pos + 4)? as usize;
    let base = pos + 8;
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let sample_count = read_u32(data, base + i * 8)?;
        let sample_delta = read_u32(data, base + i * 8 + 4)?;
        out.push((sample_count, sample_delta));
    }
    Ok(out)
}

fn parse_ctts(data: &[u8], pos: usize, _end: usize) -> Result<Vec<(u32, i64)>, String> {
    // version(1) + flags(3) + entry_count(4) + entries[(sample_count(4), offset(4))]
    // version 0 stores offset as u32; version 1 as i32. Read raw and reinterpret.
    let version = data.get(pos).copied().unwrap_or(0);
    let count = read_u32(data, pos + 4)? as usize;
    let base = pos + 8;
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let sample_count = read_u32(data, base + i * 8)?;
        let raw = read_u32(data, base + i * 8 + 4)?;
        let offset = if version == 0 { raw as i64 } else { raw as i32 as i64 };
        out.push((sample_count, offset));
    }
    Ok(out)
}

fn parse_stss(data: &[u8], pos: usize, _end: usize) -> Result<Vec<u32>, String> {
    let count = read_u32(data, pos + 4)? as usize;
    let base = pos + 8;
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        out.push(read_u32(data, base + i * 4)?);
    }
    Ok(out)
}

fn parse_stsc(data: &[u8], pos: usize, _end: usize) -> Result<Vec<(u32, u32, u32)>, String> {
    let count = read_u32(data, pos + 4)? as usize;
    let base = pos + 8;
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let first_chunk  = read_u32(data, base + i * 12)?;
        let samples_pc   = read_u32(data, base + i * 12 + 4)?;
        let desc_index   = read_u32(data, base + i * 12 + 8)?;
        out.push((first_chunk, samples_pc, desc_index));
    }
    Ok(out)
}

fn parse_stsz(data: &[u8], pos: usize, _end: usize) -> Result<Vec<u32>, String> {
    // version(1) + flags(3) + sample_size(4) + sample_count(4) + entries…
    let uniform_size = read_u32(data, pos + 4)?;
    let count = read_u32(data, pos + 8)? as usize;
    if uniform_size != 0 {
        return Ok(vec![uniform_size; count]);
    }
    let base = pos + 12;
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        out.push(read_u32(data, base + i * 4)?);
    }
    Ok(out)
}

fn parse_stco(data: &[u8], pos: usize, _end: usize) -> Result<Vec<u32>, String> {
    let count = read_u32(data, pos + 4)? as usize;
    let base = pos + 8;
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        out.push(read_u32(data, base + i * 4)?);
    }
    Ok(out)
}

fn parse_co64(data: &[u8], pos: usize, _end: usize) -> Result<Vec<u64>, String> {
    let count = read_u32(data, pos + 4)? as usize;
    let base = pos + 8;
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        out.push(read_u64(data, base + i * 8)?);
    }
    Ok(out)
}

// ── Binary read helpers ───────────────────────────────────────────────────────

fn read_box_header(data: &[u8], pos: usize) -> Result<(usize, [u8; 4]), String> {
    if pos + 8 > data.len() {
        return Err(format!("truncated box at {pos}"));
    }
    let size32 = u32::from_be_bytes(data[pos..pos + 4].try_into().unwrap()) as usize;
    let name: [u8; 4] = data[pos + 4..pos + 8].try_into().unwrap();
    let size = if size32 == 1 {
        // 64-bit extended size
        if pos + 16 > data.len() { return Err("truncated extended-size box".to_string()); }
        u64::from_be_bytes(data[pos + 8..pos + 16].try_into().unwrap()) as usize
    } else if size32 == 0 {
        data.len() - pos
    } else {
        size32
    };
    Ok((size, name))
}

#[inline]
fn read_u32(data: &[u8], pos: usize) -> Result<u32, String> {
    data.get(pos..pos + 4)
        .ok_or_else(|| format!("read_u32 out of bounds at {pos}"))
        .map(|b| u32::from_be_bytes(b.try_into().unwrap()))
}

#[inline]
fn read_u64(data: &[u8], pos: usize) -> Result<u64, String> {
    data.get(pos..pos + 8)
        .ok_or_else(|| format!("read_u64 out of bounds at {pos}"))
        .map(|b| u64::from_be_bytes(b.try_into().unwrap()))
}

#[inline]
fn read_u16(data: &[u8], pos: usize) -> Result<u16, String> {
    data.get(pos..pos + 2)
        .ok_or_else(|| format!("read_u16 out of bounds at {pos}"))
        .map(|b| u16::from_be_bytes(b.try_into().unwrap()))
}

// ── Minimal base64 encoder (no external dep) ──────────────────────────────────

fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { TABLE[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[(n & 63) as usize] as char } else { '=' });
    }
    out
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal synthetic MP4 with one I-frame to exercise the parser end-to-end.
    fn minimal_mp4() -> Vec<u8> {
        // Build a tiny but structurally valid MP4 with:
        //  ftyp + moov(mvhd + trak(tkhd + mdia(mdhd + hdlr + minf(stbl(…)))))
        // We only care that scan_inner does not panic and returns either
        // a valid result or a clear error — this test validates the parser path.
        let mut b: Vec<u8> = Vec::new();

        // ftyp box (24 bytes)
        b.extend_from_slice(&24u32.to_be_bytes());
        b.extend_from_slice(b"ftyp");
        b.extend_from_slice(b"isom");
        b.extend_from_slice(&0u32.to_be_bytes()); // minor version
        b.extend_from_slice(b"isom");
        b.extend_from_slice(b"mp41");

        b
    }

    #[test]
    fn base64_encode_roundtrip() {
        let input = b"Hello, World!";
        let encoded = base64_encode(input);
        assert_eq!(encoded, "SGVsbG8sIFdvcmxkIQ==");
    }

    #[test]
    fn base64_empty() {
        assert_eq!(base64_encode(b""), "");
    }

    #[test]
    fn ftyp_only_returns_error() {
        let mp4 = minimal_mp4();
        let result = scan_inner(&mp4);
        assert!(result.is_err(), "expected error for ftyp-only buffer");
    }

    #[test]
    fn parse_ctts_version0_unsigned() {
        // version 0, flags 0, entry_count 1, entry (sample_count=3, offset=10)
        let data = [0u8, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 3, 0, 0, 0, 10];
        assert_eq!(parse_ctts(&data, 0, data.len()).unwrap(), vec![(3, 10)]);
    }

    #[test]
    fn parse_ctts_version1_signed() {
        // version 1 → offset is i32; 0xFFFFFFFF == -1
        let data = [1u8, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 2, 0xFF, 0xFF, 0xFF, 0xFF];
        assert_eq!(parse_ctts(&data, 0, data.len()).unwrap(), vec![(2, -1)]);
    }

    #[test]
    fn samples_inner_ftyp_only_errors() {
        assert!(samples_inner(&minimal_mp4()).is_err());
    }

    #[test]
    fn real_mp4_full_sample_table() {
        // Validate the demuxer against actual footage, not just synthetic boxes.
        let bytes = include_bytes!("../../../public/sample-files/test-video.mp4");
        let table: SampleTable = serde_json::from_str(&samples_inner(bytes).unwrap()).unwrap();

        // Many frames, first is a keyframe, PTS is non-negative and starts at ~0.
        assert!(table.samples.len() > 30, "got {} samples", table.samples.len());
        assert!(table.samples[0].is_keyframe);
        assert!(table.samples.iter().all(|s| s.pts_s >= 0.0));

        // Keyframe count in the full table matches the keyframe-only scan.
        let scan: ScanResult = serde_json::from_str(&scan_inner(bytes).unwrap()).unwrap();
        let kf_in_table = table.samples.iter().filter(|s| s.is_keyframe).count();
        assert_eq!(kf_in_table, scan.keyframes.len());

        // Codec config is usable for VideoDecoder.
        assert!(table.config.codec.starts_with("avc1"));
        assert!(!table.config.description_b64.is_empty());
    }

    #[test]
    fn get_keyframe_bytes_out_of_bounds() {
        let data = vec![0u8; 10];
        let result = slice_keyframe(&data, 8, 5);
        assert!(result.is_err());
    }

    #[test]
    fn get_keyframe_bytes_valid() {
        let data: Vec<u8> = (0..16).collect();
        let result = slice_keyframe(&data, 4, 4).unwrap();
        assert_eq!(result, vec![4, 5, 6, 7]);
    }

    #[test]
    fn select_thumbnails_empty_result() {
        let json = r#"{"config":{"codec":"avc1.42E01E","description_b64":"","width":0,"height":0},"keyframes":[],"duration_s":0}"#;
        let r = select_thumbnail_keyframes(json, 5).unwrap();
        assert_eq!(r, "[]");
    }

    #[test]
    fn select_thumbnails_even_distribution() {
        let kfs: Vec<serde_json::Value> = (0..10)
            .map(|i| serde_json::json!({"timestamp_s": i, "byte_offset": 0, "byte_length": 100, "index": i}))
            .collect();
        let json = serde_json::json!({
            "config": {"codec":"avc1.42E01E","description_b64":"","width":1920,"height":1080},
            "keyframes": kfs,
            "duration_s": 10.0
        })
        .to_string();

        let indices: Vec<u32> =
            serde_json::from_str(&select_thumbnail_keyframes(&json, 5).unwrap()).unwrap();
        assert_eq!(indices.len(), 5);
        assert_eq!(indices[0], 0);
        assert_eq!(indices[4], 9);
    }
}
