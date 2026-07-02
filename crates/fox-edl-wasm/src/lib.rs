//! fox-edl-wasm — a small, **stateless** EDL (Edit Decision List) exporter.
//!
//! This crate does not hold or edit timeline state. The editor's Zustand store is
//! the single source of truth and performs all interactive edits (cut, arrange,
//! link/detach) in JS. This crate is a pure transform: it takes a snapshot of the
//! current project (sources + the video and audio tracks) as JSON and produces an
//! EDL — a frame-accurate description of the edit, plus a best-effort FFmpeg
//! `filter_complex` + command — for **external use** (real FFmpeg, other tools).
//!
//! The model deliberately mirrors the app's current, simple capabilities: two
//! single-layer tracks (video + audio), clips that reference a source with an
//! in-point, a duration, and a timeline position, linked A/V pairs, and a `z`
//! stacking order for the rare overlap. No transitions, speed changes, or
//! per-clip effects yet — those get added here when the editor grows them.

use serde::Deserialize;
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

// ── Frame-time helpers ────────────────────────────────────────────────────────

/// Snap `time_s` to the nearest whole frame at `fps_num / fps_den`.
#[wasm_bindgen]
pub fn snap_to_frame(time_s: f64, fps_num: u32, fps_den: u32) -> f64 {
    let fps = fps_num as f64 / fps_den as f64;
    (time_s * fps).round() / fps
}

/// Convert seconds to a whole frame count at `fps_num / fps_den`.
#[wasm_bindgen]
pub fn seconds_to_frames(time_s: f64, fps_num: u32, fps_den: u32) -> i64 {
    (time_s * fps_num as f64 / fps_den as f64).round() as i64
}

/// Convert a whole frame count back to seconds at `fps_num / fps_den`.
#[wasm_bindgen]
pub fn frames_to_seconds(frames: i64, fps_num: u32, fps_den: u32) -> f64 {
    frames as f64 * fps_den as f64 / fps_num as f64
}

// ── Input model — mirrors the editor store's shape ────────────────────────────

fn default_fps() -> f64 {
    30.0
}

#[derive(Deserialize, Clone, Debug)]
struct Source {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    duration_s: f64,
    #[serde(default)]
    width: u32,
    #[serde(default)]
    height: u32,
    #[serde(default)]
    has_audio: bool,
    #[serde(default)]
    is_video: bool,
}

#[derive(Deserialize, Clone, Debug)]
struct Clip {
    id: String,
    source_id: String,
    #[serde(default)]
    link: String,
    /// Timeline position of the clip's left edge, in seconds.
    start_s: f64,
    /// In-point within the source, in seconds.
    in_s: f64,
    /// Clip duration, in seconds.
    dur_s: f64,
    #[serde(default)]
    z: i32,
}

impl Clip {
    fn out_s(&self) -> f64 {
        self.in_s + self.dur_s
    }
    fn timeline_out_s(&self) -> f64 {
        self.start_s + self.dur_s
    }
}

#[derive(Deserialize, Debug)]
struct Project {
    #[serde(default = "default_fps")]
    fps: f64,
    #[serde(default)]
    sources: Vec<Source>,
    #[serde(default)]
    video_clips: Vec<Clip>,
    #[serde(default)]
    audio_clips: Vec<Clip>,
}

// ── Public WASM API ───────────────────────────────────────────────────────────

/// Export the project as an EDL JSON string (frame-accurate events + an FFmpeg
/// `filter_complex` and suggested command) for external use.
#[wasm_bindgen]
pub fn export_edl(project_json: &str) -> Result<String, JsValue> {
    let project: Project =
        serde_json::from_str(project_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
    export_edl_inner(&project).map_err(|e| JsValue::from_str(&e))
}

/// Validate the project against its sources. Returns JSON
/// `{ valid, errors[], warnings[] }`.
#[wasm_bindgen]
pub fn validate(project_json: &str) -> Result<String, JsValue> {
    let project: Project =
        serde_json::from_str(project_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
    Ok(validate_inner(&project))
}

// ── EDL construction ──────────────────────────────────────────────────────────

fn frames(fps: f64, t: f64) -> i64 {
    (t * fps).round() as i64
}

/// Distinct sources referenced by any clip, in `project.sources` order, each
/// paired with the FFmpeg input index it maps to.
fn used_sources<'a>(project: &'a Project) -> (Vec<&'a Source>, HashMap<&'a str, usize>) {
    let mut referenced: Vec<&str> = Vec::new();
    for clip in project.video_clips.iter().chain(project.audio_clips.iter()) {
        if !referenced.contains(&clip.source_id.as_str()) {
            referenced.push(&clip.source_id);
        }
    }
    let ordered: Vec<&Source> = project
        .sources
        .iter()
        .filter(|s| referenced.contains(&s.id.as_str()))
        .collect();
    let index: HashMap<&str, usize> = ordered
        .iter()
        .enumerate()
        .map(|(i, s)| (s.id.as_str(), i))
        .collect();
    (ordered, index)
}

fn source_lookup<'a>(project: &'a Project) -> HashMap<&'a str, &'a Source> {
    project.sources.iter().map(|s| (s.id.as_str(), s)).collect()
}

