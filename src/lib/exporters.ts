import { summarize, summaryIsEmpty, summaryToText } from './summarizer'
import type { Speaker, TranscriptSegment } from '../types'

/**
 * Transcript export formats. The Word exporter dynamically imports the docx
 * library so it is only downloaded (as its own chunk) the first time someone
 * actually exports a .docx.
 */

function speakerName(speakerId: number, speakers: Speaker[]): string {
  return speakers.find((s) => s.id === speakerId)?.name ?? 'Unknown speaker'
}

function finalSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  return segments.filter((s) => !s.interim && s.text.trim())
}

function formatClock(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function formatSrtTime(seconds: number): string {
  const clamped = Math.max(0, seconds)
  const h = Math.floor(clamped / 3600)
  const m = Math.floor((clamped % 3600) / 60)
  const s = Math.floor(clamped % 60)
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000)
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s
    .toString()
    .padStart(2, '0')},${ms.toString().padStart(3, '0')}`
}

export function transcriptToTxt(segments: TranscriptSegment[], speakers: Speaker[]): string {
  const body = finalSegments(segments)
    .map((s) => `[${formatClock(s.startTime)}] ${speakerName(s.speakerId, speakers)}: ${s.text}`)
    .join('\n\n')
  const summary = summarize(segments, 'meeting')
  if (summaryIsEmpty(summary)) return body
  return `${summaryToText(summary, speakers)}\n\n${'='.repeat(40)}\nTRANSCRIPT\n\n${body}`
}

export function transcriptToSrt(segments: TranscriptSegment[], speakers: Speaker[]): string {
  return finalSegments(segments)
    .map((segment, index) => {
      // SRT requires a positive display window even for zero-length segments.
      const end = Math.max(segment.endTime, segment.startTime + 0.5)
      return [
        `${index + 1}`,
        `${formatSrtTime(segment.startTime)} --> ${formatSrtTime(end)}`,
        `${speakerName(segment.speakerId, speakers)}: ${segment.text}`,
      ].join('\n')
    })
    .join('\n\n')
}

export async function transcriptToDocx(
  segments: TranscriptSegment[],
  speakers: Speaker[],
): Promise<Blob> {
  const { Document, HeadingLevel, Packer, Paragraph, TextRun } = await import('docx')

  const summary = summarize(segments, 'meeting')
  const summaryChildren = summaryIsEmpty(summary)
    ? []
    : [
        new Paragraph({ text: 'Summary', heading: HeadingLevel.HEADING_1 }),
        ...summary.overview.map((s) => new Paragraph({ text: s, spacing: { after: 120 } })),
        ...(summary.keyPoints.length > 0
          ? [
              new Paragraph({ text: 'Key points', heading: HeadingLevel.HEADING_2 }),
              ...summary.keyPoints.map(
                (s) => new Paragraph({ text: s, bullet: { level: 0 } }),
              ),
            ]
          : []),
        ...(summary.actionItems.length > 0
          ? [
              new Paragraph({ text: 'Action items', heading: HeadingLevel.HEADING_2 }),
              ...summary.actionItems.map(
                (a) =>
                  new Paragraph({
                    bullet: { level: 0 },
                    children: [
                      new TextRun({ text: `${a.text} ` }),
                      new TextRun({
                        text: `— ${speakerName(a.ownerId, speakers)}`,
                        italics: true,
                        color: '666666',
                      }),
                    ],
                  }),
              ),
            ]
          : []),
        ...(summary.decisions.length > 0
          ? [
              new Paragraph({ text: 'Decisions', heading: HeadingLevel.HEADING_2 }),
              ...summary.decisions.map((s) => new Paragraph({ text: s, bullet: { level: 0 } })),
            ]
          : []),
        new Paragraph({ text: '' }),
      ]

  const children = [
    ...summaryChildren,
    new Paragraph({ text: 'Meeting transcript', heading: HeadingLevel.HEADING_1 }),
    ...finalSegments(segments).map(
      (segment) =>
        new Paragraph({
          spacing: { after: 200 },
          children: [
            new TextRun({
              text: `${speakerName(segment.speakerId, speakers)} `,
              bold: true,
            }),
            new TextRun({
              text: `[${formatClock(segment.startTime)}]`,
              color: '888888',
              size: 18,
            }),
            new TextRun({ text: `  ${segment.text}` }),
          ],
        }),
    ),
  ]

  const doc = new Document({ sections: [{ children }] })
  return Packer.toBlob(doc)
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
