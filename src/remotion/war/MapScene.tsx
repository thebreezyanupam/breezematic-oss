import React from 'react';
import { Easing, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { geoArea, geoBounds, geoGraticule10, geoMercator, geoPath } from 'd3-geo';
import { feature, mesh } from 'topojson-client';
import type { Feature, FeatureCollection, Geometry, MultiLineString } from 'geojson';
import type { GeometryCollection, Topology } from 'topojson-specification';
import countriesTopo from 'world-atlas/countries-50m.json';
import { MONO_FONT_FAMILY, SERIF_FONT_FAMILY } from '../font.js';
import { Figure, HERO, isOutfit } from '../stickman/figure.js';
import { IconGlyph, hasIcon } from './Icon.js';
import type { WarMap } from '../../stages/warmap.js';

/**
 * A campaign map: where the story is, drawn from real geography.
 *
 * The borders are Natural Earth's (public domain) -- today's borders, which
 * is the honest limitation of it: a map of 1914 drawn with 2020 borders is
 * wrong in the details, so the borders are drawn faint and dashed and the
 * story is told with what is laid over them -- the sides in colour, the
 * places named, the armies as arrows. That is also how every campaign map on
 * this kind of channel works: nobody watches for the border of Galicia, they
 * watch the arrow.
 *
 * Everything is recomputed per frame from the projection, which is what lets
 * the camera fly in: the map opens wide, closes on the region over a second,
 * then keeps drifting in so it is never a still.
 */

const topo = countriesTopo as unknown as Topology<{ countries: GeometryCollection<{ name: string }> }>;
const COUNTRIES = feature(topo, topo.objects.countries) as unknown as FeatureCollection<Geometry, { name: string }>;
const BORDERS = mesh(topo, topo.objects.countries, (a, b) => a !== b) as MultiLineString;
const GRATICULE = geoGraticule10();

const byName = new Map<string, Feature<Geometry, { name: string }>>();
for (const country of COUNTRIES.features) byName.set(country.properties.name.toLowerCase(), country);

/** Common ways of naming a country that Natural Earth spells differently. */
const ALIASES: Record<string, string> = {
  'united states': 'united states of america', usa: 'united states of america', us: 'united states of america',
  america: 'united states of america', uk: 'united kingdom', britain: 'united kingdom',
  'great britain': 'united kingdom', england: 'united kingdom', russia: 'russia', ussr: 'russia',
  'soviet union': 'russia', czechia: 'czechia', 'czech republic': 'czechia', holland: 'netherlands',
  'south korea': 'south korea', 'north korea': 'north korea', burma: 'myanmar', persia: 'iran',
  siam: 'thailand', prussia: 'germany', ottoman: 'turkey', 'ottoman empire': 'turkey',
  'democratic republic of the congo': 'dem. rep. congo', congo: 'congo', 'ivory coast': "côte d'ivoire",
};

export function countryFeature(name: string): Feature<Geometry, { name: string }> | undefined {
  const key = name.trim().toLowerCase();
  return byName.get(ALIASES[key] ?? key) ?? byName.get(key);
}

const SIDE_FILL: Record<string, string> = { red: '#b23a2e', blue: '#2f5d9a', neutral: '#6f6a5f' };

type Extent = { west: number; east: number; south: number; north: number };

/**
 * The bounds of a country's largest landmass.
 *
 * A country's outline includes every island it owns, and some own islands a
 * long way off: Australia's reaches Macquarie Island at 55 degrees south,
 * which dragged a map of the Emu War down into the Southern Ocean, where
 * Mercator balloons, and shrank the whole of Australia to a corner.
 */
function mainland(country: Feature<Geometry, { name: string }>): [[number, number], [number, number]] {
  const geometry = country.geometry;
  if (geometry.type !== 'MultiPolygon') return geoBounds(country);
  let best = geometry.coordinates[0]!;
  let area = -1;
  for (const polygon of geometry.coordinates) {
    const a = geoArea({ type: 'Polygon', coordinates: polygon });
    if (a > area) {
      area = a;
      best = polygon;
    }
  }
  return geoBounds({ type: 'Polygon', coordinates: best });
}

/**
 * The region to frame. The named places when there are any -- they are what
 * the narration is about -- and the highlighted countries' mainlands only when
 * there are none. Padded, and never tighter than a few degrees: one town on
 * its own is a map of a field.
 */
function extentOf(map: WarMap): Extent {
  const lons: number[] = [];
  const lats: number[] = [];
  for (const place of map.places) {
    lons.push(place.lon);
    lats.push(place.lat);
  }
  if (lons.length === 0) {
    for (const item of map.highlight) {
      const country = countryFeature(item.country);
      if (country === undefined) continue;
      const [[w, s], [e, n]] = mainland(country);
      if (e - w > 100 || e < w) continue;
      lons.push(w, e);
      lats.push(s, n);
    }
  }
  if (lons.length === 0) return { west: -20, east: 50, south: 30, north: 65 };
  let west = Math.min(...lons);
  let east = Math.max(...lons);
  let south = Math.min(...lats);
  let north = Math.max(...lats);
  const minSpan = 7;
  if (east - west < minSpan) {
    const mid = (east + west) / 2;
    west = mid - minSpan / 2;
    east = mid + minSpan / 2;
  }
  if (north - south < minSpan * 0.55) {
    const mid = (north + south) / 2;
    south = mid - (minSpan * 0.55) / 2;
    north = mid + (minSpan * 0.55) / 2;
  }
  const padLon = (east - west) * 0.22;
  const padLat = (north - south) * 0.3;
  return {
    west: west - padLon,
    east: east + padLon,
    south: Math.max(-80, south - padLat),
    north: Math.min(82, north + padLat),
  };
}

/** A curved arrow from a to b, bowing to the left of the direction of travel. */
function arrowPath(a: [number, number], b: [number, number]): { d: string; at: (u: number) => [number, number]; angle: (u: number) => number; length: number } {
  const [x1, y1] = a;
  const [x2, y2] = b;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  const cx = (x1 + x2) / 2 - dy * 0.18;
  const cy = (y1 + y2) / 2 + dx * 0.18;
  const at = (u: number): [number, number] => [
    (1 - u) * (1 - u) * x1 + 2 * (1 - u) * u * cx + u * u * x2,
    (1 - u) * (1 - u) * y1 + 2 * (1 - u) * u * cy + u * u * y2,
  ];
  const angle = (u: number): number => {
    const tx = 2 * (1 - u) * (cx - x1) + 2 * u * (x2 - cx);
    const ty = 2 * (1 - u) * (cy - y1) + 2 * u * (y2 - cy);
    return (Math.atan2(ty, tx) * 180) / Math.PI;
  };
  return { d: `M${x1},${y1} Q${cx},${cy} ${x2},${y2}`, at, angle, length: length * 1.08 };
}

export const MapScene: React.FC<{ map: WarMap; durationInFrames: number; outfit?: string; t: number }> = ({
  map,
  durationInFrames,
  outfit,
  t,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const seconds = frame / fps;
  const beatSeconds = durationInFrames / fps;

  const extent = extentOf(map);
  const fitted = geoMercator().fitExtent(
    [
      [width * 0.06, height * 0.2],
      [width * 0.94, height * 0.9],
    ],
    // Corners, not a rectangle: d3-geo reads a ring's winding as which side
    // is inside, and a rectangle wound the other way is "everything but this
    // region" -- which framed the whole world around a map of one state.
    {
      type: 'MultiPoint',
      coordinates: [
        [extent.west, extent.south],
        [extent.east, extent.south],
        [extent.east, extent.north],
        [extent.west, extent.north],
      ],
    },
  );
  const center: [number, number] = [(extent.west + extent.east) / 2, (extent.south + extent.north) / 2];
  // Fly in over the first second, then keep creeping in.
  const fly = interpolate(seconds, [0, 1.1], [0, 1], {
    extrapolateRight: 'clamp',
    easing: Easing.inOut(Easing.cubic),
  });
  const zoom = interpolate(fly, [0, 1], [0.42, 1]) * (1 + 0.06 * Math.min(1, seconds / Math.max(1, beatSeconds)));
  const projection = geoMercator()
    .center(center)
    .scale(fitted.scale() * zoom)
    .translate([width / 2, height * 0.55]);
  const path = geoPath(projection);

  const placeAt = new Map<string, [number, number]>();
  for (const place of map.places) {
    const p = projection([place.lon, place.lat]);
    if (p !== null) placeAt.set(place.name.toLowerCase(), p);
  }

  const pulse = 0.85 + 0.15 * Math.sin(t * 3);

  /**
   * Where each name goes. Right of its dot unless that would sit on a name
   * already placed -- two towns eight miles apart are one dot at this scale --
   * then left, then below, then above. Measured roughly from the character
   * count; exact is not needed, only apart.
   */
  const LABEL_H = 34;
  const taken: { x0: number; x1: number; y0: number; y1: number }[] = [];
  const labels = map.places.map((place) => {
    const at = placeAt.get(place.name.toLowerCase());
    const w = place.name.length * 20 + 12;
    if (at === undefined) return { dx: 16, dy: 8, anchor: 'start' as const };
    const [x, y] = at;
    const options = [
      { dx: 16, dy: 8, anchor: 'start' as const, box: { x0: x + 12, x1: x + 12 + w, y0: y - 20, y1: y + 14 } },
      { dx: -16, dy: 8, anchor: 'end' as const, box: { x0: x - 12 - w, x1: x - 12, y0: y - 20, y1: y + 14 } },
      { dx: 0, dy: 44, anchor: 'middle' as const, box: { x0: x - w / 2, x1: x + w / 2, y0: y + 14, y1: y + 14 + LABEL_H } },
      { dx: 0, dy: -26, anchor: 'middle' as const, box: { x0: x - w / 2, x1: x + w / 2, y0: y - 20 - LABEL_H, y1: y - 20 } },
    ];
    const clear = options.find((option) =>
      taken.every((box) => option.box.x1 < box.x0 || option.box.x0 > box.x1 || option.box.y1 < box.y0 || option.box.y0 > box.y1),
    ) ?? options[0]!;
    taken.push(clear.box);
    return { dx: clear.dx, dy: clear.dy, anchor: clear.anchor };
  });
  const appear = (index: number, base: number, every: number): number =>
    spring({ frame: frame - Math.round((base + index * every) * fps), fps, config: { damping: 12, stiffness: 180 } });

  return (
    <div style={{ position: 'absolute', inset: 0, backgroundColor: '#5f808c', overflow: 'hidden' }}>
      <svg width={width} height={height} style={{ position: 'absolute', inset: 0 }}>
        <defs>
          <radialGradient id="map-sea" cx="0.5" cy="0.5" r="0.75">
            <stop offset="0" stopColor="#7597a3" />
            <stop offset="1" stopColor="#3f5c67" />
          </radialGradient>
        </defs>
        <rect width={width} height={height} fill="url(#map-sea)" />
        <path d={path(GRATICULE) ?? ''} fill="none" stroke="#ffffff" strokeOpacity={0.12} strokeWidth={1} />
        {/* Land, then the sides in colour over it, then the borders faint and dashed. */}
        {COUNTRIES.features.map((country, i) => (
          <path key={i} d={path(country) ?? ''} fill="#e8d7ae" stroke="#6f5d3e" strokeWidth={1.1} />
        ))}
        {map.highlight.map((item, i) => {
          const country = countryFeature(item.country);
          if (country === undefined) return null;
          const shown = appear(i, 0.5, 0.25);
          return (
            <path
              key={`h${i}`}
              d={path(country) ?? ''}
              fill={SIDE_FILL[item.side] ?? SIDE_FILL['neutral']}
              // Light enough that land still reads as land when a country fills
              // the frame; the outline is what says whose it is.
              fillOpacity={0.3 * shown * pulse}
              stroke={SIDE_FILL[item.side] ?? SIDE_FILL['neutral']}
              strokeWidth={4.5}
              strokeOpacity={shown}
            />
          );
        })}
        <path d={path(BORDERS) ?? ''} fill="none" stroke="#7d6a48" strokeWidth={1.2} strokeDasharray="5 5" strokeOpacity={0.8} />

        {/* The armies, as arrows drawing themselves. */}
        {map.arrows.map((arrow, i) => {
          const a = placeAt.get(arrow.from.toLowerCase());
          const b = placeAt.get(arrow.to.toLowerCase());
          if (a === undefined || b === undefined) return null;
          const shape = arrowPath(a, b);
          const start = 0.9 + i * 0.55;
          const drawn = interpolate(seconds, [start, start + 1.3], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
            easing: Easing.inOut(Easing.quad),
          });
          if (drawn <= 0) return null;
          const colour = SIDE_FILL[arrow.side] ?? SIDE_FILL['neutral'];
          const [hx, hy] = shape.at(Math.max(0.001, drawn));
          const angle = shape.angle(Math.max(0.001, drawn));
          const rider = hasIcon(arrow.icon) ? arrow.icon : null;
          return (
            <g key={`a${i}`}>
              <path d={shape.d} fill="none" stroke="#1d1b24" strokeWidth={24} strokeLinecap="round" strokeDasharray={`${shape.length * drawn} ${shape.length}`} strokeOpacity={0.55} />
              <path d={shape.d} fill="none" stroke={colour} strokeWidth={16} strokeLinecap="round" strokeDasharray={`${shape.length * drawn} ${shape.length}`} />
              <g transform={`translate(${hx},${hy}) rotate(${angle})`}>
                <path d="M16,0 L-14,-20 L-8,0 L-14,20 Z" fill={colour} stroke="#1d1b24" strokeWidth={4} strokeLinejoin="round" />
              </g>
              {rider === null || drawn >= 1 ? null : (
                // Carried along the arrow, and gone when it arrives, where the
                // place's own icon takes over.
                <g opacity={interpolate(drawn, [0.8, 1], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })}>
                  <circle cx={hx} cy={hy - 58} r={32} fill="#f4ead2" stroke="#1d1b24" strokeWidth={4} />
                  <IconGlyph name={rider} size={44} x={hx} y={hy - 58} fill={colour} />
                </g>
              )}
            </g>
          );
        })}

        {/* The places: a dot, the name, and what happened there. */}
        {map.places.map((place, i) => {
          const at = placeAt.get(place.name.toLowerCase());
          if (at === undefined) return null;
          const label = labels[i]!;
          const shown = appear(i, 0.35, 0.3);
          const [x, y] = at;
          const icon = hasIcon(place.icon) ? place.icon : null;
          return (
            <g key={`p${i}`} transform={`translate(${x},${y}) scale(${shown})`} opacity={Math.min(1, shown)}>
              {icon === null ? null : (
                <g transform={`scale(${icon === 'explosion' ? pulse : 1})`}>
                  <IconGlyph name={icon} size={64} y={-54} fill={icon === 'explosion' ? '#e8412c' : '#2a2620'} outline="#f4ead2" outlineWidth={40} />
                </g>
              )}
              <circle r={9} fill="#1d1b24" stroke="#f4ead2" strokeWidth={4} />
              <text
                x={label.dx}
                y={label.dy}
                textAnchor={label.anchor}
                fontFamily={SERIF_FONT_FAMILY}
                fontWeight={700}
                fontSize={30}
                fill="#1d1b24"
                stroke="#f4ead2"
                strokeWidth={7}
                paintOrder="stroke"
                letterSpacing="0.04em"
              >
                {place.name.toUpperCase()}
              </text>
            </g>
          );
        })}

        {/* The mascot, small in the corner, pointing at the map like a presenter. */}
        <Figure
          action="point"
          progress={Math.min(1, seconds / Math.max(0.5, beatSeconds))}
          t={t}
          x={width * 0.9}
          groundY={height * 1.02}
          scale={2.6}
          facingRight={false}
          expression="smug"
          look={HERO}
          prop="none"
          halo="#f4ead2"
          appear={1}
          phase={0}
          {...(isOutfit(outfit) ? { outfit } : {})}
        />
      </svg>

      {/* Paper and age, over everything drawn. */}
      <Img
        src={staticFile('cinema/grain.png')}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', mixBlendMode: 'overlay', opacity: 0.22 }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'radial-gradient(ellipse 75% 70% at 50% 55%, rgba(0,0,0,0) 55%, rgba(20,14,6,0.55) 100%)',
        }}
      />
      {map.title.trim() === '' ? null : (
        <div
          style={{
            position: 'absolute',
            left: '4%',
            bottom: '6%',
            padding: '10px 18px',
            background: '#1d1b24',
            color: '#f4ead2',
            fontFamily: MONO_FONT_FAMILY,
            fontWeight: 500,
            fontSize: 26,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            transform: `rotate(-1.5deg) translateY(${(1 - Math.min(1, appear(0, 0.2, 0))) * 30}px)`,
            boxShadow: '0 6px 18px rgba(0,0,0,0.45)',
          }}
        >
          {map.title}
        </div>
      )}
    </div>
  );
};
