import { useChat } from "ai/react";

export default function ChatPanel() {
  const { messages, input, handleInputChange, handleSubmit, isLoading } =
    useChat({
      api: "/api/agent/chat",
    });

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
      }}
    >
      {/* Messages */}
      <div className="chat-messages">
        {messages.length === 0 && (
          <div
            style={{
              fontFamily: "var(--display)",
              fontStyle: "italic",
              fontSize: 14,
              color: "var(--ink3)",
              padding: "20px 0",
            }}
          >
            Ask the agent about any city, route, or region&hellip;
          </div>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`chat-msg ${msg.role}`}
          >
            {msg.content}
          </div>
        ))}
        {isLoading && (
          <div className="chat-msg assistant">
            <div className="agent-brief-loading">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="chat-input-bar">
        <input
          value={input}
          onChange={handleInputChange}
          placeholder="Ask the agent..."
          disabled={isLoading}
        />
        <button type="submit" disabled={isLoading}>
          SEND
        </button>
      </form>
    </div>
  );
}
