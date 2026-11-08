import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { geoArea, geoGraticule10, geoMercator, geoPath, type GeoProjection } from 'd3-geo';
import { feature } from 'topojson-client';
import type { Feature, FeatureCollection, Geometry, MultiPolygon, Polygon } from 'geojson';
import type { GeometryCollection, Topology } from 'topojson-specification';
import countriesTopo from 'world-atlas/countries-50m.json';
import type { Graphic } from '../../explainer.js';
import { countryFeature } from '../war/MapScene.js';
import { EX, TEXT_SHADOW, easeInOut, pop, ramp } from './theme.js';

/**
 * Where it is: the camera flies from the whole world down to one country,
 * which lights up, and a pin drops on the place the beat names.
 *
 * Real geography -- Natural Earth's borders, public domain, the same file the
 * war maps use -- in the explainer's own colours rather than the war channel's
 * parchment. The flight is the point of it. A map that simply appears tells
 * you a shape; one that travels there from the globe tells you where on the
 * planet that shape is, which is the question the beat is answering.
 */

const topo = countriesTopo as unknown as Topology<{ countries: GeometryCollection<{ name: string }> }>;
const COUNTRIES = feature(topo, topo.objects.countries) as unknown as FeatureCollection<Geometry, { name: string }>;
const GRATICULE = geoGraticule10();
const WORLD: Feature<Polygon> = {
  type: 'Feature',
  properties: {},
  geometry: { type: 'Polygon', coordinates: [[[-170, -58], [-170, 78], [180, 78], [180, -58], [-170, -58]]] },
};

/**
 * The part of a country to frame: its largest landmass. France's outline
 * includes French Guiana and Réunion, and fitting all of it frames half the
 * Atlantic with a small purple country somewhere in the corner.
 */
function mainland(country: Feature<Geometry, { name: string }>): Feature<Geometry> {
  if (country.geometry.type !== 'MultiPolygon') return country;
  const parts = (country.geometry as MultiPolygon).coordinates.map((coordinates) => ({
    type: 'Feature' as const,
    properties: {},
    geometry: { type: 'Polygon' as const, coordinates },
  }));
  return parts.reduce((best, part) => (geoArea(part) > geoArea(best) ? part : best), parts[0]!);
}

/** A box around a point, for a pin with no country to frame. */
function around(lat: number, lon: number, span: number): Feature<Polygon> {
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [[[lon - span, lat - span * 0.7], [lon - span, lat + span * 0.7], [lon + span, lat + span * 0.7], [lon + span, lat - span * 0.7], [lon - span, lat - span * 0.7]]],
    },
  };
}

const FRAME: [[number, number], [number, number]] = [
  [EX.sideLeft + 20, EX.bandTop + 40],
  [EX.width - EX.sideLeft - 20, EX.bandBottom - 120],
];

function fitted(target: Feature<Geometry>): { scale: number; translate: [number, number] } {
  const projection = geoMercator().fitExtent(FRAME, target);
  return { scale: projection.scale(), translate: projection.translate() as [number, number] };
}

export function canMap(graphic: Graphic): boolean {
  return countryFeature(graphic.title) !== undefined || (graphic.lat !== null && graphic.lon !== null);
}

