//! A symphonia `MediaSource` backed by a synchronous JavaScript read callback.
//!
//! The callback — supplied from a Web Worker as `(offset, len) => Uint8Array`
//! implemented with `FileReaderSync` — lets Rust pull arbitrary byte ranges out
//! of a `File`/`Blob` on demand. Symphonia reads packets lazily, so the entire
//! media file is never held in WASM memory: peak usage is a few decode buffers
//! regardless of whether the input is 10 MB or 10 GB.

use std::io::{self, Read, Seek, SeekFrom};

use symphonia::core::io::MediaSource;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

/// Lazily reads byte ranges from a JS `File` via a synchronous callback.
pub struct JsReader {
    /// `(offset: f64, len: f64) -> Uint8Array` — reads `len` bytes at `offset`.
    read_fn: js_sys::Function,
    /// Total length of the underlying file in bytes.
    len: u64,
    /// Current read cursor.
    pos: u64,
}

// SAFETY: wasm32 in the browser is single-threaded; there is no other thread
// that could observe the `!Send`/`!Sync` `js_sys::Function`. Symphonia's
// `MediaSource` bound requires `Send + Sync`, so we assert it here. This is the
// standard pattern for bridging JS callbacks into thread-safe Rust traits on
// wasm; it must not be compiled for a real multi-threaded target.
unsafe impl Send for JsReader {}
unsafe impl Sync for JsReader {}

impl JsReader {
    pub fn new(read_fn: js_sys::Function, len: u64) -> Self {
        Self { read_fn, len, pos: 0 }
    }

    /// Invoke the JS callback and return the bytes it produced.
    fn call(&self, offset: u64, len: u64) -> io::Result<js_sys::Uint8Array> {
        let ret = self
            .read_fn
            .call2(
                &JsValue::NULL,
                &JsValue::from_f64(offset as f64),
                &JsValue::from_f64(len as f64),
            )
            .map_err(|_| io::Error::new(io::ErrorKind::Other, "read callback threw"))?;

        ret.dyn_into::<js_sys::Uint8Array>()
            .map_err(|_| io::Error::new(io::ErrorKind::Other, "read callback did not return a Uint8Array"))
    }
}

impl Read for JsReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() || self.pos >= self.len {
            return Ok(0);
        }
        let want = (buf.len() as u64).min(self.len - self.pos);
        let arr = self.call(self.pos, want)?;
        let n = (arr.length() as usize).min(buf.len());
        if n == 0 {
            return Ok(0);
        }
        arr.subarray(0, n as u32).copy_to(&mut buf[..n]);
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for JsReader {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let target: i64 = match from {
            SeekFrom::Start(o) => o as i64,
            SeekFrom::End(o) => self.len as i64 + o,
            SeekFrom::Current(o) => self.pos as i64 + o,
        };
        if target < 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "seek before start of file"));
        }
        self.pos = target as u64;
        Ok(self.pos)
    }
}

impl MediaSource for JsReader {
    fn is_seekable(&self) -> bool {
        true
    }
    fn byte_len(&self) -> Option<u64> {
        Some(self.len)
    }
}

/// Read the first `len` bytes via the callback — used for cheap container
/// sniffing before the callback is handed off to a streaming [`JsReader`].
#[allow(dead_code)] // used by some crates for container sniffing, not all
pub fn read_prefix(read_fn: &js_sys::Function, len: u64) -> Result<Vec<u8>, String> {
    let ret = read_fn
        .call2(&JsValue::NULL, &JsValue::from_f64(0.0), &JsValue::from_f64(len as f64))
        .map_err(|_| "read callback threw".to_string())?;
    ret.dyn_into::<js_sys::Uint8Array>()
        .map(|arr| arr.to_vec())
        .map_err(|_| "read callback did not return a Uint8Array".to_string())
}
