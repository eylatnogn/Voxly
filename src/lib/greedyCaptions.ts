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
export const MUTABLE_TAIL_WORDS = 2

export class GreedyCaption {
  private locked: string[] = []

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
    return [...this.locked, ...tail].join(' ')
  }

  /**
   * The recognizer finalized a phrase: keep its version only if it is at
   * least as complete as what was already captured.
   */
  finalize(finalText: string): string {
    const finalWords = finalText.trim().split(/\s+/).filter(Boolean)
    const chosen =
      finalWords.length >= this.locked.length ? finalWords.join(' ') : this.locked.join(' ')
    this.locked = []
    return chosen
  }

  reset(): void {
    this.locked = []
  }
}