fn event_json(fps: f64, clip: &Clip, input_index: usize) -> serde_json::Value {
    serde_json::json!({
        "clip_id":            clip.id,
        "source_id":          clip.source_id,
        "link":               clip.link,
        "input_index":        input_index,
        "z":                  clip.z,
        "source_in_frame":    frames(fps, clip.in_s),
        "source_out_frame":   frames(fps, clip.out_s()),
        "timeline_in_frame":  frames(fps, clip.start_s),
        "timeline_out_frame": frames(fps, clip.timeline_out_s()),
        "source_in_s":        clip.in_s,
        "source_out_s":       clip.out_s(),
        "timeline_in_s":      clip.start_s,
        "timeline_out_s":     clip.timeline_out_s(),
    })
}

fn export_edl_inner(project: &Project) -> Result<String, String> {
    let fps = if project.fps > 0.0 { project.fps } else { 30.0 };
    let (sources, index) = used_sources(project);

    // Video events sorted by z (ascending → higher z composits on top), then start.
    let mut video: Vec<&Clip> = project.video_clips.iter().collect();
    video.sort_by(|a, b| {
        a.z.cmp(&b.z)
            .then(a.start_s.partial_cmp(&b.start_s).unwrap_or(std::cmp::Ordering::Equal))
    });
    // Audio events sorted by start.
    let mut audio: Vec<&Clip> = project.audio_clips.iter().collect();
    audio.sort_by(|a, b| a.start_s.partial_cmp(&b.start_s).unwrap_or(std::cmp::Ordering::Equal));

    let total_s = project
        .video_clips
        .iter()
        .chain(project.audio_clips.iter())
        .map(Clip::timeline_out_s)
        .fold(0.0_f64, f64::max);

    let video_events: Vec<serde_json::Value> = video
        .iter()
        .map(|c| event_json(fps, c, index[c.source_id.as_str()]))
        .collect();
    let audio_events: Vec<serde_json::Value> = audio
        .iter()
        .map(|c| event_json(fps, c, index[c.source_id.as_str()]))
        .collect();

    let ffmpeg = build_ffmpeg(project, &video, &audio, &index, fps, total_s);

    let edl = serde_json::json!({
        "version":          "2.0",
        "framerate":        { "fps": fps },
        "total_frames":     frames(fps, total_s),
        "total_duration_s": total_s,
        "sources": sources.iter().enumerate().map(|(i, s)| serde_json::json!({
            "source_id":   s.id,
            "name":        s.name,
            "input_index": i,
            "is_video":    s.is_video,
            "has_audio":   s.has_audio,
            "width":       s.width,
            "height":      s.height,
            "duration_s":  s.duration_s,
        })).collect::<Vec<_>>(),
        "video_events": video_events,
        "audio_events": audio_events,
        "ffmpeg":       ffmpeg,
    });

    serde_json::to_string_pretty(&edl).map_err(|e| e.to_string())
}

// ── FFmpeg filter_complex builder (overlay + adelay/amix) ─────────────────────
//
// Video: composite each clip over a black base at its timeline offset (overlay
// gated to the clip's span), so gaps show black and overlaps resolve by z-order.
// Audio: place each clip with `adelay` then sum with `amix`.

fn out_dimensions(video: &[&Clip], sources: &HashMap<&str, &Source>) -> (u32, u32) {
    let mut w = 0;
    let mut h = 0;
    for clip in video {
        if let Some(src) = sources.get(clip.source_id.as_str()) {
            if src.width > w {
                w = src.width;
            }
            if src.height > h {
                h = src.height;
            }
        }
    }
    if w == 0 || h == 0 {
        (1280, 720)
    } else {
        (w, h)
    }
}

