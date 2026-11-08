import { Segmented } from "antd";
import { useScoreView } from "../contexts/ScoreViewContext";

export default function ScoreViewToggle() {
  const { view, changeView } = useScoreView();
  return (
    <Segmented
      className="score-view-toggle"
      size="small"
      aria-label="分数或 GPA 视图"
      value={view}
      onChange={changeView}
      options={[{ label: "分数", value: "score" }, { label: "GPA", value: "gpa" }]}
    />
  );
}
