import { Route, Routes } from "react-router-dom";
import Dashboard from "./pages/Dashboard";
import ClassDetail from "./pages/ClassDetail";
import AssignmentDetail from "./pages/AssignmentDetail";
import Grading from "./pages/Grading";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/classes/:id" element={<ClassDetail />} />
      <Route path="/assignments/:id" element={<AssignmentDetail />} />
      <Route path="/grading/:assignmentId" element={<Grading />} />
    </Routes>
  );
}
