import { createContext, useCallback, useContext, useState } from "react";
import { clientLog } from "../utils/clientLog";

const ScoreViewContext = createContext(null);
const STORAGE_KEY = "autograde_score_view";

export function ScoreViewProvider({ children }) {
  const [view, setView] = useState(() => localStorage.getItem(STORAGE_KEY) === "gpa" ? "gpa" : "score");
  const changeView = useCallback((next) => {
    if (next !== "score" && next !== "gpa") return;
    setView((current) => {
      if (current === next) return current;
      localStorage.setItem(STORAGE_KEY, next);
      clientLog.operation("score_view", "success", { view: next });
      return next;
    });
  }, []);
  return (
    <ScoreViewContext.Provider value={{ view, isGpa: view === "gpa", changeView }}>
      {children}
    </ScoreViewContext.Provider>
  );
}

export const useScoreView = () => useContext(ScoreViewContext);
