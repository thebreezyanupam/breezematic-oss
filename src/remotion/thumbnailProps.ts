/**
 * The thumbnail's inputs, apart from the component, so the server can import
 * them without pulling the fonts and React in with them.
 */
export type ThumbnailProps = {
  /** A picture under public/images. */
  image: string;
  /** Its subject's matte under public/images: white, alpha = subject. */
  matte?: string;
  /** One or two lines, already in capitals. */
  lines: string[];
  /** The colour of the words, and the tint of the grade. */
  accent: string;
  /** Where the subject is, as shares of the picture; the push-in centres on it. */
  focus: { x: number; y: number };
  /** Top of the subject's box, as a share of picture height. */
  subjectTop: number;
  zoom: number;
  /**
   * Where the top of the words goes, as a share of the frame height -- chosen
   * by measuring how much of them the subject would hide. Absent: just below
   * the top of the subject.
   */
  textTop?: number;
  bars: boolean;
};

export const THUMBNAIL_COMPOSITION_ID = 'breezematic-thumbnail';
export const THUMBNAIL_SIZE = { width: 1280, height: 720 } as const;

export const emptyThumbnail: ThumbnailProps = {
  image: '',
  lines: ['BREEZEMATIC'],
  accent: '#ffd23f',
  focus: { x: 0.5, y: 0.5 },
  subjectTop: 0.3,
  zoom: 1,
  bars: true,
};