export const MapGraphic: React.FC<{ graphic: Graphic; durationInFrames: number; fontFamily: string }> = ({
  graphic,
  durationInFrames,
  fontFamily,
}) => {
  const frame = useCurrentFrame();
  const country = countryFeature(graphic.title);
  const pin = graphic.lat !== null && graphic.lon !== null ? ([graphic.lon, graphic.lat] as [number, number]) : null;
  const target = country !== undefined ? mainland(country) : around(pin?.[1] ?? 0, pin?.[0] ?? 0, 9);

  // The flight: from the world to the country over two thirds of a second,
  // in log space so the zoom feels like constant speed rather than a lurch.
  const from = fitted(WORLD);
  const to = fitted(target);
  const fly = ramp(frame, 2, 22, easeInOut);
  const drift = interpolate(frame, [24, durationInFrames], [1, 1.06], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const scale = Math.exp(Math.log(from.scale) + (Math.log(to.scale) - Math.log(from.scale)) * fly) * drift;
  const centre: [number, number] = [(FRAME[0][0] + FRAME[1][0]) / 2, (FRAME[0][1] + FRAME[1][1]) / 2];
  // Interpolate where the target's centre lands, so the camera travels toward it.
  const targetCentre = geoMercator().fitExtent(FRAME, target);
  const lonLat = targetCentre.invert?.(centre) ?? [0, 0];
  const worldCentre = geoMercator().fitExtent(FRAME, WORLD).invert?.(centre) ?? [0, 0];
  const look: [number, number] = [
    worldCentre[0] + (lonLat[0] - worldCentre[0]) * fly,
    worldCentre[1] + (lonLat[1] - worldCentre[1]) * fly,
  ];
  const projection: GeoProjection = geoMercator().scale(scale).center(look).translate(centre);
  const path = geoPath(projection);

  const lit = ramp(frame, 18, 12);
  const pinAt = 26;
  const drop = pop(frame, pinAt, { damping: 10, stiffness: 220, mass: 0.6 });
  const spot = pin ?? (country !== undefined ? (geoPath().centroid(mainland(country)) as [number, number]) : null);
  const spotXY = spot === null ? null : projection(spot);
  const ripple = ramp(frame, pinAt + 4, 22);
  const card = ramp(frame, 20, 12);

  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ background: 'radial-gradient(ellipse 90% 70% at 50% 40%, rgba(16,32,56,0.92), rgba(5,8,14,0.96))' }} />
      <svg width={EX.width} height={EX.height} style={{ position: 'absolute', inset: 0 }}>
        <path d={path(GRATICULE) ?? ''} fill="none" stroke="rgba(120,170,255,0.08)" strokeWidth={1.5} />
        {COUNTRIES.features.map((shape, index) => (
          <path key={index} d={path(shape) ?? ''} fill="#1a2536" stroke="#34465f" strokeWidth={1.2} />
        ))}
        {country !== undefined ? (
          <path
            d={path(country) ?? ''}
            fill={EX.accent}
            fillOpacity={0.15 + 0.75 * lit}
            stroke="#ffffff"
            strokeWidth={3}
            strokeOpacity={lit}
            style={{ filter: `drop-shadow(0 0 ${Math.round(24 * lit)}px ${EX.accent})` }}
          />
        ) : null}
        {spotXY === null ? null : (
          <g transform={`translate(${spotXY[0]}, ${spotXY[1]})`}>
            <circle r={20 + ripple * 120} fill="none" stroke={EX.accent} strokeWidth={5} opacity={ripple > 0 && ripple < 1 ? (1 - ripple) * 0.8 : 0} />
            <g transform={`translate(0, ${(1 - Math.min(1, drop)) * -160}) scale(${Math.max(0, drop)})`}>
              <path d="M0 0 C -26 -40, -40 -58, -40 -80 A 40 40 0 1 1 40 -80 C 40 -58, 26 -40, 0 0 Z" fill="#ffffff" stroke={EX.ground} strokeWidth={4} />
              <circle cy={-80} r={15} fill={EX.accent} />
            </g>
          </g>
        )}
      </svg>
      <div
        style={{
          position: 'absolute',
          left: EX.sideLeft,
          top: EX.bandBottom - 70,
          opacity: card,
          transform: `translateY(${(1 - card) * 30}px)`,
        }}
      >
        <div style={{ fontFamily, fontWeight: 900, fontSize: 92, lineHeight: 1, color: EX.ink, letterSpacing: '-0.035em', textShadow: TEXT_SHADOW }}>
          {graphic.title}
        </div>
        {graphic.label !== '' ? (
          <div style={{ fontFamily, fontWeight: 650, fontSize: 44, color: EX.accent, marginTop: 10, textShadow: TEXT_SHADOW }}>
            {graphic.label}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};
