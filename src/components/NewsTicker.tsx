import { useEffect, useMemo, useRef, useState } from "react";
import { useMeridianStore } from "../store";
import { apiUrl } from "../lib/api";
import { hasToken } from "../lib/journalApi";
import { mergeTicker } from "../lib/inbox";
import { cityIndex } from "../lib/journal";
import type { TickerItem } from "../types";

const SCROLL_SPEED_PX_PER_SEC = 50;
const REFRESH_INTERVAL = 15 * 60 * 1000;

export default function NewsTicker() {
  const { ticker: news, setTicker } = useMeridianStore();
  const alerts = useMeridianStore((s) => s.alerts);
  const watches = useMeridianStore((s) => s.watches);
  const cities = useMeridianStore((s) => s.cities);
  const locked = useMeridianStore((s) => s.journalLocked);
  const setAlertsPanelOpen = useMeridianStore((s) => s.setAlertsPanelOpen);
  // Unseen alerts lead the set, only while the journal is unlocked (no token, no alert items).
  const ticker = useMemo(
    () => mergeTicker(news, alerts, watches, cityIndex(cities), hasToken() && !locked),
    [news, alerts, watches, cities, locked]
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<number>(0);
  const pausedRef = useRef(false);
  const [hovered, setHovered] = useState(false);
  const [clickedIndex, setClickedIndex] = useState<number | null>(null);

  // Fetch news on mount + periodic refresh
  useEffect(() => {
    const load = () => {
      fetch(apiUrl("/api/news"))
        .then((r) => r.json())
        .then((data) => {
          if (Array.isArray(data) && data.length > 0) setTicker(data);
        })
        .catch(() => {});
    };
    load();
    const id = setInterval(load, REFRESH_INTERVAL);
    return () => clearInterval(id);
  }, [setTicker]);

  // Continuous horizontal scroll animation
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || ticker.length === 0) return;

    let lastTime = 0;
    let offset = 0;

    const measureWidth = () => {
      const firstSet = el.querySelector(".nt-set");
      return firstSet ? firstSet.scrollWidth : 0;
    };

    const tick = (time: number) => {
      if (lastTime === 0) lastTime = time;
      const dt = (time - lastTime) / 1000;
      lastTime = time;

      if (!pausedRef.current) {
        offset -= SCROLL_SPEED_PX_PER_SEC * dt;

        const setWidth = measureWidth();
        if (setWidth > 0 && Math.abs(offset) >= setWidth) {
          offset += setWidth;
        }

        el.style.transform = `translateX(${offset}px)`;
      }

      animationRef.current = requestAnimationFrame(tick);
    };

    animationRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationRef.current);
  }, [ticker]);

  // Pause on hover
  useEffect(() => {
    pausedRef.current = hovered;
  }, [hovered]);

  const handleClick = (item: TickerItem & { alertId?: string }, index: number) => {
    if (item.alertId) {
      setAlertsPanelOpen(true);
      return;
    }
    if (!item.url) return;
    setClickedIndex(index);
    setTimeout(() => setClickedIndex(null), 600);
    window.open(item.url, "_blank", "noopener,noreferrer");
  };

  if (ticker.length === 0) {
    return (
      <div className="nt-bar">
        <span className="nt-label">NEWS</span>
        <span className="nt-loading">LOADING…</span>
      </div>
    );
  }

  // Duplicate items for seamless loop
  const items = [...ticker, ...ticker];

  return (
    <div
      className="nt-bar"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className="nt-label">NEWS</span>
      <span className="nt-live-dot" />
      <div className="nt-viewport">
        <div className="nt-track" ref={scrollRef}>
          <span className="nt-set">
            {items.map((item, i) => {
              const realIndex = i % ticker.length;
              const isClicked = clickedIndex === realIndex;
              const isAlert = !!item.alertId;
              const hasLink = !!item.url || isAlert;

              return (
                <span
                  key={i}
                  className={`nt-item ${hasLink ? "nt-clickable" : ""} ${isClicked ? "nt-clicked" : ""}`}
                  onClick={hasLink ? () => handleClick(item, realIndex) : undefined}
                  role={hasLink ? "button" : undefined}
                  tabIndex={hasLink ? 0 : undefined}
                  onKeyDown={
                    hasLink
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            handleClick(item, realIndex);
                          }
                        }
                      : undefined
                  }
                  title={isAlert ? `${item.text} (click to open alerts)` : hasLink ? `${item.text} — ${item.source ?? "Source"} (click to open)` : item.text}
                >
                  <span className={`nt-glyph ${item.glyph}`} />
                  <span className="nt-loc">{item.location}</span>
                  <span className="nt-text">{item.text}</span>
                  {item.source && <span className="nt-source">{item.source}</span>}
                  <span className="nt-time">{item.time}</span>
                  {hasLink && !isAlert && <span className="nt-link-icon">↗</span>}
                  <span className="nt-sep" />
                </span>
              );
            })}
          </span>
        </div>
      </div>
    </div>
  );
}
