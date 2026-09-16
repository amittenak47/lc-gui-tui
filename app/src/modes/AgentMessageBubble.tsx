import { useState, type HTMLAttributes } from "react";

/** New turns grow at their chat position; restored history stays still. */
export function AgentMessageBubble({
  enter, className = "", ...props
}: HTMLAttributes<HTMLDivElement> & { enter: boolean }) {
  const [animateEntry] = useState(enter);
  return <div {...props} className={`${className}${animateEntry ? " lc-agent-turn-enter" : ""}`} />;
}
