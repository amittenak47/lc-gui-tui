import { memo, useEffect, useState } from "react";
export const ThinkingDots = memo(function ThinkingDots() {
  const [count, setCount] = useState(1);
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const timer = setInterval(() => setCount(n => n % 3 + 1), 400);
    return () => clearInterval(timer);
  }, []);
  return <span aria-hidden="true" style={{ display: "inline-block", width: "2em" }}>{".".repeat(count)}</span>;
});
