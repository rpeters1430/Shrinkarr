import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import "./styles.css";
import { Nav } from "./components/Nav";
import { Dashboard } from "./pages/Dashboard";
import { Library } from "./pages/Library";
import { Queue } from "./pages/Queue";
import { HardwareAndPresets } from "./pages/HardwareAndPresets";
import { Settings } from "./pages/Settings";

function App() {
  return (
    <BrowserRouter>
      <div className="app-container">
        <Nav />
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/library" element={<Library />} />
          <Route path="/queue" element={<Queue />} />
          <Route path="/presets" element={<HardwareAndPresets />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
