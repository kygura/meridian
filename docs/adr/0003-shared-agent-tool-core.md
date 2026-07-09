# One shared tool core behind the agent loop, the mock path, and legacy endpoints

Agent capabilities (search_places, get_place_images, get_seasonality,
get_flight_estimate) are plain deterministic functions in `server/lib/agent/`. The LLM
loop wraps them as AI SDK tools; the keyless mock path executes the same functions with
deterministic selection and emits the same stream shapes; legacy `/api/agent/research`
and `/api/agent/trip-options` are thin wrappers over the same core so `AgentBrief.tsx`
keeps its contract during and after the rewrite. This is what keeps the mock demo honest
and stops the legacy/mock paths from rotting — the only difference between paths is
"LLM present or not". Rejected: a separate mock response generator (drifts from real),
and migrating AgentBrief to new endpoints (churn with no benefit).
