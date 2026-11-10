// Plan › Places to live: every city by how good it is to live in (x) and how beautiful it is (y).
// Data: GET /api/livability (scripts/build-livability.ts). Click a dot or a row to open the city.

import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { useMeridianStore } from "../../../store";
import { openCity } from "../../../shell/uiStore";
import {
  AXIS_LABEL,
  QUADRANT_LABEL,
  axisValue,
  bestOfBoth,
  fetchLivabilityRows,
  quadrant,
  type BeautyAxis,
  type LivabilityRow,
} from "../../../lib/livability";
import { WORLD_REGIONS, countryRegions, type WorldRegion } from "../../../lib/worldRegion";
import { Card, EmptyState, ErrorState, Segmented, Select, Skeleton } from "../../../ui";
import { IconWorld } from "../../../ui/icons";
import { cityRank } from "../../map/overlays";
import type { City } from "../../../types";
import "./live.css";

type Size = "major" | "all";
const CUT = 60;

interface Point {
  city: City;
  q: number;
  b: number;
  row: LivabilityRow;
  trip: boolean;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(720);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

export default function PlacesToLive() {
  const cities = useMeridianStore((s) => s.cities);
  const trips = useMeridianStore((s) => s.trips);
  const [rows, setRows] = useState<LivabilityRow[] | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [axis, setAxis] = useState<BeautyAxis>("beauty");
  const [region, setRegion] = useState<WorldRegion | "all">("all");
  const [size, setSize] = useState<Size>("major");

  useEffect(() => {
    let live = true;
    setError(false);
    fetchLivabilityRows()
      .then((d) => live && setRows(d.rows))
      .catch(() => live && setError(true));
    return () => {
      live = false;
    };
  }, [attempt]);

  const byId = useMemo(() => new Map(cities.map((c) => [c.id, c])), [cities]);
  const regions = useMemo(() => countryRegions(cities), [cities]);
  const tripIds = useMemo(() => new Set(trips.filter((t) => t.origin !== "agent").flatMap((t) => t.nodes.map((n) => n.cityId))), [trips]);

  const points = useMemo<Point[]>(() => {
    if (!rows) return [];
    const out: Point[] = [];
    for (const row of rows) {
      const city = byId.get(row[0]);
      const b = axisValue(row, axis);
      if (!city || b === null) continue;
      const trip = tripIds.has(city.id);
      if (size === "major" && cityRank(city) > 0 && !trip) continue;
      if (region !== "all" && regions.get(city.country) !== region) continue;
      out.push({ city, q: row[1], b, row, trip });
    }
    return out;
  }, [rows, byId, axis, size, region, regions, tripIds]);

  const ranked = useMemo(() => bestOfBoth(points.map((p) => p.row), axis, 20), [points, axis]);

  if (error) return <ErrorState message="Couldn’t load quality of life and beauty." onRetry={() => setAttempt((a) => a + 1)} />;
  if (!rows || !cities.length)
    return (
      <div className="plan-live">
        <Skeleton height={420} />
      </div>
    );
  if (!rows.length)
    return <EmptyState size="page" icon={<IconWorld />} title="No scores yet" description="The quality-of-life and beauty dataset hasn’t been built on this server." />;

  return (
    <div className="plan-live">
      <p className="plan-live-intro">
        Every city by how good it is to live in and how beautiful it is. Top right is both. Click a city to open it.
      </p>
      <div className="plan-live-controls">
        <Segmented<BeautyAxis>
          label="Beauty axis"
          size="sm"
          value={axis}
          onChange={setAxis}
          options={(["beauty", "setting", "character"] as const).map((a) => ({ value: a, label: AXIS_LABEL[a] }))}
        />
        <Select
          size="sm"
          aria-label="Region"
          value={region}
          onChange={(e) => setRegion(e.target.value as WorldRegion | "all")}
          options={[{ value: "all", label: "All regions" }, ...WORLD_REGIONS.map((r) => ({ value: r.value, label: r.label }))]}
        />
        <Segmented<Size>
          label="Cities shown"
          size="sm"
          value={size}
          onChange={setSize}
          options={[
            { value: "major", label: "Major cities" },
            { value: "all", label: "All" },
          ]}
        />
      </div>

      <Card className="plan-live-card">
        <Scatter points={points} axis={axis} />
      </Card>

      <section className="plan-live-ranked" aria-labelledby="plan-live-best">
        <h2 className="plan-live-h" id="plan-live-best">
          Best of both <small>ranked by the weaker of the two scores</small>
        </h2>
        <table className="plan-live-table">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">City</th>
              <th scope="col" className="num">
                Quality of life
              </th>
              <th scope="col" className="num">
                {AXIS_LABEL[axis]}
              </th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((r, i) => {
              const c = byId.get(r[0])!;
              return (
                <tr key={r[0]} onClick={() => openCity(c.id)} className={tripIds.has(c.id) ? "is-trip" : undefined}>
                  <td className="num">{i + 1}</td>
                  <td>
                    <button type="button" className="plan-live-city" onClick={() => openCity(c.id)}>
                      {c.name}
                    </button>
                    <span className="plan-live-country">{c.country}</span>
                  </td>
                  <td className="num">
                    <Bar value={r[1]} />
                  </td>
                  <td className="num">
                    <Bar value={axisValue(r, axis)!} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <p className="plan-live-note">
        <b>Quality of life</b> blends human development, life satisfaction and safety (country figures) with air quality, measured
        at the city for major cities. <b>Beauty</b> combines natural setting (mountains, sea and lakes nearby) and built character
        (World Heritage sites, how much the centre is photographed, notable places); the stronger of the two counts more. Famous places score higher on character, so
        quieter beautiful towns can sit lower than they deserve. Scores compare cities; they aren’t verdicts.
      </p>
    </div>
  );
}

function Bar({ value }: { value: number }) {
  return (
    <span className="plan-live-bar">
      <span className="plan-live-bar-num">{value}</span>
      <span className="plan-live-bar-track" aria-hidden="true">
        <span style={{ width: `${value}%` }} />
      </span>
    </span>
  );
}

const PAD = { top: 16, right: 16, bottom: 40, left: 44 };

/**
 * Greedy label placement: in priority order, try right of the dot, then left; skip a label
 * that would overlap one already placed (width estimated from the 14px serif).
 */
function placeLabels(points: Point[], x: (v: number) => number, y: (v: number) => number, left: number, right: number) {
  const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
  const out: { p: Point; x: number; y: number; anchor: "start" | "end" }[] = [];
  for (const p of points) {
    const w = p.city.name.length * 6.6;
    const cx = x(p.q);
    const cy = y(p.b);
    for (const side of ["start", "end"] as const) {
      const x0 = side === "start" ? cx + 7 : cx - 7 - w;
      const box = { x0, x1: x0 + w, y0: cy - 8, y1: cy + 8 };
      if (box.x0 < left || box.x1 > right) continue;
      if (placed.some((b) => b.x0 < box.x1 && box.x0 < b.x1 && b.y0 < box.y1 && box.y0 < b.y1)) continue;
      placed.push(box);
      out.push({ p, x: side === "start" ? cx + 7 : cx - 7, y: cy + 4, anchor: side });
      break;
    }
  }
  return out;
}

function Scatter({ points, axis }: { points: Point[]; axis: BeautyAxis }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const height = Math.round(Math.min(560, Math.max(320, width * 0.62)));
  const iw = width - PAD.left - PAD.right;
  const ih = height - PAD.top - PAD.bottom;
  const x = (v: number) => PAD.left + (v / 100) * iw;
  const y = (v: number) => PAD.top + (1 - v / 100) * ih;
  const [hover, setHover] = useState<Point | null>(null);
  const hasTrip = points.some((p) => p.trip);

  // A few labels, for the best of both; trip stops are labelled too.
  const labelled = useMemo(() => {
    const best = bestOfBoth(points.map((p) => p.row), axis, 6).map((r) => r[0]);
    const ids = new Set([...best, ...points.filter((p) => p.trip).map((p) => p.city.id)].slice(0, 14));
    return points.filter((p) => ids.has(p.city.id));
  }, [points, axis]);

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - box.left;
    const my = e.clientY - box.top;
    let best: Point | null = null;
    let bd = 14 * 14;
    for (const p of points) {
      const d = (x(p.q) - mx) ** 2 + (y(p.b) - my) ** 2;
      if (d < bd) (bd = d), (best = p);
    }
    setHover(best);
  };

  const ticks = [0, 20, 40, 60, 80, 100];
  const corner = (q: keyof typeof QUADRANT_LABEL, tx: number, ty: number, anchor: "start" | "end") => (
    <text x={tx} y={ty} textAnchor={anchor} className="plan-live-corner">
      {QUADRANT_LABEL[q]}
    </text>
  );

  return (
    <div className="plan-live-chart" ref={ref}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`${points.length} cities: quality of life against ${AXIS_LABEL[axis].toLowerCase()}`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        onClick={() => hover && openCity(hover.city.id)}
        style={{ cursor: hover ? "pointer" : "default" }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={PAD.top} y2={PAD.top + ih} className="plan-live-grid" />
            <line x1={PAD.left} x2={PAD.left + iw} y1={y(t)} y2={y(t)} className="plan-live-grid" />
            <text x={x(t)} y={PAD.top + ih + 16} textAnchor="middle" className="plan-live-tick">
              {t}
            </text>
            <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end" className="plan-live-tick">
              {t}
            </text>
          </g>
        ))}
        <line x1={x(CUT)} x2={x(CUT)} y1={PAD.top} y2={PAD.top + ih} className="plan-live-cut" />
        <line x1={PAD.left} x2={PAD.left + iw} y1={y(CUT)} y2={y(CUT)} className="plan-live-cut" />
        {corner("both", x(100) - 6, y(100) + 14, "end")}
        {corner("beauty", x(0) + 6, y(100) + 14, "start")}
        {corner("living", x(100) - 6, y(0) - 8, "end")}
        {corner("neither", x(0) + 6, y(0) - 8, "start")}
        <text x={PAD.left + iw / 2} y={height - 6} textAnchor="middle" className="plan-live-axis">
          Quality of life →
        </text>
        <text transform={`translate(12 ${PAD.top + ih / 2}) rotate(-90)`} textAnchor="middle" className="plan-live-axis">
          {AXIS_LABEL[axis]} →
        </text>

        {points
          .filter((p) => !p.trip)
          .map((p) => (
            <circle key={p.city.id} cx={x(p.q)} cy={y(p.b)} r={2.6} className="plan-live-dot" />
          ))}
        {points
          .filter((p) => p.trip)
          .map((p) => (
            <circle key={p.city.id} cx={x(p.q)} cy={y(p.b)} r={5} className="plan-live-dot is-trip" />
          ))}
        {placeLabels(labelled, x, y, PAD.left, PAD.left + iw).map((l) => (
          <text key={`l-${l.p.city.id}`} x={l.x} y={l.y} textAnchor={l.anchor} className="plan-live-label">
            {l.p.city.name}
          </text>
        ))}
        {hover ? <circle cx={x(hover.q)} cy={y(hover.b)} r={7} className="plan-live-hover" /> : null}
      </svg>

      {hasTrip ? (
        <div className="plan-live-legend" aria-hidden="true">
          <span>
            <i className="is-trip" /> Your trip stops
          </span>
          <span>
            <i /> Other cities
          </span>
        </div>
      ) : null}

      {hover ? (
        <div
          className="plan-live-tip"
          style={{
            left: Math.min(width - 210, x(hover.q) + 12),
            top: Math.max(0, y(hover.b) - 70),
          }}
        >
          <b>{hover.city.name}</b>
          <span className="plan-live-tip-sub">
            {hover.city.country} · {QUADRANT_LABEL[quadrant(hover.q, hover.b, CUT)]}
          </span>
          <span>
            Quality of life <b className="num">{hover.q}</b>
          </span>
          <span>
            Beauty <b className="num">{hover.row[2]}</b>
            {hover.row[3] !== null ? (
              <small>
                {" "}
                setting {hover.row[3]}, character {hover.row[4]}
              </small>
            ) : null}
          </span>
        </div>
      ) : null}
    </div>
  );
}
