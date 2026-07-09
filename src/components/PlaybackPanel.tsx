import { useEffect, useMemo, useRef } from 'react'
import { useVoxlyStore } from '../store'

function extensionFor(mime: string): string {
  if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a'
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3'
  if (mime.includes('wav')) return 'wav'
  if (mime.includes('ogg')) return 'ogg'
  return 'webm'
}

export function PlaybackPanel() {
  const blob = useVoxlyStore((s) => s.recordingBlob)
  const audioKind = useVoxlyStore((s) => s.audioKind)
  const seekRequest = useVoxlyStore((s) => s.seekRequest)
  const requestSeek = useVoxlyStore((s) => s.requestSeek)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const url = useMemo(() => (blob ? URL.createObjectURL(blob) : null), [blob])
  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [url])

  // MediaRecorder webm blobs report Infinity duration until forced to scan;
  // nudge to the end once so the seek bar and timestamp-jumps work.
  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !url) return
    const onMeta = () => {
      if (audio.duration === Infinity) {
        const restore = () => {
          audio.currentTime = 0
          audio.removeEventListener('timeupdate', restore)
        }
        audio.addEventListener('timeupdate', restore)
        audio.currentTime = 1e7
      }
    }
    audio.addEventListener('loadedmetadata', onMeta)
    return () => audio.removeEventListener('loadedmetadata', onMeta)
  }, [url])

  // Jump requested from a transcript timestamp.
  useEffect(() => {
    if (seekRequest === null) return
    const audio = audioRef.current
    if (audio) {
      try {
        audio.currentTime = seekRequest
        void audio.play().catch(() => {})
      } catch {
        /* metadata not ready yet */
      }
    }
    requestSeek(null)
  }, [seekRequest, requestSeek])

  if (!url || !blob) return null

  return (
    <div className="panel playback-panel">
      <h2>{audioKind === 'file' ? 'Audio file' : 'Session recording'}</h2>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- the transcript IS the caption */}
      <audio ref={audioRef} controls src={url} className="audio-player" preload="metadata" />
      <div className="playback-actions">
        <a
          className="btn btn-ghost"
          href={url}
          download={`voxly-recording.${extensionFor(blob.type)}`}
        >
          ⬇ Download audio
        </a>
      </div>
      <p className="hint">Tap a timestamp in the transcript to play from that moment.</p>
    </div>
  )
}
