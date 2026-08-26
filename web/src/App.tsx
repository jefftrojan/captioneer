import Sidebar from "./Sidebar";
import { WorkflowProvider, useWorkflow } from "./workflow";
import Home from "./pages/Home";
import Create from "./pages/Create";
import Editor from "./pages/Editor";
import Videos from "./pages/Videos";
import Channels from "./pages/Channels";

function ActivePage() {
  const { page } = useWorkflow();
  switch (page) {
    case "home":
      return <Home />;
    case "create":
      return <Create />;
    case "editor":
      return <Editor />;
    case "videos":
      return <Videos />;
    case "channels":
      return <Channels />;
  }
}

export default function App() {
  return (
    <WorkflowProvider>
      <div className="shell">
        <Sidebar />
        <main className="main">
          <ActivePage />
        </main>
      </div>
    </WorkflowProvider>
  );
}
