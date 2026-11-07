import { useId, useRef, useState } from "react";
import { Button, Popover, UnlockCard, useJournalToken } from "../../ui";
import { IconLayers } from "../../ui/icons";
import { useMapPrefs, type MapLayer } from "../../shell/mapPrefs";
import { MONTH_NAMES, MONTH_SHORT } from "./basemap";
import type { MapColors } from "./useMapColors";
import OverlayPanel, { type DataLayerInfo } from "./OverlayPanel";

interface LayerMenuProps {
  colors: MapColors;
  /** Year span of past journeys, for the legend (null while unknown). */
  years: { min: number; max: number } | null;
  pastLoading: boolean;
  data: DataLayerInfo;
}

function rgb(c: [number, number, number, number]) {
  return `rgb(${c[0]} ${c[1]} ${c[2]})`;
}

function SwitchRow({
  layer,
  name,
  hint,
  disabled,
  children,
}: {
  layer: MapLayer;
  name: string;
  hint?: React.ReactNode;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  const on = useMapPrefs((s) => s.layers[layer]);
  const setLayer = useMapPrefs((s) => s.setLayer);
  const id = useId();
  return (
    <div className="map-layer">
      <label className="map-layer-row" htmlFor={id}>
        <span className="map-layer-text">
          <span className="map-layer-name">{name}</span>
          {hint ? <span className="map-layer-hint">{hint}</span> : null}
        </span>
        <input
          id={id}
          type="checkbox"
          role="switch"
          className="map-switch"
          checked={on && !disabled}
          disabled={disabled}
          onChange={(e) => setLayer(layer, e.target.checked)}
        />
      </label>
      {on && !disabled ? children : null}
    </div>
  );
}

export function MonthPicker({ value, onChange }: { value: number; onChange: (m: number) => void }) {
  return (
    <div className="map-months" role="radiogroup" aria-label="Month">
      {MONTH_SHORT.map((m, i) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={value === i + 1}
          aria-label={MONTH_NAMES[i]}
          className="map-month"
          onClick={() => onChange(i + 1)}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

export default function LayerMenu({ colors, years, pastLoading, data }: LayerMenuProps) {
  const [open, setOpen] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const { unlocked } = useJournalToken();
  const month = useMapPrefs((s) => s.month);
  const setMonth = useMapPrefs((s) => s.setMonth);

  const pastHint = !unlocked ? (
    "Unlock your journal to show them"
  ) : pastLoading ? (
    "Loading your trips…"
  ) : years ? (
    <span className="map-years">
      <span className="num">{years.min}</span>
      <span
        className="map-years-bar"
        aria-hidden="true"
        style={{ background: `linear-gradient(to right, ${rgb(colors.yearFrom)}, ${rgb(colors.yearTo)})` }}
      />
      <span className="num">{years.max}</span>
    </span>
  ) : (
    "No logged trips yet"
  );

  return (
    <>
      <Button
        ref={anchor}
        variant="secondary"
        icon={<IconLayers />}
        className="map-float-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        Layers
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} placement="bottom-end" label="Map layers" className="map-layers-pop">
        <p className="map-layers-title map-kicker">Show on map</p>
        <SwitchRow layer="past" name="Past trips" hint={pastHint} disabled={!unlocked}>
          {null}
        </SwitchRow>
        {!unlocked ? (
          unlocking ? (
            <UnlockCard compact title="Unlock past trips" onUnlocked={() => setUnlocking(false)} className="map-unlock" />
          ) : (
            <Button variant="ghost" size="sm" className="map-unlock-btn" onClick={() => setUnlocking(true)}>
              Unlock journal
            </Button>
          )
        ) : null}
        <SwitchRow layer="planned" name="Planned trips" hint="Dashed until confirmed. Booked flights in teal." />
        <SwitchRow layer="cities" name="Cities" hint="More appear as you zoom in" />
        <SwitchRow layer="seasons" name="Data" hint={`Weather, society and signals for ${MONTH_NAMES[month - 1]}`}>
          <MonthPicker value={month} onChange={setMonth} />
          <OverlayPanel info={data} />
        </SwitchRow>
      </Popover>
    </>
  );
}
