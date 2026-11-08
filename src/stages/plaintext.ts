/**
 * A script as it is meant to be heard.
 *
 * Scripts are written in editors that speak markdown, and pasted ones carry it:
 * `*Jujutsu Kaisen*` for a title, `**Megumi.**` for weight. Every reader takes
 * those characters literally -- the local one says "asterisk" -- and the
 * captions print them. So the marks go before the script is read, aligned or
 * captioned, and only the words they were wrapped round are kept.
 *
 * `#` headings are not touched: they are chapters, and markChapters takes
 * them out on its own terms.
 */
export function plainSpeech(text: string): string {
  return (
    text
      // [the words](https://link) -> the words
      .replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, '$1')
      // **bold**, __bold__, ***both***
      .replace(/(\*{1,3}|_{2,3})(?=\S)([^*\n]+?)(?<=\S)\1/g, '$2')
      // _italic_, only where the underscores sit outside a word
      .replace(/(^|[^\p{L}\p{N}_])_(?=\S)([^_\n]+?)(?<=\S)_(?![\p{L}\p{N}_])/gu, '$1$2')
      // `code`
      .replace(/`([^`\n]*)`/g, '$1')
      // > quoted lines, and bullet markers at the start of a line
      .replace(/^[ \t]*>[ \t]?/gm, '')
      .replace(/^[ \t]*[-*+•][ \t]+/gm, '')
      // A rule on its own line (---, ***, ___) is a divider, not a word.
      .replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '')
      // 5 * 3 is arithmetic, and said as such.
      .replace(/(\d)\s*\*\s*(\d)/g, '$1 times $2')
      // Whatever asterisks are left were never going to be read well.
      .replace(/\*/g, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+$/gm, '')
  );
}
