import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';
import { log } from '../log.js';

/**
 * The full text of a book, when it is out of copyright, from Project
 * Gutenberg.
 *
 * Two things become possible with the actual words on hand. The writer can be
 * given real lines to quote instead of remembering them -- and a model's
 * memory of a novel is exactly good enough to produce a quotation that sounds
 * right and is not in the book. And when the narration does quote the book,
 * the quotation can be found on the page and shown as it is printed.
 *
 * Found through Gutenberg's own catalogue and kept in assets/gutenberg, so a
 * book is fetched once. Everything on Gutenberg
 * is public domain in the United States; a book still in copyright is simply
 * not there, and this answers null.
 */

/**
 * Gutenberg's own catalogue, one CSV of every book, published for tools like
 * this one and refreshed weekly. Gutendex, the popular JSON wrapper around
 * it, was tried first and took twenty-eight seconds to answer a redirect.
 */
const CATALOGUE_URL = 'https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv';
const CATALOGUE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DIR = path.join(ROOT, 'assets', 'gutenberg');
const TIMEOUT_MS = 120_000;
const USER_AGENT = 'BreezeMatic/0.1 (local video tool)';

export type SourceText = {
  id: number;
  title: string;
  author: string;
  /** The book's page on gutenberg.org, for the credits. */
  url: string;
  /** The text itself, without Gutenberg's licence header and footer. */
  text: string;
};

type Entry = { id: number; type: string; title: string; language: string; authors: string };

/** RFC 4180 rows: quoted fields may hold commas, doubled quotes and newlines. */
function* rows(csv: string): Generator<string[]> {
  let field = '';
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i]!;
    if (quoted) {
      if (char === '"') {
        if (csv[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && csv[i + 1] === '\n') i++;
      row.push(field);
      yield row;
      row = [];
      field = '';
    } else field += char;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    yield row;
  }
}

let catalogue: Promise<Entry[] | null> | null = null;

/** The catalogue, fetched at most once a month and parsed at most once a process. */
function loadCatalogue(): Promise<Entry[] | null> {
  catalogue ??= (async () => {
    fs.mkdirSync(DIR, { recursive: true });
    const file = path.join(DIR, 'pg_catalog.csv');
    const stale =
      !fs.existsSync(file) || Date.now() - fs.statSync(file).mtimeMs > CATALOGUE_MAX_AGE_MS;
    if (stale) {
      const fresh = await fetchText(CATALOGUE_URL);
      if (fresh !== null && fresh.length > 1_000_000) fs.writeFileSync(file, fresh, 'utf8');
    }
    if (!fs.existsSync(file)) return null;
    const entries: Entry[] = [];
    let header = true;
    for (const row of rows(fs.readFileSync(file, 'utf8'))) {
      if (header) {
        header = false;
        continue;
      }
      const [id, type, , title, language, authors] = row;
      if (id === undefined || title === undefined) continue;
      entries.push({
        id: Number(id),
        type: type ?? '',
        title,
        language: language ?? '',
        authors: authors ?? '',
      });
    }
    return entries;
  })();
  catalogue.catch(() => (catalogue = null));
  return catalogue;
}

async function fetchText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const letters = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * Only the book. Gutenberg wraps every text in a licence header and footer
 * between "*** START OF ..." and "*** END OF ..." markers, and a quotation
 * matched against the licence would be a strange thing to put on screen.
 */
function stripBoilerplate(raw: string): string {
  const start = /\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG[^\n]*\n/i.exec(raw);
  const end = /\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG/i.exec(raw);
  const from = start === null ? 0 : start.index + start[0].length;
  const to = end === null ? raw.length : end.index;
  return raw.slice(from, to).replace(/\r\n/g, '\n').trim();
}

/**
 * The book, or null when it is not on Gutenberg -- because it is still in
 * copyright, or because the catalogue could not tell which book was meant.
 *
 * Matched on title and author together. The title alone finds study guides,
 * sequels and translations; the author's surname has to be one of the book's
 * authors in their own right -- not its translator or illustrator -- and the
 * found title has to be the wanted one, give or take a subtitle. Of several
 * editions the oldest in the catalogue wins, which is reliably the standard
 * text rather than a later variant.
 */
export async function publicDomainText(book: string, author: string): Promise<SourceText | null> {
  const title = book.trim();
  if (title === '') return null;
  /**
   * Five letters of the surname, not all of it: transliterations disagree
   * after that -- the catalogue files Dostoevsky as "Dostoyevsky" and Tolstoy
   * as "Tolstoy, Leo, graf" -- and the title has to match exactly anyway.
   */
  const surname = (letters(author).split(' ').pop() ?? '').slice(0, 5);
  const wanted = letters(title).replace(/^(the|a|an) /, '');

  const entries = await loadCatalogue().catch(() => null);
  if (entries === null) {
    log.info('gutenberg: the catalogue could not be fetched; going without the book text');
    return null;
  }

  const match = entries
    .filter((entry) => entry.type === 'Text' && entry.language === 'en')
    .filter((entry) => {
      const found = letters(entry.title.split(/[:;\n]/)[0] ?? '').replace(/^(the|a|an) /, '');
      return found === wanted;
    })
    .filter(
      (entry) =>
        surname === '' ||
        entry.authors
          .split(';')
          .some((person) => !/\[(translator|editor|illustrator|contributor)/i.test(person) && letters(person).includes(surname)),
    )
    .sort((a, b) => a.id - b.id)[0];
  if (match === undefined) {
    log.info(`gutenberg: "${title}" is not on Project Gutenberg (still in copyright, or not found)`);
    return null;
  }

  // "Wilde, Oscar, 1854-1900" is how the catalogue files him; on screen he is Oscar Wilde.
  const [last = '', first = ''] = (match.authors.split(';')[0] ?? '').split(',').map((part) => part.trim());
  const authorName = first !== '' && !/^[0-9]/.test(first) ? `${first} ${last}` : last || author;
  const url = `https://www.gutenberg.org/ebooks/${match.id}`;
  const file = path.join(DIR, `${match.id}.txt`);

  if (!fs.existsSync(file)) {
    const raw = await fetchText(`https://www.gutenberg.org/cache/epub/${match.id}/pg${match.id}.txt`);
    if (raw === null || raw.length < 5_000) {
      log.info(`gutenberg: could not download "${match.title}"`);
      return null;
    }
    fs.writeFileSync(file, stripBoilerplate(raw), 'utf8');
    log.info(`gutenberg: "${match.title}" by ${authorName} — ${url}`);
  }

  return { id: match.id, title: match.title, author: authorName, url, text: fs.readFileSync(file, 'utf8') };
}
