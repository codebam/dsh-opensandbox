import { closeSync, mkdtempSync, openSync, unlinkSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Bounded, offset-based output collector with the same read semantics as the
 * local subprocess provider's collected readers:
 * - `readFrom(fromByte)` is non-consuming and addressed by whole-stream offset;
 * - overflow keeps the tail and reports `lossy` for reads that slid out of it;
 * - when a spill cap is configured, the complete stream is mirrored to a
 *   `0600` file under a fresh `0700` directory; reads then return `spillPath`
 *   so consumers can recover the dropped prefix.
 */
export class TailCollector {
  constructor({ maxBytes, spillMaxBytes } = {}) {
    this.maxBytes = Math.max(1, Number(maxBytes) || 1)
    this.spillMaxBytes = Number(spillMaxBytes) > 0 ? Number(spillMaxBytes) : 0
    this.chunks = []
    this.totalBytes = 0
    this.tailStart = 0
    this.spill = null
    this.spillBytes = 0
    this.spillBroken = false
    this.closed = false
    if (this.spillMaxBytes > 0) {
      try {
        const dir = mkdtempSync(join(tmpdir(), 'dsh-opensandbox-'))
        const file = join(dir, 'stream.log')
        const fd = openSync(file, 'wx', 0o600)
        this.spill = { dir, file, fd }
      } catch {
        this.spill = null
      }
    }
  }

  /** Append one chunk (`Buffer`, `Uint8Array`, or string). */
  push(chunk) {
    if (this.closed) return
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk)
    if (buffer.length === 0) return
    this.totalBytes += buffer.length
    this.chunks.push(buffer)
    this.dropTailPrefix()
    this.writeSpill(buffer)
  }

  /** True when any bytes were dropped from the retained window. */
  get truncated() {
    return this.tailStart > 0
  }

  /** Current retained tail as UTF-8 text. */
  get tailText() {
    return Buffer.concat(this.chunks).toString('utf8')
  }

  /** Offset of the first retained byte. */
  get startOffset() {
    return this.tailStart
  }

  /** Total bytes observed. */
  get endOffset() {
    return this.totalBytes
  }

  /** Path of the complete-spill file, when one is intact. */
  get spillPath() {
    return !this.spillBroken && this.spill !== null ? this.spill.file : undefined
  }

  /** Read the stream text at or after `fromByte`. */
  readFrom(fromByte) {
    const requested = Number.isFinite(fromByte) ? Math.max(0, Math.floor(fromByte)) : 0
    const lossy = requested < this.tailStart
    let cursor = this.tailStart
    const selected = []
    for (const chunk of this.chunks) {
      const next = cursor + chunk.length
      if (next > requested) {
        const from = Math.max(0, requested - cursor)
        selected.push(from > 0 ? chunk.subarray(from) : chunk)
      }
      cursor = next
    }
    const text = Buffer.concat(selected).toString('utf8')
    const read = { text, nextOffset: this.totalBytes, lossy }
    if (lossy && this.spillPath !== undefined) read.spillPath = this.spillPath
    return read
  }

  /** Finish the spill file and return its path, when intact. */
  close() {
    if (this.closed) return this.spillPath
    this.closed = true
    if (this.spill !== null) {
      try {
        closeSync(this.spill.fd)
      } catch {
        this.spillBroken = true
      }
      if (this.spillBroken) {
        try {
          unlinkSync(this.spill.file)
        } catch {
          // best-effort cleanup
        }
      }
    }
    return this.spillPath
  }

  /** Drop front chunks until the retained tail fits `maxBytes`. */
  dropTailPrefix() {
    while (this.totalBytes - this.tailStart > this.maxBytes && this.chunks.length > 0) {
      const head = this.chunks[0]
      const overflow = this.totalBytes - this.tailStart - this.maxBytes
      if (head.length <= overflow) {
        this.chunks.shift()
        this.tailStart += head.length
      } else {
        this.chunks[0] = head.subarray(overflow)
        this.tailStart += overflow
      }
    }
  }

  /** Mirror one chunk into the spill file, enforcing the spill cap. */
  writeSpill(buffer) {
    if (this.spillBroken || this.spill === null) return
    this.spillBytes += buffer.length
    if (this.spillBytes > this.spillMaxBytes) {
      this.spillBroken = true
      try {
        closeSync(this.spill.fd)
      } catch {
        // ignore
      }
      try {
        unlinkSync(this.spill.file)
      } catch {
        // ignore
      }
      return
    }
    try {
      writeSync(this.spill.fd, buffer)
    } catch {
      this.spillBroken = true
      try {
        closeSync(this.spill.fd)
      } catch {
        // ignore
      }
      try {
        unlinkSync(this.spill.file)
      } catch {
        // ignore
      }
    }
  }
}