fn build_ffmpeg(
    project: &Project,
    video: &[&Clip],
    audio: &[&Clip],
    index: &HashMap<&str, usize>,
    fps: f64,
    total_s: f64,
) -> serde_json::Value {
    let sources = source_lookup(project);
    let (w, h) = out_dimensions(video, &sources);
    let dur = total_s.max(0.0);

    let mut parts: Vec<String> = Vec::new();

    // ── Video chain ──
    let mut v_out: Option<String> = None;
    if !video.is_empty() {
        parts.push(format!(
            "color=c=black:s={w}x{h}:r={fps}:d={dur:.6}[base]"
        ));
        for (i, clip) in video.iter().enumerate() {
            let idx = index[clip.source_id.as_str()];
            parts.push(format!(
                "[{idx}:v]trim=start={in_s:.6}:end={out_s:.6},setpts=PTS-STARTPTS+{t0:.6}/TB,\
                 scale={w}:{h}:force_original_aspect_ratio=decrease,\
                 pad={w}:{h}:(ow-iw)/2:(oh-ih)/2[v{i}]",
                idx = idx,
                in_s = clip.in_s,
                out_s = clip.out_s(),
                t0 = clip.start_s,
                w = w,
                h = h,
                i = i,
            ));
        }
        // Chain overlays: base ← v0 ← v1 ← …, each gated to its timeline span.
        let mut prev = "base".to_string();
        for (i, clip) in video.iter().enumerate() {
            let out = if i + 1 == video.len() {
                "vout".to_string()
            } else {
                format!("ov{i}")
            };
            parts.push(format!(
                "[{prev}][v{i}]overlay=enable='between(t,{t0:.6},{t1:.6})'[{out}]",
                prev = prev,
                i = i,
                t0 = clip.start_s,
                t1 = clip.timeline_out_s(),
                out = out,
            ));
            prev = out;
        }
        v_out = Some("vout".to_string());
    }

    // ── Audio chain ──
    let mut a_out: Option<String> = None;
    if !audio.is_empty() {
        for (j, clip) in audio.iter().enumerate() {
            let idx = index[clip.source_id.as_str()];
            let delay_ms = (clip.start_s * 1000.0).round() as i64;
            parts.push(format!(
                "[{idx}:a]atrim=start={in_s:.6}:end={out_s:.6},asetpts=PTS-STARTPTS,\
                 adelay={delay}|{delay}[a{j}]",
                idx = idx,
                in_s = clip.in_s,
                out_s = clip.out_s(),
                delay = delay_ms,
                j = j,
            ));
        }
        if audio.len() == 1 {
            // Single stream: relabel to [aout] without mixing.
            parts.push("[a0]anull[aout]".to_string());
        } else {
            let inputs: String = (0..audio.len()).map(|j| format!("[a{j}]")).collect();
            parts.push(format!(
                "{inputs}amix=inputs={n}:normalize=0[aout]",
                inputs = inputs,
                n = audio.len(),
            ));
        }
        a_out = Some("aout".to_string());
    }

    let filter_complex = parts.join(";\n");

    // Input args reference each used source by name (fallback to its id).
    let (ordered, _) = used_sources(project);
    let input_args: String = ordered
        .iter()
        .map(|s| {
            let target = if s.name.is_empty() { &s.id } else { &s.name };
            format!("-i \"{target}\"")
        })
        .collect::<Vec<_>>()
        .join(" ");

    let mut maps = String::new();
    if let Some(v) = &v_out {
        maps.push_str(&format!(" -map \"[{v}]\""));
    }
    if let Some(a) = &a_out {
        maps.push_str(&format!(" -map \"[{a}]\""));
    }

    let suggested_command = if filter_complex.is_empty() {
        String::new()
    } else {
        format!(
            "ffmpeg {input_args} -filter_complex \"{fc}\"{maps} output.mp4",
            input_args = input_args,
            fc = filter_complex.replace('\n', " ").replace('"', "\\\""),
            maps = maps,
        )
    };

    serde_json::json!({
        "output": { "width": w, "height": h, "fps": fps },
        "filter_complex":    filter_complex,
        "suggested_command": suggested_command,
    })
}

// ── Validation ────────────────────────────────────────────────────────────────

