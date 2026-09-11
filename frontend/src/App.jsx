import { useEffect } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import Dashboard from "./pages/Dashboard";
import ClassDetail from "./pages/ClassDetail";
import ClassStats from "./pages/ClassStats";
import StudentDetail from "./pages/StudentDetail";
import AssignmentDetail from "./pages/AssignmentDetail";
import Grading from "./pages/Grading";
import QuestionBatchEdit from "./pages/QuestionBatchEdit";
import QuickGrade from "./pages/QuickGrade";
import Login from "./pages/Login";
import Settings from "./pages/Settings";
import Admin from "./pages/Admin";
import PageSkeleton from "./components/PageSkeleton";
import UpdateModals from "./components/UpdateModals";
import { UNAUTHORIZED_EVENT } from "./api";
import { clientLog } from "./utils/clientLog";
import { useAuth } from "./contexts/AuthContext";

// 路由守卫：登录态初始化中显示骨架屏；未登录跳 /login（记住来源路径）
// adminOnly：再校验 is_admin（防御深度：非管理员直输 URL 也拦）
function RequireAuth({ children, adminOnly = false }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading)
    return (
      <div className="page-enter">
        <PageSkeleton />
      </div>
    );
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  if (adminOnly && !user.is_admin)
    return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  // 401（token 失效/被顶掉）全局跳登录，记住来源页，登录成功原路返回
  useEffect(() => {
    const handler = () => {
      if (location.pathname !== "/login") {
        navigate("/login", { state: { from: location.pathname }, replace: true });
      }
    };
    window.addEventListener(UNAUTHORIZED_EVENT, handler);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, handler);
  }, [navigate, location.pathname]);

  // 页面浏览留痕：诊断包能还原「用户点了哪些页面」（配合 api.js 的接口日志形成完整操作路径）
  useEffect(() => {
    clientLog.add("page", `${location.pathname}${location.search}`);
  }, [location.pathname, location.search]);

  return (
    <>
      {/* 登录后更新提醒：版本更新 + 协议变更（未登录不弹，注册时已同意） */}
      {user && <UpdateModals />}
      <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <Dashboard />
          </RequireAuth>
        }
      />
      <Route
        path="/classes/:id"
        element={
          <RequireAuth>
            <ClassDetail />
          </RequireAuth>
        }
      />
      <Route
        path="/classes/:id/stats"
        element={
          <RequireAuth>
            <ClassStats />
          </RequireAuth>
        }
      />
      <Route
        path="/classes/:classId/students/:studentId"
        element={
          <RequireAuth>
            <StudentDetail />
          </RequireAuth>
        }
      />
      <Route
        path="/assignments/:id"
        element={
          <RequireAuth>
            <AssignmentDetail />
          </RequireAuth>
        }
      />
      <Route
        path="/assignments/:id/edit"
        element={
          <RequireAuth>
            <QuestionBatchEdit />
          </RequireAuth>
        }
      />
      <Route
        path="/assignments/:id/quick"
        element={
          <RequireAuth>
            <QuickGrade />
          </RequireAuth>
        }
      />
      <Route
        path="/grading/:assignmentId"
        element={
          <RequireAuth>
            <Grading />
          </RequireAuth>
        }
      />
      <Route
        path="/settings"
        element={
          <RequireAuth>
            <Settings />
          </RequireAuth>
        }
      />
      <Route
        path="/admin"
        element={
          <RequireAuth adminOnly>
            <Admin />
          </RequireAuth>
        }
      />
      {/* 兜底：未知路径回工作台 */}
      <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
