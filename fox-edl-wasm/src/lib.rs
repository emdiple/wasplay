use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

// ── Frame math (free WASM functions) ─────────────────────────────────────────

/// Snap `time_s` to the nearest frame boundary for the given framerate.
#[wasm_bindgen]
pub fn snap_to_frame(time_s: f64, fps_num: u32, fps_den: u32) -> f64 {
    snap(time_s, fps_num, fps_den)
}

/// Convert seconds to the nearest frame number.
#[wasm_bindgen]
pub fn seconds_to_frames(time_s: f64, fps_num: u32, fps_den: u32) -> i64 {
    to_frames_inner(time_s, fps_num, fps_den)
}

/// Convert a frame number back to seconds.
#[wasm_bindgen]
pub fn frames_to_seconds(frames: i64, fps_num: u32, fps_den: u32) -> f64 {
    frames as f64 * fps_den as f64 / fps_num as f64
}

// ── Internal frame helpers ────────────────────────────────────────────────────

#[inline]
fn snap(t: f64, num: u32, den: u32) -> f64 {
    let fps = num as f64 / den as f64;
    (t * fps).round() / fps
}

#[inline]
fn to_frames_inner(t: f64, num: u32, den: u32) -> i64 {
    (t * num as f64 / den as f64).round() as i64
}

// ── Internal data types ───────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Framerate {
    num: u32,
    den: u32,
}