fn validate_inner(project: &Project) -> String {
    let sources = source_lookup(project);
    let mut errors: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    let check = |clip: &Clip, track: &str, errors: &mut Vec<String>, warnings: &mut Vec<String>| {
        match sources.get(clip.source_id.as_str()) {
            None => errors.push(format!(
                "{track} clip {} references unknown source {}",
                clip.id, clip.source_id
            )),
            Some(src) => {
                if clip.dur_s <= 0.0 {
                    errors.push(format!("{track} clip {} has non-positive duration", clip.id));
                }
                if clip.in_s < -1e-6 {
                    errors.push(format!("{track} clip {} has a negative in-point", clip.id));
                }
                if src.duration_s > 0.0 && clip.out_s() > src.duration_s + 1e-3 {
                    warnings.push(format!(
                        "{track} clip {} extends past its source's duration",
                        clip.id
                    ));
                }
            }
        }
    };

    for clip in &project.video_clips {
        check(clip, "video", &mut errors, &mut warnings);
    }
    for clip in &project.audio_clips {
        check(clip, "audio", &mut errors, &mut warnings);
    }

    let result = serde_json::json!({
        "valid":    errors.is_empty(),
        "errors":   errors,
        "warnings": warnings,
    });
    result.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn sample_project() -> &'static str {
        // One source cut into two video segments arranged in sequence, with a
        // linked audio clip under the first segment.
        r#"{
            "fps": 30,
            "sources": [
                { "id": "s1", "name": "a.mp4", "duration_s": 10, "width": 1280, "height": 720, "has_audio": true, "is_video": true }
            ],
            "video_clips": [
                { "id": "v1", "source_id": "s1", "link": "l1", "start_s": 0, "in_s": 0, "dur_s": 4, "z": 1 },
                { "id": "v2", "source_id": "s1", "link": "l2", "start_s": 4, "in_s": 4, "dur_s": 3, "z": 2 }
            ],
            "audio_clips": [
                { "id": "a1", "source_id": "s1", "link": "l1", "start_s": 0, "in_s": 0, "dur_s": 4, "z": 1 }
            ]
        }"#
    }

    #[test]
    fn frame_helpers_roundtrip() {
        assert_eq!(seconds_to_frames(1.0, 30, 1), 30);
        assert_eq!(frames_to_seconds(30, 30, 1), 1.0);
        assert!((snap_to_frame(0.51, 30, 1) - 0.5).abs() < 1.0 / 30.0);
    }

    #[test]
    fn export_edl_basic_shape() {
        let out = export_edl(sample_project()).unwrap();
        let edl: Value = serde_json::from_str(&out).unwrap();

        assert_eq!(edl["total_duration_s"], 7.0);
        assert_eq!(edl["total_frames"], 210);
        assert_eq!(edl["sources"].as_array().unwrap().len(), 1);
        assert_eq!(edl["video_events"].as_array().unwrap().len(), 2);
        assert_eq!(edl["audio_events"].as_array().unwrap().len(), 1);
        // Second video segment starts at frame 120 (4s @ 30fps).
        assert_eq!(edl["video_events"][1]["timeline_in_frame"], 120);
    }

    #[test]
    fn export_edl_ffmpeg_contains_overlay_and_delay() {
        let out = export_edl(sample_project()).unwrap();
        let edl: Value = serde_json::from_str(&out).unwrap();
        let fc = edl["ffmpeg"]["filter_complex"].as_str().unwrap();
        assert!(fc.contains("color=c=black"));
        assert!(fc.contains("overlay=enable"));
        assert!(fc.contains("adelay="));
        let cmd = edl["ffmpeg"]["suggested_command"].as_str().unwrap();
        assert!(cmd.contains("-map \"[vout]\""));
        assert!(cmd.contains("-map \"[aout]\""));
        assert!(cmd.contains("-i \"a.mp4\""));
    }

    #[test]
    fn audio_only_project_has_no_video_map() {
        let json = r#"{
            "fps": 25,
            "sources": [ { "id": "s1", "name": "song.mp3", "duration_s": 30, "has_audio": true, "is_video": false } ],
            "audio_clips": [ { "id": "a1", "source_id": "s1", "link": "", "start_s": 2, "in_s": 0, "dur_s": 5, "z": 1 } ]
        }"#;
        let edl: Value = serde_json::from_str(&export_edl(json).unwrap()).unwrap();
        assert_eq!(edl["video_events"].as_array().unwrap().len(), 0);
        let cmd = edl["ffmpeg"]["suggested_command"].as_str().unwrap();
        assert!(!cmd.contains("[vout]"));
        assert!(cmd.contains("-map \"[aout]\""));
    }

    #[test]
    fn validate_flags_out_of_bounds_and_unknown_source() {
        let json = r#"{
            "sources": [ { "id": "s1", "duration_s": 5, "is_video": true } ],
            "video_clips": [
                { "id": "v1", "source_id": "s1", "start_s": 0, "in_s": 3, "dur_s": 4, "z": 1 },
                { "id": "v2", "source_id": "ghost", "start_s": 0, "in_s": 0, "dur_s": 1, "z": 1 }
            ]
        }"#;
        let res: Value = serde_json::from_str(&validate(json).unwrap()).unwrap();
        assert_eq!(res["valid"], false);
        assert!(!res["errors"].as_array().unwrap().is_empty()); // unknown source
        assert!(!res["warnings"].as_array().unwrap().is_empty()); // out of bounds
    }
}
