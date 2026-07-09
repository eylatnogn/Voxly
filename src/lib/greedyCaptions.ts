/**
 * Greedy word capture for live captions.
 *
 * The browser recognizer constantly revises its interim text — pausing,
 * rewriting, and sometimes RETRACTING words it already showed while it
 * decides what the phrase "should" be. During that deliberation, spoken words
 * get dropped. Voxly's priority is the opposite: capture words the moment
 * they're heard and never take them back — the auto-refine pass after the
 * session is where corrections belong.
 *
 * Strategy: words that have moved more than MUTABLE_TAIL_WORDS behind the
 * live edge are LOCKED. Later interim revisions can extend the text but can
 * never rewrite or remove locked words. When the recognizer finalizes a
 * phrase, its version wins only if it kept at least as many words as we
 * locked — a final that "corrected away" captured words loses to the capture.
 */

/** Only the last N interim words remain open to revision. */
export const MUTABLE_TAIL_WORDS = 1

export class GreedyCaption {
  private locked: string[] = []
  /** Exactly what is currently on screen: locked words + the mutable tail. */
  private display: string[] = []

  /** Feed the latest interim text; returns the text to display. */
  update(interimText: string): string {
    const words = interimText.trim().split(/\s+/).filter(Boolean)
    const lockUpTo = Math.min(
      words.length,
      Math.max(this.locked.length, words.length - MUTABLE_TAIL_WORDS),
    )
    for (let i = this.locked.length; i < lockUpTo; i++) {
      this.locked.push(words[i])
    }
    const tail = words.slice(this.locked.length)
    const next = [...this.locked, ...tail]
    // The display is monotonic: a retraction may not shorten what the user
    // has already seen — only same-length-or-longer updates apply.
    if (next.length >= this.display.length) this.display = next
    return this.display.join(' ')
  }

  /**
   * The recognizer finalized a phrase. Words the user has SEEN — including
   * the mutable edge word — are never rewritten or dropped: the final's
   * "corrections" contribute only the words it has beyond the displayed
   * text. A final that dropped words loses entirely.
   */
  finalize(finalText: string): string {
    const finalWords = finalText.trim().split(/\s+/).filter(Boolean)
    const base = this.display.length > this.locked.length ? this.display : this.locked
    let words: string[]
    if (base.length === 0) {
      words = finalWords // nothing was shown yet — take the final as-is
    } else if (finalWords.length > base.length) {
      words = [...base, ...finalWords.slice(base.length)]
    } else {
      words = base
    }
    this.locked = []
    this.display = []
    return words.join(' ')
  }

  reset(): void {
    this.locked = []
    this.display = []
  }
}
