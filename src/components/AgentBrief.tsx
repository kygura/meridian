import { useEffect, useState, useRef } from "react";
import { useMeridianStore } from "../store";

export default function AgentBrief() {
  const { selectedCityId } = useMeridianStore();
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!selectedCityId) {
      setContent("");
      return;
    }

    // Abort previous request
    if (abortRef.current) {
      abortRef.current.abort();
    }

    const controller = new AbortController();
    abortRef.current = controller;

    setContent("");
    setLoading(true);

    fetch("/api/agent/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cityId: selectedCityId }),
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error("Failed to fetch");

        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const data = await res.json();
          const brief = [
            data.seasonality,
            data.news,
            data.costEstimates,
            data.recommendations,
          ]
            .filter(Boolean)
            .join("\n\n");
          setContent(brief || JSON.stringify(data, null, 2));
          setLoading(false);
          return;
        }

        if (!res.body) {
          const text = await res.text();
          setContent(text);
          setLoading(false);
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          accumulated += decoder.decode(value, { stream: true });
          setContent(accumulated);
        }
        setLoading(false);
      })
      .catch((err) => {
        if (err.name !== "AbortError") {
          setLoading(false);
          setContent("Unable to load agent brief for this city.");
        }
      });

    return () => {
      controller.abort();
    };
  }, [selectedCityId]);

  return (
    <div className="section">
      <h3>
        AGENT BRIEF <span className="meta">AI-PARSED</span>
      </h3>
      <div className="h-sub">
        Intelligence summary for the selected region.
      </div>

      {loading && !content && (
        <div className="agent-brief-loading">
          <span />
          <span />
          <span />
        </div>
      )}

      {content && (
        <div className="agent-brief-content">{content}</div>
      )}

      {!loading && !content && selectedCityId && (
        <div
          style={{
            fontFamily: "var(--display)",
            fontStyle: "italic",
            fontSize: 14,
            color: "var(--ink3)",
          }}
        >
          No agent data available for this region.
        </div>
      )}
    </div>
  );
}