impl Framerate {
    fn fps(&self) -> f64 {
        self.num as f64 / self.den as f64
    }
    fn snap(&self, t: f64) -> f64 {
        snap(t, self.num, self.den)
    }
    fn frames(&self, t: f64) -> i64 {
        to_frames_inner(t, self.num, self.den)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
enum TransitionKind {
    Fade,
    Wipe,
    Slide,
    Zoom,
}

impl TransitionKind {
    fn ffmpeg_xfade(&self) -> &'static str {
        match self {
            TransitionKind::Fade => "fade",
            TransitionKind::Wipe => "wiperight",
            TransitionKind::Slide => "slideleft",
            TransitionKind::Zoom => "zoomin",
        }
    }
    fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "fade" | "dissolve" => Ok(TransitionKind::Fade),
            "wipe" => Ok(TransitionKind::Wipe),
            "slide" => Ok(TransitionKind::Slide),
            "zoom" => Ok(TransitionKind::Zoom),
            other => Err(format!("unknown transition type: {other}")),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Clip {
    id: String,
    source_id: String,
    source_in_s: f64,
    source_out_s: f64,
    timeline_in_s: f64,
    timeline_out_s: f64,
    video_track: u32,
    audio_track: Option<u32>,
    speed: f64,
    muted: bool,
}

impl Clip {
    fn source_dur(&self) -> f64 {
        self.source_out_s - self.source_in_s
    }
    fn timeline_dur(&self) -> f64 {
        self.timeline_out_s - self.timeline_in_s
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Transition {
    id: String,
    from_clip_id: String,
    to_clip_id: String,
    kind: TransitionKind,
    duration_s: f64,
}

// ── Timeline — stateful WASM object ──────────────────────────────────────────

#[wasm_bindgen]
pub struct Timeline {
    framerate: Framerate,
    clips: Vec<Clip>,
    transitions: Vec<Transition>,
    seq: u32,
}

// ── WASM public API (thin wrappers converting String→JsValue) ─────────────────

#[wasm_bindgen]
impl Timeline {
    /// Create a new empty timeline with the given framerate (num/den).
    #[wasm_bindgen(constructor)]
    pub fn new(fps_num: u32, fps_den: u32) -> Timeline {
        Timeline {
            framerate: Framerate {
                num: fps_num,
                den: fps_den,
            },
            clips: Vec::new(),
            transitions: Vec::new(),
            seq: 1,
        }
    }

    pub fn add_clip(
        &mut self,
        source_id: &str,
        source_in_s: f64,
        source_out_s: f64,
        timeline_in_s: f64,
        video_track: u32,
    ) -> Result<String, JsValue> {
        self.add_clip_inner(
            source_id,
            source_in_s,
            source_out_s,
            timeline_in_s,
            video_track,
        )
        .map_err(|e| JsValue::from_str(&e))
    }

    pub fn trim_clip(
        &mut self,
        clip_id: &str,
        new_source_in_s: f64,
        new_source_out_s: f64,
    ) -> Result<(), JsValue> {
        self.trim_clip_inner(clip_id, new_source_in_s, new_source_out_s)
            .map_err(|e| JsValue::from_str(&e))
    }

    pub fn cut_clip(&mut self, clip_id: &str, cut_time_s: f64) -> Result<String, JsValue> {
        self.cut_clip_inner(clip_id, cut_time_s)
            .map_err(|e| JsValue::from_str(&e))
    }

    pub fn move_clip(&mut self, clip_id: &str, new_timeline_in_s: f64) -> Result<(), JsValue> {
        self.move_clip_inner(clip_id, new_timeline_in_s)
            .map_err(|e| JsValue::from_str(&e))
    }

    pub fn delete_clip(&mut self, clip_id: &str) -> Result<(), JsValue> {
        self.delete_clip_inner(clip_id)
            .map_err(|e| JsValue::from_str(&e))
    }

    pub fn set_clip_speed(&mut self, clip_id: &str, speed: f64) -> Result<(), JsValue> {
        self.set_clip_speed_inner(clip_id, speed)
            .map_err(|e| JsValue::from_str(&e))
    }

    pub fn set_clip_muted(&mut self, clip_id: &str, muted: bool) -> Result<(), JsValue> {
        self.find_clip_mut(clip_id)
            .map(|c| {
                c.muted = muted;
            })
            .map_err(|e| JsValue::from_str(&e))
    }

    pub fn add_transition(
        &mut self,
        from_clip_id: &str,
        to_clip_id: &str,
        kind: &str,
        duration_s: f64,
    ) -> Result<String, JsValue> {
        self.add_transition_inner(from_clip_id, to_clip_id, kind, duration_s)
            .map_err(|e| JsValue::from_str(&e))
    }

    pub fn delete_transition(&mut self, trans_id: &str) -> Result<(), JsValue> {
        self.delete_transition_inner(trans_id)
            .map_err(|e| JsValue::from_str(&e))
    }

    /// Validate the timeline. Returns `{ valid, errors[], warnings[] }` JSON.
    pub fn validate(&self) -> String {
        self.validate_inner()
    }

    /// Export the full FFmpeg-compatible EDL as a JSON string.
    pub fn export_edl(&self) -> Result<String, JsValue> {
        self.export_edl_inner().map_err(|e| JsValue::from_str(&e))
    }

    /// Serialise timeline state to JSON (for undo/redo or persistence).
    pub fn to_json(&self) -> Result<String, JsValue> {
        self.to_json_inner().map_err(|e| JsValue::from_str(&e))
    }

    /// Restore a timeline from a previously serialised JSON snapshot.
    pub fn from_json(json: &str) -> Result<Timeline, JsValue> {
        Timeline::from_json_inner(json).map_err(|e| JsValue::from_str(&e))
    }

    /// Total timeline duration in seconds.
    pub fn duration_s(&self) -> f64 {
        self.clips
            .iter()
            .map(|c| c.timeline_out_s)
            .fold(0.0f64, f64::max)
    }

    pub fn clip_count(&self) -> usize {
        self.clips.len()
    }
}

// ── Pure Rust inner implementations (testable on native) ─────────────────────

impl Timeline {
    fn add_clip_inner(
        &mut self,
        source_id: &str,
        source_in_s: f64,
        source_out_s: f64,
        timeline_in_s: f64,
        video_track: u32,
    ) -> Result<String, String> {
        let src_in = self.framerate.snap(source_in_s);
        let src_out = self.framerate.snap(source_out_s);
        let tl_in = self.framerate.snap(timeline_in_s);

        if src_out <= src_in {
            return Err("source_out must be after source_in".to_string());
        }
        let dur = src_out - src_in;
        let tl_out = self.framerate.snap(tl_in + dur);
        let id = self.next_id("clip");

        self.clips.push(Clip {
            id: id.clone(),
            source_id: source_id.to_string(),
            source_in_s: src_in,
            source_out_s: src_out,
            timeline_in_s: tl_in,
            timeline_out_s: tl_out,
            video_track,
            audio_track: Some(video_track),
            speed: 1.0,
            muted: false,
        });
        Ok(id)
    }

    fn trim_clip_inner(
        &mut self,
        clip_id: &str,
        new_source_in_s: f64,
        new_source_out_s: f64,
    ) -> Result<(), String> {
        let fr = self.framerate.clone();
        let clip = self.find_clip_mut(clip_id)?;

        let new_in = fr.snap(new_source_in_s);
        let new_out = fr.snap(new_source_out_s);
        if new_out <= new_in {
            return Err("trim: source_out must be after source_in".to_string());
        }
        let dur = new_out - new_in;
        clip.source_in_s = new_in;
        clip.source_out_s = new_out;
        clip.timeline_out_s = fr.snap(clip.timeline_in_s + dur);
        Ok(())
    }

    fn cut_clip_inner(&mut self, clip_id: &str, cut_time_s: f64) -> Result<String, String> {
        let fr = self.framerate.clone();
        let cut = fr.snap(cut_time_s);

        let idx = self
            .clips
            .iter()
            .position(|c| c.id == clip_id)
            .ok_or_else(|| "clip not found".to_string())?;
        let clip = self.clips[idx].clone();

        if cut <= clip.timeline_in_s || cut >= clip.timeline_out_s {
            return Err("cut point must be inside the clip".to_string());
        }

        let elapsed = cut - clip.timeline_in_s;
        let new_src_in = fr.snap(clip.source_in_s + elapsed * clip.speed);

        self.clips[idx].source_out_s = new_src_in;
        self.clips[idx].timeline_out_s = cut;

        let new_id = self.next_id("clip");
        self.clips.push(Clip {
            id: new_id.clone(),
            source_id: clip.source_id,
            source_in_s: new_src_in,
            source_out_s: clip.source_out_s,
            timeline_in_s: cut,
            timeline_out_s: clip.timeline_out_s,
            video_track: clip.video_track,
            audio_track: clip.audio_track,
            speed: clip.speed,
            muted: clip.muted,
        });
        Ok(new_id)
    }

    fn move_clip_inner(&mut self, clip_id: &str, new_timeline_in_s: f64) -> Result<(), String> {
        let fr = self.framerate.clone();
        let clip = self.find_clip_mut(clip_id)?;
        let tl_in = fr.snap(new_timeline_in_s);
        let dur = clip.timeline_dur();
        clip.timeline_in_s = tl_in;
        clip.timeline_out_s = fr.snap(tl_in + dur);
        Ok(())
    }

    fn delete_clip_inner(&mut self, clip_id: &str) -> Result<(), String> {
        let before = self.clips.len();
        self.clips.retain(|c| c.id != clip_id);
        if self.clips.len() == before {
            return Err("clip not found".to_string());
        }
        self.transitions
            .retain(|t| t.from_clip_id != clip_id && t.to_clip_id != clip_id);
        Ok(())
    }

    fn set_clip_speed_inner(&mut self, clip_id: &str, speed: f64) -> Result<(), String> {
        if speed <= 0.0 {
            return Err("speed must be > 0".to_string());
        }
        let fr = self.framerate.clone();
        let clip = self.find_clip_mut(clip_id)?;
        let src_dur = clip.source_dur();
        clip.speed = speed;
        clip.timeline_out_s = fr.snap(clip.timeline_in_s + src_dur / speed);
        Ok(())
    }

    fn add_transition_inner(
        &mut self,
        from_clip_id: &str,
        to_clip_id: &str,
        kind: &str,
        duration_s: f64,
    ) -> Result<String, String> {
        let from = self
            .clips
            .iter()
            .find(|c| c.id == from_clip_id)
            .cloned()
            .ok_or_else(|| "from_clip not found".to_string())?;
        let to = self
            .clips
            .iter()
            .find(|c| c.id == to_clip_id)
            .cloned()
            .ok_or_else(|| "to_clip not found".to_string())?;

        let dur = self.framerate.snap(duration_s);
        if dur <= 0.0 {
            return Err("transition duration must be positive".to_string());
        }

        let max = from.timeline_dur().min(to.timeline_dur());
        if dur > max {
            return Err(format!(
                "transition duration {dur:.3}s exceeds clip limit {max:.3}s"
            ));
        }

        let kind = TransitionKind::from_str(kind)?;
        let id = self.next_id("trans");
        self.transitions.push(Transition {
            id: id.clone(),
            from_clip_id: from_clip_id.to_string(),
            to_clip_id: to_clip_id.to_string(),
            kind,
            duration_s: dur,
        });
        Ok(id)
    }

    fn delete_transition_inner(&mut self, trans_id: &str) -> Result<(), String> {
        let before = self.transitions.len();
        self.transitions.retain(|t| t.id != trans_id);
        if self.transitions.len() == before {
            return Err("transition not found".to_string());
        }
        Ok(())
    }

    fn validate_inner(&self) -> String {
        let mut errors: Vec<String> = Vec::new();
        let mut warnings: Vec<String> = Vec::new();
        let fps = self.framerate.fps();

        for clip in &self.clips {
            let tol = 0.5 / fps;
            for (name, t) in &[
                ("source_in", clip.source_in_s),
                ("source_out", clip.source_out_s),
                ("timeline_in", clip.timeline_in_s),
                ("timeline_out", clip.timeline_out_s),
            ] {
                if ((t * fps) - (t * fps).round()).abs() > tol * fps {
                    errors.push(format!(
                        "clip {}: {name} ({t:.6}s) is not on a frame boundary",
                        clip.id
                    ));
                }
            }
            if clip.source_out_s <= clip.source_in_s {
                errors.push(format!(
                    "clip {}: zero or negative source duration",
                    clip.id
                ));
            }
            if clip.speed <= 0.0 {
                errors.push(format!("clip {}: invalid speed {}", clip.id, clip.speed));
            }
        }

        // Overlap / gap check per video track
        let mut by_track: HashMap<u32, Vec<&Clip>> = HashMap::new();
        for clip in &self.clips {
            by_track.entry(clip.video_track).or_default().push(clip);
        }
        for (track, mut clips) in by_track {
            clips.sort_by(|a, b| a.timeline_in_s.partial_cmp(&b.timeline_in_s).unwrap());
            for pair in clips.windows(2) {
                let (a, b) = (pair[0], pair[1]);
                let overlap = a.timeline_out_s - b.timeline_in_s;
                if overlap > 1.0 / fps {
                    let has_trans = self.transitions.iter().any(|t| {
                        (t.from_clip_id == a.id && t.to_clip_id == b.id)
                            || (t.from_clip_id == b.id && t.to_clip_id == a.id)
                    });
                    if !has_trans {
                        errors.push(format!(
                            "track {track}: clips {} and {} overlap by {overlap:.3}s with no transition",
                            a.id, b.id
                        ));
                    }
                } else {
                    let gap = b.timeline_in_s - a.timeline_out_s;
                    if gap > 1.0 / fps {
                        warnings.push(format!(
                            "track {track}: {gap:.3}s gap between {} and {}",
                            a.id, b.id
                        ));
                    }
                }
            }
        }

        for trans in &self.transitions {
            let from = self.clips.iter().find(|c| c.id == trans.from_clip_id);
            let to = self.clips.iter().find(|c| c.id == trans.to_clip_id);
            match (from, to) {
                (None, _) => errors.push(format!(
                    "transition {}: from_clip '{}' not found",
                    trans.id, trans.from_clip_id
                )),
                (_, None) => errors.push(format!(
                    "transition {}: to_clip '{}' not found",
                    trans.id, trans.to_clip_id
                )),
                (Some(f), Some(t)) => {
                    let max = f.timeline_dur().min(t.timeline_dur());
                    if trans.duration_s > max {
                        errors.push(format!(
                            "transition {}: duration {:.3}s exceeds clip limit {max:.3}s",
                            trans.id, trans.duration_s
                        ));
                    }
                }
            }
        }

        serde_json::json!({
            "valid":            errors.is_empty(),
            "errors":           errors,
            "warnings":         warnings,
            "clip_count":       self.clips.len(),
            "transition_count": self.transitions.len(),
        })
        .to_string()
    }

    fn export_edl_inner(&self) -> Result<String, String> {
        let fr = &self.framerate;
        let fps = fr.fps();

        let mut source_order: Vec<String> = Vec::new();
        for clip in &self.clips {
            if !source_order.contains(&clip.source_id) {
                source_order.push(clip.source_id.clone());
            }
        }
        let source_index: HashMap<&str, usize> = source_order
            .iter()
            .enumerate()
            .map(|(i, id)| (id.as_str(), i))
            .collect();

        let total_s = self
            .clips
            .iter()
            .map(|c| c.timeline_out_s)
            .fold(0.0f64, f64::max);

        let video_clips: Vec<serde_json::Value> = {
            let mut clips: Vec<&Clip> = self.clips.iter().collect();
            clips.sort_by(|a, b| {
                a.video_track
                    .cmp(&b.video_track)
                    .then(a.timeline_in_s.partial_cmp(&b.timeline_in_s).unwrap())
            });
            clips
                .iter()
                .map(|c| {
                    serde_json::json!({
                        "id":                 c.id,
                        "source_id":          c.source_id,
                        "input_index":        source_index[c.source_id.as_str()],
                        "track":              c.video_track,
                        "audio_track":        c.audio_track,
                        "source_in_frame":    fr.frames(c.source_in_s),
                        "source_out_frame":   fr.frames(c.source_out_s),
                        "timeline_in_frame":  fr.frames(c.timeline_in_s),
                        "timeline_out_frame": fr.frames(c.timeline_out_s),
                        "source_in_s":        c.source_in_s,
                        "source_out_s":       c.source_out_s,
                        "timeline_in_s":      c.timeline_in_s,
                        "timeline_out_s":     c.timeline_out_s,
                        "speed":              c.speed,
                        "muted":              c.muted,
                    })
                })
                .collect()
        };

        let transitions: Vec<serde_json::Value> = self
            .transitions
            .iter()
            .filter_map(|t| {
                let from = self.clips.iter().find(|c| c.id == t.from_clip_id)?;
                let offset_s = from.timeline_out_s - t.duration_s;
                Some(serde_json::json!({
                    "id":              t.id,
                    "type":            t.kind.ffmpeg_xfade(),
                    "from_clip_id":    t.from_clip_id,
                    "to_clip_id":      t.to_clip_id,
                    "duration_s":      t.duration_s,
                    "duration_frames": fr.frames(t.duration_s),
                    "offset_s":        offset_s,
                    "offset_frames":   fr.frames(offset_s),
                }))
            })
            .collect();

        let ffmpeg = build_ffmpeg_section(&self.clips, &self.transitions, &source_index, fr);

        let edl = serde_json::json!({
            "version": "1.0",
            "framerate": { "num": fr.num, "den": fr.den, "fps": fps },
            "total_frames":     fr.frames(total_s),
            "total_duration_s": total_s,
            "sources": source_order.iter().enumerate()
                .map(|(i, id)| serde_json::json!({ "source_id": id, "input_index": i }))
                .collect::<Vec<_>>(),
            "video_clips":  video_clips,
            "transitions":  transitions,
            "ffmpeg":        ffmpeg,
        });

        serde_json::to_string_pretty(&edl).map_err(|e| e.to_string())
    }

    fn to_json_inner(&self) -> Result<String, String> {
        #[derive(Serialize)]
        struct State<'a> {
            framerate: &'a Framerate,
            clips: &'a Vec<Clip>,
            transitions: &'a Vec<Transition>,
            seq: u32,
        }
        serde_json::to_string(&State {
            framerate: &self.framerate,
            clips: &self.clips,
            transitions: &self.transitions,
            seq: self.seq,
        })
        .map_err(|e| e.to_string())
    }

    fn from_json_inner(json: &str) -> Result<Timeline, String> {
        #[derive(Deserialize)]
        struct State {
            framerate: Framerate,
            clips: Vec<Clip>,
            transitions: Vec<Transition>,
            seq: u32,
        }
        let s: State = serde_json::from_str(json).map_err(|e| e.to_string())?;
        Ok(Timeline {
            framerate: s.framerate,
            clips: s.clips,
            transitions: s.transitions,
            seq: s.seq,
        })
    }

    fn find_clip_mut(&mut self, id: &str) -> Result<&mut Clip, String> {
        self.clips
            .iter_mut()
            .find(|c| c.id == id)
            .ok_or_else(|| "clip not found".to_string())
    }

    fn next_id(&mut self, prefix: &str) -> String {
        let id = format!("{prefix}_{:04}", self.seq);
        self.seq += 1;
        id
    }
}

// ── FFmpeg filter_complex builder ─────────────────────────────────────────────

fn build_ffmpeg_section(
    clips: &[Clip],
    transitions: &[Transition],
    source_index: &HashMap<&str, usize>,
    fr: &Framerate,
) -> serde_json::Value {
    let mut ordered: Vec<&Clip> = clips.iter().filter(|c| c.video_track == 0).collect();
    ordered.sort_by(|a, b| a.timeline_in_s.partial_cmp(&b.timeline_in_s).unwrap());

    let fps = fr.fps();
    let mut video_filters: Vec<String> = Vec::new();
    let mut audio_filters: Vec<String> = Vec::new();
    let mut audio_labels: Vec<String> = Vec::new();

    for (i, clip) in ordered.iter().enumerate() {
        let input = source_index[clip.source_id.as_str()];
        let setpts = if (clip.speed - 1.0).abs() < 1e-6 {
            "setpts=PTS-STARTPTS".to_string()
        } else {
            format!("setpts=(PTS-STARTPTS)/{:.6}", clip.speed)
        };
        video_filters.push(format!(
            "[{input}:v]trim=start={:.6}:end={:.6},{setpts},fps={fps:.6}[v{i}]",
            clip.source_in_s, clip.source_out_s
        ));

        if !clip.muted {
            let al = format!("a{i}");
            let atempo = if (clip.speed - 1.0).abs() < 1e-6 {
                String::new()
            } else {
                format!(",atempo={:.6}", clip.speed)
            };
            audio_filters.push(format!(
                "[{input}:a]atrim=start={:.6}:end={:.6},asetpts=PTS-STARTPTS{atempo}[{al}]",
                clip.source_in_s, clip.source_out_s
            ));
            audio_labels.push(al);
        }
    }

    let (v_out, chain) = build_video_chain(&ordered, transitions);
    video_filters.extend(chain);

    let (a_out, a_concat) = if audio_labels.len() <= 1 {
        (
            audio_labels
                .into_iter()
                .next()
                .unwrap_or_else(|| "anull".to_string()),
            None,
        )
    } else {
        let inputs: String = audio_labels.iter().map(|l| format!("[{l}]")).collect();
        let n = audio_labels.len();
        (
            "aout".to_string(),
            Some(format!("{inputs}concat=n={n}:v=0:a=1[aout]")),
        )
    };
    if let Some(c) = a_concat {
        audio_filters.push(c);
    }

    let mut all_parts = video_filters;
    all_parts.extend(audio_filters);
    let filter_complex = all_parts.join(";\n");

    let mut src_list: Vec<(&str, usize)> = source_index.iter().map(|(k, v)| (*k, *v)).collect();
    src_list.sort_by_key(|(_, i)| *i);
    let input_args: String = src_list
        .iter()
        .map(|(id, _)| format!("-i \"{id}\""))
        .collect::<Vec<_>>()
        .join(" ");
    let suggested_cmd = format!(
        "ffmpeg {input_args} -filter_complex \"{fc}\" -map \"[{v_out}]\" -map \"[{a_out}]\" output.mp4",
        fc = filter_complex.replace('"', "\\\""),
    );

    serde_json::json!({
        "filter_complex":     filter_complex,
        "video_output_label": v_out,
        "audio_output_label": a_out,
        "suggested_command":  suggested_cmd,
    })
}

fn build_video_chain(clips: &[&Clip], transitions: &[Transition]) -> (String, Vec<String>) {
    if clips.is_empty() {
        return ("vout".to_string(), vec![]);
    }
    if clips.len() == 1 {
        return ("v0".to_string(), vec![]);
    }

    let mut parts: Vec<String> = Vec::new();
    let mut cur: String = "v0".to_string();
    // Track total OUTPUT duration so xfade offsets stay correct
    let mut accumulated_out_dur: f64 = clips[0].timeline_dur();

    for i in 1..clips.len() {
        let prev = clips[i - 1];
        let clip = clips[i];
        let clip_dur = clip.timeline_dur();
        let out_label = if i + 1 < clips.len() {
            format!("xf{i}")
        } else {
            "vout".to_string()
        };

        let trans = transitions
            .iter()
            .find(|t| t.from_clip_id == prev.id && t.to_clip_id == clip.id);

        if let Some(t) = trans {
            let offset = (accumulated_out_dur - t.duration_s).max(0.0);
            parts.push(format!(
                "[{cur}][v{i}]xfade=transition={kind}:duration={dur:.6}:offset={off:.6}[{out_label}]",
                kind = t.kind.ffmpeg_xfade(),
                dur  = t.duration_s,
                off  = offset,
            ));
            accumulated_out_dur += clip_dur - t.duration_s;
        } else {
            parts.push(format!("[{cur}][v{i}]concat=n=2:v=1:a=0[{out_label}]"));
            accumulated_out_dur += clip_dur;
        }
        cur = out_label;
    }

    ("vout".to_string(), parts)
}

// ── Tests (call inner methods, no JsValue) ────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn tl25() -> Timeline {
        Timeline::new(25, 1)
    }
    fn tl24() -> Timeline {
        Timeline::new(24, 1)
    }

    // ── Frame math ────────────────────────────────────────────────────────────

    #[test]
    fn snap_to_frame_24fps() {
        // 1.01 * 24 = 24.24 → rounds to 24 → 24/24 = 1.0
        assert!((snap_to_frame(1.01, 24, 1) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn snap_already_aligned() {
        let t = 3.0 / 24.0; // frame 3 at 24fps
        assert!((snap_to_frame(t, 24, 1) - t).abs() < 1e-9);
    }

    #[test]
    fn seconds_frames_roundtrip_25fps() {
        let frames = 250i64;
        let s = frames_to_seconds(frames, 25, 1);
        assert_eq!(seconds_to_frames(s, 25, 1), frames);
    }

    #[test]
    fn frames_to_seconds_23976() {
        // 24 frames at 23.976 fps = 24 * 1001/24000 = 1.001s
        let s = frames_to_seconds(24, 24000, 1001);
        assert!((s - 1.001).abs() < 1e-6);
    }

    // ── add_clip ──────────────────────────────────────────────────────────────

    #[test]
    fn add_clip_basic() {
        let mut tl = tl25();
        tl.add_clip_inner("a.mp4", 0.0, 5.0, 0.0, 0).unwrap();
        tl.add_clip_inner("b.mp4", 0.0, 3.0, 5.0, 0).unwrap();
        assert_eq!(tl.clip_count(), 2);
        assert!((tl.duration_s() - 8.0).abs() < 1e-6);
    }

    #[test]
    fn add_clip_snaps_to_frame() {
        let mut tl = tl24();
        tl.add_clip_inner("a.mp4", 0.01, 5.01, 0.01, 0).unwrap();
        let clip = &tl.clips[0];
        let fps = 24.0f64;
        assert!((clip.source_in_s * fps - (clip.source_in_s * fps).round()).abs() < 1e-6);
        assert!((clip.source_out_s * fps - (clip.source_out_s * fps).round()).abs() < 1e-6);
        assert!((clip.timeline_in_s * fps - (clip.timeline_in_s * fps).round()).abs() < 1e-6);
    }

    #[test]
    fn add_clip_rejects_zero_duration() {
        let mut tl = tl25();
        assert!(tl.add_clip_inner("a.mp4", 5.0, 5.0, 0.0, 0).is_err());
        assert!(tl.add_clip_inner("a.mp4", 6.0, 4.0, 0.0, 0).is_err());
    }

    #[test]
    fn add_clip_returns_unique_ids() {
        let mut tl = tl25();
        let id1 = tl.add_clip_inner("a.mp4", 0.0, 5.0, 0.0, 0).unwrap();
        let id2 = tl.add_clip_inner("b.mp4", 0.0, 5.0, 5.0, 0).unwrap();
        assert_ne!(id1, id2);
    }

    // ── trim_clip ─────────────────────────────────────────────────────────────

    #[test]
    fn trim_updates_out_point() {
        let mut tl = tl25();
        let id = tl.add_clip_inner("a.mp4", 0.0, 10.0, 0.0, 0).unwrap();
        tl.trim_clip_inner(&id, 2.0, 7.0).unwrap();
        let c = &tl.clips[0];
        assert!((c.source_in_s - 2.0).abs() < 1e-6);
        assert!((c.source_out_s - 7.0).abs() < 1e-6);
        assert!((c.timeline_out_s - 5.0).abs() < 1e-6);
    }

    #[test]
    fn trim_rejects_inverted_range() {
        let mut tl = tl25();
        let id = tl.add_clip_inner("a.mp4", 0.0, 10.0, 0.0, 0).unwrap();
        assert!(tl.trim_clip_inner(&id, 7.0, 2.0).is_err());
    }

    // ── cut_clip ──────────────────────────────────────────────────────────────

    #[test]
    fn cut_splits_into_two() {
        let mut tl = tl25();
        let id = tl.add_clip_inner("a.mp4", 0.0, 10.0, 0.0, 0).unwrap();
        let new_id = tl.cut_clip_inner(&id, 4.0).unwrap();

        assert_eq!(tl.clip_count(), 2);
        let left = tl.clips.iter().find(|c| c.id == id).unwrap();
        let right = tl.clips.iter().find(|c| c.id == new_id).unwrap();

        assert!((left.timeline_out_s - 4.0).abs() < 1e-6);
        assert!((right.timeline_in_s - 4.0).abs() < 1e-6);
        assert!((right.timeline_out_s - 10.0).abs() < 1e-6);
        // Left source_out + right source duration should equal total original source duration
        assert!((left.source_out_s + right.source_dur() - 10.0).abs() < 1e-6);
    }

    #[test]
    fn cut_outside_clip_is_error() {
        let mut tl = tl25();
        let id = tl.add_clip_inner("a.mp4", 0.0, 5.0, 2.0, 0).unwrap();
        assert!(tl.cut_clip_inner(&id, 0.0).is_err()); // before
        assert!(tl.cut_clip_inner(&id, 9.0).is_err()); // after
    }

    // ── move_clip ─────────────────────────────────────────────────────────────

    #[test]
    fn move_preserves_duration() {
        let mut tl = tl25();
        let id = tl.add_clip_inner("a.mp4", 0.0, 8.0, 0.0, 0).unwrap();
        tl.move_clip_inner(&id, 10.0).unwrap();
        let c = &tl.clips[0];
        assert!((c.timeline_in_s - 10.0).abs() < 1e-6);
        assert!((c.timeline_out_s - 18.0).abs() < 1e-6);
    }

    // ── delete_clip ───────────────────────────────────────────────────────────

    #[test]
    fn delete_removes_clip_and_transitions() {
        let mut tl = tl25();
        let a = tl.add_clip_inner("a.mp4", 0.0, 5.0, 0.0, 0).unwrap();
        let b = tl.add_clip_inner("b.mp4", 0.0, 5.0, 4.5, 0).unwrap();
        tl.add_transition_inner(&a, &b, "fade", 0.5).unwrap();
        tl.delete_clip_inner(&a).unwrap();
        assert_eq!(tl.clip_count(), 1);
        assert_eq!(tl.transitions.len(), 0);
    }

    #[test]
    fn delete_nonexistent_is_error() {
        let mut tl = tl25();
        assert!(tl.delete_clip_inner("clip_9999").is_err());
    }

    // ── speed ─────────────────────────────────────────────────────────────────

    #[test]
    fn double_speed_halves_timeline_duration() {
        let mut tl = tl25();
        let id = tl.add_clip_inner("a.mp4", 0.0, 10.0, 0.0, 0).unwrap();
        tl.set_clip_speed_inner(&id, 2.0).unwrap();
        assert!((tl.clips[0].timeline_dur() - 5.0).abs() < 1e-6);
    }

    #[test]
    fn zero_speed_is_error() {
        let mut tl = tl25();
        let id = tl.add_clip_inner("a.mp4", 0.0, 5.0, 0.0, 0).unwrap();
        assert!(tl.set_clip_speed_inner(&id, 0.0).is_err());
        assert!(tl.set_clip_speed_inner(&id, -1.0).is_err());
    }

    // ── transitions ───────────────────────────────────────────────────────────

    #[test]
    fn transition_too_long_fails() {
        let mut tl = tl25();
        let a = tl.add_clip_inner("a.mp4", 0.0, 2.0, 0.0, 0).unwrap();
        let b = tl.add_clip_inner("b.mp4", 0.0, 2.0, 1.5, 0).unwrap();
        assert!(tl.add_transition_inner(&a, &b, "fade", 3.0).is_err());
        assert!(tl.add_transition_inner(&a, &b, "fade", 1.0).is_ok());
    }

    #[test]
    fn unknown_kind_fails() {
        let mut tl = tl25();
        let a = tl.add_clip_inner("a.mp4", 0.0, 5.0, 0.0, 0).unwrap();
        let b = tl.add_clip_inner("b.mp4", 0.0, 5.0, 4.5, 0).unwrap();
        assert!(tl.add_transition_inner(&a, &b, "teleport", 0.5).is_err());
    }

    #[test]
    fn all_kinds_accepted() {
        for kind in &["fade", "dissolve", "wipe", "slide", "zoom"] {
            let mut tl = tl25();
            let a = tl.add_clip_inner("a.mp4", 0.0, 5.0, 0.0, 0).unwrap();
            let b = tl.add_clip_inner("b.mp4", 0.0, 5.0, 4.5, 0).unwrap();
            assert!(
                tl.add_transition_inner(&a, &b, kind, 0.5).is_ok(),
                "kind {kind} rejected"
            );
        }
    }

    // ── validate ──────────────────────────────────────────────────────────────

    #[test]
    fn validate_clean_timeline() {
        let mut tl = tl25();
        tl.add_clip_inner("a.mp4", 0.0, 5.0, 0.0, 0).unwrap();
        tl.add_clip_inner("b.mp4", 0.0, 3.0, 5.0, 0).unwrap();
        let r: serde_json::Value = serde_json::from_str(&tl.validate_inner()).unwrap();
        assert!(r["valid"].as_bool().unwrap());
        assert_eq!(r["errors"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn validate_overlap_no_transition() {
        let mut tl = tl25();
        tl.add_clip_inner("a.mp4", 0.0, 5.0, 0.0, 0).unwrap();
        tl.add_clip_inner("b.mp4", 0.0, 5.0, 3.0, 0).unwrap();
        let r: serde_json::Value = serde_json::from_str(&tl.validate_inner()).unwrap();
        assert!(!r["valid"].as_bool().unwrap());
    }

    #[test]
    fn validate_overlap_with_transition_ok() {
        let mut tl = tl25();
        let a = tl.add_clip_inner("a.mp4", 0.0, 5.0, 0.0, 0).unwrap();
        let b = tl.add_clip_inner("b.mp4", 0.0, 5.0, 4.5, 0).unwrap();
        tl.add_transition_inner(&a, &b, "fade", 0.5).unwrap();
        let r: serde_json::Value = serde_json::from_str(&tl.validate_inner()).unwrap();
        assert!(r["valid"].as_bool().unwrap());
    }

    #[test]
    fn validate_gap_produces_warning() {
        let mut tl = tl25();
        tl.add_clip_inner("a.mp4", 0.0, 3.0, 0.0, 0).unwrap();
        tl.add_clip_inner("b.mp4", 0.0, 3.0, 5.0, 0).unwrap(); // 2s gap
        let r: serde_json::Value = serde_json::from_str(&tl.validate_inner()).unwrap();
        assert!(r["valid"].as_bool().unwrap()); // gaps are warnings, not errors
        assert!(!r["warnings"].as_array().unwrap().is_empty());
    }

    // ── EDL export ────────────────────────────────────────────────────────────

    #[test]
    fn edl_required_fields() {
        let mut tl = tl25();
        tl.add_clip_inner("a.mp4", 0.0, 5.0, 0.0, 0).unwrap();
        tl.add_clip_inner("b.mp4", 0.0, 3.0, 5.0, 0).unwrap();
        let edl: serde_json::Value = serde_json::from_str(&tl.export_edl_inner().unwrap()).unwrap();

        assert_eq!(edl["version"], "1.0");
        assert_eq!(edl["framerate"]["num"], 25);
        assert_eq!(edl["total_frames"], 200); // 8s * 25fps
        assert_eq!(edl["video_clips"].as_array().unwrap().len(), 2);
        assert_eq!(edl["sources"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn edl_frame_counts_correct() {
        let mut tl = tl25();
        tl.add_clip_inner("a.mp4", 0.0, 5.0, 0.0, 0).unwrap();
        let edl: serde_json::Value = serde_json::from_str(&tl.export_edl_inner().unwrap()).unwrap();
        let c = &edl["video_clips"][0];
        assert_eq!(c["source_in_frame"], 0);
        assert_eq!(c["source_out_frame"], 125); // 5s * 25fps
        assert_eq!(c["timeline_in_frame"], 0);
        assert_eq!(c["timeline_out_frame"], 125);
    }

    #[test]
    fn edl_two_clips_concat_filter() {
        let mut tl = tl25();
        tl.add_clip_inner("a.mp4", 0.0, 5.0, 0.0, 0).unwrap();
        tl.add_clip_inner("b.mp4", 0.0, 3.0, 5.0, 0).unwrap();
        let edl: serde_json::Value = serde_json::from_str(&tl.export_edl_inner().unwrap()).unwrap();
        let fc = edl["ffmpeg"]["filter_complex"].as_str().unwrap();
        assert!(fc.contains("concat"), "expected concat in: {fc}");
        assert!(fc.contains("[0:v]"), "expected [0:v] in: {fc}");
        assert!(fc.contains("[1:v]"), "expected [1:v] in: {fc}");
    }

    #[test]
    fn edl_xfade_in_filter_complex() {
        let mut tl = tl25();
        let a = tl.add_clip_inner("a.mp4", 0.0, 5.0, 0.0, 0).unwrap();
        let b = tl.add_clip_inner("b.mp4", 0.0, 5.0, 4.5, 0).unwrap();
        tl.add_transition_inner(&a, &b, "fade", 0.5).unwrap();
        let edl: serde_json::Value = serde_json::from_str(&tl.export_edl_inner().unwrap()).unwrap();
        let fc = edl["ffmpeg"]["filter_complex"].as_str().unwrap();
        assert!(fc.contains("xfade"), "expected xfade in: {fc}");
        assert!(fc.contains("fade"), "expected fade kind in: {fc}");
    }

    #[test]
    fn edl_same_source_deduped() {
        let mut tl = tl25();
        tl.add_clip_inner("a.mp4", 0.0, 5.0, 0.0, 0).unwrap();
        tl.add_clip_inner("a.mp4", 5.0, 10.0, 5.0, 0).unwrap(); // same source, different range
        let edl: serde_json::Value = serde_json::from_str(&tl.export_edl_inner().unwrap()).unwrap();
        // Only one source entry
        assert_eq!(edl["sources"].as_array().unwrap().len(), 1);
        // Both clips reference input_index 0
        assert_eq!(edl["video_clips"][0]["input_index"], 0);
        assert_eq!(edl["video_clips"][1]["input_index"], 0);
    }

    // ── Serialisation ─────────────────────────────────────────────────────────

    #[test]
    fn roundtrip_json() {
        let mut tl = tl24();
        let a = tl.add_clip_inner("a.mp4", 0.0, 5.0, 0.0, 0).unwrap();
        tl.add_clip_inner("b.mp4", 0.0, 3.0, 5.0, 0).unwrap();
        tl.add_transition_inner(&a, "clip_0002", "wipe", 0.5)
            .unwrap();
        let json = tl.to_json_inner().unwrap();
        let restored = Timeline::from_json_inner(&json).unwrap();
        assert_eq!(restored.clip_count(), 2);
        assert_eq!(restored.transitions.len(), 1);
        assert!((restored.duration_s() - 8.0).abs() < 1e-6);
    }
}
