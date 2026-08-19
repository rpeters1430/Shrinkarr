import { NavLink } from "react-router-dom";

const linkStyle = ({ isActive }: { isActive: boolean }) => ({
  marginRight: "1rem",
  fontWeight: isActive ? 700 : 400,
});

export function Nav() {
  return (
    <nav style={{ padding: "1rem", borderBottom: "1px solid #ccc" }}>
      <NavLink to="/" end style={linkStyle}>
        Dashboard
      </NavLink>
      <NavLink to="/library" style={linkStyle}>
        Library
      </NavLink>
      <NavLink to="/queue" style={linkStyle}>
        Queue
      </NavLink>
      <NavLink to="/settings" style={linkStyle}>
        Settings
      </NavLink>
    </nav>
  );
}
