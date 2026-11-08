/**
 * The grade, laid over the picture and under the type.
 *
 * The first version of this was a spatial gradient — warm at the top of the
 * frame, cool at the bottom — which is not a grade at all. Measured on one
 * shot: the source averaged R49 G59 B70, correctly cool, and came out R63 G47
 * B54, a magenta cast, purely because the bright water happened to sit in the
 * warm half of the frame. A neighbouring shot was untouched. Tinting by where
 * content sits rather than by how bright it is gives a different answer for
 * every composition, which is the opposite of a look.
 *
 * Split toning is a function of luminance, and two blend modes give it without
 * a shader pass:
 *
 *   screen with a dark teal    screen(black, x) = x, screen(white, x) = white,
 *                              so it lifts shadows toward teal and leaves
 *                              highlights alone
 *   multiply with a warm white multiply(white, x) = x, multiply(black, x) =
 *                              black, so it warms highlights and leaves
 *                              shadows alone
 *
 * Under the type on purpose. Grading the captions along with the picture tints
 * white type, which reads as a mistake rather than as a look.
 */

/** Lifts the blacks toward teal. Dark, or it fogs the whole frame. */
const SHADOW_TEAL = 'rgb(10, 38, 48)';
/** Pulls the brights toward amber. Near-white, or it darkens everything. */
const HIGHLIGHT_WARM = 'rgb(255, 238, 212)';

/**
 * `strength` scales the split tone, not the vignette or the flash: at 0.4 a
 * watercolour keeps its own colour and still sits in the same film as the
 * rest of the edit.
 */
export const CinemaGrade: React.FC<{ flash: number; strength?: number }> = ({
  flash,
  strength = 1,
}) => (
  <>
    <div
      style={{
        position: 'absolute',
        inset: 0,
        backgroundColor: SHADOW_TEAL,
        mixBlendMode: 'screen',
        opacity: strength,
      }}
    />
    <div
      style={{
        position: 'absolute',
        inset: 0,
        backgroundColor: HIGHLIGHT_WARM,
        mixBlendMode: 'multiply',
        opacity: strength,
      }}
    />
    <div
      style={{
        position: 'absolute',
        inset: 0,
        /*
          In percentages of the frame rather than pixels of the short. It was
          sized from RENDER, the vertical short's dimensions, which drew a
          tall narrow vignette in the middle of a landscape essay. On a short
          the two are the same number.
        */
        background:
          'radial-gradient(ellipse 78% 62% at 50% 48%, ' +
          'rgba(0,0,0,0) 45%, rgba(0,0,0,0.5) 100%)',
      }}
    />
    {flash > 0 ? (
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundColor: '#ffffff',
          opacity: flash,
        }}
      />
    ) : null}
  </>
);
