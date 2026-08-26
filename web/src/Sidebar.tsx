import { Film, Home, Plus, Wand2, PlaySquare } from "lucide-react";
import Logo from "./Logo";
import { type Page, useWorkflow } from "./workflow";

const NAV: { page: Page; label: string; icon: typeof Home }[] = [
  { page: "home", label: "Home", icon: Home },
  { page: "editor", label: "Editor", icon: Wand2 },
  { page: "videos", label: "History", icon: Film },
  { page: "channels", label: "YouTube", icon: PlaySquare },
];

export default function Sidebar() {
  const { page, navigate } = useWorkflow();

  return (
    <nav className="sidebar">
      <div className="sidebar-mark">
        <Logo size={30} />
      </div>

      <button className="nav-create" onClick={() => navigate("create")} title="Create">
        <Plus size={22} />
      </button>
      <span className="nav-create-label">Create</span>

      {NAV.map(({ page: p, label, icon: Icon }) => (
        <button
          key={p}
          className={`nav-item${page === p ? " active" : ""}`}
          onClick={() => navigate(p)}
        >
          <Icon />
          {label}
        </button>
      ))}

      <div className="sidebar-spacer" />
    </nav>
  );
}
