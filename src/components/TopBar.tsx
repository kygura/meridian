import { useEffect, useState } from "react";
import { useMeridianStore } from "../store";
import NewsTicker from "./NewsTicker";

export default function TopBar() {
  const { theme, toggleTheme, toggleLeftDrawer } = useMeridianStore();
  const [utc, setUtc] = useState("");
  const [local, setLocal] = useState("");

  useEffect(() => {
    function tick() {
      const now = new Date();
      const hh = String(now.getUTCHours()).padStart(2, "0");
      const mm = String(now.getUTCMinutes()).padStart(2, "0");
      const ss = String(now.getUTCSeconds()).padStart(2, "0");
      setUtc(`${hh}:${mm}:${ss}`);
      setLocal(
        now
          .toLocaleString(undefined, {
            month: "short",
            day: "2-digit",
            weekday: "short",
          })
          .toUpperCase()
      );
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div
      style={{
        gridArea: "top",
        display: "flex",
        alignItems: "stretch",
        borderBottom: "1px solid var(--hairline2)",
        background: "var(--bg)",
        zIndex: 10,
      }}
    >
      {/* Menu button */}
      <button
        onClick={toggleLeftDrawer}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 44,
          border: "none",
          background: "transparent",
          borderRight: "1px solid var(--hairline)",
          cursor: "pointer",
          color: "var(--ink)",
          fontSize: 16,
          fontFamily: "var(--sans)",
        }}
        title="Toggle drawer [["
      >
        ☰
      </button>

      {/* Brand */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0 18px",
          borderRight: "1px solid var(--hairline)",
          minWidth: 200,
        }}
      >
        {/* Mark circle */}
        {/* <div
          style={{
            width: 18,
            height: 18,
            border: "1px solid var(--ink)",
            borderRadius: "50%",
            position: "relative",
            flexShrink: 0,
          }}
        >
          <div
            style={{
              position: "absolute",
              left: "50%",
              top: 0,
              bottom: 0,
              width: 1,
              background: "var(--ink)",
              transform: "translateX(-50%)",
            }}
          />
          <div
            style={{
              position: "absolute",
              top: "50%",
              left: 0,
              right: 0,
              height: 1,
              background: "var(--ink)",
              transform: "translateY(-50%)",
            }}
          />
        </div> */}
        <span
          style={{
            fontFamily: "var(--display)",
            fontStyle: "italic",
            fontSize:25,
            color: "var(--ink3)",
            marginLeft: "auto",
            letterSpacing: "0.07em",
          }}
        >
          Meridian
          
        </span>
        <span
          style={{
            fontFamily: "var(--display)",
            fontSize: 14,
            color: "var(--ink3)",
            marginLeft: "auto",
            letterSpacing: "0.01em",
          }}
        >
          cartographic interface
        </span>
      </div>

      {/* News Ticker */}
      <NewsTicker />

      {/* Clock */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "0 16px",
          borderLeft: "1px solid var(--hairline)",
          fontFamily: "var(--mono)",
          fontSize: 11,
          letterSpacing: "0.04em",
          color: "var(--ink2)",
        }}
      >
        <span>UTC</span>
        <span style={{ fontWeight: 700, color: "var(--ink)" }}>{utc}</span>
        <span style={{ color: "var(--ink4)" }}>·</span>
        <span>{local}</span>
      </div>

      {/* Theme toggle */}
      <div
        className="theme-toggle-btn"
        onClick={(e) => toggleTheme(e.clientX, e.clientY)}
        title="Toggle day/night"
      >
        <span className="tt-glyph" />
        <span>{theme === "dark" ? "NIGHT" : "DAY"}</span>
      </div>
    </div>
  );
}
